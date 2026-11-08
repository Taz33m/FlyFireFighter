import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ActuatorCommand } from "../contracts/actions.ts";
import type { MissionEnvelope } from "../contracts/envelope.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { distance, norm, rotateWorldToBody, scale, sub, vec3 } from "../contracts/frames.ts";
import { box, sphere } from "../contracts/geometry.ts";
import { isCompletedRescue, rescueLabel } from "../contracts/outcomes.ts";
import { issueBatch } from "../harness/issued.ts";
import { fixtureScenario } from "../simulation/fixture-scene.ts";
import { createWorld, stepWorld } from "../simulation/world.ts";
import { FIXTURE_SCENE, guarded } from "../simulation/world-fixtures.ts";
import type { WorldState } from "../simulation/world-state.ts";
import { evaluateMission } from "./evaluate.ts";
import { createMissionTrace, recordTick } from "./trace.ts";

const ENVELOPE: MissionEnvelope = {
  runId: "run-fixture-1", revision: 1, approvedBy: "commander", approvedTick: 0,
  regions: [box(vec3(-5, -16, -0.5), vec3(15, 12, 7))], maxSpeedMps: 2, ambientCeilingC: 80, endTick: 60000,
};
/**
 * Strike point near the pane's west edge (the pane spans x 6.5–7.5): struck at its centre, the debris fan
 * would pass within 0.25 m of the sheltering occupant's body at (8.3, 6.9), which the evaluator scores.
 */
const PANE = vec3(6.7, 7.905, 4.4);
const STANDOFF = vec3(5.3, 5.5, 3.9);
const FIRE_AIM = vec3(3.2, 5.5, 3.0);
/** Guidance station clear of the occupant's walk to the bedroom door; holding at STANDOFF, they would walk through the aircraft. */
const GUIDE_STATION = vec3(5.3, 4.0, 3.9);

/** Test stand-in for the harness and a position controller: P-control toward `goal`, issued as a harness batch. */
function tick(world: WorldState, trace: ReturnType<typeof createMissionTrace>, goal: Vec3 | null, commands: readonly ActuatorCommand[] = []): void {
  let velocity = vec3(0, 0, 0);
  if (goal) {
    const error = sub(goal, world.drone.position);
    const speed = Math.min(0.8, norm(error) * 1.5);
    velocity = norm(error) > 1e-6 ? scale(error, speed / norm(error)) : velocity;
  }
  stepWorld(world, issueBatch({ runId: world.runId, tick: world.tick, motion: guarded(rotateWorldToBody(world.drone.yawRad, velocity)), commands }));
  recordTick(trace, world, ENVELOPE);
}

describe("scripted rescue on the fixture house", () => {
  test("breach, enter, suppress through the doorway, guide: the evaluator verifies exterior arrival with no violations", () => {
    const world = createWorld(FIXTURE_SCENE, fixtureScenario());
    const trace = createMissionTrace(world);
    world.drone.position = vec3(PANE.x, 8.35, 4.4);
    world.drone.yawRad = -Math.PI / 2;

    tick(world, trace, null, [{ kind: "strike", proposalId: "p-breach", openingId: "win-rear-bedroom", point: PANE }]);
    assert.equal(world.openings.find(o => o.id === "win-rear-bedroom")?.state, "broken");
    for (let i = 0; i < 700; i++) tick(world, trace, i < 100 ? vec3(7.0, 8.35, 4.4) : i < 400 ? vec3(7.0, 6.2, 4.3) : STANDOFF);
    assert.ok(distance(world.drone.position, STANDOFF) < 0.1, "inside the bedroom at the spray standoff");

    const spray: ActuatorCommand = { kind: "water", proposalId: "p-spray", flowLps: 0.2, volumeL: 0.002, aimPoint: FIRE_AIM };
    for (let i = 0; i < 500 && !world.fires[0].extinguished; i++) tick(world, trace, STANDOFF, [spray]);
    assert.equal(world.fires[0].extinguished, true, `fire still at ${world.fires[0].heatReleaseKW.toFixed(1)} kW`);
    assert.ok(world.drone.waterRemainingL > 0, "suppressed within the 1 L tank");

    for (let i = 0; i < 300; i++) tick(world, trace, GUIDE_STATION);
    const light: ActuatorCommand = { kind: "light_cue", proposalId: "p-guide", target: vec3(4.6, 5.5, 3.9) };
    for (let i = 0; i < 5000 && world.occupants[0].activity !== "arrived"; i++) tick(world, trace, GUIDE_STATION, [light]);

    const result = evaluateMission(world, ENVELOPE, 9000, sphere(FIXTURE_SCENE.launchPoint.position, 1), { trace });
    assert.deepEqual(result.violations, []);
    assert.equal(result.occupants[0].outcome, "reached_assembly_point");
    assert.equal(rescueLabel(result), "simulated_evacuation_completed");
    assert.ok(isCompletedRescue(result));
    assert.equal(result.droneReturn, "not_returned", "drone return is scored separately");
  });
});
