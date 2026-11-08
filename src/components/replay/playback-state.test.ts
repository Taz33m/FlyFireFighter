/** Playback state only: recorded timing, replacement exports, seeking and empty recordings; no 3D view. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { advancePlayback, initialPlayback, playbackForFrames, seekPlayback, togglePlayback } from "./playback-state.ts";

const frames = [0, 10, 25, 40, 100].map(tick => ({ tick }));

test("replacing a playing recording with a shorter export resets and pauses the playhead", () => {
  const playing = advancePlayback(togglePlayback(initialPlayback(frames)), 50);
  assert.equal(playing.index, 3);
  assert.equal(playing.playing, true);
  const shorter = frames.slice(0, 2);
  const replaced = playbackForFrames(playing, shorter);
  assert.equal(replaced.frames, shorter);
  assert.equal(replaced.index, 0);
  assert.equal(replaced.playing, false);
  assert.equal(advancePlayback(replaced, 500), replaced, "old playback ticks cannot advance a paused replacement");
  const restarted = advancePlayback(togglePlayback(replaced), 10);
  assert.equal(restarted.index, 1);
  assert.equal(restarted.playing, false);
});

test("an unchanged recording keeps its playhead; even equal-length replacement content resets it", () => {
  const playing = advancePlayback(togglePlayback(initialPlayback(frames)), 30);
  assert.equal(playbackForFrames(playing, frames), playing);
  const revised = frames.map(frame => ({ tick: frame.tick + 200 }));
  const replaced = playbackForFrames(playing, revised);
  assert.equal(replaced.index, 0);
  assert.equal(replaced.playing, false);
});

test("empty recordings stay paused at index zero through load, seek and play", () => {
  const empty = playbackForFrames(togglePlayback(initialPlayback(frames)), []);
  for (const index of [-1, 8, Number.NaN, Infinity]) {
    const sought = seekPlayback(empty, index);
    assert.equal(sought.index, 0);
    assert.equal(togglePlayback(sought).playing, false);
    assert.equal(advancePlayback(sought, 1000), sought);
  }
});

test("seek pauses, uses whole frame indices, and keeps invalid or out-of-range requests bounded", () => {
  const playing = togglePlayback(initialPlayback(frames));
  for (const [requested, expected] of [[-10, 0], [2.9, 2], [999, 4], [NaN, 0], [Infinity, 0], [-Infinity, 0]]) {
    const sought = seekPlayback(playing, requested);
    assert.equal(sought.index, expected);
    assert.equal(sought.playing, false);
    assert.ok(sought.frames[sought.index]);
  }
});

test("playback follows recorded ticks, stops at the end and restarts on play", () => {
  let state = togglePlayback(initialPlayback(frames));
  state = advancePlayback(state, 24);
  assert.equal(state.index, 1, "the next recorded frame is not shown early");
  state = advancePlayback(state, 25);
  assert.equal(state.index, 2);
  assert.equal(advancePlayback(state, NaN), state);
  state = advancePlayback(state, 1000);
  assert.equal(state.index, 4);
  assert.equal(state.playing, false);
  state = togglePlayback(state);
  assert.equal(state.index, 0);
  assert.equal(state.playing, true);
  state = togglePlayback(state);
  assert.equal(advancePlayback(state, 1000), state, "paused playback stays still");
});
