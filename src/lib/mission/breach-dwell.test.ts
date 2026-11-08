/**
 * The look before a breach, closed loop: MissionRuntime on the Troy main preset (headless collider camera, optical-flow
 * baseline, local planner, scripted commander, the default report), run until the first breach is approved and struck. H6 judges a breach by how much of its debris region a person search covered in the
 * last 200 ticks (harness rules.ts breachCoverageAssessment), so the aircraft must keep its forward cameras on the pane
 * while it dwells. Scope: the controller settings the runtime selects for that dwell, the aircraft's heading relative
 * to the strike point at its end, and H6's own measure of the debris region's coverage from the runtime's belief. It
 * does not fly the breach itself (mission.e2e.test.ts does).
 *
 * Before the fix the dwell scan switched the controller back to its cruise settings: their 0.6 m forward and lateral
 * range clearances, about 0.6 m from the pane, braked and turned the aircraft away from the glass and vetoed the turn
 * back, so it ended the dwell 20–45° off the strike point with the debris region below H6's breach floor (live run
 * run-mw7rphk9-c970825f and troy-seed-1 at d06d7bd: 59–62% against 65%).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ActionSpec } from "../contracts/actions.ts";
import { TENDER_T1 } from "../contracts/aircraft.ts";
import type { MissionEnvelope } from "../contracts/envelope.ts";
import type { MissionEvent } from "../contracts/events.ts";
import type { BeliefSnapshot } from "../contracts/evidence.ts";
import { vec3 } from "../contracts/frames.ts";
import { box, sphere } from "../contracts/geometry.ts";
import { deepFreeze } from "../contracts/ids.ts";
import { affectedRegion } from "../harness/effects.ts";
import { DEFAULT_POLICY } from "../harness/policy.ts";
import { breachCoverageAssessment } from "../harness/rules.ts";
import { buildCandidateSet } from "../navigation/planner/candidates.ts";
import { observation } from "../navigation/planner/test-fixtures.ts";
import { floorPlanPriorFromScene } from "../simulation/prior.ts";
import { driveMission, troyMeta } from "./mission-driver.ts";
import { facingErrorRad, FACE_TOLERANCE_RAD } from "./planner-step.ts";

type BreachSpec = Extract<ActionSpec, { readonly kind: "breach_opening" }>;

interface AtApproval {
  readonly tick: number;
  readonly breach: BreachSpec;
  readonly facingRad: number | null;
  readonly fraction: number;
  readonly text: string;
}

/*
 * DEMO: the window phase no longer prepositions and dwells. The first move is a look that ends on the entry window's
 * breach standoff, the breach is proposed there after a short turn to face the pane, and the long striker (1.2 m) acts
 * from that station without docking. The test therefore checks the hold while the commander decides (a dwell scan,
 * which keeps the close-quarters settings) at the moment the scripted commander approves, and that the strike starts
 * at once. H6 itself is unchanged; its breach floor is the demo policy's (DEFAULT_POLICY.breachMinCoverageFraction).
 */
describe("the look before a breach (Troy main preset, headless)", () => {
  test("at the first breach approval the cameras are on the pane: close-quarters settings, facing the strike point, H6 coverage at the breach floor, and the strike starts at once", { timeout: 5 * 60_000 }, async () => {
    let at: AtApproval | null = null;
    const run = await driveMission({
      runId: "run-breach-dwell",
      seed: "demo-001",
      maxTicks: 9000,
      until: runtime => {
        const record = runtime.harness.records().find(r => r.proposal.action.kind === "breach_opening" && r.history.some(h => h.status === "approved"));
        if (record === undefined || record.proposal.action.kind !== "breach_opening") return false;
        if (at === null) {
          const tick = runtime.world.tick;
          const ctx = runtime.context(tick);
          const breach = record.proposal.action;
          const region = affectedRegion(breach, runtime.preset.scenario.profile, runtime.preset.prior);
          assert.ok(region);
          const assessment = breachCoverageAssessment(breach, region, ctx);
          at = { tick, breach, facingRad: facingErrorRad(ctx.belief.pose, breach.strikePoint), fraction: assessment.fraction, text: assessment.text };
        }
        return record.status === "completed" || record.status === "invalidated" || record.status === "aborted";
      },
    });
    run.runtime.close();
    assert.ok(at !== null, "a breach was approved");
    const approved = at as AtApproval;
    const modes = run.events.filter((e: MissionEvent) => (e.kind === "controller.docking" || e.kind === "controller.cruise") && e.tick <= approved.tick);
    const inForce = modes[modes.length - 1];
    assert.ok(inForce !== undefined && inForce.kind === "controller.docking", `controller settings at the approval of ${approved.breach.openingId}: ${inForce === undefined ? "none" : `${inForce.kind} — ${inForce.reason}`}`);
    assert.ok(approved.facingRad !== null && approved.facingRad <= FACE_TOLERANCE_RAD, `heading ${approved.facingRad === null ? "?" : Math.round((approved.facingRad * 180) / Math.PI)}° off the strike point of ${approved.breach.openingId} at t=${(approved.tick / 100).toFixed(2)} s`);
    assert.ok(approved.fraction >= DEFAULT_POLICY.breachMinCoverageFraction, `${approved.breach.openingId}: ${approved.text}`);
    const record = run.runtime.harness.records().find(r => r.proposal.action.kind === "breach_opening" && r.history.some(h => h.status === "approved"));
    assert.ok(record !== undefined && record.status === "completed", `the breach ${record?.status ?? "was not found"}`);
    const tickOf = (status: string) => record.history.find(h => h.status === status)?.tick ?? NaN;
    assert.ok(tickOf("executing") - tickOf("approved") <= 5, `the strike starts on approval (approved ${tickOf("approved")}, executing ${tickOf("executing")})`);
    assert.ok(tickOf("completed") - tickOf("approved") <= 100, "the glass breaks within about a second of approval");
  });
});

/*
 * Right after a strike. The plan made the tick a breach completes still has the struck pane's last "closed" sighting
 * (the frames that show it broken arrive a few ticks later). In a troy-seed-1 run (flow baseline) that plan offered
 * the same breach again and it waited for the commander until the scripted approval invalidated it.
 * Belief fixture: the Troy prior, every exterior window observed closed 2 ticks before T, the aircraft outside.
 */
describe("breach candidates after an intervention (Troy prior)", () => {
  const prior = floorPlanPriorFromScene(troyMeta().meta);
  const T = 18_320;
  const envelope: MissionEnvelope = deepFreeze({ runId: "run-troy", revision: 1, approvedBy: "commander-1", approvedTick: 0, regions: [box(vec3(-48, -34, -0.15), vec3(62, 58, 8))], maxSpeedMps: 2, ambientCeilingC: 80, endTick: 100_000 });
  const windows = prior.openings.filter(o => o.kind === "window" && o.rooms[1] === "exterior");
  const seenAt = T - 2;
  const belief: BeliefSnapshot = deepFreeze({
    runId: "run-troy",
    tick: T,
    evidenceRevision: 40,
    mapPrior: prior,
    mapRevision: 1,
    mapChanges: [],
    pose: { tick: T, position: vec3(18.2, -3.4, 5.1), yawRad: Math.PI / 2, velocity: vec3(0, 0, 0), sigmaM: 0.1, yawSigmaRad: 0.02, supported: true },
    aircraft: { enduranceRemainingS: 600, waterRemainingL: 1, payloadsOnboard: [], ambientC: 22, thrustAvailableN: 60 },
    landing: { supported: false, site: null, evidenceIds: [], reason: "No landing surface observed." },
    observations: windows.map(o => ({ ...observation(`obs-${o.id}`, seenAt, { modality: "rgb", personSearch: "oracle_fixture", footprint: sphere(vec3(18.2, -3.4, 5.1), 1), position: vec3(18.2, -3.4, 5.1), detections: [{ kind: "opening_state", openingId: o.id, state: "closed" }] }), runId: "run-troy" })),
    reports: [],
    tracks: [],
    crewConfirmations: [],
    coverage: prior.rooms.map(room => ({ roomId: room.id, state: "unobserved" as const, fractionAdequate: 0, fractionAny: 0, lastObservedTick: null, bestModality: null })),
    hazards: [],
    openings: windows.map(o => ({ openingId: o.id, state: "closed" as const, tick: seenAt, observationId: `obs-${o.id}` })),
    routes: [],
    dispatchConfirmed: null,
  });
  const breaches = (lastInterventionTick: number | null) => buildCandidateSet({ belief, profile: TENDER_T1, envelope, policy: DEFAULT_POLICY, lastInterventionTick }).candidates.filter(c => c.tool === "request_breach").map(c => c.id);

  test("a window last seen closed before the latest strike is not offered for a breach until it is seen again", () => {
    assert.ok(breaches(null).includes("request_breach:win-u-study-s1"), "offered with no intervention yet");
    assert.ok(breaches(seenAt - 1).includes("request_breach:win-u-study-s1"), "offered when seen closed after the latest intervention");
    assert.deepEqual(breaches(T - 1), [], "the strike completed after every window's latest sighting: no breach on that evidence");
  });
});
