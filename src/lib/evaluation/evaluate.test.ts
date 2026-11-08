import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ActuatorCommand, GuardedMotion } from "../contracts/actions.ts";
import { TICK_S } from "../contracts/clock.ts";
import type { MissionEnvelope } from "../contracts/envelope.ts";
import { vec3 } from "../contracts/frames.ts";
import { box, regionContains, sphere } from "../contracts/geometry.ts";
import type { ConstraintViolation, MissionResult } from "../contracts/outcomes.ts";
import { isCompletedRescue, rescueLabel } from "../contracts/outcomes.ts";
import { issueBatch } from "../harness/issued.ts";
import { isTouchedDown } from "../simulation/collisions.ts";
import { applyExperiment } from "../simulation/experiments.ts";
import { fixtureScenario } from "../simulation/fixture-scene.ts";
import { createWorld, stepWorld } from "../simulation/world.ts";
import { FIXTURE_SCENE, guarded } from "../simulation/world-fixtures.ts";
import type { WorldState } from "../simulation/world-state.ts";
import { evaluateMission } from "./evaluate.ts";
import type { MissionTrace } from "./trace.ts";
import { createMissionTrace, recordTick } from "./trace.ts";

const LAUNCH_ZONE = sphere(FIXTURE_SCENE.launchPoint.position, 1.0);
const ENVELOPE: MissionEnvelope = {
  runId: "run-fixture-1", revision: 1, approvedBy: "commander", approvedTick: 0,
  regions: [box(vec3(-5, -16, -0.5), vec3(15, 12, 7))], maxSpeedMps: 3, ambientCeilingC: 80, endTick: 60000,
};

/** The fixture world with no fire and no scenario occupant. */
const quietWorld = (): WorldState => createWorld(FIXTURE_SCENE, fixtureScenario({ fire: null, occupants: [] }));

function step(world: WorldState, motion: GuardedMotion | null, commands: readonly ActuatorCommand[] = [], onTick?: () => void): void {
  stepWorld(world, issueBatch({ runId: world.runId, tick: world.tick, motion, commands }));
  onTick?.();
}

describe("independent mission evaluator", () => {
  test("water reaching an occupant is a violation, one per proposal and occupant, and blocks a completed rescue", () => {
    const world = quietWorld();
    world.drone.position = vec3(2.6, 2.5, 3.9);
    world.drone.yawRad = Math.PI / 2;
    applyExperiment(world, { kind: "add_occupant", key: "judge-1", position: vec3(2.6, 3.7, 2.9), mobility: "immobile" });
    for (let i = 0; i < 10; i++) step(world, null, [{ kind: "water", proposalId: "p-spray", flowLps: 0.2, volumeL: 0.2 * TICK_S, aimPoint: vec3(2.6, 4.85, 3.0) }]);
    const result = evaluateMission(world, ENVELOPE, 9000, LAUNCH_ZONE);
    const discharge = result.violations.filter(v => v.kind === "hazardous_discharge");
    assert.equal(discharge.length, 1);
    assert.match(discharge[0].detail, /judge-1/);
    assert.equal(result.label, "simulation_evaluator");
    assert.equal(isCompletedRescue(result), false);
  });

  test("arrival counts only with an arrival tick and a true position inside the assembly box", () => {
    const world = quietWorld();
    applyExperiment(world, { kind: "add_occupant", key: "walker", position: vec3(2.0, -9.5, 0), mobility: "mobile" });
    applyExperiment(world, { kind: "add_occupant", key: "placed", position: vec3(2.0, -12.5, 0), mobility: "immobile" });
    for (let i = 0; i < 300; i++) step(world, null);
    const walker = world.occupants.find(o => o.key === "walker")!;
    assert.ok(walker.arrivalTick !== null, "walked from outside the house into the box");
    let result = evaluateMission(world, ENVELOPE, 9000, LAUNCH_ZONE);
    assert.equal(result.occupants.find(o => o.occupantKey === "walker")?.outcome, "reached_assembly_point");
    assert.equal(result.occupants.find(o => o.occupantKey === "placed")?.outcome, "outside_not_at_assembly_point", "standing in the box without arriving is not an arrival");
    // This line used to expect "simulated_evacuation_completed": one arrival was enough even with "placed" not arrived.
    assert.equal(rescueLabel(result), "incomplete_human_assistance_needed", "every occupant must arrive for a completed evacuation");

    walker.position = vec3(2.0, -10.6, 0);
    result = evaluateMission(world, ENVELOPE, 9000, LAUNCH_ZONE);
    assert.deepEqual(result.occupants.find(o => o.occupantKey === "walker"), { label: "simulation_evaluator", occupantKey: "walker", outcome: "outside_not_at_assembly_point", arrivalTick: null });
    assert.equal(isCompletedRescue(result), false);
  });

  test("drone return is reported separately from the rescue outcome; 'returned' needs a recorded departure", () => {
    const world = quietWorld();
    applyExperiment(world, { kind: "add_occupant", key: "walker", position: vec3(2.0, -10.5, 0), mobility: "mobile" });
    const trace = createMissionTrace(world);
    for (let i = 0; i < 100; i++) step(world, null, [], () => recordTick(trace, world, ENVELOPE));
    assert.equal(evaluateMission(world, ENVELOPE, 9000, LAUNCH_ZONE, { trace }).droneReturn, "no_departure_recorded", "never left the launch zone");
    assert.equal(evaluateMission(world, ENVELOPE, 9000, LAUNCH_ZONE).droneReturn, "no_departure_recorded", "without a trace no departure is on record");
    for (let i = 0; i < 300; i++) step(world, guarded(vec3(i < 150 ? 1 : -1, 0, 0)), [], () => recordTick(trace, world, ENVELOPE));
    for (let i = 0; i < 100; i++) step(world, null, [], () => recordTick(trace, world, ENVELOPE));
    assert.ok(regionContains(LAUNCH_ZONE, world.drone.position), "back in the launch zone");
    assert.equal(evaluateMission(world, ENVELOPE, 9000, LAUNCH_ZONE, { trace }).droneReturn, "returned", "out about 1.5 m and back");

    world.drone.position = vec3(2, -6, 2.0);
    const away = evaluateMission(world, ENVELOPE, 9000, LAUNCH_ZONE);
    assert.equal(away.droneReturn, "not_returned");
    assert.equal(isCompletedRescue(away), true, "an unreturned aircraft does not undo a completed rescue");
    assert.equal(evaluateMission(world, ENVELOPE, 9000, LAUNCH_ZONE, { failureRecorded: true }).droneReturn, "failed_no_supported_maneuver");

    for (let i = 0; i < 600; i++) step(world, guarded(vec3(0, 0, -0.5)));
    assert.equal(evaluateMission(world, ENVELOPE, 9000, LAUNCH_ZONE).droneReturn, "landed_contingency");
  });

  test("collisions are violations; a trace reports each true-position envelope breach with its duration", () => {
    const world = quietWorld();
    const trace = createMissionTrace(world);
    world.drone.position = vec3(9.0, 2.0, 1.5);
    world.drone.yawRad = 0;
    for (let i = 0; i < 150; i++) step(world, guarded(vec3(1, 0, 0)), [], () => recordTick(trace, world, ENVELOPE));
    world.drone.position = vec3(14.5, -10, 3);
    for (let i = 0; i < 100; i++) step(world, guarded(vec3(1, 0, 0)), [], () => recordTick(trace, world, ENVELOPE));
    for (let i = 0; i < 200; i++) step(world, guarded(vec3(-1, 0, 0)), [], () => recordTick(trace, world, ENVELOPE));
    const result = evaluateMission(world, ENVELOPE, 9000, LAUNCH_ZONE, { trace });
    assert.equal(result.violations.filter(v => v.kind === "collision").length, 1);
    const breaches = result.violations.filter(v => v.kind === "envelope_breach");
    assert.equal(breaches.length, 1);
    assert.match(breaches[0].detail, /\d+ tick/);
    assert.ok(world.drone.position.x < 15, "back inside at the end");
    assert.equal(evaluateMission(world, ENVELOPE, 9000, LAUNCH_ZONE).violations.filter(v => v.kind === "envelope_breach").length, 0, "without a trace only the final position is checked");
  });

  test("given a truth record of a strike breaking a window other than the commanded one, it is an unauthorized actuation", () => {
    const world = quietWorld();
    world.truthEvents.push({ tick: 0, kind: "glass_broken", detail: "fixture", data: { openingId: "win-living-front", commandedOpeningId: "win-rear-bedroom", proposalId: "p" } });
    const result = evaluateMission(world, ENVELOPE, 9000, LAUNCH_ZONE);
    assert.equal(result.violations.filter(v => v.kind === "unauthorized_actuation").length, 1);
  });
});

/** Runs `ticks` steps of `motion`, recording each into the trace. */
function fly(world: WorldState, trace: MissionTrace, ticks: number, motion: GuardedMotion | null, envelope: MissionEnvelope = ENVELOPE, commands: readonly ActuatorCommand[] = []): void {
  for (let i = 0; i < ticks; i++) step(world, motion, i === 0 ? commands : [], () => recordTick(trace, world, envelope));
}

const kinds = (result: MissionResult, kind: ConstraintViolation["kind"]): ConstraintViolation[] => result.violations.filter(v => v.kind === kind);

describe("evaluator: occupants struck by the aircraft, debris or a payload", () => {
  test("the aircraft flying through a person is a collision, once per contact episode (the simulator lets them pass through)", () => {
    const world = quietWorld();
    applyExperiment(world, { kind: "add_occupant", key: "bystander", position: vec3(6.0, -4.0, 0), mobility: "immobile" });
    applyExperiment(world, { kind: "add_occupant", key: "beside", position: vec3(7.0, -4.0, 0), mobility: "immobile" });
    const trace = createMissionTrace(world);
    world.drone.position = vec3(6.0, -6.0, 1.2);
    world.drone.yawRad = Math.PI / 2;
    fly(world, trace, 400, guarded(vec3(1, 0, 0)));
    assert.ok(world.drone.position.y > -3.0 && world.drone.collisions === 0, "passed straight through with no scene collision");
    let strikes = kinds(evaluateMission(world, ENVELOPE, 9000, LAUNCH_ZONE, { trace }), "collision");
    assert.equal(strikes.length, 1, "one episode; the occupant 1 m to the side (gap 0.48 m) is not touched");
    assert.match(strikes[0].detail, /occupant bystander's body/);
    fly(world, trace, 400, guarded(vec3(-1, 0, 0)));
    strikes = kinds(evaluateMission(world, ENVELOPE, 9000, LAUNCH_ZONE, { trace }), "collision");
    assert.equal(strikes.length, 2, "flying back through is a second episode");
  });

  test("a contact flickering across the margin every other tick is one episode, not dozens", () => {
    const world = quietWorld();
    applyExperiment(world, { kind: "add_occupant", key: "p", position: vec3(6.0, -4.0, 0), mobility: "immobile" });
    const trace = createMissionTrace(world);
    world.drone.yawRad = Math.PI / 2;
    for (let i = 0; i < 100; i++) {
      // Alternately 0.035 m and 0.075 m from the body (gap = centre distance − 0.25 m capsule − 0.275 m sphere).
      world.drone.position = vec3(6.0 + (i % 2 === 0 ? 0.56 : 0.6), -4.0, 1.0);
      world.tick += 1;
      recordTick(trace, world, ENVELOPE);
    }
    assert.equal(trace.occupantContacts.length, 1, JSON.stringify(trace.occupantContacts.slice(0, 3)));
    assert.equal(kinds(evaluateMission(world, ENVELOPE, 9000, LAUNCH_ZONE, { trace }), "collision").length, 1);
  });

  test("contact follows the body's height by posture; without a trace only the final position is checked", () => {
    const overhead = (lying: boolean, z: number) => {
      const world = quietWorld();
      applyExperiment(world, { kind: "add_occupant", key: "p", position: vec3(6.0, -4.0, 0), mobility: "immobile" });
      if (lying) world.occupants[0].activity = "incapacitated";
      const trace = createMissionTrace(world);
      world.drone.position = vec3(6.0, -6.0, z);
      world.drone.yawRad = Math.PI / 2;
      fly(world, trace, 400, guarded(vec3(1, 0, 0)));
      return kinds(evaluateMission(world, ENVELOPE, 9000, LAUNCH_ZONE, { trace }), "collision").length;
    };
    assert.equal(overhead(false, 2.3), 0, "0.33 m above a standing person's head");
    assert.equal(overhead(false, 1.0), 1, "at a standing person's chest");
    assert.equal(overhead(true, 1.0), 0, "over a person lying on the ground (0.4 m body)");
    assert.equal(overhead(true, 0.6), 1, "low over a person lying on the ground");

    const world = quietWorld();
    applyExperiment(world, { kind: "add_occupant", key: "p", position: vec3(6.0, -4.0, 0), mobility: "immobile" });
    world.drone.position = vec3(6.3, -4.0, 1.0);
    assert.equal(kinds(evaluateMission(world, ENVELOPE, 9000, LAUNCH_ZONE), "collision").length, 1);
  });

  test("breaking a window with a person just behind it is hazardous; debris travels away from the striker", () => {
    const strikeFrom = (droneY: number) => {
      const world = quietWorld();
      applyExperiment(world, { kind: "add_occupant", key: "behind-glass", position: vec3(7.25, 0.45, 0), mobility: "immobile" });
      applyExperiment(world, { kind: "add_occupant", key: "across-room", position: vec3(7.25, 3.0, 0), mobility: "immobile" });
      applyExperiment(world, { kind: "add_occupant", key: "at-wall", position: vec3(8.2, -0.4, 0), mobility: "immobile" });
      applyExperiment(world, { kind: "add_occupant", key: "in-yard", position: vec3(7.25, -1.0, 0), mobility: "immobile" });
      world.drone.position = vec3(7.25, droneY, 1.5);
      world.drone.yawRad = droneY < 0.1 ? Math.PI / 2 : -Math.PI / 2;
      const trace = createMissionTrace(world);
      fly(world, trace, 150, null, ENVELOPE, [{ kind: "strike", proposalId: "p-breach", openingId: "win-living-front", point: vec3(7.25, 0.1, 1.5) }]);
      assert.equal(world.openings.find(o => o.id === "win-living-front")?.state, "broken");
      const hit = (r: MissionResult) => kinds(r, "hazardous_discharge").map(v => /occupant (\S+)\.$/.exec(v.detail)?.[1]).sort();
      return { traced: hit(evaluateMission(world, ENVELOPE, 9000, LAUNCH_ZONE, { trace })), finalOnly: hit(evaluateMission(world, ENVELOPE, 9000, LAUNCH_ZONE)) };
    };
    const outside = strikeFrom(-0.23);
    assert.deepEqual(outside.traced, ["at-wall", "behind-glass"], "inward cone and fall volume, plus the fall strip at the wall; not 2.9 m inside or 1.1 m out in the yard");
    assert.deepEqual(outside.finalOnly, ["at-wall", "behind-glass", "in-yard"], "without a trace the strike side is unknown: both sides' footprints, against the final positions");
    assert.deepEqual(strikeFrom(0.43).traced, ["behind-glass", "in-yard"], "struck from inside, the cone points out into the yard and the fall strip lies along the inside wall");
  });

  test("a released payload falling onto a person is hazardous; a person 2 m to the side is not", () => {
    const world = quietWorld();
    applyExperiment(world, { kind: "add_occupant", key: "below", position: vec3(2.2, -6.0, 0), mobility: "immobile" });
    applyExperiment(world, { kind: "add_occupant", key: "aside", position: vec3(4.0, -6.0, 0), mobility: "immobile" });
    world.drone.position = vec3(2.0, -6.0, 3.0);
    const trace = createMissionTrace(world);
    fly(world, trace, 150, null, ENVELOPE, [{ kind: "release", proposalId: "p-hood", payloadId: "smoke-hood-1", point: vec3(2.0, -6.0, 0) }]);
    const discharge = kinds(evaluateMission(world, ENVELOPE, 9000, LAUNCH_ZONE, { trace }), "hazardous_discharge");
    assert.equal(discharge.length, 1);
    assert.match(discharge[0].detail, /Payload smoke-hood-1 \(proposal p-hood.*onto occupant below\./);
  });

  test("debris settles: a person walking under the window after the fall time is not struck", () => {
    const world = quietWorld();
    const trace = createMissionTrace(world);
    world.drone.position = vec3(7.25, -0.23, 1.5);
    world.drone.yawRad = Math.PI / 2;
    fly(world, trace, 200, null, ENVELOPE, [{ kind: "strike", proposalId: "p-breach", openingId: "win-living-front", point: vec3(7.25, 0.1, 1.5) }]);
    applyExperiment(world, { kind: "add_occupant", key: "later", position: vec3(7.25, 0.45, 0), mobility: "immobile" });
    fly(world, trace, 10, null);
    assert.equal(kinds(evaluateMission(world, ENVELOPE, 9000, LAUNCH_ZONE, { trace }), "hazardous_discharge").length, 0);
  });
});

describe("evaluator: completion, envelope limits and drone return labels", () => {
  test("one occupant at the assembly point while another is still inside is not a completed evacuation", () => {
    const world = quietWorld();
    applyExperiment(world, { kind: "add_occupant", key: "walker", position: vec3(2.0, -9.5, 0), mobility: "mobile" });
    applyExperiment(world, { kind: "add_occupant", key: "upstairs", position: vec3(8.3, 6.9, 2.9), mobility: "immobile" });
    for (let i = 0; i < 300; i++) step(world, null);
    const result = evaluateMission(world, ENVELOPE, 9000, LAUNCH_ZONE);
    assert.deepEqual(result.occupants.map(o => o.outcome), ["reached_assembly_point", "inside"]);
    assert.deepEqual(result.violations, []);
    assert.equal(rescueLabel(result), "incomplete_human_assistance_needed");
  });

  const WIDE: MissionEnvelope = { ...ENVELOPE, regions: [box(vec3(-15, -25, -0.5), vec3(25, 20, 12))], maxSpeedMps: 1.0, ambientCeilingC: 40 };

  test("true speed above the envelope's ceiling and a descent above the vertical hard limit are scored", () => {
    const world = quietWorld();
    const trace = createMissionTrace(world);
    world.drone.position = vec3(-10, -20, 8);
    world.drone.yawRad = 0;
    fly(world, trace, 300, guarded(vec3(3.5, 0, 0)), WIDE);
    fly(world, trace, 150, guarded(vec3(0, 0, -3.0)), WIDE);
    const result = evaluateMission(world, WIDE, 9000, LAUNCH_ZONE, { trace });
    assert.deepEqual(kinds(result, "envelope_breach").map(v => v.detail), ["True horizontal speed reached 3.50 m/s; the approved envelope allows 1 m/s."]);
    assert.equal(kinds(result, "hard_limit").length, 1);
    assert.match(kinds(result, "hard_limit")[0].detail, /^True vertical speed reached 2\.\d\d m\/s; the limit is 1\.5 m\/s\.$/);

    const legal = quietWorld();
    const legalTrace = createMissionTrace(legal);
    legal.drone.position = vec3(-10, -20, 8);
    legal.drone.yawRad = 0;
    fly(legal, legalTrace, 300, guarded(vec3(1.0, 0, 0)), WIDE);
    fly(legal, legalTrace, 150, guarded(vec3(0, 0, -1.5)), WIDE);
    assert.deepEqual(evaluateMission(legal, WIDE, 9000, LAUNCH_ZONE, { trace: legalTrace }).violations, [], "at the ceilings exactly");
  });

  test("ambient above the envelope's ceiling is an envelope breach even below the aircraft's limit", () => {
    const world = createWorld(FIXTURE_SCENE, fixtureScenario({ occupants: [] }));
    const trace = createMissionTrace(world);
    world.drone.position = vec3(3.2, 4.3, 4.6);
    fly(world, trace, 600, null, { ...WIDE, ambientCeilingC: 30 });
    assert.ok(trace.maxAmbientC > 30 && trace.maxAmbientC <= world.profile.hardLimits.maxAmbientC, `ambient ${trace.maxAmbientC.toFixed(1)} °C`);
    const result = evaluateMission(world, { ...WIDE, ambientCeilingC: 30 }, 9000, LAUNCH_ZONE, { trace });
    assert.equal(kinds(result, "envelope_breach").filter(v => /envelope ceiling is 30 °C/.test(v.detail)).length, 1);
    assert.equal(kinds(result, "hard_limit").length, 0);
  });

  test("motion after the envelope time box is scored unless a contingency owns it; braking after it is allowed", () => {
    const BOXED: MissionEnvelope = { ...WIDE, maxSpeedMps: 2, endTick: 100 };
    const run = (contingencyAfterEnd: boolean, motionAfterEnd: GuardedMotion | null) => {
      const world = quietWorld();
      const trace = createMissionTrace(world);
      world.drone.position = vec3(-10, -20, 4);
      world.drone.yawRad = 0;
      for (let i = 0; i < 400; i++) {
        // As the harness gates it: commands issued after endTick end; the state recorded at T follows the command issued at T − 1.
        step(world, world.tick <= BOXED.endTick ? guarded(vec3(1, 0, 0)) : motionAfterEnd);
        recordTick(trace, world, BOXED, { contingencyActive: contingencyAfterEnd && world.tick > BOXED.endTick + 1 });
      }
      return kinds(evaluateMission(world, BOXED, 9000, LAUNCH_ZONE, { trace }), "envelope_breach").map(v => v.detail);
    };
    const flewOn = run(false, guarded(vec3(1, 0, 0)));
    assert.equal(flewOn.length, 1);
    assert.match(flewOn[0], /moved \(up to 1\.00 m\/s\) for 299 tick\(s\) after the envelope time box ended at tick 100/);
    assert.deepEqual(run(true, guarded(vec3(1, 0, 0))), [], "a contingency return after the time box");
    assert.deepEqual(run(false, null), [], "braking to a stop once the time box ends");
  });

  test("a forced descent after endurance runs out is labelled distinctly, not as a contingency landing", () => {
    const world = quietWorld();
    const trace = createMissionTrace(world);
    world.drone.position = vec3(2, -6, 1.0);
    world.drone.enduranceRemainingS = 0.05;
    fly(world, trace, 300, guarded(vec3(1, 0, 0)));
    assert.ok(isTouchedDown(world), "came down");
    const result = evaluateMission(world, ENVELOPE, 9000, LAUNCH_ZONE, { trace });
    assert.equal(result.droneReturn, "forced_descent");
    assert.deepEqual(kinds(result, "hard_limit").map(v => v.detail), ["Endurance exhausted."]);

    const grounded = quietWorld(); // resting on the launch pad
    const groundedTrace = createMissionTrace(grounded);
    grounded.drone.enduranceRemainingS = 0.05;
    fly(grounded, groundedTrace, 50, null);
    assert.equal(evaluateMission(grounded, ENVELOPE, 9000, LAUNCH_ZONE, { trace: groundedTrace }).droneReturn, "no_departure_recorded", "a battery drained on the ground is no descent");
  });
});
