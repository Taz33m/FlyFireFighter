/** Recorded-clock playback transitions; no simulator or browser APIs. */
export type PlaybackFrames = readonly { readonly tick: number }[];

export interface PlaybackState {
  readonly frames: PlaybackFrames;
  readonly index: number;
  readonly playing: boolean;
}

export function initialPlayback(frames: PlaybackFrames): PlaybackState {
  return { frames, index: 0, playing: false };
}

/** A replacement export can have the same run id but a different frame count or contents. */
export function playbackForFrames(state: PlaybackState, frames: PlaybackFrames): PlaybackState {
  return state.frames === frames ? state : initialPlayback(frames);
}

function boundedIndex(frames: PlaybackFrames, index: number): number {
  if (frames.length === 0 || !Number.isFinite(index)) return 0;
  return Math.min(frames.length - 1, Math.max(0, Math.trunc(index)));
}

export function seekPlayback(state: PlaybackState, index: number): PlaybackState {
  return { ...state, index: boundedIndex(state.frames, index), playing: false };
}

export function togglePlayback(state: PlaybackState): PlaybackState {
  if (state.frames.length === 0) return state;
  const index = !state.playing && state.index >= state.frames.length - 1 ? 0 : state.index;
  return { ...state, index, playing: !state.playing };
}

/** Advance only to recorded frames at or before the playhead and stop on the last one. */
export function advancePlayback(state: PlaybackState, tick: number): PlaybackState {
  if (!state.playing || state.frames.length === 0 || !Number.isFinite(tick)) return state;
  let index = boundedIndex(state.frames, state.index);
  while (index + 1 < state.frames.length && state.frames[index + 1].tick <= tick) index++;
  const playing = index < state.frames.length - 1;
  return index === state.index && playing === state.playing ? state : { ...state, index, playing };
}
