/**
 * GET /api/runs/[runId] — one saved simulation run as its bundle files (results.json, events.jsonl rebuilt
 * from the events collection, replay.jsonl from GridFS), for /results and /replay. Hash checks made while
 * rebuilding are returned as problems. Same guard, configuration and limits as /api/runs.
 */
import { handleBundleRequest } from "@/lib/persistence/http";
import { routeLimits, runsRouteDeps } from "@/lib/persistence/server";

const limiter = routeLimits.bundle();

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }): Promise<Response> {
  const { runId } = await context.params;
  return handleBundleRequest(request, runId, runsRouteDeps(limiter));
}
