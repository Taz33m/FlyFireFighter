import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ActuatorCommand } from "../contracts/actions.ts";
import { SCOUT_S1, TENDER_T1 } from "../contracts/aircraft.ts";
import { TICK_S } from "../contracts/clock.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { distance, dot, norm, normalize, sub, vec3, ZERO } from "../contracts/frames.ts";
import { sphere } from "../contracts/geometry.ts";
import { actuationNotes, applyActuatorCommands } from "./actuators.ts";
import { moveDrone } from "./collisions.ts";
import { jetReactionN } from "./dynamics.ts";
import { bareWorld, occupantAt } from "./world-fixtures.ts";
import type { WorldState } from "./world-state.ts";

const FIRE_ORIGIN = vec3(2.6, 4.85, 2.9);
const AIM = vec3(2.6, 4.85, 3.0);
const PER_TICK_L = 0.2 * TICK_S;
const water = (aimPoint: Vec3 = AIM, volumeL = PER_TICK_L): ActuatorCommand => ({ kind: "water", proposalId: "p-spray", flowLps: 0.2, volumeL, aimPoint });

/** Hovering in the upstairs hall 2.35 m south of the fire with a clear line to it. */
function hallWorldWithFire(): WorldState {
  const world = bareWorld({ position: vec3(2.6, 2.5, 3.9), yawRad: Math.PI / 2 });
  world.fires.push({ id: "fire-hall-up", roomId: "hall-up", region: sphere(FIRE_ORIGIN, 0.45), heatReleaseKW: 60, fuelMJ: 40, waterDeliveredL: 0, extinguished: false });
  return world;
}

const events = (world: WorldState, kind: string) => world.truthEvents.filter(e => e.kind === kind);

describe("water actuator", () => {
  test("an aligned estimate puts the jet on the fire, draws the tank down and pushes the aircraft back", () => {
    const world = hallWorldWithFire();
    const recoil = applyActuatorCommands(world, [water()]);
    const reached = events(world, "water_delivered")[0].data.reachedFireL as number;
    assert.ok(reached > 0.5 * PER_TICK_L, `reached ${reached}`);
    assert.ok(world.fires[0].waterDeliveredL > 0);
    assert.ok(Math.abs(world.drone.waterRemainingL - (TENDER_T1.modules.water!.tankL - PER_TICK_L)) < 1e-12);
    const jet = normalize(sub(AIM, world.drone.position));
    assert.ok(Math.abs(norm(recoil) - jetReactionN(0.2, 4)) < 1e-9);
    assert.ok(dot(recoil, jet) < -0.99 * norm(recoil), "reaction opposes the jet");
  });

  test("position drift in the estimate shifts the true jet off the fire: the same command misses", () => {
    const world = hallWorldWithFire();
    world.estimator.driftM = vec3(1.0, 0, 0);
    applyActuatorCommands(world, [water()]);
    assert.equal(events(world, "water_delivered")[0].data.reachedFireL, 0);
    assert.equal(world.fires[0].waterDeliveredL, 0);
    assert.ok(world.drone.waterRemainingL < TENDER_T1.modules.water!.tankL, "the water is spent anyway");
  });

  test("heading drift rotates the true jet away from the fire", () => {
    const world = hallWorldWithFire();
    world.estimator.yawDriftRad = 0.4;
    applyActuatorCommands(world, [water()]);
    assert.equal(world.fires[0].waterDeliveredL, 0);
    const axis = events(world, "water_delivered")[0].data.axis as unknown as Vec3;
    assert.ok(Math.abs(Math.atan2(axis.y, axis.x) - (Math.PI / 2 - 0.4)) < 0.02);
  });

  test("records water reaching an occupant in the jet, but not one behind a wall", () => {
    const inJet = hallWorldWithFire();
    inJet.occupants.push(occupantAt("o-hall", vec3(2.6, 3.7, 2.9)));
    applyActuatorCommands(inJet, [water()]);
    assert.equal(events(inJet, "water_on_occupant").length, 1);
    assert.equal(events(inJet, "water_on_occupant")[0].data.occupantKey, "o-hall");

    const walled = bareWorld({ position: vec3(3.0, 3.5, 3.9), yawRad: 0 });
    walled.occupants.push(occupantAt("o-bedroom", vec3(4.8, 3.5, 2.9)));
    applyActuatorCommands(walled, [water(vec3(5.5, 3.5, 3.6))]);
    assert.equal(events(walled, "water_on_occupant").length, 0);
    walled.activeColliderIds.delete("wall-u-3");
    applyActuatorCommands(walled, [water(vec3(5.5, 3.5, 3.6))]);
    assert.equal(events(walled, "water_on_occupant").length, 1, "the same occupant is in the jet once the wall is gone");
  });

  test("an empty tank or a missing module discharges nothing and produces no reaction", () => {
    const empty = hallWorldWithFire();
    empty.drone.waterRemainingL = 0;
    assert.deepEqual(applyActuatorCommands(empty, [water()]), ZERO);
    assert.equal(events(empty, "water_delivered").length, 0);
    assert.match(actuationNotes(empty)[0].reason, /empty/);
    const scout = bareWorld({ profile: SCOUT_S1, position: vec3(2.6, 2.5, 3.9) });
    assert.deepEqual(applyActuatorCommands(scout, [water()]), ZERO);
  });

  test("never discharges more than the module's maximum flow in one tick", () => {
    const world = hallWorldWithFire();
    applyActuatorCommands(world, [water(AIM, 0.5)]);
    assert.ok(Math.abs(TENDER_T1.modules.water!.tankL - world.drone.waterRemainingL - PER_TICK_L) < 1e-12);
  });
});

/** Hovering 0.4 m outside the rear bedroom window, facing it. */
const PANE_POINT = vec3(7.0, 7.905, 4.4);
const strike = (point: Vec3 = PANE_POINT): ActuatorCommand => ({ kind: "strike", proposalId: "p-breach", openingId: "win-rear-bedroom", point });
const outsideWindow = (y = 8.3): WorldState => bareWorld({ position: vec3(7.0, y, 4.4), yawRad: -Math.PI / 2 });
const windowTruth = (world: WorldState) => world.openings.find(o => o.id === "win-rear-bedroom")!;

describe("glass-breaker actuator", () => {
  test("a strike within reach on intact glass breaks the window for good and removes its pane", () => {
    const world = outsideWindow();
    applyActuatorCommands(world, [strike()]);
    assert.equal(windowTruth(world).state, "broken");
    assert.ok(Math.abs(windowTruth(world).openAreaM2 - 1.2) < 1e-12);
    assert.equal(world.activeColliderIds.has("glass-rear-bedroom"), false);
    assert.equal(events(world, "glass_broken").length, 1);

    applyActuatorCommands(world, [strike()]);
    assert.equal(windowTruth(world).state, "broken");
    assert.equal(events(world, "glass_broken").length, 1, "a second strike changes nothing");
    assert.match(actuationNotes(world)[0].reason, /No intact window glass/);
  });

  test("after the break the aircraft flies through the opening without a collision", () => {
    const world = outsideWindow(9.0);
    world.drone.position = vec3(7.0, 8.3, 4.4);
    applyActuatorCommands(world, [strike()]);
    world.drone.velocity = vec3(0, -1, 0);
    for (let i = 0; i < 150; i++) moveDrone(world, TICK_S);
    assert.ok(world.drone.position.y < 7.0);
    assert.equal(events(world, "collision").length, 0);
  });

  test("a strike out of reach, or one that drift moves off the pane, has no effect", () => {
    const far = outsideWindow(9.0);
    applyActuatorCommands(far, [strike()]);
    assert.equal(windowTruth(far).state, "closed");
    assert.equal(far.activeColliderIds.has("glass-rear-bedroom"), true);
    assert.match(actuationNotes(far)[0].reason, /reach/);

    const drifted = outsideWindow();
    drifted.estimator.driftM = vec3(0.6, 0, 0);
    applyActuatorCommands(drifted, [strike()]);
    assert.equal(windowTruth(drifted).state, "closed");
  });
});

describe("payload and cue actuators", () => {
  test("a release removes the payload once; it says nothing about receipt", () => {
    const world = bareWorld({ position: vec3(6, 5, 4) });
    const release: ActuatorCommand = { kind: "release", proposalId: "p-rel", payloadId: "smoke-hood-1", point: vec3(6, 5, 3) };
    applyActuatorCommands(world, [release]);
    assert.deepEqual(world.drone.payloads, []);
    applyActuatorCommands(world, [release]);
    assert.equal(events(world, "payload_released").length, 1);
    assert.match(actuationNotes(world)[0].reason, /not aboard/);
  });

  test("cues originate at the true aircraft position and the light lands where the drifted aim sends it", () => {
    const world = bareWorld({ position: vec3(6, 5, 4), yawRad: 0 });
    world.estimator.driftM = vec3(0.5, 0, 0);
    world.tick = 42;
    applyActuatorCommands(world, [{ kind: "light_cue", proposalId: "p-guide", target: vec3(5, 5, 3) }, { kind: "audio", proposalId: "p-guide", templateId: "follow-light" }]);
    assert.deepEqual(world.cues.light?.origin, vec3(6, 5, 4));
    assert.ok(distance(world.cues.light!.target, vec3(4.5, 5, 3)) < 1e-9);
    assert.equal(world.cues.audio?.templateId, "follow-light");
    assert.equal(world.cues.audio?.tick, 42);
  });
});
