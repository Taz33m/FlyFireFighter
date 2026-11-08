"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { DisplayedDigest } from "@/components/mission/approval";
import { APPROVAL_ARMING_MS, noteDisplayed } from "@/components/mission/approval";
import type { Gesture } from "@/components/mission/console/buttons";
import { decideGesture } from "@/components/mission/console/decide";
import type { ScreenSpec } from "@/components/mission/console/screens";
import { deriveScreen, overlayText, screenDigest } from "@/components/mission/console/screens";
import type { ConsoleSnapshot, DeviceScreen } from "@/components/mission/console/session";
import { ConsoleSession } from "@/components/mission/console/session";
import { requestConsolePort, webSerial, webSerialTransport } from "@/components/mission/console/web-serial";
import type { PhaseRailState } from "@/components/mission/phases";
import type { MissionUiState } from "@/hooks/useMissionWorker";
import type { UiCommand } from "@/lib/mission/protocol";

/** How long a console note ("Review delay…", "Approve p-3") stays in the status line. */
const NOTE_MS = 4000;
/** Session tick: button polling (every POLL_MS), hold detection, acknowledgement timeouts. */
const TICK_MS = 50;

interface Options {
  readonly state: Pick<MissionUiState, "runId" | "view">;
  readonly send: (command: UiCommand) => void;
  /** Commander for abort before the first view arrives. */
  readonly commanderId: string;
  readonly rail: PhaseRailState | null;
}

export type ConsolePhase = "idle" | "choosing" | "open" | "ended";

export interface CommanderConsole {
  /** Web Serial is available in this browser. */
  readonly supported: boolean;
  readonly phase: ConsolePhase;
  readonly snapshot: ConsoleSnapshot | null;
  /** The console screen, drawn full size in the on-screen mirror (render.ts). */
  readonly spec: ScreenSpec;
  /** What the device itself shows under OG firmware v024: one short line. */
  readonly device: DeviceScreen;
  /** The last console decision or refusal, for the status line. */
  readonly note: string | null;
  readonly error: string | null;
  /** Must run inside a click handler: Web Serial needs a user gesture to choose the port. */
  readonly connect: () => void;
  readonly disconnect: () => void;
}

const subscribeNothing = () => () => {};

/**
 * The Free-WiLi commander console: a Web Serial connection whose button gestures become the same UiCommands
 * the action card sends (console/decide.ts), and whose display shows the pending decision. Tracks when the
 * action card's digest went on screen, so the console honours the card's review delay.
 */
export function useCommanderConsole({ state, send, commanderId, rail }: Options): CommanderConsole {
  const supported = useSyncExternalStore(subscribeNothing, () => webSerial() !== null, () => false);
  const [phase, setPhase] = useState<ConsolePhase>("idle");
  const [snapshot, setSnapshot] = useState<ConsoleSnapshot | null>(null);
  const [note, setNote] = useState<{ readonly text: string; readonly id: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const session = useRef<ConsoleSession | null>(null);
  const latest = useRef({ state, send, commanderId });
  const screenShown = useRef<DisplayedDigest | null>(null);
  const decided = useRef<{ runId: string | null; digests: Set<string> }>({ runId: null, digests: new Set() });
  const noteId = useRef(0);
  const digest = state.view?.pendingApproval?.proposal.digest ?? null;

  useEffect(() => {
    latest.current = { state, send, commanderId };
  });

  // The action card renders the same view in the same commit, so this is when the digest went on screen.
  useEffect(() => {
    screenShown.current = noteDisplayed(screenShown.current, digest, performance.now());
  }, [digest]);

  // The same review delay as the action card's Approve button, for the screen's "hold" state.
  const [armedDigest, setArmedDigest] = useState<string | null>(null);
  useEffect(() => {
    if (digest === null) return;
    const timer = setTimeout(() => setArmedDigest(digest), APPROVAL_ARMING_MS);
    return () => clearTimeout(timer);
  }, [digest]);

  const spec = useMemo(() => deriveScreen({ view: state.view, rail, armed: digest !== null && armedDigest === digest }), [state.view, rail, digest, armedDigest]);
  const text = overlayText(spec);
  const shownDigest = screenDigest(spec, state.view);
  const device = useMemo<DeviceScreen>(() => ({ text, digest: shownDigest }), [text, shownDigest]);

  const screenRef = useRef(device);
  useEffect(() => {
    screenRef.current = device;
    session.current?.show(device);
  }, [device]);

  useEffect(() => {
    if (note === null) return;
    const timer = setTimeout(() => setNote(current => (current?.id === note.id ? null : current)), NOTE_MS);
    return () => clearTimeout(timer);
  }, [note]);

  const onGesture = useCallback((gesture: Gesture) => {
    const { state: current, send: deliver, commanderId: fallback } = latest.current;
    if (decided.current.runId !== current.runId) decided.current = { runId: current.runId, digests: new Set() };
    const result = decideGesture(gesture, {
      runId: current.runId,
      view: current.view,
      commanderId: fallback,
      screen: screenShown.current,
      device: session.current?.snapshot().device ?? null,
      decided: decided.current.digests,
      dialogOpen: document.querySelector("dialog[open]") !== null,
      nowMs: performance.now(),
    });
    noteId.current += 1;
    setNote({ text: result.reason, id: noteId.current });
    if (result.command === null) return;
    if (result.decidedDigest !== null) decided.current.digests.add(result.decidedDigest);
    deliver(result.command);
  }, []);

  const connect = useCallback(() => {
    const serial = webSerial();
    if (serial === null || session.current !== null) return;
    setError(null);
    setPhase("choosing");
    void (async () => {
      try {
        const port = await requestConsolePort(serial);
        const next = new ConsoleSession(webSerialTransport(port), {
          now: () => performance.now(),
          onGesture,
          onChange: snap => {
            setSnapshot(snap);
            if (snap.status === "disconnected" || snap.status === "closed") {
              if (session.current === next) session.current = null;
              setPhase("ended");
            }
          },
        });
        session.current = next;
        setPhase("open");
        await next.start();
        // The firmware's first frame enables display writes; the session's tick then sends this screen.
        next.show(screenRef.current);
      } catch (cause) {
        session.current = null;
        const cancelled = cause instanceof DOMException && cause.name === "NotFoundError";
        setPhase(cancelled ? "idle" : "ended");
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
  }, [onGesture]);

  const disconnect = useCallback(() => {
    const current = session.current;
    session.current = null;
    if (current !== null) void current.close();
  }, []);

  // Drive hold detection, acknowledgement timeouts and countdown refreshes while a session is open.
  useEffect(() => {
    if (phase !== "open") return;
    const timer = setInterval(() => session.current?.tick(), TICK_MS);
    return () => clearInterval(timer);
  }, [phase]);

  // Leaving the page closes the port and restores the device menu.
  useEffect(() => () => { void session.current?.close(); session.current = null; }, []);

  const mirror: ScreenSpec = phase === "ended" && snapshot?.status === "disconnected" ? { kind: "disconnected" } : spec;
  return { supported, phase, snapshot, spec: mirror, device, note: note?.text ?? null, error, connect, disconnect };
}
