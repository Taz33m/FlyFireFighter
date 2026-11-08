"use client";

/**
 * Replay position and playback on the simulated clock, shared by the results page's replay panel and the
 * projector replay page. Frames are recorded at ≤ 10 Hz of simulation time; playback advances the playhead
 * by recorded ticks, never by re-running anything.
 */
import { useEffect, useRef, useState } from "react";
import type { ReplayFrame } from "@/lib/mission/protocol";
import { advancePlayback, initialPlayback, playbackForFrames, seekPlayback, togglePlayback } from "./playback-state";

export const SPEEDS = [0.5, 1, 2, 4, 8, 16] as const;
const TICKS_PER_S = 100;

export function usePlayback(frames: readonly ReplayFrame[]) {
  const [state, setState] = useState(() => initialPlayback(frames));
  const current = playbackForFrames(state, frames);
  // Adjust before effects run: reloading this run need not change the parent component's React key.
  if (current !== state) setState(current);
  const { index, playing } = current;
  const playbackRef = useRef(current);
  const [speed, setSpeed] = useState<number>(1);
  useEffect(() => { playbackRef.current = current; }, [current]);
  useEffect(() => {
    if (!playing || frames.length === 0) return;
    let raf = 0;
    let last = performance.now();
    let cursor = playbackRef.current;
    let simTick = frames[cursor.index]?.tick ?? frames[0].tick;
    const step = (now: number) => {
      simTick += ((now - last) / 1000) * TICKS_PER_S * speed;
      last = now;
      cursor = advancePlayback(cursor, simTick);
      // A callback queued by an old recording must not update the replacement recording.
      setState(previous => previous.frames === frames && previous.playing ? advancePlayback(previous, simTick) : previous);
      if (cursor.playing) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, frames]);
  const seek = (i: number) => setState(previous => seekPlayback(playbackForFrames(previous, frames), i));
  const toggle = () => setState(previous => togglePlayback(playbackForFrames(previous, frames)));
  return { index, playing, speed, setSpeed, seek, toggle };
}

export type Playback = ReturnType<typeof usePlayback>;
