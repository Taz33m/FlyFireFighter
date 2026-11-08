/**
 * GET /api/runs/search?q=…[&runId=…][&limit=…] — search mission logs: Atlas Search (fuzzy full text with
 * highlights) over events.reason and decisions.rationale, or a literal case-insensitive match while the
 * Search indexes are missing or building (the reply's `mode` and `note` say which). Same guard,
 * configuration and limits as /api/runs.
 */
import { handleSearchRequest } from "@/lib/persistence/http";
import { routeLimits, runsRouteDeps } from "@/lib/persistence/server";

const limiter = routeLimits.search();

export async function GET(request: Request): Promise<Response> {
  return handleSearchRequest(request, runsRouteDeps(limiter));
}
