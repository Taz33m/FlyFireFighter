/**
 * Button levels → gestures. Scope: only an observed released→pressed edge is a press; the connect baseline,
 * repeated and replayed frames, bounce and ambiguous chords never are; the red abort needs a double press
 * within the Esc Esc window or a one-second hold, and fires once per gesture.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Gesture } from "./buttons.ts";
import { ABORT_DOUBLE_TAP_MS, ABORT_HOLD_MS, ButtonGestures, DEBOUNCE_MS } from "./buttons.ts";
import type { ButtonLevels } from "./stock-protocol.ts";

const UP: ButtonLevels = { gray: false, yellow: false, green: false, blue: false, red: false };
const only = (pressed: Partial<ButtonLevels>): ButtonLevels => ({ ...UP, ...pressed });
const kinds = (gestures: readonly Gesture[]) => gestures.map(g => (g.kind === "abort" ? `abort:${g.via}` : g.kind));

/** A tracker past its baseline (all released at t = 0), with a running sequence number. */
function ready() {
  const tracker = new ButtonGestures();
  let seq = 100;
  tracker.update(UP, seq, 0);
  return { tracker, frame: (levels: ButtonLevels, t: number) => tracker.update(levels, ++seq, t) };
}

describe("presses", () => {
  test("green and yellow presses are approve and reject, once per press", () => {
    const { frame } = ready();
    assert.deepEqual(kinds(frame(only({ green: true }), 200)), ["approve"]);
    assert.deepEqual(kinds(frame(UP, 300)), []);
    assert.deepEqual(kinds(frame(only({ yellow: true }), 500)), ["reject"]);
  });

  test("the firmware repeating the same pressed levels is still one press", () => {
    const { frame } = ready();
    const out = [200, 250, 300, 350, 400].flatMap(t => frame(only({ green: true }), t));
    assert.deepEqual(kinds(out), ["approve"]);
  });

  test("a replayed or older frame (same or lower sequence number) is ignored", () => {
    const tracker = new ButtonGestures();
    tracker.update(UP, 10, 0);
    tracker.update(UP, 11, 100);
    assert.deepEqual(tracker.update(only({ green: true }), 11, 200), []);
    assert.deepEqual(tracker.update(only({ green: true }), 9, 210), []);
    assert.deepEqual(kinds(tracker.update(only({ green: true }), 12, 220)), ["approve"]);
  });

  test("contact bounce: a press right after a release does not count", () => {
    const { frame } = ready();
    assert.deepEqual(kinds(frame(only({ green: true }), 200)), ["approve"]);
    frame(UP, 210);
    assert.deepEqual(kinds(frame(only({ green: true }), 210 + DEBOUNCE_MS - 1)), []);
  });

  test("green and yellow together is ambiguous and sends neither", () => {
    const { frame } = ready();
    assert.deepEqual(kinds(frame(only({ green: true, yellow: true }), 200)), []);
  });

  test("gray and blue do nothing", () => {
    const { frame } = ready();
    assert.deepEqual(kinds(frame(only({ gray: true, blue: true }), 200)), []);
  });
});

describe("connect and reconnect never press anything", () => {
  test("a button already held at the first snapshot must be released and pressed again", () => {
    const tracker = new ButtonGestures();
    assert.deepEqual(tracker.update(only({ green: true }), 1, 0), []);
    assert.deepEqual(tracker.update(only({ green: true }), 2, 500), []);
    tracker.update(UP, 3, 600);
    assert.deepEqual(kinds(tracker.update(only({ green: true }), 4, 800)), ["approve"]);
  });

  test("red held at connect never aborts by holding", () => {
    const tracker = new ButtonGestures();
    tracker.update(only({ red: true }), 1, 0);
    assert.deepEqual(tracker.tick(ABORT_HOLD_MS * 5), []);
  });

  test("reset makes the next snapshot a baseline again, and accepts a restarted sequence", () => {
    const { tracker } = ready();
    tracker.reset();
    assert.deepEqual(tracker.update(only({ yellow: true }), 1, 1000), []);
  });
});

describe("abort gesture", () => {
  test("one red tap only primes; a second within the Esc Esc window aborts", () => {
    const { tracker, frame } = ready();
    assert.deepEqual(kinds(frame(only({ red: true }), 200)), ["abort_primed"]);
    assert.equal(tracker.abortPrimed(300), true);
    frame(UP, 300);
    assert.deepEqual(kinds(frame(only({ red: true }), 200 + ABORT_DOUBLE_TAP_MS)), ["abort:double_press"]);
    assert.equal(tracker.abortPrimed(200 + ABORT_DOUBLE_TAP_MS), false);
  });

  test("a second tap after the window primes again instead of aborting", () => {
    const { frame } = ready();
    frame(only({ red: true }), 200);
    frame(UP, 300);
    assert.deepEqual(kinds(frame(only({ red: true }), 201 + ABORT_DOUBLE_TAP_MS)), ["abort_primed"]);
  });

  test("holding red aborts once after ABORT_HOLD_MS, not again while still held", () => {
    const { tracker, frame } = ready();
    frame(only({ red: true }), 200);
    assert.deepEqual(tracker.tick(200 + ABORT_HOLD_MS - 1), []);
    assert.deepEqual(kinds(tracker.tick(200 + ABORT_HOLD_MS)), ["abort:hold"]);
    assert.deepEqual(tracker.tick(200 + ABORT_HOLD_MS * 3), []);
    frame(only({ red: true }), 200 + ABORT_HOLD_MS * 3);
    assert.deepEqual(tracker.tick(200 + ABORT_HOLD_MS * 4), []);
  });

  test("the second press of a double press, held on, does not abort a second time", () => {
    const { tracker, frame } = ready();
    frame(only({ red: true }), 200);
    frame(UP, 300);
    frame(only({ red: true }), 400);
    assert.deepEqual(tracker.tick(400 + ABORT_HOLD_MS * 2), []);
  });

  test("red is the e-stop: it counts even while another button is held", () => {
    const { frame } = ready();
    frame(only({ green: true, yellow: true }), 200);
    assert.deepEqual(kinds(frame(only({ green: true, yellow: true, red: true }), 300)), ["abort_primed"]);
  });
});
