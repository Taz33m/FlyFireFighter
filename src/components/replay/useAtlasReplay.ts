/**
 * /replay?atlas=<runId>: load a simulation run saved in MongoDB Atlas as a RunBundle (validated like any
 * other bundle), and list recent Atlas runs for the stage's run picker. Only the bundle on stage is kept in
 * memory (a recording can be tens of megabytes once parsed; shared 16 GB Mac).
 */
import { useEffect, useState } from "react";
import { fetchAtlasBundle, fetchAtlasRuns } from "@/components/results/atlas-client";
import type { AtlasRunSummary } from "@/components/results/atlas-wire";
import type { RunBundle } from "@/components/results/bundle";

export type AtlasReplay =
  | { readonly state: "none" }
  | { readonly state: "loading"; readonly runId: string }
  | { readonly state: "loaded"; readonly runId: string; readonly bundle: RunBundle }
  | { readonly state: "error"; readonly runId: string; readonly message: string };

export type AtlasRunList = { readonly state: "loading" } | { readonly state: "unavailable" } | { readonly state: "listed"; readonly runs: readonly AtlasRunSummary[] };

type Loaded = { readonly ok: true; readonly bundle: RunBundle } | { readonly ok: false; readonly message: string };

const RECENT_RUNS = 30;

export function useAtlasReplay(runId: string | null): { readonly replay: AtlasReplay; readonly runs: AtlasRunList } {
  const [loaded, setLoaded] = useState<Readonly<Record<string, Loaded>>>({});
  const [runs, setRuns] = useState<AtlasRunList>({ state: "loading" });
  const current = runId === null ? undefined : loaded[runId];

  useEffect(() => {
    const controller = new AbortController();
    fetchAtlasRuns({ limit: RECENT_RUNS }, controller.signal).then(reply => setRuns(reply.status === "ok" ? { state: "listed", runs: reply.runs } : { state: "unavailable" })).catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (runId === null || current !== undefined) return;
    const controller = new AbortController();
    fetchAtlasBundle(runId, controller.signal)
      .then(load => setLoaded({ [runId]: load.ok ? { ok: true, bundle: load.bundle } : { ok: false, message: load.message } }))
      .catch(error => { if (!controller.signal.aborted) setLoaded({ [runId]: { ok: false, message: error instanceof Error ? error.message : String(error) } }); });
    return () => controller.abort();
  }, [runId, current]);

  const replay: AtlasReplay = runId === null ? { state: "none" }
    : current === undefined ? { state: "loading", runId }
    : current.ok ? { state: "loaded", runId, bundle: current.bundle } : { state: "error", runId, message: current.message };
  return { replay, runs };
}
