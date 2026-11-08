/**
 * Auto-save a finished simulation run to MongoDB Atlas.
 *
 * When the mission worker has posted the evaluator outcome for the current run, the hook asks
 * /api/runs/status whether persistence is configured and reachable. Only then does it request the run's
 * bundle from the worker (the existing export_run message) and POST it to /api/runs once. It never saves a
 * UI-fixture run: those are not simulation runs. The returned note says plainly what happened ("Saved to
 * Atlas", "not saved" and why), for the workspace to show.
 */
import { useEffect, useRef, useState } from "react";
import { fetchAtlasStatus, saveBundleToAtlas } from "@/components/results/atlas-client";
import type { AtlasBundleFiles } from "@/components/results/atlas-wire";
import type { UiCommand } from "@/lib/mission/protocol";
import type { MissionUiState } from "./useMissionWorker";

export type AtlasSaveNote =
  | { readonly kind: "hidden" }
  | { readonly kind: "fixture" }
  | { readonly kind: "checking"; readonly runId: string }
  | { readonly kind: "not_saved"; readonly runId: string; readonly reason: string }
  | { readonly kind: "exporting"; readonly runId: string }
  | { readonly kind: "saving"; readonly runId: string }
  | { readonly kind: "saved"; readonly runId: string; readonly existed: boolean };

type Check = { readonly ok: true } | { readonly ok: false; readonly reason: string };
type Saved = { readonly ok: true; readonly existed: boolean } | { readonly ok: false; readonly reason: string };

/** The exported files as a bundle to upload, or null when the export lacks results.json or events.jsonl. */
export function bundleFiles(files: { readonly [name: string]: string }): AtlasBundleFiles | null {
  const results = files["results.json"];
  const events = files["events.jsonl"];
  if (typeof results !== "string" || typeof events !== "string") return null;
  const replay = files["replay.jsonl"];
  return typeof replay === "string" && replay !== "" ? { "results.json": results, "events.jsonl": events, "replay.jsonl": replay } : { "results.json": results, "events.jsonl": events };
}

async function checkPersistence(): Promise<Check> {
  const reply = await fetchAtlasStatus();
  if (reply.status === "not_configured") return { ok: false, reason: "Atlas persistence is not configured (MONGODB_URI is unset)." };
  if (reply.status !== "ok") return { ok: false, reason: reply.message };
  return reply.reachable ? { ok: true } : { ok: false, reason: "Atlas is configured but could not be reached." };
}

async function upload(files: AtlasBundleFiles): Promise<Saved> {
  const reply = await saveBundleToAtlas(files);
  if (!("message" in reply)) return { ok: true, existed: reply.status === "exists" };
  const detail = "errors" in reply && reply.errors !== undefined && reply.errors.length > 0 ? ` (${reply.errors[0]})` : "";
  return { ok: false, reason: `${reply.message}${detail}` };
}

function noteFor(runId: string, check: Check | undefined, saved: Saved | undefined, exported: MissionUiState["exportFiles"]): AtlasSaveNote {
  if (check === undefined) return { kind: "checking", runId };
  if (!check.ok) return { kind: "not_saved", runId, reason: check.reason };
  if (saved !== undefined) return saved.ok ? { kind: "saved", runId, existed: saved.existed } : { kind: "not_saved", runId, reason: saved.reason };
  if (exported?.runId !== runId) return { kind: "exporting", runId };
  return bundleFiles(exported.files) === null ? { kind: "not_saved", runId, reason: "The run export has no results.json/events.jsonl." } : { kind: "saving", runId };
}

export function useAtlasAutoSave(state: MissionUiState, send: (command: UiCommand) => void): AtlasSaveNote {
  const [checks, setChecks] = useState<Readonly<Record<string, Check>>>({});
  const [saves, setSaves] = useState<Readonly<Record<string, Saved>>>({});
  const checking = useRef(new Set<string>());
  const requested = useRef(new Set<string>());
  const posted = useRef(new Set<string>());
  // An export the commander made before the outcome lacks the evaluator result: never upload that one.
  const stale = useRef<MissionUiState["exportFiles"]>(null);
  const finished = state.source === "worker" && state.outcome !== null ? state.runId : null;
  const check = finished === null ? undefined : checks[finished];

  // 1. Once per finished run: is persistence configured and reachable?
  useEffect(() => {
    if (finished === null || checking.current.has(finished)) return;
    checking.current.add(finished);
    void checkPersistence().then(result => setChecks(c => ({ ...c, [finished]: result })));
  }, [finished]);

  // 2. Then ask the worker for a fresh bundle, which now includes the evaluator result.
  useEffect(() => {
    if (finished === null || check?.ok !== true || requested.current.has(finished)) return;
    requested.current.add(finished);
    stale.current = state.exportFiles;
    send({ type: "export_run", runId: finished });
  }, [finished, check, send, state.exportFiles]);

  // 3. Upload the export once it arrives.
  useEffect(() => {
    const exported = state.exportFiles;
    if (exported === null || exported === stale.current || !requested.current.has(exported.runId) || posted.current.has(exported.runId)) return;
    const files = bundleFiles(exported.files);
    if (files === null) return;
    posted.current.add(exported.runId);
    void upload(files).then(result => setSaves(s => ({ ...s, [exported.runId]: result })));
  }, [state.exportFiles]);

  if (state.source === "fixture") return state.outcome === null ? { kind: "hidden" } : { kind: "fixture" };
  if (finished === null) return { kind: "hidden" };
  return noteFor(finished, check, saves[finished], state.exportFiles);
}
