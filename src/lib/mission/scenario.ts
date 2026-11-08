/**
 * Mission presets: the seeded main rescue on a scene and its documented variants.
 *
 * main: the Tender T1 aircraft; a small fire at scenarioAnchors.fireOrigin in the room containing it
 * (room-u-hall in the Troy scene); one mobile occupant at scenarioAnchors.occupantStart; the floor-plan
 * prior from the scene metadata with no anchors in it. The fire is radius MAIN_FIRE.radiusM: in the fire
 * model's item-peak rule (400 kW/m² × πr²) 0.15 m caps it near 28 kW. Measured on the Troy scene with the
 * fire model alone (a scratch run, not a test): the upstairs hall's smoke extinction then stays at or below
 * about 1.3 /m through the 10-minute budget once the rear bedroom window is broken (about 1.45 /m with every
 * window intact); at 0.25 m (≈79 kW) it reached 1.4 /m within two minutes and 2.2 /m within four, and its
 * fuel burned out in about five. 20 MJ at 28 kW outlasts the budget, so the fire does not burn out on its
 * own before the rescue is scored.
 *
 * Variants differ from main only as stated:
 * - immobile_occupant: the occupant cannot walk (an incomplete rescue needing human assistance is expected);
 * - blocked_exit: the exit door is jammed in the world (opening override "blocked") while the plan still
 *   draws it closed;
 * - wrong_prior: an interior door that is open in the world is drawn closed in the plan;
 * - no_fire: no fire;
 * - kitchen_grease_fire: the fire (MAIN_FIRE's size, a labelled stand-in: the fire model has no oil chemistry)
 *   burns at GREASE_FIRE.origin, on the kitchen counter, instead of in the upstairs hall, and the default report
 *   adds the caller's "A pan of oil caught fire on the stove in the kitchen." Water is the wrong agent for a
 *   cooking-oil fire, so the expected run has no spray at all: the harness refuses one (H19, from the report's
 *   words and the prior's kitchen) and the planner offers none, saying why; the rescue goes on with route
 *   assessment and guidance.
 *
 * STAGED TEST TOOLS (staged_spray, staged_post_suppression): not rescue scenarios and never a substitute for
 * the main acceptance test (mission.e2e.test.ts flies "main" from the report). They skip the first
 * STAGED.elapsedS of the main mission so the stages after entry can be exercised in a few minutes. Only the
 * initial WORLD differs, and only as follows; the prior, the report, the occupant's start and every rule are
 * main's, and the run starts with an empty evidence store (no coverage, tracks, openings or fire evidence
 * carry over: the aircraft must observe everything again).
 * - The fire model and the occupant model alone are stepped for STAGED.elapsedS from main's initial world
 *   (fire burning from tick 0, occupant sheltering and breathing smoke), with STAGED.brokenWindowId broken at
 *   STAGED.brokenAtS (the window the main run's approved breach broke, at about that time).
 * - The aircraft then hovers inside the upstairs study at STAGED.dronePosition, just inside the broken window
 *   and facing it (as right after entering through it), with a fresh localization estimate and endurance
 *   reduced by the skipped time. Its first frames observe the window broken, as the main run's did.
 * - The rescue budget and the envelope time box are shortened by the skipped time.
 * - staged_spray: the fire is still burning (the suppression is the run's own, commander-approved spray).
 * - staged_post_suppression: STAGED.waterL of water reaches the fire through the fire model's own
 *   suppression rule at the end of the skipped time (extinguishing it; the smoke stays) and leaves the tank.
 *   No intervention record exists in the harness, so route support is judged as without an intervention.
 * Everything is a pure function of (meta, variant, seed, runId); the seed is carried into the scenario for
 * the simulator's keyed noise. Preset geometry does not depend on it.
 */
import { TENDER_T1 } from "../contracts/aircraft.ts";
import type { Tick } from "../contracts/clock.ts";
import { FIRE_PERIOD_TICKS, TICK_S, ticksFromSeconds } from "../contracts/clock.ts";
import type { MissionEnvelope } from "../contracts/envelope.ts";
import { hardLimitViolations } from "../contracts/envelope.ts";
import type { FloorPlanPrior } from "../contracts/evidence.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { add, vec3 } from "../contracts/frames.ts";
import type { Region } from "../contracts/geometry.ts";
import { box, representativePoint } from "../contracts/geometry.ts";
import type { RunId } from "../contracts/ids.ts";
import { deepFreeze } from "../contracts/ids.ts";
import type { SceneMetaJson } from "../contracts/scene.ts";
import type { RouteRequest } from "../navigation/routes/index.ts";
import { deliverWater, stepFire } from "../simulation/fire.ts";
import { stepOccupants } from "../simulation/occupant.ts";
import { floorPlanPriorFromScene } from "../simulation/prior.ts";
import { clearOpeningAreaM2, findOpening, roomAt, sceneModelFromMeta } from "../simulation/scene.ts";
import { createWorld } from "../simulation/world.ts";
import type { ScenarioConfig, SceneModel, WorldState } from "../simulation/world-state.ts";

export type StagedVariant = "staged_spray" | "staged_post_suppression";
export type PresetVariant = "main" | "immobile_occupant" | "blocked_exit" | "wrong_prior" | "no_fire" | "kitchen_grease_fire" | StagedVariant;

/** Test tools that skip the start of the main mission (see the module comment); not rescue scenarios. */
export const STAGED_VARIANTS: readonly StagedVariant[] = ["staged_spray", "staged_post_suppression"];
export const PRESET_VARIANTS: readonly PresetVariant[] = ["main", "immobile_occupant", "blocked_exit", "wrong_prior", "no_fire", "kitchen_grease_fire", ...STAGED_VARIANTS];

export function isStagedVariant(variant: PresetVariant): variant is StagedVariant {
  return (STAGED_VARIANTS as readonly string[]).includes(variant);
}

/**
 * Staging of the staged test variants. elapsedS: the main run proposed its spray from about 100 s and had it
 * approved at about 244 s, so 240 s reproduces the fire and smoke it met; brokenAtS: its glass strike landed
 * at about 78 s. dronePosition: 1 m inside win-u-study-s1 (0.83 m from the study's south wall, more than 1.3 m
 * from its east and west walls) at about the window's height; yaw −π/2 faces the window.
 */
export const STAGED = deepFreeze({
  elapsedS: 240,
  brokenWindowId: "win-u-study-s1",
  brokenAtS: 78,
  dronePosition: { x: 18.2, y: -1.95, z: 5.0 },
  droneYawRad: -Math.PI / 2,
  waterL: 0.3,
});

export interface MissionPreset {
  readonly variant: PresetVariant;
  readonly scene: SceneModel;
  readonly scenario: ScenarioConfig;
  readonly prior: FloorPlanPrior;
  readonly envelope: (runId: RunId, approvedBy: string, tick: Tick) => MissionEnvelope;
  readonly launchZone: Region;
  readonly budgetTick: Tick;
  readonly defaultReport: string;
  readonly assemblyPoint: Region;
  readonly evacuationRouteRequest: (from: Vec3) => RouteRequest;
  readonly returnRouteRequest: (from: Vec3) => RouteRequest;
}

export const MAIN_FIRE = deepFreeze({ radiusM: 0.15, initialHeatReleaseKW: 10, fuelMJ: 20 });
export const OCCUPANT_KEY = "occupant-1";
export const EVACUATION_ROUTE_ID = "route-evacuation";
export const RETURN_ROUTE_ID = "route-return";
/** Planning speeds for route durations: between the occupant model's 1.0 m/s clear and 0.6 m/s smoky walk; a cautious indoor flight. */
export const EVACUATION_SPEED_MPS = 0.8;
export const RETURN_SPEED_MPS = 1.0;
export const BUDGET_TICKS: Tick = ticksFromSeconds(10 * 60);
export const ENVELOPE_DURATION_TICKS: Tick = ticksFromSeconds(12 * 60);
export const ENVELOPE_MAX_SPEED_MPS = 2;
export const ENVELOPE_CEILING_M = 8;
export const DEFAULT_REPORT = "Someone may be in the upstairs rear bedroom.";
/**
 * The kitchen_grease_fire variant: a pan of oil burning on the kitchen's east counter (Troy: room-g-kitchen, top
 * at 0.92 m, 0.3 m in from the wall), and the caller's words for it after main's report. The origin must lie in a
 * scene room whose name shows a kitchen.
 */
export const GREASE_FIRE = deepFreeze({
  origin: { x: 25.9, y: 1.0, z: 0.92 },
  report: `${DEFAULT_REPORT} A pan of oil caught fire on the stove in the kitchen.`,
});
/** The exit the evacuation uses when the scene has it (Troy: the front door); otherwise the scene's first exit. */
export const PREFERRED_EXIT_OPENING = "door-front";
/** The door the blocked_exit variant jams. */
export const BLOCKED_EXIT_OPENING = "door-front";
/** The open interior door the wrong_prior variant draws closed (the occupant's room door in the Troy scene). */
export const WRONG_PRIOR_OPENING = "door-u-rear-bedroom";
const LAUNCH_ZONE_HALF_WIDTH_M = 1.5;

export function scenarioIdOf(sceneId: string, variant: PresetVariant): string {
  return `${sceneId}/${variant}`;
}

/** The variant named by a scenario id such as "troy-training/main", or null. */
export function variantOfScenarioId(scenarioId: string): PresetVariant | null {
  const variant = scenarioId.slice(scenarioId.lastIndexOf("/") + 1);
  return PRESET_VARIANTS.find(v => v === variant) ?? null;
}

export function loadPreset(meta: SceneMetaJson, variant: PresetVariant, seed: string, runId: RunId): MissionPreset {
  if (!PRESET_VARIANTS.includes(variant)) throw new RangeError(`Unknown preset variant ${String(variant)}`);
  if (!seed || !runId) throw new RangeError("A preset needs a non-empty seed and run id");
  const scene = sceneModelFromMeta(meta);
  const profile = TENDER_T1;
  const scenario: ScenarioConfig = deepFreeze({
    scenarioId: scenarioIdOf(meta.sceneId, variant),
    seed,
    runId,
    profile,
    fire: variant === "no_fire" ? null : variant === "kitchen_grease_fire" ? greaseFire(scene) : mainFire(scene),
    occupants: [{ key: OCCUPANT_KEY, start: scene.anchors.occupantStart, mobility: variant === "immobile_occupant" ? "immobile" : "mobile" }],
    openingOverrides: openingOverridesFor(variant),
  });
  const prior = variant === "wrong_prior"
    ? floorPlanPriorFromScene(meta, { corruption: { openingStates: { [WRONG_PRIOR_OPENING]: "closed" } } })
    : floorPlanPriorFromScene(meta);
  const exitId = evacuationExitId(meta);
  const assemblyCentre = representativePoint(scene.assemblyPoint);
  const launch = scene.launchPoint.position;
  return Object.freeze({
    variant,
    scene,
    scenario,
    prior,
    envelope: (envelopeRunId: RunId, approvedBy: string, tick: Tick) => missionEnvelope(scene, envelopeRunId, approvedBy, tick, ENVELOPE_DURATION_TICKS - skippedTicks(variant)),
    launchZone: launchZoneAround(launch),
    budgetTick: BUDGET_TICKS - skippedTicks(variant),
    defaultReport: variant === "kitchen_grease_fire" ? GREASE_FIRE.report : DEFAULT_REPORT,
    assemblyPoint: scene.assemblyPoint,
    evacuationRouteRequest: (from: Vec3): RouteRequest => deepFreeze({
      id: EVACUATION_ROUTE_ID, purpose: "evacuation", from, destination: { kind: "exit", exitId, then: assemblyCentre }, traveler: "occupant", speedMps: EVACUATION_SPEED_MPS,
    }),
    returnRouteRequest: (from: Vec3): RouteRequest => deepFreeze({
      id: RETURN_ROUTE_ID, purpose: "return", from, destination: { kind: "point", point: launch }, traveler: "drone", speedMps: RETURN_SPEED_MPS,
    }),
  });
}

/** The initial world for a preset (tick 0, before any step); staged variants are staged as documented above. */
export function createPresetWorld(preset: MissionPreset): WorldState {
  const world = createWorld(preset.scene, preset.scenario);
  if (isStagedVariant(preset.variant)) stageWorld(world, preset.variant);
  return world;
}

/** Simulated ticks of the main mission a variant skips (0 except for the staged test tools). */
export function skippedTicks(variant: PresetVariant): Tick {
  return isStagedVariant(variant) ? ticksFromSeconds(STAGED.elapsedS) : 0;
}

/**
 * Steps only the fire and occupant models for STAGED.elapsedS (breaking STAGED.brokenWindowId on the way),
 * then places the aircraft and returns the clock to tick 0. Truth events of the skipped time are dropped:
 * none is an aircraft action, and the evaluator scores only the run itself.
 */
function stageWorld(world: WorldState, variant: StagedVariant): void {
  const total = ticksFromSeconds(STAGED.elapsedS);
  const breakAt = ticksFromSeconds(STAGED.brokenAtS);
  for (let tick = 0; tick < total; tick++) {
    world.tick = tick;
    if (tick === breakAt) breakForStaging(world, STAGED.brokenWindowId);
    stepOccupants(world, TICK_S);
    if ((tick + 1) % FIRE_PERIOD_TICKS === 0) stepFire(world, FIRE_PERIOD_TICKS * TICK_S);
  }
  if (variant === "staged_post_suppression") {
    for (const fire of world.fires) deliverWater(world, fire.region, STAGED.waterL, total);
    world.drone.waterRemainingL = Math.max(0, world.drone.waterRemainingL - STAGED.waterL);
  }
  const p = STAGED.dronePosition;
  world.drone.position = vec3(p.x, p.y, p.z);
  world.drone.yawRad = STAGED.droneYawRad;
  world.drone.enduranceRemainingS -= STAGED.elapsedS;
  world.tick = 0;
  world.truthEvents.length = 0;
}

/** The glass breaker's effect on the opening (actuators.ts breakWindow) without a strike: state, open area, panes. */
function breakForStaging(world: WorldState, openingId: string): void {
  const opening = findOpening(world.scene, openingId);
  const truth = world.openings.find(o => o.id === openingId);
  if (!opening || !truth || opening.kind !== "window") throw new RangeError(`Staging: ${openingId} is not a window of the scene`);
  truth.state = "broken";
  truth.openAreaM2 = clearOpeningAreaM2(opening);
  for (const collider of world.scene.colliders) if (collider.kind === "glass" && collider.openingId === openingId) world.activeColliderIds.delete(collider.id);
}

function openingOverridesFor(variant: PresetVariant): ScenarioConfig["openingOverrides"] {
  return variant === "blocked_exit" ? { [BLOCKED_EXIT_OPENING]: "blocked" } : {};
}

function mainFire(scene: SceneModel): NonNullable<ScenarioConfig["fire"]> {
  const origin = scene.anchors.fireOrigin;
  const room = roomAt(scene, origin, 0.05);
  if (!room) throw new RangeError(`The fire anchor (${origin.x}, ${origin.y}, ${origin.z}) is not inside a scene room`);
  return { roomId: room.id, origin, ...MAIN_FIRE };
}

function greaseFire(scene: SceneModel): NonNullable<ScenarioConfig["fire"]> {
  const origin = vec3(GREASE_FIRE.origin.x, GREASE_FIRE.origin.y, GREASE_FIRE.origin.z);
  const room = roomAt(scene, origin, 0.05);
  if (!room || !/\bkitchen\b/i.test(room.name)) throw new RangeError(`The kitchen_grease_fire origin (${origin.x}, ${origin.y}, ${origin.z}) is not in a kitchen of scene ${scene.meta.sceneId}`);
  return { roomId: room.id, origin, ...MAIN_FIRE };
}

function evacuationExitId(meta: SceneMetaJson): string {
  const exit = meta.exits.find(e => e.openingId === PREFERRED_EXIT_OPENING) ?? meta.exits[0];
  if (!exit) throw new RangeError(`Scene ${meta.sceneId} has no exit for the evacuation route`);
  return exit.id;
}

/** The site bounds up to ENVELOPE_CEILING_M, 2 m/s, the aircraft's ambient limit and a time box (12 minutes for every rescue variant). */
function missionEnvelope(scene: SceneModel, runId: RunId, approvedBy: string, tick: Tick, durationTicks: Tick): MissionEnvelope {
  const { min, max } = scene.bounds;
  const envelope: MissionEnvelope = deepFreeze({
    runId,
    revision: 1,
    approvedBy,
    approvedTick: tick,
    regions: [box(min, vec3(max.x, max.y, Math.max(min.z, Math.min(max.z, ENVELOPE_CEILING_M))))],
    maxSpeedMps: ENVELOPE_MAX_SPEED_MPS,
    ambientCeilingC: TENDER_T1.hardLimits.maxAmbientC,
    endTick: tick + durationTicks,
  });
  const violations = hardLimitViolations(envelope, TENDER_T1, tick);
  if (violations.length > 0) throw new Error(`Preset envelope exceeds the aircraft's hard limits: ${violations.join(" ")}`);
  return envelope;
}

function launchZoneAround(launch: Vec3): Region {
  const half = LAUNCH_ZONE_HALF_WIDTH_M;
  return box(add(launch, vec3(-half, -half, -0.25)), add(launch, vec3(half, half, 2)));
}
