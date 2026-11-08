/**
 * Lifecycle behaviour of the ActionHarness: binding, expiry, current-evidence revalidation, monitored
 * discharge, idempotency, reset, abort, envelope revisions, capability, guidance, speech and the actuation
 * path. Scope: deterministic fixtures (test-fixtures.ts) stepped tick by tick with no motion requests; the
 * motion guard and contingency selector are exercised only through the harness's calls into them.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ActuatorBatch, ActuatorCommand, Finding, ProposalBasis, ProposalRecord } from "../contracts/actions.ts";
import { SCOUT_S1, TENDER_T1 } from "../contracts/aircraft.ts";
import type { Tick } from "../contracts/clock.ts";
import { TICK_S } from "../contracts/clock.ts";
import type { MissionEnvelope } from "../contracts/envelope.ts";
import { EventLog } from "../contracts/events.ts";
import type { BeliefSnapshot } from "../contracts/evidence.ts";
import { vec3 } from "../contracts/frames.ts";
import { box } from "../contracts/geometry.ts";
import type { RunId } from "../contracts/ids.ts";
import { PERSON_DETECTION_CONFIDENCE } from "../contracts/observation.ts";
import { EVIDENCE_DEFAULTS } from "../evidence/config.ts";
import { contingencyProposalInput } from "./contingency.ts";
import type { SubmitResult } from "./harness.ts";
import { ActionHarness } from "./harness.ts";
import { isHarnessIssued } from "./issued.ts";
import type { HarnessContext } from "./policy.ts";
import { DEFAULT_POLICY } from "./policy.ts";
import {
  approveCommand,
  BASIS,
  breachBelief,
  breachInput,
  COMMANDER,
  contingencyHoldInput,
  ENVELOPE,
  EVAC_WAYPOINTS,
  evacuationRoute,
  executeCommand,
  guideInput,
  makeContext,
  moveInput,
  observation,
  occupantTrack,
  personObservation,
  proposalInput,
  returnRoute,
  routeObservation,
  RUN_ID,
  sprayBelief,
  sprayInput,
  T0,
} from "./test-fixtures.ts";

type ContextOverrides = Partial<Omit<HarnessContext, "belief" | "tick">>;

const PER_TICK_L = 0.2 * TICK_S;
const CONSEQUENTIAL_COMMANDS: ReadonlySet<string> = new Set(["water", "strike", "release"]);

function newHarness(runId: RunId = RUN_ID): { harness: ActionHarness; log: EventLog } {
  const log = new EventLog(runId);
  return { harness: new ActionHarness(runId, log), log };
}

function ids(result: SubmitResult): { id: string; digest: string } {
  if (result.proposalId === null || result.digest === null) throw new Error(`submission refused: ${JSON.stringify(result.findings)}`);
  return { id: result.proposalId, digest: result.digest };
}

function current(harness: ActionHarness, id: string): ProposalRecord {
  const record = harness.record(id);
  if (!record) throw new Error(`no record ${id}`);
  return record;
}

function steps(harness: ActionHarness, from: Tick, to: Tick, belief: (tick: Tick) => BeliefSnapshot, overrides: ContextOverrides = {}): ActuatorBatch[] {
  const batches: ActuatorBatch[] = [];
  for (let tick = from; tick <= to; tick++) batches.push(harness.step(makeContext(belief(tick), overrides), null));
  return batches;
}

function commandsOf(batches: readonly ActuatorBatch[], kind: ActuatorCommand["kind"]): ActuatorCommand[] {
  return batches.flatMap(b => b.commands).filter(c => c.kind === kind);
}

function water(batches: readonly ActuatorBatch[]): number {
  return batches.flatMap(b => b.commands).reduce((sum, c) => (c.kind === "water" ? sum + c.volumeL : sum), 0);
}

function ruleIds(findings: readonly Finding[]): string[] {
  return [...new Set(findings.map(f => f.ruleId))].sort();
}

function close(actual: number | undefined, expected: number, message?: string): void {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, message ?? `${actual} is not ${expected}`);
}

function abortMission(harness: ActionHarness, tick: Tick, runId: RunId = RUN_ID, belief: BeliefSnapshot = sprayBelief(tick)) {
  return harness.abort({ type: "abort", runId, scope: "mission", by: COMMANDER, tick, reason: "Commander abort." }, makeContext(belief));
}

/** Submit at T0 and approve at T0 + 5. */
function approvedSpray(harness: ActionHarness, input = sprayInput()): { id: string; digest: string } {
  const submitted = harness.submit(input, makeContext(sprayBelief(T0)));
  assert.equal(submitted.status, "awaiting_approval", JSON.stringify(submitted.findings));
  const proposal = ids(submitted);
  const approved = harness.approve(approveCommand(proposal.id, proposal.digest, T0 + 5), makeContext(sprayBelief(T0 + 5)));
  assert.equal(approved.status, "approved", approved.reason);
  return proposal;
}

/** Approved at T0 + 5 and executing from T0 + 10. */
function executingSpray(harness: ActionHarness, input = sprayInput()): { id: string; digest: string } {
  const proposal = approvedSpray(harness, input);
  const started = harness.requestExecution(executeCommand(proposal.id, proposal.digest, "req-1", T0 + 10), makeContext(sprayBelief(T0 + 10)));
  assert.equal(started.status, "executing", started.reason);
  return proposal;
}

function approvedBreach(harness: ActionHarness): { id: string; digest: string } {
  const submitted = harness.submit(breachInput(), makeContext(breachBelief(T0)));
  assert.equal(submitted.status, "awaiting_approval", JSON.stringify(submitted.findings));
  const proposal = ids(submitted);
  assert.equal(harness.approve(approveCommand(proposal.id, proposal.digest, T0 + 5), makeContext(breachBelief(T0 + 5))).status, "approved");
  return proposal;
}

describe("approval binding", () => {
  test("approving A does not authorize B that differs only in aircraft or target", () => {
    const { harness } = newHarness();
    const a = approvedSpray(harness);
    const target = ids(harness.submit(sprayInput({}, { aimPoint: vec3(7.2, 1, 3.4) }), makeContext(sprayBelief(T0 + 6))));
    assert.notEqual(target.digest, a.digest);
    assert.equal(current(harness, target.id).status, "awaiting_approval");
    const aircraft = harness.submit(sprayInput({ aircraftId: "tender-t2" }), makeContext(sprayBelief(T0 + 6)));
    assert.equal(aircraft.status, "rejected");
    assert.deepEqual(ruleIds(aircraft.findings), ["H0"]);

    const ctx = makeContext(sprayBelief(T0 + 10));
    const attempts = [
      executeCommand(target.id, a.digest, "b-with-a-digest", T0 + 10),
      executeCommand(target.id, target.digest, "b-own-digest", T0 + 10),
      executeCommand(ids(aircraft).id, a.digest, "c-with-a-digest", T0 + 10),
    ];
    for (const attempt of attempts) assert.equal(harness.requestExecution(attempt, ctx).accepted, false, attempt.requestId);
    assert.equal(current(harness, target.id).status, "awaiting_approval");
    assert.equal(water(steps(harness, T0 + 10, T0 + 20, t => sprayBelief(t))), 0);
    assert.equal(current(harness, a.id).status, "approved", "A's approval still governs only A");
  });

  test("an approval does not survive a change of the aircraft profile or envelope revision", () => {
    const variants: { label: string; overrides: ContextOverrides; basis: ProposalBasis }[] = [
      { label: "profile", overrides: { profile: { ...TENDER_T1, revision: 2 } }, basis: { ...BASIS, profileRevision: 2 } },
      { label: "envelope", overrides: { envelope: { ...ENVELOPE, revision: 2 } }, basis: { ...BASIS, envelopeRevision: 2 } },
    ];
    for (const { label, overrides, basis } of variants) {
      const { harness } = newHarness();
      const a = approvedSpray(harness);
      const result = harness.requestExecution(executeCommand(a.id, a.digest, "req-1", T0 + 10), makeContext(sprayBelief(T0 + 10), overrides));
      assert.equal(result.status, "invalidated", label);
      assert.ok(result.findings.some(f => f.ruleId === "H4" && f.reason.includes(label)), label);
      const b = ids(harness.submit(sprayInput({ basis, createdTick: T0 + 11 }), makeContext(sprayBelief(T0 + 11), overrides)));
      assert.equal(current(harness, b.id).status, "awaiting_approval", `${label}: the re-proposal needs its own approval`);
      assert.equal(harness.requestExecution(executeCommand(b.id, b.digest, "req-2", T0 + 12), makeContext(sprayBelief(T0 + 12), overrides)).accepted, false);
      assert.equal(water(steps(harness, T0 + 12, T0 + 30, t => sprayBelief(t), overrides)), 0, label);
    }
  });

  test("an approve with a different digest or another run id is refused, and a double approve is a no-op", () => {
    const { harness } = newHarness();
    const a = ids(harness.submit(sprayInput(), makeContext(sprayBelief(T0))));
    const ctx = makeContext(sprayBelief(T0 + 5));
    const wrongDigest = harness.approve(approveCommand(a.id, "0".repeat(64), T0 + 5), ctx);
    assert.equal(wrongDigest.accepted, false);
    assert.deepEqual(ruleIds(wrongDigest.findings), ["H5"]);
    const otherRun = harness.approve(approveCommand(a.id, a.digest, T0 + 5, { runId: "run-0" }), ctx);
    assert.equal(otherRun.accepted, false);
    assert.deepEqual(ruleIds(otherRun.findings), ["run"]);
    assert.equal(current(harness, a.id).status, "awaiting_approval");

    assert.equal(harness.approve(approveCommand(a.id, a.digest, T0 + 6), makeContext(sprayBelief(T0 + 6))).status, "approved");
    const again = harness.approve(approveCommand(a.id, a.digest, T0 + 7), makeContext(sprayBelief(T0 + 7)));
    assert.equal(again.accepted, false);
    assert.equal(current(harness, a.id).approval?.issuedTick, T0 + 6);
  });

  test("a commander rejection is terminal and records the commander's reason", () => {
    const { harness } = newHarness();
    const a = ids(harness.submit(sprayInput(), makeContext(sprayBelief(T0))));
    const rejected = harness.reject({ type: "reject", runId: RUN_ID, proposalId: a.id, commanderId: COMMANDER, tick: T0 + 3, reason: "Crew will handle the hallway." }, makeContext(sprayBelief(T0 + 3)));
    assert.equal(rejected.status, "rejected");
    assert.match(current(harness, a.id).history.at(-1)?.reason ?? "", /Crew will handle the hallway/);
    assert.equal(harness.approve(approveCommand(a.id, a.digest, T0 + 4), makeContext(sprayBelief(T0 + 4))).accepted, false);
    assert.equal(harness.requestExecution(executeCommand(a.id, a.digest, "req-1", T0 + 5), makeContext(sprayBelief(T0 + 5))).duplicate, true);
  });
});

describe("expiry on the mission clock", () => {
  test("execution requested after the approval expires is expired, with no actuation", () => {
    const { harness } = newHarness();
    const a = approvedSpray(harness);
    assert.equal(current(harness, a.id).approval?.expiresTick, T0 + 5 + DEFAULT_POLICY.approvalTtlTicks);
    const late = T0 + 5 + DEFAULT_POLICY.approvalTtlTicks + 1;
    const result = harness.requestExecution(executeCommand(a.id, a.digest, "late", late), makeContext(sprayBelief(late)));
    assert.equal(result.status, "expired");
    assert.equal(result.accepted, false);
    assert.equal(water(steps(harness, late, late + 30, t => sprayBelief(t))), 0);
    assert.equal(current(harness, a.id).execution, null);
  });

  test("an expired proposal cannot be approved again", () => {
    const { harness } = newHarness();
    const lapsedApproval = approvedSpray(harness);
    harness.step(makeContext(sprayBelief(T0 + 5 + DEFAULT_POLICY.approvalTtlTicks + 1)), null);
    assert.equal(current(harness, lapsedApproval.id).status, "expired");
    const renewed = harness.approve(approveCommand(lapsedApproval.id, lapsedApproval.digest, T0 + 2100), makeContext(sprayBelief(T0 + 2100)));
    assert.equal(renewed.accepted, false);
    assert.equal(renewed.status, "expired");

    const second = newHarness();
    const neverApproved = ids(second.harness.submit(sprayInput({ expiresTick: T0 + 100 }), makeContext(sprayBelief(T0))));
    second.harness.step(makeContext(sprayBelief(T0 + 101)), null);
    const late = second.harness.approve(approveCommand(neverApproved.id, neverApproved.digest, T0 + 102), makeContext(sprayBelief(T0 + 102)));
    assert.equal(late.accepted, false);
    assert.equal(late.status, "expired");
  });
});

describe("stale-approval challenge", () => {
  test("an uncited possible person observed in the sector after approval invalidates execution with zero water", () => {
    const { harness } = newHarness();
    const a = approvedSpray(harness);
    const person = personObservation("obs-person-1", T0 + 8);
    assert.ok(!sprayInput().citedEvidence.includes(person.id), "the proposal never cited this observation");
    const result = harness.requestExecution(executeCommand(a.id, a.digest, "req-1", T0 + 10), makeContext(sprayBelief(T0 + 10, { extraObservations: [person] })));
    assert.equal(result.status, "invalidated");
    assert.ok(result.findings.some(f => f.ruleId === "H6" && f.evidenceIds?.includes("obs-person-1")));
    assert.match(result.reason, /obs-person-1/);
    assert.equal(water(steps(harness, T0 + 10, T0 + 40, t => sprayBelief(t, { extraObservations: [person] }))), 0);

    const reuse = harness.requestExecution(executeCommand(a.id, a.digest, "req-2", T0 + 41), makeContext(sprayBelief(T0 + 41)));
    assert.equal(reuse.duplicate, true, "the old approval cannot be reused, even once the person has gone");
    assert.equal(water([harness.step(makeContext(sprayBelief(T0 + 41)), null)]), 0);
  });
});

describe("conflicting evidence during discharge", () => {
  test("a possible person arriving after k ticks stops water that tick; exactly k ticks of flow are recorded and logged", () => {
    const { harness, log } = newHarness();
    const k = 40;
    const a = executingSpray(harness);
    const before = steps(harness, T0 + 10, T0 + 10 + k - 1, t => sprayBelief(t));
    close(water(before), k * PER_TICK_L);

    const arrival = T0 + 10 + k;
    const person = personObservation("obs-person-1", arrival);
    const after = steps(harness, arrival, arrival + 30, t => sprayBelief(t, { extraObservations: [person] }));
    assert.equal(commandsOf(after, "water").length, 0);

    const record = current(harness, a.id);
    assert.equal(record.status, "invalidated");
    close(record.execution?.effects.waterDischargedL, k * PER_TICK_L);
    assert.equal(record.execution?.effects.ticksExecuted, k);
    assert.equal(record.execution?.endedTick, arrival);
    assert.match(record.execution?.stopReason ?? "", /obs-person-1/);
    assert.ok(record.findings.some(f => f.ruleId === "H6" && f.evidenceIds?.includes("obs-person-1")));

    const event = log.entries().find(e => e.kind === "proposal.invalidated" && e.subject === a.id);
    assert.ok(event && event.ruleIds.includes("H6"));
    close((event.data.effects as { waterDischargedL?: number }).waterDischargedL, k * PER_TICK_L);
  });

  test("coverage that stops being refreshed mid-spray stops the discharge once it is older than the freshness limit", () => {
    const { harness } = newHarness();
    const a = executingSpray(harness);
    const lastFrame = T0 + 50;
    const batches = steps(harness, T0 + 10, T0 + 309, t => sprayBelief(t, { coverageTick: Math.min(t - 5, lastFrame) }));
    const record = current(harness, a.id);
    assert.equal(record.status, "invalidated");
    assert.equal(record.execution?.endedTick, lastFrame + DEFAULT_POLICY.coverageFreshTicks + 1);
    const dischargeTicks = lastFrame + DEFAULT_POLICY.coverageFreshTicks + 1 - (T0 + 10);
    close(water(batches), dischargeTicks * PER_TICK_L);
    assert.ok(record.findings.some(f => f.ruleId === "H6" && /coverage/.test(f.reason)));
  });
});

describe("coverage is required, not assumed", () => {
  test("no fresh coverage of the sector refuses the spray even though nothing was detected", () => {
    const { harness } = newHarness();
    const result = harness.submit(sprayInput(), makeContext(sprayBelief(T0, { coverageTick: null })));
    assert.equal(result.status, "rejected");
    assert.deepEqual(ruleIds(result.findings), ["H6"]);
    assert.ok(result.findings.every(f => /coverage/.test(f.reason)));
  });

  test("coverage only from frames unusable as a whole (quality below minCoverageQuality) refuses the spray", () => {
    const { harness } = newHarness();
    const result = harness.submit(sprayInput(), makeContext(sprayBelief(T0, { coverageQuality: 0.2 })));
    assert.equal(result.status, "rejected");
    assert.deepEqual(ruleIds(result.findings), ["H6"]);
  });

  test("a smoky frame whose person-search footprint covers the region supports the spray; one whose footprint stops short does not", () => {
    // Quality 0.45: a smoky frame the former 0.6 bar discarded whole. Its footprint holds only points where a
    // person would have been detected (the sensors cut it per point), so where it reaches, it counts.
    const smoky = 0.45;
    const covering = newHarness().harness.submit(sprayInput(), makeContext(sprayBelief(T0, { coverageQuality: smoky })));
    assert.equal(covering.status, "awaiting_approval", JSON.stringify(covering.findings));
    // The same frame with its footprint cut 1 m short of the fire, as smoke nearer the aim would cut it.
    const nearOnly = observation("obs-smoky-near", T0 - 5, box(vec3(3, -1.5, 1.5), vec3(6, 3.5, 6.5)), { quality: smoky, modality: "rgb", personSearch: "oracle_fixture" });
    const short = newHarness().harness.submit(sprayInput(), makeContext(sprayBelief(T0, { coverageTick: null, extraObservations: [nearOnly] })));
    assert.equal(short.status, "rejected");
    assert.deepEqual(ruleIds(short.findings), ["H6"]);
    assert.ok(short.findings.some(f => /coverage/.test(f.reason)));
  });

  test("under a policy counting only detections more confident than footprints are cut to, no footprint supports the spray", () => {
    const stricter = { ...DEFAULT_POLICY, personConfidenceThreshold: PERSON_DETECTION_CONFIDENCE + 0.1 };
    const result = newHarness().harness.submit(sprayInput(), makeContext(sprayBelief(T0), { policy: stricter }));
    assert.equal(result.status, "rejected", "a footprint would claim space where a person could be reported below the stricter threshold");
    assert.deepEqual(ruleIds(result.findings), ["H6"]);
    const looser = { ...DEFAULT_POLICY, personConfidenceThreshold: PERSON_DETECTION_CONFIDENCE - 0.05 };
    assert.equal(newHarness().harness.submit(sprayInput(), makeContext(sprayBelief(T0), { policy: looser })).status, "awaiting_approval", "a lower threshold is safe");
  });

  test("the default thresholds stay tied to the footprint contract", () => {
    assert.equal(DEFAULT_POLICY.personConfidenceThreshold, PERSON_DETECTION_CONFIDENCE, "footprints are cut to the detection threshold the harness blocks on");
    assert.equal(EVIDENCE_DEFAULTS.adequateQuality, DEFAULT_POLICY.minCoverageQuality, "the evidence store's searched-room fractions and the harness use the same whole-frame bar");
  });

  test("coverage that ages out between approval and execution invalidates the spray before any water", () => {
    const { harness } = newHarness();
    const a = approvedSpray(harness);
    const late = T0 + DEFAULT_POLICY.coverageFreshTicks + 20;
    const result = harness.requestExecution(executeCommand(a.id, a.digest, "req-1", late), makeContext(sprayBelief(late, { coverageTick: T0 })));
    assert.equal(result.status, "invalidated");
    assert.deepEqual(ruleIds(result.findings), ["H6"]);
    assert.equal(water(steps(harness, late, late + 20, t => sprayBelief(t))), 0);
  });
});

describe("idempotent execution", () => {
  test("repeated execute requests during and after execution produce exactly one dose and are all recorded", () => {
    const { harness, log } = newHarness();
    const a = approvedSpray(harness);
    const start = makeContext(sprayBelief(T0 + 10));
    assert.equal(harness.requestExecution(executeCommand(a.id, a.digest, "req-1", T0 + 10), start).status, "executing");
    assert.equal(harness.requestExecution(executeCommand(a.id, a.digest, "req-1", T0 + 10), start).duplicate, true);

    const batches: ActuatorBatch[] = [];
    for (let tick = T0 + 10; tick <= T0 + 330; tick++) {
      const ctx = makeContext(sprayBelief(tick));
      if (tick === T0 + 150) assert.equal(harness.requestExecution(executeCommand(a.id, a.digest, "req-2", tick), ctx).duplicate, true);
      batches.push(harness.step(ctx, null));
    }
    const late = harness.requestExecution(executeCommand(a.id, a.digest, "req-3", T0 + 331), makeContext(sprayBelief(T0 + 331)));
    assert.equal(late.duplicate, true);
    assert.equal(late.status, "completed");
    batches.push(harness.step(makeContext(sprayBelief(T0 + 331)), null));

    close(water(batches), 0.6);
    assert.equal(commandsOf(batches, "water").length, 300);
    const record = current(harness, a.id);
    assert.equal(record.status, "completed");
    close(record.execution?.effects.waterDischargedL, 0.6);
    assert.deepEqual(record.execution?.requestIds, ["req-1", "req-1", "req-2", "req-3"]);
    assert.equal(log.entries().filter(e => e.kind === "execution.duplicate_ignored").length, 3);
  });

  test("step runs once per tick, so one tick can never discharge twice", () => {
    const { harness } = newHarness();
    const a = executingSpray(harness);
    harness.step(makeContext(sprayBelief(T0 + 10)), null);
    assert.throws(() => harness.step(makeContext(sprayBelief(T0 + 10)), null), RangeError);
    close(current(harness, a.id).execution?.effects.waterDischargedL, PER_TICK_L);
  });
});

describe("reset", () => {
  const run2Envelope: ContextOverrides = { envelope: { ...ENVELOPE, runId: "run-2" } };
  const run2Belief = (tick: Tick) => sprayBelief(tick, { runId: "run-2" });

  test("a run-2 harness refuses run-1 proposals, approvals and executions", () => {
    const run1 = newHarness("run-1");
    const old = ids(run1.harness.submit(sprayInput(), makeContext(sprayBelief(T0))));
    const run2 = newHarness("run-2");
    const ctx = makeContext(run2Belief(T0 + 5), run2Envelope);
    const submitted = run2.harness.submit(sprayInput(), ctx);
    assert.equal(submitted.accepted, false);
    assert.equal(submitted.proposalId, null);
    assert.deepEqual(ruleIds(submitted.findings), ["run"]);
    assert.equal(run2.harness.approve(approveCommand(old.id, old.digest, T0 + 5), ctx).accepted, false);
    assert.equal(run2.harness.requestExecution(executeCommand(old.id, old.digest, "req-1", T0 + 5), ctx).accepted, false);
    assert.equal(run2.harness.records().length, 0);
    assert.equal(water(steps(run2.harness, T0 + 5, T0 + 20, run2Belief, run2Envelope)), 0);
  });

  test("a late run-1 approval reply cannot act on the identical action re-proposed in run 2", () => {
    const run1 = newHarness("run-1");
    const old = ids(run1.harness.submit(sprayInput(), makeContext(sprayBelief(T0))));
    const run2 = newHarness("run-2");
    const fresh = ids(run2.harness.submit(sprayInput({ runId: "run-2", createdTick: T0 + 1 }), makeContext(run2Belief(T0 + 1), run2Envelope)));
    assert.notEqual(fresh.digest, old.digest, "the run id is part of the digest");
    const ctx = makeContext(run2Belief(T0 + 6), run2Envelope);
    assert.equal(run2.harness.approve(approveCommand(old.id, old.digest, T0 + 2), ctx).accepted, false, "the reply as sent");
    assert.equal(run2.harness.approve(approveCommand(fresh.id, old.digest, T0 + 2, { runId: "run-2" }), ctx).accepted, false, "the reply re-addressed");
    assert.equal(current(run2.harness, fresh.id).status, "awaiting_approval");
    assert.equal(run2.harness.requestExecution(executeCommand(fresh.id, fresh.digest, "req-1", T0 + 7), makeContext(run2Belief(T0 + 7), run2Envelope)).accepted, false);
    assert.equal(water(steps(run2.harness, T0 + 7, T0 + 20, run2Belief, run2Envelope)), 0);
  });
});

describe("abort", () => {
  test("a mission abort mid-spray stops water, keeps the spent volume and selects a contingency", () => {
    const { harness, log } = newHarness();
    const a = executingSpray(harness);
    const k = 25;
    const before = steps(harness, T0 + 10, T0 + 10 + k - 1, t => sprayBelief(t));
    const result = abortMission(harness, T0 + 10 + k);
    assert.equal(result.accepted, true);
    assert.deepEqual(result.stopped, [a.id]);
    assert.ok(result.contingency, "a contingency or explicit failure is always returned");
    assert.equal(harness.missionAborted, true);
    assert.equal(harness.terminalFailure, result.contingency.kind === "failure");
    assert.equal(water(steps(harness, T0 + 10 + k, T0 + 10 + k + 30, t => sprayBelief(t))), 0);
    close(water(before), k * PER_TICK_L);
    const record = current(harness, a.id);
    assert.equal(record.status, "aborted");
    close(record.execution?.effects.waterDischargedL, k * PER_TICK_L);
    assert.ok(log.entries().some(e => e.kind === "mission.aborted"));
  });

  test("an abort after the strike keeps strikeDelivered; an abort during the strike delay prevents the strike", () => {
    const struck = newHarness();
    const b = approvedBreach(struck.harness);
    assert.equal(struck.harness.requestExecution(executeCommand(b.id, b.digest, "req-1", T0 + 10), makeContext(breachBelief(T0 + 10))).status, "executing");
    const batches = steps(struck.harness, T0 + 10, T0 + 70, t => breachBelief(t));
    assert.equal(commandsOf(batches, "strike").length, 1);
    assert.equal(commandsOf(batches.slice(0, TENDER_T1.modules.glassBreaker?.strikeDelayTicks ?? 0), "strike").length, 0, "no strike during the delay");
    const proposalAbort = struck.harness.abort({ type: "abort", runId: RUN_ID, scope: b.id, by: COMMANDER, tick: T0 + 71, reason: "Too late." }, makeContext(breachBelief(T0 + 71)));
    assert.deepEqual([proposalAbort.stopped, proposalAbort.cancelled], [[], []]);
    abortMission(struck.harness, T0 + 72, RUN_ID, breachBelief(T0 + 72));
    const record = current(struck.harness, b.id);
    assert.equal(record.status, "completed");
    assert.equal(record.execution?.effects.strikeDelivered, true);

    const early = newHarness();
    const c = approvedBreach(early.harness);
    early.harness.requestExecution(executeCommand(c.id, c.digest, "req-1", T0 + 10), makeContext(breachBelief(T0 + 10)));
    const waiting = steps(early.harness, T0 + 10, T0 + 30, t => breachBelief(t));
    early.harness.abort({ type: "abort", runId: RUN_ID, scope: c.id, by: COMMANDER, tick: T0 + 31, reason: "Person reported at the window." }, makeContext(breachBelief(T0 + 31)));
    const later = steps(early.harness, T0 + 31, T0 + 90, t => breachBelief(t));
    assert.equal(commandsOf([...waiting, ...later], "strike").length, 0);
    assert.equal(current(early.harness, c.id).status, "aborted");
    assert.equal(current(early.harness, c.id).execution?.effects.strikeDelivered, false);
  });

  test("an abort carrying another run id still stops the current run", () => {
    const { harness, log } = newHarness();
    const a = executingSpray(harness);
    steps(harness, T0 + 10, T0 + 19, t => sprayBelief(t));
    const result = abortMission(harness, T0 + 20, "run-0");
    assert.equal(result.runIdMismatch, true);
    assert.deepEqual(result.stopped, [a.id]);
    assert.equal(water(steps(harness, T0 + 20, T0 + 40, t => sprayBelief(t))), 0);
    assert.ok(log.entries().some(e => e.kind === "abort.run_mismatch"));
  });

  test("a mission abort starts its selected contingency itself in the same tick, even after its cited route evidence left the window", () => {
    const { harness } = newHarness();
    executingSpray(harness);
    steps(harness, T0 + 10, T0 + 14, t => sprayBelief(t));
    // A supported return route assessed at T0; the observation it cites is no longer in the belief window.
    const scene = (tick: Tick) => sprayBelief(tick, { routes: [returnRoute(T0)] });
    const abort = abortMission(harness, T0 + 15, RUN_ID, scene(T0 + 15));
    assert.equal(abort.contingency?.kind, "return");
    assert.equal(harness.terminalFailure, false);
    const record = abort.contingencyRecord;
    assert.ok(record, "the abort returns the contingency's record");
    assert.equal(record.status, "executing");
    assert.equal(record.proposal.proposer, "contingency");
    assert.equal(record.execution?.startedTick, T0 + 15, "no tick passes between the abort and the contingency");
    // The aircraft already sits on the route's first waypoint, so it steers for the second.
    assert.deepEqual(harness.activeMotion(), { proposal: record.proposal, goal: returnRoute(T0).waypoints[1] });
  });

  test("review F4: submit refuses the contingency proposer from any caller; a re-submitted contingency proposal cannot claim the exemptions", () => {
    const { harness, log } = newHarness();
    const scene = (tick: Tick) => sprayBelief(tick, { routes: [returnRoute(T0)] });
    const abort = abortMission(harness, T0 + 1, RUN_ID, scene(T0 + 1));
    assert.ok(abort.contingency);
    const input = contingencyProposalInput(abort.contingency, makeContext(scene(T0 + 2)));
    assert.ok(input);
    for (const attempt of [input, contingencyHoldInput(T0 + 2), sprayInput({ proposer: "contingency", createdTick: T0 + 2 })]) {
      const result = harness.submit(attempt, makeContext(scene(T0 + 2)));
      assert.equal(result.accepted, false);
      assert.equal(result.proposalId, null, "refused before a record exists");
      assert.deepEqual(ruleIds(result.findings), ["authority"]);
    }
    assert.ok(log.entries().some(e => e.kind === "command.refused" && e.ruleIds.includes("authority")));
    assert.equal(harness.records().filter(r => r.proposal.proposer === "contingency").length, 1, "only the harness's own contingency exists");
  });

  test("after a mission abort only the harness's contingency runs; every submitted proposal is refused", () => {
    const { harness } = newHarness();
    const pending = ids(harness.submit(sprayInput(), makeContext(sprayBelief(T0))));
    // No route is assessed, so with supported localization, ambient within limits and spare endurance the abort holds.
    const abort = abortMission(harness, T0 + 1);
    assert.equal(current(harness, pending.id).status, "aborted");
    assert.equal(abort.contingency?.kind, "hold");
    assert.equal(abort.contingencyRecord?.status, "executing");
    assert.equal(harness.approve(approveCommand(pending.id, pending.digest, T0 + 2), makeContext(sprayBelief(T0 + 2))).accepted, false, "a late approval cannot revive it");

    const ctx = makeContext(sprayBelief(T0 + 2));
    const refused = [
      moveInput(vec3(8, 1, 4.2), { createdTick: T0 + 2 }),
      proposalInput({ kind: "hold", durationTicks: 100 }, { proposer: "operator", createdTick: T0 + 2 }),
    ];
    for (const input of refused) {
      const result = harness.submit(input, ctx);
      assert.equal(result.status, "rejected", `${input.proposer} ${input.action.kind}`);
      assert.ok(result.findings.some(f => f.ruleId === "H16"));
    }
    assert.equal(harness.activeMotion()?.proposal.id, abort.contingencyRecord?.proposal.id);
  });

  test("review F3b: when the harness's own rules refuse the selected contingency, the abort records an explicit failure and brakes and descends", () => {
    const { harness, log } = newHarness();
    // Localization lost with σ 3 m: the selector picks landing in place on a site under the aircraft, but H3
    // inflates the site by σ beyond the envelope floor (z ≥ 0), so the harness refuses that landing.
    const here = vec3(5, 1, 4.2);
    const lost = (tick: Tick) => sprayBelief(tick, { position: here, poseSupported: false, sigmaM: 3, landing: { supported: true, site: vec3(5, 1, 0.6), evidenceIds: [], reason: "fixture: downward ultrasound sees a flat surface" } });
    const abort = abortMission(harness, T0 + 1, RUN_ID, lost(T0 + 1));
    assert.equal(abort.contingency?.kind, "failure");
    assert.equal(harness.terminalFailure, true);
    assert.match(abort.contingency.reason, /land contingency could not run: H3/);
    assert.match(abort.contingency.termination, /not a safe landing/);
    assert.equal(abort.contingencyRecord?.proposal.action.kind, "land");
    assert.equal(abort.contingencyRecord?.status, "rejected", "the refused landing is on record");
    const batch = harness.step(makeContext(lost(T0 + 2)), { source: "contingency", tick: T0 + 2, velocityBody: vec3(0, 0, 0), yawRateRadps: 0 });
    assert.deepEqual(batch.motion?.executed, { velocityBody: vec3(0, 0, -DEFAULT_POLICY.terminalDescentMps), yawRateRadps: 0 }, "brake and descend, not an assumed hover");
    assert.ok(log.entries().some(e => e.kind === "contingency.selected" && e.data.kind === "failure" && e.data.selectedKind === "land"));
  });

  test("review F3a: with localization lost, a supported landing site far from the aircraft is not landed on 'in place'; the harness fails explicitly", () => {
    const { harness } = newHarness();
    const site = vec3(-4, 2, 0.6);
    const lost = (tick: Tick) => sprayBelief(tick, { position: vec3(5, 1, 4.2), poseSupported: false, sigmaM: 0.5, landing: { supported: true, site, evidenceIds: [], reason: "fixture: flat exterior ground observed" } });
    const started = harness.startContingency("localization_lost", makeContext(lost(T0)));
    assert.equal(started.selected.kind, "failure", "the selector no longer claims landing in place 9.7 m away");
    assert.equal(started.record, null);
    assert.equal(harness.terminalFailure, true);
    const batch = harness.step(makeContext(lost(T0 + 1)), { source: "contingency", tick: T0 + 1, velocityBody: vec3(1, 0, -0.3), yawRateRadps: 0 });
    assert.deepEqual(batch.motion?.executed, { velocityBody: vec3(0, 0, -DEFAULT_POLICY.terminalDescentMps), yawRateRadps: 0 });
    assert.equal(harness.records().some(r => r.status === "executing"), false, "nothing claims to be landing on the site");
  });

  test("startContingency starts a supported maneuver at once, and a later trigger without support fails explicitly and stops everything", () => {
    const { harness } = newHarness();
    const move = ids(harness.submit(moveInput(vec3(8, 1, 4.2)), makeContext(sprayBelief(T0))));
    assert.equal(harness.requestExecution(executeCommand(move.id, move.digest, "req-move", T0 + 1), makeContext(sprayBelief(T0 + 1))).status, "executing");
    const pendingSpray = ids(harness.submit(sprayInput({ createdTick: T0 + 2 }), makeContext(sprayBelief(T0 + 2))));
    const reserve = harness.startContingency("reserve", makeContext(sprayBelief(T0 + 3, { routes: [returnRoute(T0)] })));
    assert.equal(reserve.contingency.kind, "return");
    assert.equal(reserve.record?.status, "executing");
    assert.equal(current(harness, move.id).status, "aborted", "the contingency preempts the planner's motion");
    assert.equal(harness.missionAborted, false, "a supported contingency does not abort the mission");
    assert.equal(current(harness, pendingSpray.id).status, "awaiting_approval");

    // Localization lost, no landing support: nothing is supported, so the harness fails explicitly.
    const lost = harness.startContingency("localization_lost", makeContext(sprayBelief(T0 + 4, { poseSupported: false })));
    assert.equal(lost.contingency.kind, "failure");
    assert.equal(lost.record, null);
    assert.equal(harness.terminalFailure, true);
    assert.equal(harness.missionAborted, true);
    assert.equal(current(harness, reserve.record?.proposal.id ?? "").status, "aborted");
    assert.equal(current(harness, pendingSpray.id).status, "aborted", "nothing pending survives a terminal failure");
    assert.equal(harness.startContingency("reserve", makeContext(sprayBelief(T0 + 5, { routes: [returnRoute(T0)] }))).record, null, "nothing starts after a terminal failure");
  });
});

describe("mission envelope and routine actions", () => {
  const revised: MissionEnvelope = { ...ENVELOPE, revision: 2, approvedTick: T0 + 5, regions: [box(vec3(-6, -3, 0), vec3(24, 6, 8))] };

  test("a move outside the envelope is rejected, and routine actions have no approval path", () => {
    const { harness } = newHarness();
    const outside = harness.submit(moveInput(vec3(20, 0, 4)), makeContext(sprayBelief(T0)));
    assert.equal(outside.status, "rejected");
    assert.deepEqual(ruleIds(outside.findings), ["H3"]);
    const inside = ids(harness.submit(moveInput(vec3(8, 1, 4.2)), makeContext(sprayBelief(T0))));
    const approval = harness.approve(approveCommand(inside.id, inside.digest, T0 + 1), makeContext(sprayBelief(T0 + 1)));
    assert.equal(approval.accepted, false);
    assert.equal(current(harness, inside.id).status, "validated");
    assert.equal(current(harness, inside.id).approval, null);
  });

  test("after an envelope revision the old proposal is invalidated at execution and a re-proposal bound to the new revision executes", () => {
    const { harness } = newHarness();
    const old = ids(harness.submit(moveInput(vec3(8, 1, 4.2)), makeContext(sprayBelief(T0))));
    const stale = harness.requestExecution(executeCommand(old.id, old.digest, "req-1", T0 + 10), makeContext(sprayBelief(T0 + 10), { envelope: revised }));
    assert.equal(stale.status, "invalidated");
    assert.deepEqual(ruleIds(stale.findings), ["H4"]);

    const next = harness.submit(moveInput(vec3(20, 0, 4), { createdTick: T0 + 11, basis: { ...BASIS, envelopeRevision: 2 } }), makeContext(sprayBelief(T0 + 11), { envelope: revised }));
    assert.equal(next.status, "validated", JSON.stringify(next.findings));
    const started = harness.requestExecution(executeCommand(ids(next).id, ids(next).digest, "req-2", T0 + 12), makeContext(sprayBelief(T0 + 12), { envelope: revised }));
    assert.equal(started.status, "executing");
    assert.deepEqual(harness.activeMotion()?.goal, vec3(20, 0, 4));
  });

  test("an envelope beyond the aircraft's hard limits blocks mission actions but not contingencies", () => {
    const { harness } = newHarness();
    const tooFast: MissionEnvelope = { ...ENVELOPE, maxSpeedMps: TENDER_T1.hardLimits.maxSpeedMps + 5 };
    const move = harness.submit(moveInput(vec3(8, 1, 4.2)), makeContext(sprayBelief(T0), { envelope: tooFast }));
    assert.equal(move.status, "rejected");
    assert.deepEqual(ruleIds(move.findings), ["H3"]);
    const hold = harness.startContingency("route_blocked", makeContext(sprayBelief(T0), { envelope: tooFast }));
    assert.equal(hold.contingency.kind, "hold");
    assert.equal(hold.record?.status, "executing");
  });

  test("review F4: a contingency hold still needs its own support — ambient within limits and endurance above the reserve — at every tick", () => {
    const { harness } = newHarness();
    const hold = harness.startContingency("route_blocked", makeContext(sprayBelief(T0)));
    assert.equal(hold.contingency.kind, "hold");
    const id = hold.record?.proposal.id ?? "";
    harness.step(makeContext(sprayBelief(T0 + 1)), null);
    assert.equal(current(harness, id).status, "executing");
    harness.step(makeContext(sprayBelief(T0 + 2, { aircraft: { ambientC: 95 } })), null);
    const record = current(harness, id);
    assert.equal(record.status, "invalidated", "the hold stops when the ambient leaves its limit");
    assert.match(record.execution?.stopReason ?? "", /Ambient 95/);

    const low = newHarness();
    const lowHold = low.harness.startContingency("route_blocked", makeContext(sprayBelief(T0)));
    low.harness.step(makeContext(sprayBelief(T0 + 1, { aircraft: { enduranceRemainingS: TENDER_T1.hardLimits.returnReserveS - 1 } })), null);
    assert.equal(current(low.harness, lowHold.record?.proposal.id ?? "").status, "invalidated", "the hold stops at the return reserve");
  });

  test("a contingency preempts the executing motion action, while a second planner motion is refused", () => {
    const { harness, log } = newHarness();
    const move = ids(harness.submit(moveInput(vec3(8, 1, 4.2)), makeContext(sprayBelief(T0))));
    assert.equal(harness.requestExecution(executeCommand(move.id, move.digest, "req-move", T0 + 1), makeContext(sprayBelief(T0 + 1))).status, "executing");
    const second = ids(harness.submit(moveInput(vec3(6, 1, 4.2), { createdTick: T0 + 2 }), makeContext(sprayBelief(T0 + 2))));
    const refused = harness.requestExecution(executeCommand(second.id, second.digest, "req-second", T0 + 2), makeContext(sprayBelief(T0 + 2)));
    assert.equal(refused.accepted, false);
    assert.equal(refused.status, "validated", "refused for concurrency, still executable later");

    const hold = harness.startContingency("route_blocked", makeContext(sprayBelief(T0 + 3)));
    assert.equal(hold.record?.status, "executing");
    assert.equal(current(harness, move.id).status, "aborted");
    assert.equal(harness.activeMotion()?.proposal.id, hold.record?.proposal.id);
    assert.ok(log.entries().some(e => e.subject === move.id && e.kind === "proposal.aborted" && /Preempted by contingency/.test(e.reason)));
  });
});

describe("capability and limits", () => {
  test("the same spray is rejected on Scout S1 by H1 but awaits approval on Tender T1", () => {
    const scout = newHarness();
    const onScout = scout.harness.submit(sprayInput({ aircraftId: SCOUT_S1.id }), makeContext(sprayBelief(T0), { profile: SCOUT_S1 }));
    assert.equal(onScout.status, "rejected");
    assert.deepEqual(ruleIds(onScout.findings), ["H1"]);
    const tender = newHarness();
    assert.equal(tender.harness.submit(sprayInput(), makeContext(sprayBelief(T0))).status, "awaiting_approval");
  });

  test("a dose above the remaining water is rejected", () => {
    const { harness } = newHarness();
    const result = harness.submit(sprayInput(), makeContext(sprayBelief(T0, { aircraft: { waterRemainingL: 0.5 } })));
    assert.equal(result.status, "rejected");
    assert.ok(result.findings.some(f => f.ruleId === "H2" && /Dose 0.6 L/.test(f.reason)));
  });

  test("a jet reaction above the allowed fraction of the thrust margin is rejected", () => {
    const { harness } = newHarness();
    const strict = { ...TENDER_T1, hardLimits: { ...TENDER_T1.hardLimits, maxReactionFractionOfMargin: 0.05 } };
    const result = harness.submit(sprayInput(), makeContext(sprayBelief(T0), { profile: strict }));
    assert.equal(result.status, "rejected");
    assert.deepEqual(ruleIds(result.findings), ["H2"]);
    assert.match(result.findings[0].reason, /reaction/);
  });

  test("a proposer cannot supply its own risk class", () => {
    const { harness } = newHarness();
    const result = harness.submit({ ...sprayInput(), risk: "routine" }, makeContext(sprayBelief(T0)));
    assert.equal(result.accepted, false);
    assert.equal(result.proposalId, null);
    assert.ok(result.findings.some(f => f.ruleId === "schema" && f.reason.includes("risk")));
  });
});

describe("guidance after an intervention", () => {
  test("guide needs an evacuation route assessed after the last completed spray, and stops when support lapses", () => {
    const { harness } = newHarness();
    const sprayed = executingSpray(harness, sprayInput({}, { durationTicks: 30 }));
    steps(harness, T0 + 10, T0 + 39, t => sprayBelief(t));
    assert.equal(current(harness, sprayed.id).status, "completed");
    assert.equal(current(harness, sprayed.id).execution?.endedTick, T0 + 39);

    const tracks = [occupantTrack(T0 + 40)];
    const scene = (tick: Tick, routeTick: Tick, status: "supported" | "unsupported" = "supported") => sprayBelief(tick, { tracks, routes: [evacuationRoute(routeTick, status)], extraObservations: [routeObservation(routeTick)] });
    const beforeSpray = harness.submit(guideInput({ createdTick: T0 + 45 }), makeContext(scene(T0 + 45, T0 + 30)));
    assert.equal(beforeSpray.status, "rejected", "supported, but assessed before the suppression changed conditions");
    assert.ok(beforeSpray.findings.some(f => f.ruleId === "H15" && /after the intervention/.test(f.reason)));

    const guide = ids(harness.submit(guideInput({ createdTick: T0 + 45 }), makeContext(scene(T0 + 45, T0 + 42))));
    assert.equal(current(harness, guide.id).status, "validated");
    assert.equal(harness.requestExecution(executeCommand(guide.id, guide.digest, "req-guide", T0 + 46), makeContext(scene(T0 + 46, T0 + 42))).status, "executing");
    const guiding = steps(harness, T0 + 46, T0 + 50, t => scene(t, T0 + 42));
    const cues = commandsOf(guiding, "light_cue");
    assert.equal(cues.length, 5);
    // The occupant is nearest the first waypoint, so the light leads to the second.
    assert.ok(cues.every(c => c.kind === "light_cue" && c.target.x === EVAC_WAYPOINTS[1].x && c.target.y === EVAC_WAYPOINTS[1].y));
    assert.deepEqual(commandsOf(guiding, "audio").map(c => (c.kind === "audio" ? c.templateId : "")), ["follow-light"]);

    const lapsed = steps(harness, T0 + 51, T0 + 55, t => scene(t, T0 + 51, "unsupported"));
    assert.equal(commandsOf(lapsed, "light_cue").length, 0);
    const record = current(harness, guide.id);
    assert.equal(record.status, "invalidated");
    assert.match(record.execution?.stopReason ?? "", /route no longer supported/i);
  });
});

describe("truthful speech", () => {
  test("the dispatch template is refused until the commander confirms dispatch, then plays exactly once", () => {
    const { harness } = newHarness();
    const speak = proposalInput({ kind: "speak", templateId: "firefighters-dispatched" });
    const refused = harness.submit(speak, makeContext(sprayBelief(T0)));
    assert.equal(refused.status, "rejected");
    assert.deepEqual(ruleIds(refused.findings), ["H8"]);

    const confirmed = (tick: Tick) => sprayBelief(tick, { dispatchConfirmed: true });
    const accepted = ids(harness.submit(speak, makeContext(confirmed(T0))));
    assert.equal(harness.requestExecution(executeCommand(accepted.id, accepted.digest, "req-speak", T0 + 1), makeContext(confirmed(T0 + 1))).status, "executing");
    const batches = steps(harness, T0 + 1, T0 + 5, confirmed);
    assert.deepEqual(commandsOf(batches, "audio").map(c => (c.kind === "audio" ? c.templateId : "")), ["firefighters-dispatched"]);
    assert.equal(current(harness, accepted.id).status, "completed");
  });
});

describe("actuation path", () => {
  test("step batches are harness-issued, hand-built batches are not, and nothing consequential precedes approval", () => {
    const { harness } = newHarness();
    const a = ids(harness.submit(sprayInput(), makeContext(sprayBelief(T0))));
    const batches: ActuatorBatch[] = [];
    for (let tick = T0 + 1; tick <= T0 + 30; tick++) {
      const ctx = makeContext(sprayBelief(tick));
      assert.equal(harness.requestExecution(executeCommand(a.id, a.digest, `early-${tick}`, tick), ctx).accepted, false);
      batches.push(harness.step(ctx, null));
    }
    assert.ok(batches.every(batch => isHarnessIssued(batch)));
    assert.deepEqual(batches.flatMap(b => b.commands).filter(c => CONSEQUENTIAL_COMMANDS.has(c.kind)), []);

    assert.equal(harness.approve(approveCommand(a.id, a.digest, T0 + 31), makeContext(sprayBelief(T0 + 31))).status, "approved");
    assert.equal(harness.requestExecution(executeCommand(a.id, a.digest, "req-1", T0 + 32), makeContext(sprayBelief(T0 + 32))).status, "executing");
    const first = harness.step(makeContext(sprayBelief(T0 + 32)), null);
    assert.ok(isHarnessIssued(first));
    assert.equal(commandsOf([first], "water").length, 1);

    const forged: ActuatorBatch = { runId: RUN_ID, tick: T0 + 33, motion: null, commands: [{ kind: "water", proposalId: a.id, flowLps: 0.2, volumeL: PER_TICK_L, aimPoint: { x: 4, y: 0.75, z: 3.4 } }] };
    assert.equal(isHarnessIssued(forged), false);
    assert.equal(isHarnessIssued({ ...first }), false, "a copy of an issued batch is not issued");
    assert.throws(() => (first.commands as ActuatorCommand[]).push(forged.commands[0]), TypeError);
  });

  test("each lifecycle transition is appended to the event log with a reason, and the record keeps the same history", () => {
    const { harness, log } = newHarness();
    const a = executingSpray(harness, sprayInput({}, { durationTicks: 5 }));
    steps(harness, T0 + 10, T0 + 14, t => sprayBelief(t));
    const events = log.entries().filter(e => e.subject === a.id && e.kind.startsWith("proposal."));
    const lifecycle = ["proposed", "awaiting_approval", "approved", "executing", "completed"];
    assert.deepEqual(events.map(e => e.kind), lifecycle.map(status => `proposal.${status}`));
    assert.deepEqual(current(harness, a.id).history.map(h => h.status), lifecycle);
    assert.ok(events.every(e => e.source === "harness" && e.reason.length > 0));
    assert.notEqual(events[0].data.affectedRegion, null, "the affected region is recorded with the proposal");
  });
});
