"use client";

import type { CommanderConsole as ConsoleState } from "@/hooks/useCommanderConsole";
import styles from "./CommanderConsole.module.css";
import { ConsoleScreenCanvas } from "./ConsoleScreenCanvas";

type Tone = "ok" | "warn" | "muted";

function endedLine(c: ConsoleState): { readonly text: string; readonly tone: Tone } {
  if (c.error !== null) return { text: `Console not connected: ${c.error} The on-screen controls keep working.`, tone: "warn" };
  if (c.snapshot?.status === "closed") return { text: "Console closed. The on-screen controls keep working.", tone: "muted" };
  return { text: "Console disconnected. The on-screen controls keep working.", tone: "warn" };
}

function openLine(snap: ConsoleState["snapshot"]): { readonly text: string; readonly tone: Tone } {
  if (snap === null || snap.status === "connecting" || snap.status === "waiting") return { text: "Port open; asking the device who it is…", tone: "muted" };
  if (snap.status !== "connected") return { text: snap.detail ?? "The console cannot be used.", tone: "warn" };
  if (!snap.buttonsLive) return { text: "Connected; waiting for button events…", tone: "muted" };
  if (snap.abortPrimed) return { text: "Press red again (or keep holding) to abort the mission.", tone: "warn" };
  return { text: `Connected (${snap.product ?? "FWOG main"}): GREEN approve, YELLOW reject, RED twice or hold 1 s to abort.`, tone: "ok" };
}

function statusLine(c: ConsoleState): { readonly text: string; readonly tone: Tone } {
  if (!c.supported) return { text: "Web Serial is not available in this browser (use Chrome or Edge). The on-screen controls work as usual.", tone: "muted" };
  if (c.phase === "idle") return { text: "Not connected. The on-screen controls and keyboard work as usual.", tone: "muted" };
  if (c.phase === "choosing") return { text: "Choose the FWOG main port named \"Board CDC\" in the browser dialog…", tone: "muted" };
  return c.phase === "ended" ? endedLine(c) : openLine(c.snapshot);
}

function displayLine(c: ConsoleState): string | null {
  if (c.phase !== "open" || c.snapshot?.status !== "connected") return null;
  const pending = c.device.digest;
  if (pending === null) return `Device shows "${c.device.text}".`;
  if (c.snapshot.device?.digest === pending) return `Device shows "${c.device.text}" for #${pending.slice(0, 8)} (confirmed).`;
  return "The device has not confirmed this proposal; console approval is held until it does.";
}

/** Free-WiLi commander console: connect control, status, and a mirror of what the device screen shows. */
export function CommanderConsole({ state: c }: { readonly state: ConsoleState }) {
  const status = statusLine(c);
  const display = displayLine(c);
  const open = c.phase === "open" || c.phase === "choosing";
  return <section className={styles.console} aria-label="Free-WiLi commander console">
    <div className={styles.row}>
      <span className={styles.title}>Free-WiLi console</span>
      <span className={styles.status} data-tone={status.tone} role="status">{status.text}</span>
      {c.supported && (open
        ? <button type="button" onClick={c.disconnect} disabled={c.phase === "choosing"}>Disconnect console</button>
        : <button type="button" onClick={c.connect}>{c.phase === "ended" ? "Reconnect console" : "Connect console"}</button>)}
    </div>
    {(display !== null || c.note !== null) && <div className={styles.row}>
      {display !== null && <span className="muted small">{display}</span>}
      {c.note !== null && <span className="small">Console: {c.note}</span>}
    </div>}
    <details open>
      <summary className={styles.summary}>Console screen</summary>
      <ConsoleScreenCanvas spec={c.spec} className={styles.mirror} label="Console screen (320 × 240)" />
    </details>
  </section>;
}
