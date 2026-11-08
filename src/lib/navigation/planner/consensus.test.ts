/**
 * Gemini and consensus deciders, offline: the gateway's consensus over both providers (agreement,
 * disagreement, one provider down, parallel calls), the broker's judgement of Gemini and consensus replies
 * (attribution, fallback, run-wide unconfigured, honesty against a reply that claims more than its
 * proposals show) and the command labels. Upstreams are injected fakes.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { TENDER_T1 } from "../../contracts/aircraft.ts";
import { EventLog } from "../../contracts/events.ts";
import { DEFAULT_POLICY } from "../../harness/policy.ts";
import type { BrokerStep } from "./broker.ts";
import { DecisionBroker, decisionEvent } from "./broker.ts";
import { buildCandidateSet } from "./candidates.ts";
import { decisionUrl, httpDecisionTransport } from "./client.ts";
import type { DecisionHttpOptions, FetchLike } from "./gateway.ts";
import { callDecisionsApi, consensusOf, handleDecisionHttpRequest, tokenBucket } from "./gateway.ts";
import type { GeminiApiBody } from "./gemini-gateway.ts";
import { callGeminiApi } from "./gemini-gateway.ts";
import { closedWindowBelief, ENVELOPE, RUN_ID } from "./test-fixtures.ts";
import type { CloudDecider, DecisionGatewayRequest, ProviderProposal, ProviderStatus } from "./types.ts";

const OPENAI_KEY = "sk-test-not-a-real-key-0123456789";
const GEMINI_KEY = "gemini-test-not-a-real-key-0123456789";
const BREACH = "request_breach:window-rear";

const belief = closedWindowBelief();
const set = buildCandidateSet({ belief, profile: TENDER_T1, envelope: ENVELOPE, policy: DEFAULT_POLICY });

function broker(cloudDecider: CloudDecider): DecisionBroker {
  return new DecisionBroker({ runId: RUN_ID, cloudEnabled: true, cloudDecider, deadlineMs: 2000 });
}

function sent(step: BrokerStep): DecisionGatewayRequest {
  assert.ok(step.send, "a request is sent");
  return step.send;
}

const proposal = (provider: ProviderProposal["provider"], status: ProviderStatus, choice: string | null = null): ProviderProposal => ({ provider, choice, status });

/** A gateway reply as the server would send it, with an explicit top-level claim. */
function reply(request: DecisionGatewayRequest, decider: CloudDecider, proposals: readonly ProviderProposal[], top: { choice: string | null; status: string } = { choice: null, status: "no_consensus" }) {
  return { runId: request.runId, requestId: request.requestId, evidenceRevision: request.evidenceRevision, decider, ...top, proposals };
}

/* Upstream fakes: OpenAI Decisions picks the offered choice at `index`; Gemini likewise; or they fail. */

type Upstream = { readonly fetch: FetchLike; readonly calls: number[] };

function openaiPicking(index: number | "hang", delayMs = 0): Upstream {
  const calls: number[] = [];
  return {
    calls,
    fetch: async (_url, init) => {
      calls.push(Date.now());
      if (index === "hang") return new Promise<Response>(() => undefined);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      const body = JSON.parse(init.body) as { questions: { choices: { value: string }[] }[] };
      return Response.json({ answers: [{ type: "choice", name: "next_action", choice: body.questions[0].choices[index].value }] });
    },
  };
}

function geminiPicking(index: number | "refuse", delayMs = 0): Upstream {
  const calls: number[] = [];
  return {
    calls,
    fetch: async (_url, init) => {
      calls.push(Date.now());
      await new Promise(resolve => setTimeout(resolve, delayMs));
      if (index === "refuse") return Response.json({ promptFeedback: { blockReason: "SAFETY" } });
      const body = JSON.parse(init.body) as GeminiApiBody;
      const chosen = body.generationConfig.responseJsonSchema.properties.choice.enum[index];
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ rationale: "r", choice: chosen }) }] }, finishReason: "STOP" }] });
    },
  };
}

function handlerOptions(openai: Upstream, gemini: Upstream, keys: { openai?: string; gemini?: string } = { openai: OPENAI_KEY, gemini: GEMINI_KEY }, timeoutMs?: number): DecisionHttpOptions {
  return {
    providers: {
      openai_decisions: { call: (request, signal) => callDecisionsApi(request, { apiKey: keys.openai, fetch: openai.fetch, signal, timeoutMs }), rateLimiter: tokenBucket(100, 100) },
      gemini: { call: (request, signal) => callGeminiApi(request, { apiKey: keys.gemini, fetch: gemini.fetch, signal, timeoutMs }), rateLimiter: tokenBucket(100, 100) },
    },
  };
}

function plannedRequest(decider: CloudDecider) {
  const b = broker(decider);
  return { broker: b, request: sent(b.plan(set, belief, 0)) };
}

async function consensusOver(openai: Upstream, gemini: Upstream, keys?: { openai?: string; gemini?: string }, timeoutMs?: number) {
  const { broker: b, request } = plannedRequest("consensus");
  const response = await handleDecisionHttpRequest(new Request("http://127.0.0.1:3200/api/decisions?provider=consensus", {
    method: "POST",
    headers: { host: "127.0.0.1:3200", origin: "http://127.0.0.1:3200", "content-type": "application/json" },
    body: JSON.stringify(request),
  }), handlerOptions(openai, gemini, keys, timeoutMs));
  const body = await response.json() as { decider: string; choice: string | null; status: string; proposals: ProviderProposal[] };
  return { broker: b, request, response, body };
}

describe("consensus agreement", () => {
  const offered = new Set(["a", "b", "defer"]);

  test("agreed only when exactly one OpenAI and one Gemini proposal both chose the same offered id", () => {
    assert.deepEqual(consensusOf([proposal("openai_decisions", "ok", "a"), proposal("gemini", "ok", "a")], offered), { agreement: "agreed", choice: "a" });
    assert.deepEqual(consensusOf([proposal("openai_decisions", "ok", "a"), proposal("gemini", "ok", "b")], offered), { agreement: "disagreed", choice: null });
    assert.deepEqual(consensusOf([proposal("openai_decisions", "ok", "a"), proposal("gemini", "timeout")], offered), { agreement: "incomplete", choice: null });
    assert.deepEqual(consensusOf([proposal("openai_decisions", "ok", "zzz"), proposal("gemini", "ok", "zzz")], offered), { agreement: "incomplete", choice: null }, "an id that was not offered never agrees");
    assert.deepEqual(consensusOf([proposal("openai_decisions", "ok", "a"), proposal("openai_decisions", "ok", "a")], offered), { agreement: "incomplete", choice: null }, "two OpenAI proposals are not a consensus");
    assert.deepEqual(consensusOf([proposal("gemini", "ok", "a")], offered), { agreement: "incomplete", choice: null });
  });
});

describe("consensus through the gateway and the broker", () => {
  test("both models choose the same id: the reply is ok and the broker credits the consensus, still behind the commander", async () => {
    const openai = openaiPicking(0);
    const gemini = geminiPicking(0);
    const { broker: b, request, response, body } = await consensusOver(openai, gemini);
    assert.equal(response.status, 200);
    const chosen = request.candidates[0].id;
    assert.deepEqual(body, { runId: request.runId, requestId: request.requestId, evidenceRevision: request.evidenceRevision, decider: "consensus", choice: chosen, status: "ok", proposals: [proposal("openai_decisions", "ok", chosen), proposal("gemini", "ok", chosen)] });
    const [decision] = b.receive(request.requestId, body, 900).decisions;
    assert.equal(decision.decider, "consensus");
    assert.equal(decision.candidateId, chosen);
    assert.equal(decision.fallbackReason, null);
    assert.equal(decision.cloud?.agreement, "agreed");
    assert.deepEqual(decision.cloud?.proposals, body.proposals);
    if (decision.proposal !== null) assert.equal(decision.proposal.proposer, "consensus_planner");
    assert.equal(decisionEvent(decision, 1).data?.deciderLabel, "Consensus: OpenAI Decisions + Gemini");
  });

  test("a consensus breach keeps the application's proposal and the commander gate", () => {
    const { broker: b, request } = plannedRequest("consensus");
    const agreed = [proposal("openai_decisions", "ok", BREACH), proposal("gemini", "ok", BREACH)];
    const [decision] = b.receive(request.requestId, reply(request, "consensus", agreed, { choice: BREACH, status: "ok" }), 10).decisions;
    const local = set.candidates.find(candidate => candidate.id === BREACH);
    assert.equal(decision.decider, "consensus");
    assert.equal(decision.requiresCommanderApproval, true);
    assert.deepEqual({ ...decision.proposal, proposer: "local_planner" }, local?.proposal, "only the attribution differs");
  });

  test("the models disagree: the local planner decides, labelled as consensus not reached, with both proposals kept", async () => {
    const { broker: b, request, body } = await consensusOver(openaiPicking(0), geminiPicking(1));
    assert.equal(body.status, "no_consensus");
    assert.equal(body.choice, null);
    assert.equal(body.proposals.length, 2);
    const [decision] = b.receive(request.requestId, body, 900).decisions;
    assert.equal(decision.decider, "local_planner");
    assert.equal(decision.candidateId, decision.localChoiceId);
    assert.equal(decision.gatewayStatus, "no_consensus");
    assert.equal(decision.cloud?.agreement, "disagreed");
    assert.deepEqual(decision.cloud?.proposals.map(p => p.choice), [request.candidates[0].id, request.candidates[1].id]);
    assert.match(decision.fallbackReason ?? "", /^Local planner \(consensus not reached: the models disagreed: OpenAI Decisions chose ".+", Gemini chose ".+"\)\.$/);
    assert.equal(decisionEvent(decision, 1).data?.deciderLabel, "Local planner");
    assert.equal(b.cloudActive, true, "disagreement does not end cloud planning");
  });

  test("Gemini unconfigured: no Gemini call, the local planner decides and the rest of the run stays local", async () => {
    const gemini = geminiPicking(0);
    const { broker: b, request, body } = await consensusOver(openaiPicking(0), gemini, { openai: OPENAI_KEY, gemini: undefined });
    assert.equal(gemini.calls.length, 0);
    assert.deepEqual(body.proposals.map(p => p.status), ["ok", "unconfigured"]);
    const [decision] = b.receive(request.requestId, body, 50).decisions;
    assert.equal(decision.decider, "local_planner");
    assert.equal(decision.cloud?.agreement, "incomplete");
    assert.match(decision.fallbackReason ?? "", /consensus not reached: OpenAI Decisions chose ".+", Gemini is not configured on the server/);
    assert.equal(b.cloudActive, false);
    const next = closedWindowBelief({ evidenceRevision: 13 });
    const step = b.plan(buildCandidateSet({ belief: next, profile: TENDER_T1, envelope: ENVELOPE, policy: DEFAULT_POLICY }), next, 60);
    assert.equal(step.send, null);
    assert.equal(step.decisions[0].decider, "local_planner");
  });

  test("one provider times out or refuses: the local planner decides, and the calls ran in parallel", async () => {
    const openai = openaiPicking("hang");
    const gemini = geminiPicking(0, 40);
    const started = Date.now();
    const timedOut = await consensusOver(openai, gemini, undefined, 150);
    assert.ok(Date.now() - started < 600, "the deadline is per request, not the sum of the two calls");
    assert.equal(openai.calls.length, 1);
    assert.equal(gemini.calls.length, 1);
    assert.ok(Math.abs(openai.calls[0] - gemini.calls[0]) < 40, "both providers were asked at the same time");
    assert.deepEqual(timedOut.body.proposals.map(p => p.status), ["timeout", "ok"]);
    const [late] = timedOut.broker.receive(timedOut.request.requestId, timedOut.body, 200).decisions;
    assert.equal(late.decider, "local_planner");
    assert.match(late.fallbackReason ?? "", /OpenAI Decisions timed out, Gemini chose/);

    const refused = await consensusOver(openaiPicking(0), geminiPicking("refuse"));
    const [declined] = refused.broker.receive(refused.request.requestId, refused.body, 50).decisions;
    assert.equal(declined.decider, "local_planner");
    assert.match(declined.fallbackReason ?? "", /Gemini declined to choose/);
  });

  test("honesty: a reply whose top level claims agreement while its proposals disagree is not credited", () => {
    const { broker: b, request } = plannedRequest("consensus");
    const forged = reply(request, "consensus", [proposal("openai_decisions", "ok", BREACH), proposal("gemini", "ok", "defer")], { choice: BREACH, status: "ok" });
    const [decision] = b.receive(request.requestId, forged, 10).decisions;
    assert.equal(decision.decider, "local_planner");
    assert.equal(decision.cloud?.agreement, "disagreed");
  });

  test("honesty: a single-provider reply is not accepted as a consensus, nor an OpenAI reply as Gemini's", () => {
    const consensus = plannedRequest("consensus");
    const single = reply(consensus.request, "openai_decisions", [proposal("openai_decisions", "ok", BREACH)], { choice: BREACH, status: "ok" });
    const first = consensus.broker.receive(consensus.request.requestId, single, 10);
    assert.equal(first.decisions[0].decider, "local_planner");
    assert.equal(first.discarded[0].reason, "mismatched_reply");

    const gemini = plannedRequest("gemini");
    const fromOpenai = reply(gemini.request, "openai_decisions", [proposal("openai_decisions", "ok", BREACH)], { choice: BREACH, status: "ok" });
    const second = gemini.broker.receive(gemini.request.requestId, fromOpenai, 10);
    assert.equal(second.decisions[0].decider, "local_planner");
    assert.equal(second.discarded[0].reason, "mismatched_reply");
  });

  test("a consensus proposal naming an id that was not offered is recorded as invalid and discarded", () => {
    const { broker: b, request } = plannedRequest("consensus");
    const step = b.receive(request.requestId, reply(request, "consensus", [proposal("openai_decisions", "ok", "approve_all"), proposal("gemini", "ok", "approve_all")]), 10);
    assert.equal(step.decisions[0].decider, "local_planner");
    assert.deepEqual(step.decisions[0].cloud?.proposals.map(p => p.status), ["invalid", "invalid"]);
    assert.equal(step.discarded.filter(d => d.reason === "unknown_candidate").length, 2);
  });

  test("both models defer: the local planner decides", () => {
    const { broker: b, request } = plannedRequest("consensus");
    const [decision] = b.receive(request.requestId, reply(request, "consensus", [proposal("openai_decisions", "ok", "defer"), proposal("gemini", "ok", "defer")], { choice: "defer", status: "ok" }), 10).decisions;
    assert.equal(decision.decider, "local_planner");
    assert.equal(decision.cloud?.agreement, "agreed");
    assert.match(decision.fallbackReason ?? "", /both deferred/);
  });

  test("a throttled consensus request (no proposals) and the worker's deadline fall back as consensus not reached", () => {
    const throttled = plannedRequest("consensus");
    const [decision] = throttled.broker.receive(throttled.request.requestId, reply(throttled.request, "consensus", [], { choice: null, status: "error" }), 10).decisions;
    assert.equal(decision.decider, "local_planner");
    assert.equal(decision.gatewayStatus, "error");
    assert.match(decision.fallbackReason ?? "", /^Local planner \(consensus not reached: /);

    const slow = plannedRequest("consensus");
    const [timedOut] = slow.broker.poll(2000).decisions;
    assert.equal(timedOut.gatewayStatus, "timeout");
    assert.equal(timedOut.fallbackReason, "Local planner (consensus not reached: no reply within 2000 ms).");
    assert.equal(timedOut.cloud?.agreement, "incomplete");
  });
});

describe("Gemini decider in the broker", () => {
  test("an offered Gemini choice is credited to Gemini and attributed to the Gemini planner", () => {
    const { broker: b, request } = plannedRequest("gemini");
    const [decision] = b.receive(request.requestId, reply(request, "gemini", [proposal("gemini", "ok", BREACH)], { choice: BREACH, status: "ok" }), 300).decisions;
    assert.equal(decision.decider, "gemini");
    assert.equal(decision.proposal?.proposer, "gemini_planner");
    assert.equal(decision.requiresCommanderApproval, true);
    assert.deepEqual(decision.cloud, { decider: "gemini", proposals: [proposal("gemini", "ok", BREACH)], agreement: null });
  });

  for (const status of ["refused", "invalid", "timeout", "error"] as const) {
    test(`Gemini "${status}" falls back to the local planner and names Gemini in the reason`, () => {
      const { broker: b, request } = plannedRequest("gemini");
      const [decision] = b.receive(request.requestId, reply(request, "gemini", [proposal("gemini", status)], { choice: null, status }), 10).decisions;
      assert.equal(decision.decider, "local_planner");
      assert.equal(decision.gatewayStatus, status);
      assert.match(decision.fallbackReason ?? "", /^Gemini /);
    });
  }

  test("Gemini unconfigured keeps the rest of the run local", () => {
    const { broker: b, request } = plannedRequest("gemini");
    b.receive(request.requestId, reply(request, "gemini", [proposal("gemini", "unconfigured")], { choice: null, status: "unconfigured" }), 10);
    assert.equal(b.cloudActive, false);
  });

  test("the worker's transport reaches the Gemini route through the caller guard and the choice reaches the broker", async () => {
    const { broker: b, request } = plannedRequest("gemini");
    const gemini = geminiPicking(0);
    const workerFetch: FetchLike = async (url, init) => {
      const target = new URL(url, "http://127.0.0.1:3200");
      const forwarded = new Request(target, { method: init.method, body: init.body, signal: init.signal, headers: { ...init.headers, host: target.host, origin: "http://127.0.0.1:3200" } });
      return handleDecisionHttpRequest(forwarded, handlerOptions(openaiPicking(0), gemini));
    };
    const body = await httpDecisionTransport(workerFetch, decisionUrl("gemini"))(request, new AbortController().signal);
    assert.equal(gemini.calls.length, 1);
    assert.equal(b.receive(request.requestId, body, 50).decisions[0].decider, "gemini");
  });

  test("decision URLs: OpenAI keeps the plain route; Gemini and consensus add the provider parameter", () => {
    assert.equal(decisionUrl("openai_decisions"), "/api/decisions");
    assert.equal(decisionUrl("gemini"), "/api/decisions?provider=gemini");
    assert.equal(decisionUrl("consensus"), "/api/decisions?provider=consensus");
  });
});

describe("label honesty", () => {
  test("the command label names a model only when its choice was used, and the event records both proposals", () => {
    const consensus = plannedRequest("consensus");
    const [agreed] = consensus.broker.receive(consensus.request.requestId, reply(consensus.request, "consensus", [proposal("openai_decisions", "ok", BREACH), proposal("gemini", "ok", BREACH)], { choice: BREACH, status: "ok" }), 10).decisions;
    const other = plannedRequest("consensus");
    const [split] = other.broker.receive(other.request.requestId, reply(other.request, "consensus", [proposal("openai_decisions", "ok", BREACH), proposal("gemini", "error")]), 10).decisions;
    const gemini = plannedRequest("gemini");
    const [geminiChoice] = gemini.broker.receive(gemini.request.requestId, reply(gemini.request, "gemini", [proposal("gemini", "ok", BREACH)], { choice: BREACH, status: "ok" }), 10).decisions;

    // The command view's labels (mission/view.ts) are checked in src/lib/mission/decider-view.test.ts: planner
    // code and tests never import mission or simulation modules.

    const log = new EventLog(RUN_ID);
    const agreedEvent = log.append(decisionEvent(agreed, 1000));
    assert.equal(agreedEvent.source, "decisions_gateway");
    assert.match(agreedEvent.reason, /^Consensus: OpenAI Decisions \+ Gemini selected: .*individual approval/);
    assert.equal(agreedEvent.data.agreement, "agreed");
    assert.equal(agreedEvent.data.cloudDecider, "consensus");
    const splitEvent = log.append(decisionEvent(split, 1001));
    assert.equal(splitEvent.source, "planner");
    assert.equal(splitEvent.data.deciderLabel, "Local planner");
    assert.equal(splitEvent.data.agreement, "incomplete");
    assert.deepEqual(splitEvent.data.proposals, [{ provider: "openai_decisions", choice: BREACH, status: "ok" }, { provider: "gemini", choice: null, status: "error" }]);
    assert.match(splitEvent.reason, /^Local planner selected: /);
    assert.equal(log.append(decisionEvent(geminiChoice, 1002)).data.deciderLabel, "Gemini");
  });
});
