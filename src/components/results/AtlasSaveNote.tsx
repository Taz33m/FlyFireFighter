"use client";

import Link from "next/link";
import type { AtlasSaveNote as Note } from "@/hooks/useAtlasAutoSave";

/** One honest line about whether the finished simulation run was saved to MongoDB Atlas. */
export function AtlasSaveNote({ note }: { readonly note: Note }) {
  if (note.kind === "hidden") return null;
  const text = (() => {
    switch (note.kind) {
      case "fixture": return "Not saved to Atlas: UI fixture, not a simulation run.";
      case "checking": return "Checking Atlas persistence…";
      case "exporting": return `Saving simulation run ${note.runId} to Atlas: exporting the bundle…`;
      case "saving": return `Saving simulation run ${note.runId} to Atlas…`;
      case "saved": return note.existed ? `Saved to Atlas: simulation run ${note.runId} was already stored.` : `Saved to Atlas: simulation run ${note.runId}.`;
      case "not_saved": return `Not saved to Atlas: ${note.reason}`;
    }
  })();
  return <p className={`small atlas-note ${note.kind === "saved" ? "ok" : note.kind === "not_saved" || note.kind === "fixture" ? "warn" : "muted"}`} role="status">
    {text}
    {note.kind === "saved" && <> <Link href="/results">Results</Link> · <Link href={`/replay?atlas=${encodeURIComponent(note.runId)}`}>Replay</Link></>}
  </p>;
}
