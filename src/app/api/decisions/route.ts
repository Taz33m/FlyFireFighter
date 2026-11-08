/**
 * POST /api/decisions — bounded mission decisions through OpenAI Decisions, Gemini or their consensus.
 *
 * The `provider` query parameter selects the decider: absent or "openai_decisions" asks OpenAI Decisions,
 * "gemini" asks Gemini, "consensus" asks both in parallel over the same request. The body is {runId,
 * requestId, evidenceRevision, evidence, candidates: [{id, description}]}; the reply is {runId, requestId,
 * evidenceRevision, decider, choice, status, proposals: [{provider, choice, status}]}. Consensus replies
 * "ok" only when both providers chose the same offered id, otherwise "no_consensus"; the worker re-derives
 * the agreement from the proposals itself.
 *
 * OPENAI_API_KEY and GEMINI_API_KEY are read here, on the server only, and are never returned or logged.
 * A provider without its key answers "unconfigured" without a network call and the mission worker uses its
 * local planner. A model chooses an offered candidate id and nothing else: the worker resolves the id to its
 * own proposal and the harness validates it and obtains any commander approval.
 *
 * Only local callers are admitted: Host must be 127.0.0.1:3200, localhost:3200 or an entry of the optional
 * comma-separated DECISIONS_ALLOWED_HOSTS, and an Origin header, when sent, must name one of those hosts;
 * otherwise 403 with no upstream call. Admitted, valid requests take a token from each asked provider's
 * per-process bucket (burst 5, 30 per minute); excess gets 429 with no upstream call. The mission worker's
 * same-origin fetch sends the page's Origin and Host and passes. Residual risk, accepted for a single-machine
 * demo: this is not authentication, so a local process that can reach 127.0.0.1:3200 can still spend the
 * keys within the rate limits.
 */
import { callGeminiApi } from "@/lib/navigation/planner/gemini-gateway";
import { allowedHostsFromEnv, callDecisionsApi, handleDecisionHttpRequest, tokenBucket } from "@/lib/navigation/planner/gateway";

const openaiRateLimiter = tokenBucket();
const geminiRateLimiter = tokenBucket();

export async function POST(request: Request): Promise<Response> {
  const fetchUpstream = (url: string, init: RequestInit) => fetch(url, init);
  return handleDecisionHttpRequest(request, {
    allowedHosts: allowedHostsFromEnv(process.env.DECISIONS_ALLOWED_HOSTS),
    providers: {
      openai_decisions: { call: (body, signal) => callDecisionsApi(body, { apiKey: process.env.OPENAI_API_KEY, fetch: fetchUpstream, signal }), rateLimiter: openaiRateLimiter },
      gemini: { call: (body, signal) => callGeminiApi(body, { apiKey: process.env.GEMINI_API_KEY, fetch: fetchUpstream, signal }), rateLimiter: geminiRateLimiter },
    },
  });
}
