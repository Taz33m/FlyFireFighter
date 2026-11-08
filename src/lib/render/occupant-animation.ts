/**
 * Pure animation logic for the rigged occupant (no three.js): which clip a RenderSnapshot animation
 * plays, crossfade state between clips, walk playback rate from the occupant's measured speed, and the
 * frozen pose used for drone-camera captures and reduced motion.
 *
 * Clip names match the actions in public/actors/occupant.glb (assets/actors/build_scan_occupant.py). Native
 * locomotion speeds come from that build's occupant.provenance.json: the source clips' root drift scaled to
 * the scanned character's hip height.
 */
import type { RenderSnapshot } from "../mission/protocol.ts";

export type OccupantAnimation = RenderSnapshot["occupants"][number]["animation"];
export type ClipName = OccupantAnimation;

export const CLIP_NAMES: readonly ClipName[] = ["idle", "crouch", "cough", "walk", "follow"];

/** What the loaded figure actually is; matches the `label` in public/actors/occupant.provenance.json. */
export const CHARACTER_LABEL = "Simulated occupant — scanned character (Mike Alger, CC BY 4.0) with Rocketbox animations (MIT); fictional person";

/** Crossfade length between clips, seconds. */
export const FADE_S = 0.3;
/** Simulation ticks per second (RenderSnapshot.tick). */
export const TICK_HZ = 100;
/** Speed of the source clips before root motion was removed (m/s); provenance `nativeSpeedMps`. */
export const NATIVE_SPEED_MPS: Readonly<Partial<Record<ClipName, number>>> = { walk: 1.043, follow: 0.847 };
/** Representative clip time for a frozen pose: mid-stride for locomotion, mid-cough for the cough. */
export const FROZEN_TIME_S: Readonly<Record<ClipName, number>> = { idle: 0, crouch: 0, cough: 1.2, walk: 0.4, follow: 0.4 };
const RATE_MIN = 0.6;
const RATE_MAX = 1.6;
const MOVING_MPS = 0.05;

/** The clip for a snapshot animation; anything unrecognised plays idle rather than failing. */
export function clipFor(animation: string): ClipName {
  return (CLIP_NAMES as readonly string[]).includes(animation) ? (animation as ClipName) : "idle";
}

/** Playback rate so feet roughly match ground speed; non-locomotion clips and unknown speed play at 1. */
export function playbackRate(clip: ClipName, speedMps: number | null): number {
  const native = NATIVE_SPEED_MPS[clip];
  if (native === undefined || speedMps === null || !Number.isFinite(speedMps) || speedMps < MOVING_MPS) return 1;
  return Math.min(RATE_MAX, Math.max(RATE_MIN, speedMps / native));
}

export interface BlendState {
  readonly current: ClipName;
  /** The clip fading out, or null when no fade is running. */
  readonly previous: ClipName | null;
  /** Fade progress 0 → 1 (the weight of `current`). */
  readonly fade: number;
  /** Playback time of each clip that has played, seconds, wrapped to its duration. */
  readonly times: Readonly<Partial<Record<ClipName, number>>>;
}

export interface ClipWeight {
  readonly clip: ClipName;
  readonly time: number;
  readonly weight: number;
}

export function initialBlend(clip: ClipName): BlendState {
  return { current: clip, previous: null, fade: 1, times: { [clip]: 0 } };
}

function wrap(time: number, duration: number): number {
  if (!(duration > 0)) return 0;
  const t = time % duration;
  return t < 0 ? t + duration : t;
}

/**
 * Advance the blend by dtS toward `target`. A new target starts a crossfade from whichever clip was
 * dominant, and the clip fading in starts from its beginning; going back to the clip that was fading
 * out reverses the fade. Pure: returns a new state.
 */
export function stepBlend(state: BlendState, target: ClipName, dtS: number, durations: Readonly<Partial<Record<ClipName, number>>>, rate = 1): BlendState {
  const dt = Math.max(0, Number.isFinite(dtS) ? dtS : 0);
  let { current, previous, fade } = state;
  const times: Partial<Record<ClipName, number>> = { ...state.times };
  if (target !== current) {
    if (target === previous) {
      // Returning to the clip that was fading out: reverse the fade so weights stay continuous.
      previous = current;
      fade = 1 - fade;
    } else {
      // A third clip interrupts a fade: fade out from whichever clip is dominant.
      previous = previous !== null && fade < 0.5 ? previous : current;
      fade = 0;
      times[target] = 0;
    }
    current = target;
  }
  fade = Math.min(1, fade + dt / FADE_S);
  if (fade >= 1) previous = null;
  for (const clip of previous === null ? [current] : [current, previous]) {
    const r = clip === current ? rate : 1;
    times[clip] = wrap((times[clip] ?? 0) + dt * r, durations[clip] ?? 0);
  }
  return { current, previous, fade, times };
}

/** Clip weights for a blend state; they always sum to 1. */
export function blendWeights(state: BlendState): ClipWeight[] {
  const now: ClipWeight = { clip: state.current, time: state.times[state.current] ?? 0, weight: state.previous === null ? 1 : state.fade };
  if (state.previous === null) return [now];
  return [now, { clip: state.previous, time: state.times[state.previous] ?? 0, weight: 1 - state.fade }];
}

/** Deterministic pose for a snapshot animation: no clock, no crossfade, no dependency on history. */
export function frozenWeights(animation: string, durations: Readonly<Partial<Record<ClipName, number>>>): ClipWeight[] {
  const clip = clipFor(animation);
  return [{ clip, time: wrap(FROZEN_TIME_S[clip], durations[clip] ?? 0), weight: 1 }];
}

export interface SpeedEstimate {
  readonly tick: number;
  readonly x: number;
  readonly y: number;
  readonly speedMps: number | null;
}

/**
 * Horizontal ground speed from successive snapshots, by simulation ticks (not wall time), smoothed.
 * Unchanged ticks keep the estimate; a reset, a backwards tick or a gap over one second restarts it.
 */
export function updateSpeed(previous: SpeedEstimate | null, tick: number, x: number, y: number): SpeedEstimate {
  if (previous === null || tick < previous.tick || tick - previous.tick > TICK_HZ) return { tick, x, y, speedMps: null };
  if (tick === previous.tick) return previous;
  const instant = Math.hypot(x - previous.x, y - previous.y) / ((tick - previous.tick) / TICK_HZ);
  const speedMps = previous.speedMps === null ? instant : previous.speedMps + 0.3 * (instant - previous.speedMps);
  return { tick, x, y, speedMps };
}
