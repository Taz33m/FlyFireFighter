"use client";

import { useState } from "react";
import type { RunId } from "@/lib/contracts/ids";
import type { UiCommand } from "@/lib/mission/protocol";
import { DEFAULT_SCENARIO } from "./scenarios";

/** `example` is the running scenario's default report (scenarios.ts), offered by "Use example". */
export function ReportIntake({ runId, send, example = DEFAULT_SCENARIO.exampleReport }: { readonly runId: RunId | null; readonly send: (command: UiCommand) => void; readonly example?: string }) {
  const [text, setText] = useState("");
  const [source, setSource] = useState<"judge" | "caller">("judge");
  const trimmed = text.trim();
  const submit = () => {
    if (runId === null || trimmed === "") return;
    send({ type: "report", runId, text: trimmed, channel: "typed", source });
    setText("");
  };
  return <form className="intake" onSubmit={event => { event.preventDefault(); submit(); }} aria-label="Report intake">
    <textarea rows={2} value={text} placeholder={example} onChange={e => setText(e.target.value)} disabled={runId === null} aria-label="Report text" maxLength={500} />
    <div className="intake-row">
      <label>From
        <select value={source} onChange={e => setSource(e.target.value as "judge" | "caller")} disabled={runId === null}>
          <option value="judge">Judge</option>
          <option value="caller">Caller</option>
        </select>
      </label>
      <button type="button" onClick={() => setText(example)} disabled={runId === null}>Use example</button>
      <button type="submit" className="primary" disabled={runId === null || trimmed === ""}>Record report</button>
    </div>
    <p className="muted small">The rescue record keeps the reporter&apos;s exact words.</p>
  </form>;
}
