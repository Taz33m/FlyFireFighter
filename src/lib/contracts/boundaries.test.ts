import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SCOUT_S1, TENDER_T1 } from "./aircraft.ts";
import { ticksFromSeconds } from "./clock.ts";
import type { MissionEnvelope } from "./envelope.ts";
import { envelopeContains, envelopeRevisionViolations, hardLimitViolations } from "./envelope.ts";
import { EventLog } from "./events.ts";
import { vec3 } from "./frames.ts";
import { box } from "./geometry.ts";
import type { MissionResult } from "./outcomes.ts";
import { isCompletedRescue, rescueLabel } from "./outcomes.ts";
import { parseProposalInput } from "./schema.ts";

const envelope: MissionEnvelope = {
  runId: "run-1", revision: 1, approvedBy: "commander", approvedTick: 0,
  regions: [box(vec3(-20, -20, 0), vec3(20, 20, 8))],
  maxSpeedMps: 2, ambientCeilingC: 70, endTick: ticksFromSeconds(600),
};

describe("mission envelope versus hard limits", () => {
  test("an envelope within the aircraft's limits has no violations", () => {
    assert.deepEqual(hardLimitViolations(envelope, TENDER_T1, 0), []);
  });

  test("speed, ambient ceiling and time box cannot exceed hard limits", () => {
    const tooMuch = { ...envelope, maxSpeedMps: 9, ambientCeilingC: 120, endTick: ticksFromSeconds(TENDER_T1.hardLimits.enduranceS) };
    assert.equal(hardLimitViolations(tooMuch, TENDER_T1, 0).length, 3);
  });

  test("the same envelope can be valid for one aircraft and not another", () => {
    const hot = { ...envelope, ambientCeilingC: 75 };
    assert.deepEqual(hardLimitViolations(hot, TENDER_T1, 0), []);
    assert.equal(hardLimitViolations(hot, SCOUT_S1, 0).length, 1);
  });

  test("a revision must increment by one, stay in the run and respect hard limits", () => {
    assert.deepEqual(envelopeRevisionViolations({ ...envelope, revision: 2 }, envelope, TENDER_T1, 0), []);
    assert.equal(envelopeRevisionViolations({ ...envelope, revision: 3 }, envelope, TENDER_T1, 0).length, 1);
    assert.equal(envelopeRevisionViolations({ ...envelope, revision: 2, runId: "run-2" }, envelope, TENDER_T1, 0).length, 1);
    assert.equal(envelopeRevisionViolations({ ...envelope, revision: 2, maxSpeedMps: 99 }, envelope, TENDER_T1, 0).length, 1);
  });

  test("containment with a margin rejects points near the boundary", () => {
    assert.ok(envelopeContains(envelope, vec3(19.8, 0, 4)));
    assert.ok(!envelopeContains(envelope, vec3(19.8, 0, 4), 0.5));
  });
});

const validInput = {
  runId: "run-1", aircraftId: "tender-t1", proposer: "local_planner",
  action: { kind: "spray", standoff: { x: 1, y: 0.75, z: 4.2 }, aimPoint: { x: 4, y: 0.75, z: 3.4 }, flowLps: 0.2, durationTicks: 300 },
  rationale: "Suppress the small fire blocking the hallway.", citedEvidence: ["obs-3"],
  basis: { evidenceRevision: 4, mapRevision: 1, profileRevision: 1, envelopeRevision: 1, policyRevision: 1 },
  createdTick: 100, expiresTick: 2000,
};

describe("proposal boundary schema", () => {
  test("accepts a complete proposal", () => {
    const result = parseProposalInput(validInput);
    assert.ok(result.ok, result.ok ? "" : result.errors.join("; "));
  });

  test("rejects a proposer-supplied risk class or approval", () => {
    const withRisk = parseProposalInput({ ...validInput, risk: "routine" });
    assert.ok(!withRisk.ok && withRisk.errors.some(e => e.includes("risk")));
    const withApproval = parseProposalInput({ ...validInput, action: { ...validInput.action, approved: true } });
    assert.ok(!withApproval.ok && withApproval.errors.some(e => e.includes("approved")));
  });

  test("rejects unknown actions, non-finite coordinates, zero flow and negative ticks", () => {
    const cases = [
      { ...validInput, action: { kind: "mark_house_clear" } },
      { ...validInput, action: { ...validInput.action, aimPoint: { x: NaN, y: 0, z: 0 } } },
      { ...validInput, action: { ...validInput.action, flowLps: 0 } },
      { ...validInput, createdTick: -1 },
      { ...validInput, proposer: "language_model" },
    ];
    for (const input of cases) assert.equal(parseProposalInput(input).ok, false, JSON.stringify(input));
  });

  test("rejects keys that shadow Object.prototype members (constructor, toString, valueOf)", () => {
    const base = JSON.parse(JSON.stringify(validInput)) as Record<string, unknown>;
    const action: Record<string, unknown> = { ...(base.action as Record<string, unknown>), valueOf: 1 };
    const smuggled: Record<string, unknown> = { ...base, constructor: "x", toString: "y", action };
    const result = parseProposalInput(smuggled);
    assert.ok(!result.ok);
    assert.ok(["constructor", "toString", "valueOf"].every(key => result.errors.some(e => e.includes(key))), result.errors.join("; "));
  });

  test("reports missing fields", () => {
    const { basis: _omitted, ...missing } = validInput;
    void _omitted;
    const result = parseProposalInput(missing);
    assert.ok(!result.ok && result.errors.some(e => e.includes("basis")));
  });
});

describe("event log", () => {
  test("is append-only with gap-free sequence numbers and frozen entries", () => {
    const log = new EventLog("run-1");
    log.append({ tick: 0, source: "system", kind: "run.started", reason: "Run started." });
    const second = log.append({ tick: 5, source: "harness", kind: "proposal.rejected", reason: "No capability.", ruleIds: ["H1"], data: { proposalId: "p1" } });
    assert.deepEqual(log.entries().map(e => e.seq), [1, 2]);
    assert.throws(() => { (second as { reason: string }).reason = "edited"; }, TypeError);
    assert.throws(() => { (second.ruleIds as string[]).push("H2"); }, TypeError);
    const copy = log.entries() as unknown as unknown[];
    copy.pop();
    assert.equal(log.length, 2);
  });

  test("rejects ticks that go backwards and data that is not JSON", () => {
    const log = new EventLog("run-1");
    log.append({ tick: 10, source: "system", kind: "a", reason: "a" });
    assert.throws(() => log.append({ tick: 9, source: "system", kind: "b", reason: "b" }), RangeError);
    assert.throws(() => log.append({ tick: 11, source: "system", kind: "c", reason: "c", data: { bad: NaN } }), TypeError);
    assert.equal(log.length, 1);
  });

  test("exports one canonical JSON object per line", () => {
    const log = new EventLog("run-7");
    log.append({ tick: 1, source: "intake", kind: "report.received", reason: "Typed report.", data: { text: "Someone may be upstairs" } });
    const lines = log.toJsonl().trimEnd().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).runId, "run-7");
  });
});

describe("rescue outcome", () => {
  const base: MissionResult = { label: "simulation_evaluator", runId: "run-1", seed: "s1", endedTick: 9000, budgetTick: 8000, occupants: [], violations: [], droneReturn: "returned" };

  test("a detection without exterior arrival is not a completed rescue", () => {
    const detectedOnly = { ...base, occupants: [{ label: "simulation_evaluator" as const, occupantKey: "o1", outcome: "inside" as const, arrivalTick: null }] };
    assert.equal(isCompletedRescue(detectedOnly), false);
    assert.equal(rescueLabel(detectedOnly), "incomplete_human_assistance_needed");
  });

  test("arrival counts only within budget and without violations; drone return is separate", () => {
    const arrived = { ...base, droneReturn: "not_returned" as const, occupants: [{ label: "simulation_evaluator" as const, occupantKey: "o1", outcome: "reached_assembly_point" as const, arrivalTick: 7000 }] };
    assert.equal(isCompletedRescue(arrived), true);
    assert.equal(isCompletedRescue({ ...arrived, budgetTick: 6999 }), false);
    assert.equal(isCompletedRescue({ ...arrived, violations: [{ tick: 50, kind: "collision", detail: "wall" }] }), false);
  });
});
