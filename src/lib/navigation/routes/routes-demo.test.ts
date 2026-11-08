/**
 * The demo setting policy.routeSupportRelaxed (support.ts): after a spray, the occupant's route is supported as
 * soon as the fire beside it is seen out, using rooms and doors seen before the spray, and cites only observations
 * captured after it (so H15 accepts it). Without the setting the same evidence leaves the route unknown until a
 * fresh sweep. Scope: the route assessor on the authored route fixtures (test-fixtures.ts).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assessRoute } from "./index.ts";
import type { RouteAssessorInput } from "./index.ts";
import { allOpeningsSeen, evacuation, fireSeen, input, NOW, roomsSeenAt, STAIR_TOP_FIRE } from "./test-fixtures.ts";

const INTERVENTION = NOW - 1000;

function relaxed(base: RouteAssessorInput, on: boolean): RouteAssessorInput {
  return { ...base, policy: { ...base.policy, routeSupportRelaxed: on } };
}

describe("route support, demo setting", () => {
  const rooms = roomsSeenAt(INTERVENTION - 100);
  const before = { observations: rooms.observations, coverage: rooms.coverage, openings: allOpeningsSeen(INTERVENTION - 100) };
  const flame = fireSeen("fire-before", INTERVENTION - 200);
  const out = fireSeen("fire-out", INTERVENTION + 50, STAIR_TOP_FIRE, 0.3, 0);

  test("rooms and doors seen before the spray count once the fire is seen out after it; only post-spray frames are cited", () => {
    const scene = { ...before, fires: [flame, out] };
    const supported = assessRoute(relaxed(input(scene, INTERVENTION), true), evacuation());
    assert.equal(supported.status, "supported", supported.reason);
    assert.deepEqual(supported.evidenceIds, ["fire-out"], "only the post-spray look is cited (H15 requires that)");
    const strict = assessRoute(relaxed(input(scene, INTERVENTION), false), evacuation());
    assert.equal(strict.status, "unknown", "the full rule still wants a fresh sweep");
  });

  test("the fire is judged as before: no post-spray look at it, no support", () => {
    const noLook = assessRoute(relaxed(input({ ...before, fires: [flame] }, INTERVENTION), true), evacuation());
    assert.equal(noLook.status, "unknown");
    assert.match(noLook.reason, /needs a fresh look after the intervention/);
    const stillBurning = assessRoute(relaxed(input({ ...before, fires: [fireSeen("fire-after", INTERVENTION + 50)] }, INTERVENTION), true), evacuation());
    assert.equal(stillBurning.status, "unsupported", "a flame seen after the spray still blocks the route");
  });
});
