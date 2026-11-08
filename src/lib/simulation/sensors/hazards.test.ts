/**
 * Fire recognition when a fire has gone out (hazards.ts): a camera that sees the place where it burned reports
 * a fire hazard of intensity 0 there, under the visibility test a flame would pass; a place it cannot see
 * yields no report. Regression (main E2E): only burning fires were reported, so after a spray put the fire out
 * nothing ever said so, and the last flame sighting kept another spray on offer and the route unsupported.
 * Fixture house (environment-fixtures.ts), not the Troy scene.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { vec3 } from "../../contracts/frames.ts";
import { regionContains } from "../../contracts/geometry.ts";
import type { Detection } from "../../contracts/observation.ts";
import { fixtureWorld } from "../environment-fixtures.ts";
import { addSmoke, deliverWater } from "../fire.ts";
import type { WorldState } from "../world-state.ts";
import { senseTick } from "./index.ts";

const FIRE_AT = vec3(3.3, 2.3, 0.3);
const world = (yawRad = 0) => fixtureWorld({ drone: { position: vec3(2, 2, 1.2), yawRad }, fire: { roomId: "room-a", origin: FIRE_AT, radiusM: 0.25, initialHeatReleaseKW: 40, fuelMJ: 60 } });

function fireSightings(w: WorldState, sensorId: string): Extract<Detection, { kind: "hazard" }>[] {
  const o = senseTick(w).observations.find(candidate => candidate.sensorId === sensorId);
  assert.ok(o, `${sensorId} fired`);
  return o.detections.flatMap(d => (d.kind === "hazard" && d.hazard === "fire" ? [d] : []));
}

/** Put the fire out the way a spray does: water reaching it through the fire model's suppression rule. */
function putOut(w: WorldState): void {
  deliverWater(w, w.fires[0].region, 1, w.tick);
  assert.equal(w.fires[0].extinguished, true);
}

describe("fire sightings after the fire is out", () => {
  for (const sensorId of ["rgb-front", "thermal-front"]) {
    test(`${sensorId}: the place where the fire burned is reported with intensity 0`, () => {
      const w = world();
      const burning = fireSightings(w, sensorId);
      assert.equal(burning.length, 1);
      assert.ok(burning[0].intensity > 0);
      putOut(w);
      const out = fireSightings(w, sensorId);
      assert.equal(out.length, 1, "the camera still sees the place");
      assert.equal(out[0].intensity, 0, "and no flame there");
      assert.ok(regionContains(out[0].region, FIRE_AT), "at the place where the fire burned");
    });
  }

  test("a place the camera cannot see yields no report at all, burning or out", () => {
    const away = world(Math.PI);
    putOut(away);
    assert.deepEqual(fireSightings(away, "rgb-front"), [], "out of view");
    const smoky = world();
    putOut(smoky);
    addSmoke(smoky, "room-a", 20);
    assert.deepEqual(fireSightings(smoky, "rgb-front"), [], "hidden by smoke: no sighting is not a no-flame report");
  });
});
