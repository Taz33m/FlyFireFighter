import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FIXTURE_PRIOR, FIXTURE_RUN, fixtureStore, observation, person, report, snapshotInput } from "./fixtures.ts";
import { interpretReport } from "./interpret.ts";
import { occupancySummary } from "./summary.ts";

const t = (n: number) => `${FIXTURE_RUN}/t${n}`;

/** Every key in a nested value, so a summary cannot hide a derived count anywhere. */
function keysOf(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...keysOf(child)]);
}

describe("evidence-based occupancy accounting", () => {
  test("review acceptance: one person seen twice, a revised count and a crew location", () => {
    const store = fixtureStore();
    const first = "Two people might be upstairs, I think in the back bedroom";
    store.addReport(report({ id: "r1", receivedTick: 10, text: first, ...interpretReport(first, FIXTURE_PRIOR) }));
    store.ingestObservation(observation({ id: "thermal-1", captureTick: 1000, detections: [person(2, 6, 3.6, { uncertaintyM: 0.5 })] }));
    store.ingestObservation(observation({ id: "thermal-2", captureTick: 1500, detections: [person(3.2, 6.4, 3.5, { uncertaintyM: 0.5 })] }));
    const revised = "Sorry, correction: it's just one person, my uncle, upstairs in the back bedroom";
    store.addReport(report({ id: "r2", receivedTick: 1600, text: revised, supersedes: "r1", ...interpretReport(revised, FIXTURE_PRIOR) }));
    store.addCrewConfirmation({ id: "c1", tick: 2000, crewId: "engine-2", trackId: t(1), reportIds: ["r2"], roomId: "f1-rear-bedroom", text: "Crew sees one person at the rear bedroom window." });

    const belief = store.snapshot(snapshotInput(2000));
    const summary = occupancySummary(belief);

    // Both reports are preserved in the reporters' words; the correction supersedes without deleting.
    assert.deepEqual(belief.reports.map(r => [r.id, r.originalText, r.roomHint, r.countText]), [
      ["r1", first, "f1-rear-bedroom", "Two people"],
      ["r2", revised, "f1-rear-bedroom", "just one person, my uncle"],
    ]);
    assert.deepEqual(summary.reports.map(r => [r.reportId, r.originalText, r.revises]), [["r2", revised, ["r1"]]]);
    assert.deepEqual(summary.latestCountText, { reportId: "r2", text: "just one person, my uncle", receivedTick: 1600 });

    // One candidate track where association is supported, still a possible occupant with its uncertainty.
    assert.equal(belief.tracks.length, 1);
    assert.deepEqual(summary.possibleTracks.map(track => [track.trackId, track.observationIds, track.uncertaintyM, track.ambiguousWith]), [
      [t(1), ["thermal-1", "thermal-2"], 0.5, []],
    ]);
    assert.equal(belief.tracks[0].status, "possible");

    // The crew location is linked to the track and the revised report; it resolves nothing.
    assert.deepEqual(summary.crewLocated.map(c => [c.id, c.trackId, c.reportIds, c.roomId]), [["c1", t(1), ["r2"], "f1-rear-bedroom"]]);

    // Who remains inside stays uncertain: no missing or remaining count, no total, no clear state.
    assert.equal(summary.occupancy, "unresolved");
    assert.deepEqual(Object.keys(summary).sort(), ["crewLocated", "evidenceRevision", "latestCountText", "occupancy", "possibleTracks", "reports", "roomsByCoverage", "runId", "tick"]);
    assert.ok(!keysOf(summary).some(key => /missing|remain|unaccounted|total|headcount|clear/i.test(key)), keysOf(summary).join(","));
  });

  test("ambiguous identities are listed among possible tracks only; corrected tracks drop out of the account", () => {
    const store = fixtureStore();
    store.ingestObservation(observation({ id: "o1", captureTick: 1000, detections: [person(1, 6, 3.9), person(4, 6, 3.9)] }));
    store.ingestObservation(observation({ id: "o2", captureTick: 1100, detections: [person(2.5, 6, 3.9)] }));
    assert.deepEqual(
      occupancySummary(store.snapshot(snapshotInput(1105))).possibleTracks.map(track => [track.trackId, track.ambiguousWith]),
      [[t(1), [t(3)]], [t(2), [t(3)]], [t(3), [t(1), t(2)]]],
    );

    store.retractTrack(t(2), "Crew: reflection of the fire on the window.", 1200);
    const belief = store.snapshot(snapshotInput(1200));
    const summary = occupancySummary(belief);
    assert.deepEqual(summary.possibleTracks.map(track => [track.trackId, track.ambiguousWith]), [[t(1), [t(3)]], [t(3), [t(1)]]]);
    assert.deepEqual(belief.tracks.find(track => track.id === t(3))?.ambiguousWith, [t(1), t(2)], "the raw track keeps its history");
    assert.equal(summary.occupancy, "unresolved");
  });
});
