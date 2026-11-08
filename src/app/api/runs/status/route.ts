/**
 * GET /api/runs/status — whether Atlas persistence is configured and reachable, the database name and the
 * state of each Atlas Search index. Never returns the connection string. Same guard and configuration
 * handling as /api/runs.
 */
import { handleStatusRequest } from "@/lib/persistence/http";
import { routeLimits, runsRouteDeps } from "@/lib/persistence/server";

const limiter = routeLimits.status();

export async function GET(request: Request): Promise<Response> {
  return handleStatusRequest(request, runsRouteDeps(limiter));
}
