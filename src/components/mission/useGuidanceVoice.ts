"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { MissionView } from "@/lib/mission/protocol";
import type { GuidanceVoiceStatus } from "./guidance-voice";
import { GuidanceVoice, browserSpeechOutput, speechActivation } from "./guidance-voice";

/**
 * Plays the drone's guidance speech through the browser's local speech engine while `enabled` (default off in
 * the caller). Reads only the truth-free MissionView. Views arrive several times a second while a run is
 * live, which is often enough for the voice's waits and repeats.
 */
export function useGuidanceVoice(view: MissionView | null, enabled: boolean): GuidanceVoiceStatus {
  const [voice] = useState(() => new GuidanceVoice(browserSpeechOutput()));

  useEffect(() => {
    voice.update({
      runId: view?.runId ?? null,
      status: view?.status ?? null,
      activation: speechActivation(view),
      dispatchConfirmed: view !== null && view.belief.dispatchConfirmed !== null,
      enabled,
      nowMs: performance.now(),
    });
  }, [voice, view, enabled]);

  useEffect(() => () => voice.stop(), [voice]);

  return useSyncExternalStore(voice.subscribe, voice.getStatus, voice.getStatus);
}
