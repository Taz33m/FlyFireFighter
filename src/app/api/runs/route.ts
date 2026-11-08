/**
 * /api/runs — simulation run bundles in MongoDB Atlas.
 *
 * GET: saved runs (newest first) with aggregates from an Atlas aggregation pipeline; optional exact filters
 * controller, decider, scenarioId, outcome=completed|incomplete and limit (1–200).
 * POST: save one bundle, body {files: {"results.json", "events.jsonl", "replay.jsonl"?}} as exported by the
 * mission worker (64 MB at most). 201 saved, 200 already stored, 409 a different bundle under that run id,
 * 422 not a valid simulation bundle.
 *
 * MONGODB_URI/MONGODB_DB are read here on the server only and never returned or logged; without
 * MONGODB_URI every reply is 503 {status: "not_configured"}. Only local callers are admitted (Host/Origin
 * allowlist as for /api/decisions, extendable with PERSISTENCE_ALLOWED_HOSTS), each route has its own
 * token bucket. Logic and tests: src/lib/persistence/http.ts.
 */
import { handleListRequest, handleSaveRequest } from "@/lib/persistence/http";
import { routeLimits, runsRouteDeps } from "@/lib/persistence/server";

const listLimiter = routeLimits.list();
const saveLimiter = routeLimits.save();

export async function GET(request: Request): Promise<Response> {
  return handleListRequest(request, runsRouteDeps(listLimiter));
}

export async function POST(request: Request): Promise<Response> {
  return handleSaveRequest(request, runsRouteDeps(saveLimiter));
}
