/**
 * The command view's decider label and status (mission/view.ts) name a model only when its choice was used:
 * consensus credited only on agreement, Gemini on its own choice, the local planner otherwise. Records come
 * from the real broker judging injected replies, as in the planner's consensus tests.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { TENDER_T1 } from "../contracts/aircraft.ts";
import { DEFAULT_POLICY } from "../harness/policy.ts";
import { DecisionBroker } from "../navigation/planner/broker.ts";
import { buildCandidateSet } from "../navigation/planner/candidates.ts";
import { closedWindowBelief, ENVELOPE, RUN_ID } from "../navigation/planner/test-fixtures.ts";
import type { CloudDecider, DecisionGatewayRequest, ProviderProposal, ProviderStatus } from "../navigation/planner/types.ts";
import { deciderView } from "./view.ts";

const BREACH = "request_breach:window-rear";
const belief = closedWindowBelief();
const set = buildCandidateSet({ belief, profile: TENDER_T1, envelope: ENVELOPE, policy: DEFAULT_POLICY });
const proposal = (provider: ProviderProposal["provider"], status: ProviderStatus, choice: string | null = null): ProviderProposal => ({ provider, choice, status });

function decide(decider: CloudDecider, proposals: readonly ProviderProposal[], top: { choice: string | null; status: string }) {
  const broker = new DecisionBroker({ runId: RUN_ID, cloudEnabled: true, cloudDecider: decider, deadlineMs: 2000 });
  const step = broker.plan(set, belief, 0);
  assert.ok(step.send);
  const request: DecisionGatewayRequest = step.send;
  const body = { runId: request.runId, requestId: request.requestId, evidenceRevision: request.evidenceRevision, decider, ...top, proposals };
  const [decision] = broker.receive(request.requestId, body, 10).decisions;
  return decision;
}

describe("decider labels in the command view", () => {
  test("a model is named only when its choice was used", () => {
    const agreed = decide("consensus", [proposal("openai_decisions", "ok", BREACH), proposal("gemini", "ok", BREACH)], { choice: BREACH, status: "ok" });
    const split = decide("consensus", [proposal("openai_decisions", "ok", BREACH), proposal("gemini", "error")], { choice: null, status: "no_consensus" });
    const geminiChoice = decide("gemini", [proposal("gemini", "ok", BREACH)], { choice: BREACH, status: "ok" });
    assert.equal(deciderView(agreed, "consensus", true, false).label, "Consensus: OpenAI Decisions + Gemini");
    assert.equal(deciderView(geminiChoice, "gemini", true, false).label, "Gemini");
    const fallback = deciderView(split, "consensus", true, false);
    assert.equal(fallback.label, "Local planner", "OpenAI's lone choice is not credited in consensus mode");
    assert.match(fallback.status, /^Local planner \(consensus not reached: OpenAI Decisions chose ".+", Gemini was unavailable\)\.$/);
    assert.equal(deciderView(null, "consensus", true, false).label, "Local planner");
    assert.equal(deciderView(null, "consensus", false, false).status, "Local planner (consensus not reached: a model is not configured on the server)");
  });
});
