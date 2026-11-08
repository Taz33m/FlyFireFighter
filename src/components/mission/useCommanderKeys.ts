"use client";

import { useEffect, useRef, useState } from "react";
import type { MissionUiState } from "@/hooks/useMissionWorker";
import type { UiCommand } from "@/lib/mission/protocol";
import type { DisplayedDigest } from "./approval";
import { noteDisplayed } from "./approval";
import type { EscapeMemory, KeyTargetLike } from "./commander-keys";
import { ABORT_DOUBLE_TAP_MS, NO_ESCAPE, interpretKey } from "./commander-keys";

interface Options {
  readonly state: Pick<MissionUiState, "runId" | "view">;
  readonly send: (command: UiCommand) => void;
  /** Commander for abort before the first view arrives (state.config?.commanderId ?? DEFAULT_CONFIG.commanderId). */
  readonly commanderId: string;
  readonly enabled?: boolean;
}

/**
 * Global A / R / Esc-Esc commander shortcuts (commander-keys.ts). Tracks when the action card's digest was first
 * displayed, so the keyboard honours the same review delay as the Approve button. Returns whether the first Esc
 * of an abort double tap is waiting, for an on-screen "press Esc again to abort" hint.
 */
export function useCommanderKeys({ state, send, commanderId, enabled = true }: Options): { readonly abortPrimed: boolean } {
  const [abortPrimed, setAbortPrimed] = useState(false);
  const latest = useRef({ state, send, commanderId });
  const displayed = useRef<DisplayedDigest | null>(null);
  const escape = useRef<EscapeMemory>(NO_ESCAPE);
  const digest = state.view?.pendingApproval?.proposal.digest ?? null;

  useEffect(() => {
    latest.current = { state, send, commanderId };
  });

  // The action card renders the same view in the same commit, so this is when the digest went on screen.
  useEffect(() => {
    displayed.current = noteDisplayed(displayed.current, digest, performance.now());
  }, [digest]);

  useEffect(() => {
    if (!enabled) return;
    let clearPrime: ReturnType<typeof setTimeout> | undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      const { state: current, send: deliver, commanderId: fallback } = latest.current;
      const target: KeyTargetLike | null = event.target instanceof HTMLElement ? event.target : null;
      // Chrome's autofill fires keydown events without a key.
      const key = typeof event.key === "string" ? event.key : "";
      const result = interpretKey({ key, repeat: event.repeat, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey, isComposing: event.isComposing, target }, {
        runId: current.runId,
        view: current.view,
        commanderId: fallback,
        displayed: displayed.current,
        dialogOpen: document.querySelector("dialog[open]") !== null,
        nowMs: performance.now(),
        escape: escape.current,
      });
      escape.current = result.escape;
      const primed = result.escape.primedAtMs !== null;
      setAbortPrimed(primed);
      clearTimeout(clearPrime);
      if (primed) clearPrime = setTimeout(() => setAbortPrimed(false), ABORT_DOUBLE_TAP_MS);
      if (result.command === null) return;
      event.preventDefault();
      deliver(result.command);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      clearTimeout(clearPrime);
    };
  }, [enabled]);

  return { abortPrimed: enabled && abortPrimed };
}
