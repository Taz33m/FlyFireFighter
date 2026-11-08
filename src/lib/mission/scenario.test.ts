import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { TENDER_T1 } from "../contracts/aircraft.ts";
import { envelopeContains, hardLimitViolations } from "../contracts/envelope.ts";
import type { BeliefSnapshot, RouteAssessment } from "../contracts/evidence.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { distance, vec3 } from "../contracts/frames.ts";
import { regionContains, representativePoint } from "../contracts/geometry.ts";
import type { SceneMetaJson } from "../contracts/scene.ts";
import { DEFAULT_POLICY } from "../harness/policy.ts";
import { assessRoute } from "../navigation/routes/index.ts";
import { raycast } from "../simulation/raycast.ts";
import { parseSceneMeta, roomAt } from "../simulation/scene.ts";
import type { MissionPreset, PresetVariant } from "./scenario.ts";
import { createPresetWorld, GREASE_FIRE, isStagedVariant, loadPreset, MAIN_FIRE, PRESET_VARIANTS, STAGED, STAGED_VARIANTS, variantOfScenarioId } from "./scenario.ts";

const META: SceneMetaJson = parseSceneMeta(JSON.parse(readFileSync(new URL("../../../public/scenes/troy-training/scene.meta.json", import.meta.url), "utf8")));
const preset = (variant: PresetVariant, seed = "seed-1"): MissionPreset => loadPreset(META, variant, seed, "run-1");
const MAIN = preset("main");
const FIRE_ANCHOR = MAIN.scene.anchors.fireOrigin;
const OCCUPANT_ANCHOR = MAIN.scene.anchors.occupantStart;
const LAUNCH = MAIN.scene.launchPoint.position;

/** Every {x, y, z} object anywhere inside a value. */
function vectorsIn(value: unknown, out: Vec3[] = []): Vec3[] {
  if (value === null || typeof value !== "object") return out;
  const record = value as Record<string, unknown>;
  if (typeof record.x === "number" && typeof record.y === "number" && typeof record.z === "number") out.push(record as unknown as Vec3);
  for (const child of Object.values(record)) vectorsIn(child, out);
  return out;
}

/** The serializable parts of a preset (functions applied to fixed inputs). */
function comparable(p: MissionPreset) {
  return {
    scenario: { ...p.scenario, scenarioId: "-" }, prior: p.prior, launchZone: p.launchZone, budgetTick: p.budgetTick,
    defaultReport: p.defaultReport, assemblyPoint: p.assemblyPoint, envelope: p.envelope("run-x", "commander", 100),
    evacuation: p.evacuationRouteRequest(OCCUPANT_ANCHOR), return: p.returnRouteRequest(vec3(24, 0, 4.8)),
  };
}

describe("mission presets", () => {
  test("every variant loads and builds its initial world as documented", () => {
    for (const variant of PRESET_VARIANTS) {
      const world = createPresetWorld(preset(variant));
      assert.equal(world.scenarioId, `troy-training/${variant}`);
      assert.equal(variantOfScenarioId(world.scenarioId), variant);
      assert.equal(world.occupants.length, 1);
      assert.deepEqual(world.occupants[0].position, OCCUPANT_ANCHOR);
      const door = (id: string) => world.openings.find(o => o.id === id)?.state;
      assert.equal(door("door-front"), variant === "blocked_exit" ? "blocked" : "closed");
      assert.equal(door("door-u-rear-bedroom"), "open", "the world's rear bedroom door is open in every variant");
      assert.equal(world.occupants[0].mobility, variant === "immobile_occupant" ? "immobile" : "mobile");
      assert.equal(world.fires.length, variant === "no_fire" ? 0 : 1);
    }
    const fire = createPresetWorld(MAIN).fires[0];
    assert.equal(fire.roomId, "room-u-hall");
    assert.deepEqual(fire.region, { kind: "sphere", center: FIRE_ANCHOR, radiusM: MAIN_FIRE.radiusM });
    assert.equal(MAIN.defaultReport, "Someone may be in the upstairs rear bedroom.");
    const grease = preset("kitchen_grease_fire");
    const kitchenFire = createPresetWorld(grease).fires[0];
    assert.equal(kitchenFire.roomId, "room-g-kitchen", "the grease fire burns in the kitchen");
    assert.deepEqual(kitchenFire.region, { kind: "sphere", center: GREASE_FIRE.origin, radiusM: MAIN_FIRE.radiusM });
    assert.match(grease.defaultReport, /^Someone may be in the upstairs rear bedroom\. A pan of oil caught fire/);
    assert.equal(MAIN.budgetTick, 60_000);
  });

  test("the planner's prior never carries the scenario anchors or the launch point", () => {
    for (const variant of PRESET_VARIANTS) {
      const prior = preset(variant).prior;
      const text = JSON.stringify(prior);
      assert.doesNotMatch(text, /scenarioAnchors|fireOrigin|occupantStart|launchPoint/);
      for (const v of vectorsIn(prior)) {
        for (const secret of [FIRE_ANCHOR, OCCUPANT_ANCHOR, LAUNCH]) assert.ok(distance(v, secret) > 1e-9, `prior of ${variant} contains (${v.x}, ${v.y}, ${v.z})`);
      }
    }
  });

  test("the envelope stays within the aircraft's hard limits and covers the mission", () => {
    for (const tick of [0, 4321]) {
      const envelope = MAIN.envelope("run-1", "commander-1", tick);
      assert.deepEqual(hardLimitViolations(envelope, TENDER_T1, tick), []);
      assert.equal(envelope.endTick - tick, 72_000);
      assert.equal(envelope.approvedTick, tick);
      assert.ok(envelope.maxSpeedMps <= TENDER_T1.hardLimits.maxSpeedMps && envelope.ambientCeilingC <= TENDER_T1.hardLimits.maxAmbientC);
      for (const p of [LAUNCH, OCCUPANT_ANCHOR, FIRE_ANCHOR, representativePoint(MAIN.assemblyPoint)]) assert.ok(envelopeContains(envelope, p));
      assert.ok(!envelopeContains(envelope, vec3(LAUNCH.x, LAUNCH.y, 8.5)), "nothing above 8 m");
    }
    assert.ok(regionContains(MAIN.launchZone, LAUNCH));
  });

  test("variants differ from main only as documented, and presets are deterministic in the seed", () => {
    const main = comparable(MAIN);
    const expect = (variant: PresetVariant) => {
      const occupants = [{ ...MAIN.scenario.occupants[0], mobility: variant === "immobile_occupant" ? "immobile" : "mobile" }];
      const wrongDoor = (o: MissionPreset["prior"]["openings"][number]) => (o.id === "door-u-rear-bedroom" ? { ...o, priorState: "closed" } : o);
      const prior = variant === "wrong_prior" ? { ...MAIN.prior, source: `${MAIN.prior.source} (corrupted for experiment)`, openings: MAIN.prior.openings.map(wrongDoor) } : MAIN.prior;
      const openingOverrides = variant === "blocked_exit" ? { "door-front": "blocked" } : {};
      const skipped = isStagedVariant(variant) ? STAGED.elapsedS * 100 : 0;
      const envelope = { ...main.envelope, endTick: main.envelope.endTick - skipped };
      const grease = variant === "kitchen_grease_fire";
      const fire = variant === "no_fire" ? null : grease ? { ...main.scenario.fire, roomId: "room-g-kitchen", origin: GREASE_FIRE.origin } : main.scenario.fire;
      const defaultReport = grease ? `${main.defaultReport} A pan of oil caught fire on the stove in the kitchen.` : main.defaultReport;
      return { ...main, scenario: { ...main.scenario, occupants, openingOverrides, fire }, prior, budgetTick: main.budgetTick - skipped, envelope, defaultReport };
    };
    for (const variant of PRESET_VARIANTS) assert.deepEqual(comparable(preset(variant)), expect(variant), variant);
    assert.deepEqual(comparable(preset("main")), main);
    const reseeded = comparable(preset("main", "seed-2"));
    assert.deepEqual(reseeded, { ...main, scenario: { ...main.scenario, seed: "seed-2" } });
  });
});

describe("preset routes on the Troy prior", () => {
  const STRUCTURE = new Set(["wall", "floor", "ceiling", "roof", "stair"]);
  const belief = (openings: BeliefSnapshot["openings"]): BeliefSnapshot => ({
    runId: "run-1", tick: 1000, evidenceRevision: 1, mapPrior: MAIN.prior, mapRevision: 1, mapChanges: [],
    pose: { tick: 1000, position: LAUNCH, yawRad: 0, velocity: vec3(0, 0, 0), sigmaM: 0.1, yawSigmaRad: 0.02, supported: true },
    aircraft: { enduranceRemainingS: 800, waterRemainingL: 1, payloadsOnboard: [], ambientC: 20, thrustAvailableN: 60 },
    landing: { supported: false, site: null, evidenceIds: [], reason: "fixture" },
    observations: [], reports: [], tracks: [], crewConfirmations: [], coverage: [], hazards: [], openings, routes: [], dispatchConfirmed: null,
  });
  const assess = (request: ReturnType<MissionPreset["returnRouteRequest"]>, openings: BeliefSnapshot["openings"] = []): RouteAssessment =>
    assessRoute({ belief: belief(openings), tick: 1000, lastInterventionTick: null, policy: DEFAULT_POLICY }, request);
  const centre = (id: string): Vec3 => MAIN.prior.openings.find(o => o.id === id)?.center ?? vec3(NaN, NaN, NaN);
  const through = (route: RouteAssessment, id: string): boolean => route.waypoints.some(w => distance(w, centre(id)) < 1e-6);

  /** Truth-side check: no leg of the route passes through the scene's structural colliders. */
  function assertClearOfStructure(route: RouteAssessment): void {
    for (let i = 1; i < route.waypoints.length; i++) {
      const [a, b] = [route.waypoints[i - 1], route.waypoints[i]];
      const length = distance(a, b);
      if (length < 1e-9) continue;
      const hit = raycast(MAIN.scene.colliders, a, vec3((b.x - a.x) / length, (b.y - a.y) / length, (b.z - a.z) / length), length, c => !STRUCTURE.has(c.kind));
      assert.equal(hit, null, `leg ${i} hits ${hit?.colliderId}`);
    }
  }

  test("the evacuation leaves the rear bedroom, rounds the hall, takes the stair and the front door to the assembly point", () => {
    const route = assess(MAIN.evacuationRouteRequest(vec3(OCCUPANT_ANCHOR.x, OCCUPANT_ANCHOR.y, OCCUPANT_ANCHOR.z + 1)));
    assert.ok(through(route, "door-u-rear-bedroom") && through(route, "door-front"));
    const stair = MAIN.prior.stairs?.[0];
    assert.ok(stair && route.waypoints.some(w => distance(w, vec3(stair.top.x, stair.top.y, stair.top.z + 1)) < 1e-6));
    assert.deepEqual(route.waypoints[route.waypoints.length - 1], representativePoint(MAIN.assemblyPoint));
    assert.equal(route.status, "unknown", "nothing has been observed yet");
    assertClearOfStructure(route);
  });

  test("the return from the rear bedroom leaves by the broken window and flies around the house to the launch point", () => {
    const broken = [{ openingId: "win-u-rear-bedroom", state: "broken" as const, tick: 900, observationId: "obs-window" }];
    const route = assess(MAIN.returnRouteRequest(vec3(24.5, -1, 4.8)), broken);
    assert.ok(through(route, "win-u-rear-bedroom") && !through(route, "door-front"));
    assert.deepEqual(route.waypoints[route.waypoints.length - 1], LAUNCH);
    assertClearOfStructure(route);
    const sealed = assess(MAIN.returnRouteRequest(vec3(24.5, -1, 4.8)));
    assert.equal(sealed.status, "unsupported", "with every window intact and the front door closed the aircraft cannot get out");
  });
});

describe("staged test tools (not rescue scenarios)", () => {
  const SKIPPED_S = STAGED.elapsedS;
  const staged = (variant: (typeof STAGED_VARIANTS)[number]) => {
    const p = preset(variant);
    return { preset: p, world: createPresetWorld(p) };
  };
  const compartment = (world: ReturnType<typeof createPresetWorld>, id: string) => world.compartments.find(c => c.id === id);

  test("the fire and smoke are what the fire model alone produces over the skipped time, with the study window broken", () => {
    const { world } = staged("staged_spray");
    const fire = world.fires[0];
    const capKW = 400 * Math.PI * MAIN_FIRE.radiusM ** 2;
    assert.ok(!fire.extinguished && Math.abs(fire.heatReleaseKW - capKW) < 0.5, `a t² fire reaches its item peak within a minute and stays there: ${fire.heatReleaseKW} kW`);
    // Fuel burned: at most the cap for the whole time, at least the cap after the first minute of growth.
    const burnedMJ = MAIN_FIRE.fuelMJ - fire.fuelMJ;
    assert.ok(burnedMJ <= (capKW * SKIPPED_S) / 1000 && burnedMJ >= (capKW * (SKIPPED_S - 60)) / 1000, `burned ${burnedMJ} MJ`);
    const k = (id: string) => compartment(world, id)?.smokeExtinctionPerM ?? NaN;
    assert.ok(k("room-u-hall") > 0.3, "smoke builds up in the fire's room");
    assert.ok(k("room-u-rear-bedroom") > 0, "smoke reaches the occupant's room through its open door");
    assert.equal(k("room-u-front-bedroom"), 0, "a closed door keeps smoke out");
    const window = world.openings.find(o => o.id === STAGED.brokenWindowId);
    assert.equal(window?.state, "broken");
    assert.ok((window?.openAreaM2 ?? 0) > 1);
    const panes = MAIN.scene.colliders.filter(c => c.kind === "glass" && c.openingId === STAGED.brokenWindowId);
    assert.ok(panes.length > 0 && panes.every(c => !world.activeColliderIds.has(c.id)), "the broken window's panes no longer collide");
    assert.equal(world.openings.filter(o => o.state === "broken").length, 1, "no other opening changed");
    const occupant = world.occupants[0];
    assert.equal(occupant.activity, "shelter", "without any cue the occupant has stayed where main starts it");
    assert.ok(occupant.smokeExposure > 0, "and has been breathing smoke");
  });

  test("the aircraft hovers in the upstairs study with the skipped time taken off its endurance, the budget and the time box", () => {
    for (const variant of STAGED_VARIANTS) {
      const { preset: p, world } = staged(variant);
      assert.equal(roomAt(world.scene, world.drone.position)?.id, "room-u-study", variant);
      assert.equal(world.drone.enduranceRemainingS, TENDER_T1.hardLimits.enduranceS - SKIPPED_S);
      assert.equal(world.tick, 0, "the run's clock starts at 0");
      assert.deepEqual(world.truthEvents, [], "nothing from the skipped time is scored");
      assert.equal(p.budgetTick, MAIN.budgetTick - SKIPPED_S * 100);
      assert.equal(p.envelope("run-1", "c", 500).endTick - 500, MAIN.envelope("run-1", "c", 500).endTick - 500 - SKIPPED_S * 100);
      assert.deepEqual(p.prior, MAIN.prior, "the planner's map prior is main's: staging never reaches it");
    }
    assert.equal(staged("staged_spray").world.drone.waterRemainingL, TENDER_T1.modules.water?.tankL);
  });

  test("staged_post_suppression puts the fire out with the fire model's own suppression rule and leaves the smoke", () => {
    const spray = staged("staged_spray").world;
    const post = staged("staged_post_suppression").world;
    assert.equal(post.fires[0].extinguished, true);
    assert.equal(post.fires[0].heatReleaseKW, 0);
    assert.ok(Math.abs(post.fires[0].waterDeliveredL - STAGED.waterL) < 1e-9);
    assert.ok(Math.abs(post.drone.waterRemainingL - ((TENDER_T1.modules.water?.tankL ?? 0) - STAGED.waterL)) < 1e-9);
    assert.deepEqual(post.compartments, spray.compartments, "suppression at the last instant does not clear the smoke");
    assert.deepEqual(post.occupants, spray.occupants);
  });

  test("staged worlds are deterministic", () => {
    for (const variant of STAGED_VARIANTS) {
      const a = staged(variant).world;
      const b = staged(variant).world;
      for (const key of ["drone", "openings", "compartments", "fires", "occupants", "estimator"] as const) assert.deepEqual(a[key], b[key], `${variant} ${key}`);
      assert.deepEqual([...a.activeColliderIds].sort(), [...b.activeColliderIds].sort());
    }
  });
});
