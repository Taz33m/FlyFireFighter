/**
 * H19 (extinguishing agent) and H14's look before spraying again, through the ActionHarness and the rule
 * table. Scope: the deterministic harness fixtures (test-fixtures.ts: a fictional house with the standard
 * hallway fire upstairs and a kitchen downstairs) with authored reports and crew confirmations, stepped tick by
 * tick with no motion requests. Nothing here is simulator output.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ActionProposal, Finding, ProposalRecord } from "../contracts/actions.ts";
import type { Tick } from "../contracts/clock.ts";
import { EventLog } from "../contracts/events.ts";
import type { BeliefSnapshot, CallerReport, CrewConfirmation, HazardEvidence } from "../contracts/evidence.ts";
import { vec3 } from "../contracts/frames.ts";
import { sphere } from "../contracts/geometry.ts";
import { digestOf } from "../contracts/canonical.ts";
import type { SubmitResult } from "./harness.ts";
import { ActionHarness } from "./harness.ts";
import type { SprayDischarge } from "./respray.ts";
import { sprayDischarges } from "./respray.ts";
import { fireClassDisclosure, validateProposal } from "./rules.ts";
import {
  approveCommand,
  breachInput,
  executeCommand,
  FIRE_OBS_ID,
  fireHazard,
  fireObservation,
  makeBelief,
  makeContext,
  observation,
  RUN_ID,
  sprayAction,
  sprayBelief,
  sprayInput,
  T0,
} from "./test-fixtures.ts";

const NO_INDICATOR = "Extinguishing agent (H19): water. Fire class not confirmed; no cooking, fuel or electrical indicator near it.";

function report(id: string, originalText: string, source: CallerReport["source"] = "caller"): CallerReport {
  return { id, runId: RUN_ID, receivedTick: T0 - 100, source, channel: "typed", originalText, roomHint: null, countText: null, interpretation: "rules", supersedes: null };
}

function crew(id: string, text: string): CrewConfirmation {
  return { id, tick: T0 - 50, crewId: "engine-1", trackId: null, reportIds: [], roomId: null, text };
}

function withEvidence(belief: BeliefSnapshot, reports: readonly CallerReport[], crewConfirmations: readonly CrewConfirmation[] = []): BeliefSnapshot {
  return { ...belief, reports, crewConfirmations };
}

function newHarness(): ActionHarness {
  return new ActionHarness(RUN_ID, new EventLog(RUN_ID));
}

function ids(result: SubmitResult): { id: string; digest: string } {
  if (result.proposalId === null || result.digest === null) throw new Error(`submission refused: ${JSON.stringify(result.findings)}`);
  return { id: result.proposalId, digest: result.digest };
}

function record(harness: ActionHarness, id: string): ProposalRecord {
  const found = harness.record(id);
  assert.ok(found, `no record ${id}`);
  return found;
}

function ruleIds(findings: readonly Finding[]): string[] {
  return [...new Set(findings.map(f => f.ruleId))].sort();
}

/** Run a short spray (30 ticks from T0 + 10) to completion; returns its proposal id. It ends at T0 + 39. */
function completedSpray(harness: ActionHarness): string {
  const proposal = ids(harness.submit(sprayInput({}, { durationTicks: 30 }), makeContext(sprayBelief(T0))));
  assert.equal(harness.approve(approveCommand(proposal.id, proposal.digest, T0 + 5), makeContext(sprayBelief(T0 + 5))).status, "approved");
  assert.equal(harness.requestExecution(executeCommand(proposal.id, proposal.digest, "req-1", T0 + 10), makeContext(sprayBelief(T0 + 10))).status, "executing");
  for (let tick = T0 + 10; tick <= T0 + 39; tick++) harness.step(makeContext(sprayBelief(tick)), null);
  assert.equal(record(harness, proposal.id).status, "completed");
  assert.equal(record(harness, proposal.id).execution?.endedTick, T0 + 39);
  return proposal.id;
}

describe("H19 extinguishing agent", () => {
  test("refuses a spray for each water-unsafe class a report indicates, naming the class and the report", () => {
    const cases: [string, RegExp][] = [
      ["A pan of oil caught fire.", /cooking-oil or grease fire \(class K\/F\): caller report r-1 mentions "pan", "oil"/],
      ["It smells of gasoline in the hall.", /flammable-liquid or gas fire \(class B\): caller report r-1 mentions "gasoline"/],
      ["Sparks came out of the outlet.", /live electrical fire \(class C\): caller report r-1 mentions "Sparks", "outlet"/],
    ];
    for (const [text, reason] of cases) {
      const result = newHarness().submit(sprayInput(), makeContext(withEvidence(sprayBelief(T0), [report("r-1", text)])));
      assert.equal(result.accepted, false, text);
      assert.deepEqual(ruleIds(result.findings), ["H19"], `${text}: only the agent rule refuses`);
      assert.match(result.findings[0].reason, /^Water is this aircraft's only extinguishing agent and must not be used here\. Water is unsafe for a possible /);
      assert.match(result.findings[0].reason, reason);
      assert.deepEqual(result.findings[0].evidenceIds, [FIRE_OBS_ID], "the assessed fire sighting is cited");
    }
  });

  test("refuses a spray at a fire in the prior's kitchen with no report at all", () => {
    const fire: HazardEvidence = { observationId: "obs-kitchen-fire", tick: T0 - 20, hazard: "fire", region: sphere(vec3(10, 2, 0.4), 0.3), intensity: 0.7 };
    const belief = makeBelief(T0, { position: vec3(8, 2, 1.0), hazards: [fire], observations: [observation(fire.observationId, fire.tick, null, { modality: "thermal", detections: [{ kind: "hazard", hazard: "fire", region: fire.region, intensity: 0.7 }] })] });
    const input = sprayInput({ citedEvidence: [fire.observationId] }, { standoff: vec3(8, 2, 1.0), aimPoint: vec3(10, 2, 0.5) });
    const proposal: ActionProposal = { ...input, id: `${RUN_ID}/p1`, digest: digestOf(input) };
    const findings = validateProposal({ phase: "submit", proposal, ctx: makeContext(belief), state: { runId: RUN_ID, missionAborted: false, lastInterventionTick: null, sprays: [] }, status: "proposed", approval: null }).filter(f => f.ruleId === "H19");
    assert.equal(findings.length, 1);
    assert.match(findings[0].reason, /cooking-oil or grease fire \(class K\/F\): the fire is in the Kitchen \(floor-plan prior: a kitchen\)\.$/);
  });

  test("with no indicator it allows water and discloses the unconfirmed class at submission and approval", () => {
    const harness = newHarness();
    const submitted = harness.submit(sprayInput(), makeContext(withEvidence(sprayBelief(T0), [report("r-1", "Someone may be in the upstairs rear bedroom.")])));
    assert.equal(submitted.status, "awaiting_approval", JSON.stringify(submitted.findings));
    const proposal = ids(submitted);
    assert.ok(record(harness, proposal.id).history.at(-1)?.reason.endsWith(NO_INDICATOR), record(harness, proposal.id).history.at(-1)?.reason);
    const approved = harness.approve(approveCommand(proposal.id, proposal.digest, T0 + 5), makeContext(sprayBelief(T0 + 5)));
    assert.equal(approved.status, "approved");
    assert.ok(approved.reason.endsWith(NO_INDICATOR), approved.reason);
    assert.equal(fireClassDisclosure(breachInput().action, makeContext(sprayBelief(T0))), null, "only a spray carries the agent disclosure");
  });

  test("a crew's de-energized statement resolves an electrical report, and the approval reason says so", () => {
    const belief = withEvidence(sprayBelief(T0), [report("r-1", "Sparks came out of the outlet.")], [crew("c-1", "Power is off, breakers tripped")]);
    const harness = newHarness();
    const submitted = harness.submit(sprayInput(), makeContext(belief));
    assert.equal(submitted.status, "awaiting_approval", JSON.stringify(submitted.findings));
    assert.match(record(harness, ids(submitted).id).history.at(-1)?.reason ?? "", /Extinguishing agent \(H19\): water\. Fire class not confirmed; every cooking, fuel or electrical indicator near it is resolved\. Resolved: .*crew confirmation c-1 \(engine-1\): "Power is off"/);
  });

  test("a report arriving after submission invalidates the spray at approval", () => {
    const harness = newHarness();
    const proposal = ids(harness.submit(sprayInput(), makeContext(sprayBelief(T0))));
    const result = harness.approve(approveCommand(proposal.id, proposal.digest, T0 + 5), makeContext(withEvidence(sprayBelief(T0 + 5), [report("r-1", "It's a grease fire")])));
    assert.equal(result.status, "invalidated");
    assert.deepEqual(ruleIds(result.findings), ["H19"]);
  });

  test("a report arriving mid-spray stops the discharge that tick", () => {
    const harness = newHarness();
    const proposal = ids(harness.submit(sprayInput(), makeContext(sprayBelief(T0))));
    harness.approve(approveCommand(proposal.id, proposal.digest, T0 + 5), makeContext(sprayBelief(T0 + 5)));
    assert.equal(harness.requestExecution(executeCommand(proposal.id, proposal.digest, "req-1", T0 + 10), makeContext(sprayBelief(T0 + 10))).status, "executing");
    const arrival: Tick = T0 + 30;
    const belief = (tick: Tick) => (tick < arrival ? sprayBelief(tick) : withEvidence(sprayBelief(tick), [report("r-1", "The wiring in the wall is burning")]));
    let waterAfter = 0;
    for (let tick = T0 + 10; tick <= arrival + 10; tick++) {
      const batch = harness.step(makeContext(belief(tick)), null);
      if (tick >= arrival) waterAfter += batch.commands.reduce((sum, c) => sum + (c.kind === "water" ? c.volumeL : 0), 0);
    }
    const stopped = record(harness, proposal.id);
    assert.equal(stopped.status, "invalidated");
    assert.equal(stopped.execution?.endedTick, arrival);
    assert.deepEqual(ruleIds(stopped.findings), ["H19"]);
    assert.equal(waterAfter, 0, "no water once the report is in the belief");
  });
});

describe("H14: look before spraying again", () => {
  test("after a completed spray, another at the same fire is refused until a sighting after the spray still shows flame", () => {
    const harness = newHarness();
    const first = completedSpray(harness);
    const at = T0 + 60;
    const again = (hazards: readonly HazardEvidence[]) => harness.submit(sprayInput({ createdTick: at }), makeContext(sprayBelief(at, { hazards })));

    const stale = again([fireHazard()]);
    assert.equal(stale.accepted, false);
    assert.deepEqual(ruleIds(stale.findings), ["H14"]);
    assert.match(stale.findings[0].reason, new RegExp(`last seen burning at tick 700, before spray proposal ${first.replace(/[/]/g, "\\/")}, which reached it, ended at tick ${T0 + 39}\\. Look at it again first`));

    const out = again([fireHazard(), { ...fireHazard(T0 + 50), intensity: 0 }]);
    assert.deepEqual(ruleIds(out.findings), ["H14"]);
    assert.match(out.findings[0].reason, /show no flame/);

    const stillBurning = again([fireHazard(), fireHazard(T0 + 50)]);
    assert.equal(stillBurning.status, "awaiting_approval", JSON.stringify(stillBurning.findings));
  });

  test("a sighting during the spray is not enough, and a spray elsewhere or one that put out no water does not count", () => {
    const running: SprayDischarge = { proposalId: `${RUN_ID}/p9`, action: sprayAction() as SprayDischarge["action"], endedTick: null };
    const elsewhere: SprayDischarge = { proposalId: `${RUN_ID}/p8`, action: sprayAction({ standoff: vec3(1, 2, 4.2), aimPoint: vec3(2, 3, 4.2) }) as SprayDischarge["action"], endedTick: T0 - 10 };
    const check = (sprays: readonly SprayDischarge[], hazards: readonly HazardEvidence[]) => {
      const input = sprayInput();
      const proposal: ActionProposal = { ...input, id: `${RUN_ID}/p1`, digest: digestOf(input) };
      return validateProposal({ phase: "submit", proposal, ctx: makeContext(sprayBelief(T0, { hazards, observations: [fireObservation(T0 - 5)] })), state: { runId: RUN_ID, missionAborted: false, lastInterventionTick: null, sprays }, status: "proposed", approval: null }).filter(f => f.ruleId === "H14");
    };
    assert.equal(check([running], [fireHazard(T0 - 5)]).length, 1, "a spray still discharging: no sighting can postdate it");
    assert.deepEqual(check([elsewhere], [fireHazard()]), [], "a spray whose sector never reached the fire");
    assert.deepEqual(check([{ ...running, endedTick: T0 - 10 }], [fireHazard(T0 - 5)]), [], "a flame seen after the spray ended");

    const base = { proposal: { ...sprayInput(), id: `${RUN_ID}/p2`, digest: "d" }, risk: "consequential" as const, approval: null, findings: [], history: [] };
    const execution = (dischargedL: number) => ({ proposalId: `${RUN_ID}/p2`, startedTick: T0, endedTick: T0 + 3, requestIds: [], effects: { waterDischargedL: dischargedL, strikeDelivered: false, payloadReleased: false, cuesIssued: 0, ticksExecuted: 3 }, stopReason: null });
    assert.deepEqual(sprayDischarges([{ ...base, status: "aborted", execution: execution(0) }]), [], "stopped before any water left");
    assert.equal(sprayDischarges([{ ...base, status: "invalidated", execution: execution(0.06) }])[0]?.endedTick, T0 + 3);
    assert.equal(sprayDischarges([{ ...base, status: "executing", execution: { ...execution(0), endedTick: null } }])[0]?.endedTick, null);
    assert.deepEqual(sprayDischarges([{ ...base, status: "awaiting_approval", execution: null }]), []);
  });

  test("regression: the standard hallway fire stays sprayable with no earlier spray", () => {
    const result = newHarness().submit(sprayInput(), makeContext(sprayBelief(T0)));
    assert.equal(result.status, "awaiting_approval", JSON.stringify(result.findings));
  });
});
