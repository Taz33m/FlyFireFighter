import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { TENDER_T1 } from "../../contracts/aircraft.ts";
import { DEFAULT_POLICY } from "../../harness/policy.ts";
import { DecisionBroker } from "./broker.ts";
import { buildCandidateSet } from "./candidates.ts";
import { httpDecisionTransport } from "./client.ts";
import type { FetchLike } from "./gateway.ts";
import { allowedHostsFromEnv, callDecisionsApi, handleDecisionHttpRequest, tokenBucket } from "./gateway.ts";
import { callGeminiApi } from "./gemini-gateway.ts";
import { closedWindowBelief, ENVELOPE, RUN_ID } from "./test-fixtures.ts";

const KEY = "sk-test-not-a-real-key-0123456789";

/**
 * The mission worker's fetch as a browser performs it: the relative URL resolves against the page, and the
 * browser adds the page's Host and, because it is a POST, its Origin. The request is then handled by the
 * gateway with an injected upstream fetch, so nothing leaves the process.
 */
function browserWorkerFetch(pageOrigin: string, allowedHosts: readonly string[], upstreamCalls: string[]): FetchLike {
  return async (url, init) => {
    const target = new URL(url, pageOrigin);
    const request = new Request(target, { method: init.method, body: init.body, signal: init.signal, headers: { ...init.headers, host: target.host, origin: pageOrigin, "sec-fetch-site": "same-origin" } });
    const upstream: FetchLike = async (_upstream, upstreamInit) => {
      const body = JSON.parse(upstreamInit.body) as { questions: { choices: { value: string }[] }[] };
      const chosen = body.questions[0].choices[0].value;
      upstreamCalls.push(chosen);
      return Response.json({ answers: [{ type: "choice", name: "next_action", choice: chosen }] });
    };
    return handleDecisionHttpRequest(request, {
      allowedHosts,
      providers: {
        openai_decisions: { call: (body, signal) => callDecisionsApi(body, { apiKey: KEY, fetch: upstream, signal }), rateLimiter: tokenBucket() },
        gemini: { call: body => callGeminiApi(body, { apiKey: undefined, fetch: upstream }), rateLimiter: tokenBucket() },
      },
    });
  };
}

function plannedRequest() {
  const belief = closedWindowBelief();
  const set = buildCandidateSet({ belief, profile: TENDER_T1, envelope: ENVELOPE, policy: DEFAULT_POLICY });
  const broker = new DecisionBroker({ runId: RUN_ID, cloudEnabled: true, deadlineMs: 2000 });
  const step = broker.plan(set, belief, 0);
  assert.ok(step.send, "the broker sends a request");
  return { broker, request: step.send };
}

describe("worker transport through the gateway's caller checks", () => {
  for (const page of ["http://127.0.0.1:3200", "http://localhost:3200"]) {
    test(`the worker's same-origin fetch from ${page} is admitted and its choice reaches the broker`, async () => {
      const { broker, request } = plannedRequest();
      const upstreamCalls: string[] = [];
      const transport = httpDecisionTransport(browserWorkerFetch(page, allowedHostsFromEnv(undefined), upstreamCalls));
      const body = await transport(request, new AbortController().signal);
      assert.equal(upstreamCalls.length, 1);
      const [decision] = broker.receive(request.requestId, body, 50).decisions;
      assert.equal(decision.decider, "openai_decisions");
    });
  }

  test("a page on a host that is not allowed is refused without an upstream call and the local planner decides", async () => {
    const { broker, request } = plannedRequest();
    const upstreamCalls: string[] = [];
    const transport = httpDecisionTransport(browserWorkerFetch("http://192.168.1.20:3200", allowedHostsFromEnv(undefined), upstreamCalls));
    const body = await transport(request, new AbortController().signal);
    assert.equal(upstreamCalls.length, 0);
    const [decision] = broker.receive(request.requestId, body, 50).decisions;
    assert.equal(decision.decider, "local_planner");
    assert.equal(decision.gatewayStatus, "error");
  });

  test("the same LAN page is admitted once DECISIONS_ALLOWED_HOSTS lists its host", async () => {
    const { broker, request } = plannedRequest();
    const upstreamCalls: string[] = [];
    const transport = httpDecisionTransport(browserWorkerFetch("http://192.168.1.20:3200", allowedHostsFromEnv("192.168.1.20:3200"), upstreamCalls));
    const body = await transport(request, new AbortController().signal);
    assert.equal(upstreamCalls.length, 1);
    assert.equal(broker.receive(request.requestId, body, 50).decisions[0].decider, "openai_decisions");
  });
});
