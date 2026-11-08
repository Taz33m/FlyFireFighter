import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SCOUT_S1, TENDER_T1 } from "../contracts/aircraft.ts";
import { distance, vec3 } from "../contracts/frames.ts";
import { fixtureWorld } from "./environment-fixtures.ts";
import { addSmoke, temperatureAt } from "./fire.ts";
import { aircraftStatus, degradeLocalization, estimatedPose, landingSupport, LOCALIZATION_MODEL, updateEstimator } from "./localization.ts";
import type { WorldState } from "./world-state.ts";

function advance(world: WorldState, ticks: number): number[] {
  const sigmas: number[] = [];
  for (let i = 0; i < ticks; i++) {
    world.tick += 1;
    updateEstimator(world);
    sigmas.push(world.estimator.sigmaM);
  }
  return sigmas;
}

describe("localization error model", () => {
  test("σ stays at its floor with good range and visual features", () => {
    const world = fixtureWorld({ drone: { position: vec3(2, 2, 1.2), velocity: vec3(0.5, 0, 0) } });
    advance(world, 2000);
    assert.ok(world.estimator.sigmaM <= LOCALIZATION_MODEL.sigmaMinM + 0.01, `σ ${world.estimator.sigmaM}`);
    assert.equal(estimatedPose(world).supported, true);
  });

  test("σ grows in dense smoke until movement is unsupported, and recovers when features return", () => {
    const world = fixtureWorld({ drone: { position: vec3(2, 2, 1.2), velocity: vec3(0.5, 0, 0) } });
    addSmoke(world, "room-a", 6);
    const sigmas = advance(world, 2500);
    assert.ok(sigmas.every((s, i) => i === 0 || s >= sigmas[i - 1] - 1e-12), "σ never shrinks without features");
    assert.ok(world.estimator.featureQuality < 0.05, `feature quality ${world.estimator.featureQuality}`);
    assert.equal(estimatedPose(world).supported, false, `σ ${world.estimator.sigmaM}`);

    addSmoke(world, "room-a", -6);
    advance(world, 600);
    assert.ok(world.estimator.sigmaM < 0.15, `σ after recovery ${world.estimator.sigmaM}`);
    assert.equal(estimatedPose(world).supported, true);
  });

  test("moderate smoke near walls keeps the estimate supported (lidar still returns)", () => {
    const world = fixtureWorld({ drone: { position: vec3(2, 2, 1.2), velocity: vec3(0.5, 0, 0) } });
    addSmoke(world, "room-a", 1);
    advance(world, 2000);
    assert.ok(world.estimator.featureQuality > 0.5);
    assert.ok(world.estimator.sigmaM < 0.2, `σ ${world.estimator.sigmaM}`);
  });

  test("supported flips exactly at the documented threshold, the harness's default 0.75 m advance limit", () => {
    assert.equal(LOCALIZATION_MODEL.supportSigmaM, 0.75);
    const world = fixtureWorld();
    world.estimator.sigmaM = LOCALIZATION_MODEL.supportSigmaM;
    assert.equal(estimatedPose(world).supported, true);
    world.estimator.sigmaM = LOCALIZATION_MODEL.supportSigmaM + 1e-9;
    assert.equal(estimatedPose(world).supported, false);
    world.estimator.sigmaM = Number.NaN;
    assert.equal(estimatedPose(world).supported, false);
  });

  test("the estimated pose is truth plus the modelled error, never truth alone", () => {
    const world = fixtureWorld({ drone: { position: vec3(2, 2, 1.2), yawRad: 0.3 } });
    const clean = estimatedPose(world);
    assert.notDeepEqual(clean.position, world.drone.position, "white jitter is always present");
    world.estimator.driftM = vec3(0.4, -0.3, 0.05);
    world.estimator.yawDriftRad = 0.1;
    const pose = estimatedPose(world);
    const expected = vec3(2.4, 1.7, 1.25);
    assert.ok(distance(pose.position, expected) < 4 * LOCALIZATION_MODEL.jitterM, `estimate ${JSON.stringify(pose.position)}`);
    assert.ok(Math.abs(pose.yawRad - 0.4) < 1e-12);
    assert.equal(pose.tick, world.tick);
  });

  test("degradeLocalization inflates σ and displaces the estimate; invalid input is rejected", () => {
    const world = fixtureWorld();
    degradeLocalization(world, 0.5);
    assert.ok(Math.abs(world.estimator.sigmaM - (LOCALIZATION_MODEL.sigmaMinM + 0.5)) < 1e-12);
    assert.ok(Math.hypot(world.estimator.driftM.x, world.estimator.driftM.y) > 0);
    assert.throws(() => degradeLocalization(world, -0.1), RangeError);
  });

  test("identical worlds produce identical estimator histories", () => {
    const a = fixtureWorld({ drone: { position: vec3(2, 2, 1.2), velocity: vec3(0.5, 0, 0) } });
    const b = fixtureWorld({ drone: { position: vec3(2, 2, 1.2), velocity: vec3(0.5, 0, 0) } });
    for (const world of [a, b]) addSmoke(world, "room-a", 4);
    advance(a, 700);
    advance(b, 700);
    assert.deepEqual(a.estimator, b.estimator);
  });
});

describe("landing support and onboard status", () => {
  test("a flat floor within downward ultrasound range supports landing at the estimated site", () => {
    const world = fixtureWorld({ tick: 12, drone: { position: vec3(2, 2.8, 1.2) } });
    const support = landingSupport(world);
    assert.equal(support.supported, true, support.reason);
    assert.ok(support.site !== null && Math.abs(support.site.z) < 0.1, `site ${JSON.stringify(support.site)}`);
    assert.deepEqual(support.evidenceIds, ["run-fixture/ultrasound-down/5"], "latest capture whose 3-tick latency has elapsed");
  });

  test("landing needs an arrived downward return", () => {
    assert.equal(landingSupport(fixtureWorld({ tick: 2 })).supported, false, "nothing has arrived before the latency elapses");
    const high = fixtureWorld({ tick: 50, drone: { position: vec3(-5, 2, 6) } });
    const support = landingSupport(high);
    assert.equal(support.supported, false);
    assert.match(support.reason, /no confident echo/);
    const blind = fixtureWorld({ tick: 50, profile: { ...TENDER_T1, sensors: TENDER_T1.sensors.filter(s => s.id !== "ultrasound-down") } });
    assert.equal(landingSupport(blind).supported, false);
  });

  test("an uneven surface (table edge above the floor) does not support landing", () => {
    // The beam centre passes just beside the table top (x ≥ 2.4) to the floor; the +x ray lands on the top.
    const world = fixtureWorld({ tick: 50, drone: { position: vec3(2.35, 1.0, 1.5) } });
    const support = landingSupport(world);
    assert.equal(support.supported, false);
    assert.match(support.reason, /not flat/);
  });

  test("aircraft status reports the onboard instruments", () => {
    const tender = fixtureWorld({ drone: { position: vec3(2, 2, 1.2) } });
    tender.drone.enduranceRemainingS = 321.9;
    const status = aircraftStatus(tender);
    assert.equal(status.enduranceRemainingS, 321);
    assert.equal(status.waterRemainingL, TENDER_T1.modules.water?.tankL);
    assert.equal(status.thrustAvailableN, TENDER_T1.hardLimits.maxThrustN);
    assert.ok(status.ambientC !== null && Math.abs(status.ambientC - temperatureAt(tender, tender.drone.position)) < 2);
    assert.equal(aircraftStatus(fixtureWorld({ profile: SCOUT_S1 })).waterRemainingL, null);
  });
});
