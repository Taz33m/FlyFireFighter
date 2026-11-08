/**
 * Free-WiLi button levels → deliberate commander gestures. Pure and browser-safe.
 *
 * Mapping (labels are printed on the device screen above the buttons):
 * - GREEN press: approve the decision shown (decide.ts adds the review delay and digest binding).
 * - YELLOW press: reject the decision shown.
 * - RED, pressed twice within ABORT_DOUBLE_TAP_MS (the Esc Esc window), or held for ABORT_HOLD_MS: abort the
 *   mission. A single red tap only primes abort. Red is the e-stop: it counts even while another button is held.
 * - GRAY and BLUE do nothing.
 *
 * What never becomes a gesture:
 * - the first snapshot after connect or reconnect (the baseline): a button already held then must be released
 *   and pressed again, so plugging in, reconnecting or a stuck button never approves anything;
 * - a repeated or older event frame (same or lower sequence number), and the identical levels the firmware
 *   repeats while nothing changes — only an observed released→pressed edge is a press;
 * - contact bounce: a press needs the button to have been seen released for at least DEBOUNCE_MS;
 * - a green or yellow press while the other decision button is also held (ambiguous chord).
 */
import { ABORT_DOUBLE_TAP_MS } from "../commander-keys.ts";
import type { ButtonLevels, ButtonName } from "./stock-protocol.ts";
import { BUTTON_NAMES } from "./stock-protocol.ts";

export { ABORT_DOUBLE_TAP_MS };
/** Holding red this long aborts (well short of any firmware long-press). */
export const ABORT_HOLD_MS = 1000;
/** A button must have been seen released this long before a press counts. */
export const DEBOUNCE_MS = 60;
/** Sequence numbers further back than this are treated as a firmware restart, not a replay. */
const SEQ_RESTART_GAP = 10_000;

export type Gesture =
  | { readonly kind: "approve" }
  | { readonly kind: "reject" }
  | { readonly kind: "abort"; readonly via: "double_press" | "hold" }
  /** First red tap: press again within the window (or keep holding) to abort. */
  | { readonly kind: "abort_primed" };

interface PerButton {
  readonly down: boolean;
  /** When the current level was first seen. */
  readonly sinceMs: number;
  /** Held since the baseline: must be released before it can press. */
  readonly latched: boolean;
}

export class ButtonGestures {
  private buttons: Record<ButtonName, PerButton> | null = null;
  private lastSeq: number | null = null;
  private redPrimedAtMs: number | null = null;
  private redHoldFired = false;

  /** Forget everything (connect, reconnect, disconnect): the next snapshot is a baseline. */
  reset(): void {
    this.buttons = null;
    this.lastSeq = null;
    this.redPrimedAtMs = null;
    this.redHoldFired = false;
  }

  /** True when a single red tap is waiting for its second press. */
  abortPrimed(nowMs: number): boolean {
    return this.redPrimedAtMs !== null && nowMs - this.redPrimedAtMs <= ABORT_DOUBLE_TAP_MS;
  }

  /** Feed one snapshot of every button's level. `seq` is the frame's sequence number (null for none). */
  update(levels: ButtonLevels, seq: number | null, nowMs: number): Gesture[] {
    if (seq !== null && this.lastSeq !== null && seq <= this.lastSeq && this.lastSeq - seq < SEQ_RESTART_GAP) return [];
    if (seq !== null) this.lastSeq = seq;
    if (this.buttons === null) {
      this.buttons = baseline(levels, nowMs);
      return [];
    }
    const previous = this.buttons;
    const next = { ...previous };
    const pressed: ButtonName[] = [];
    for (const name of BUTTON_NAMES) {
      const was = previous[name];
      const down = levels[name];
      if (down === was.down) continue;
      next[name] = { down, sinceMs: nowMs, latched: false };
      if (down && !was.latched && nowMs - was.sinceMs >= DEBOUNCE_MS) pressed.push(name);
    }
    this.buttons = next;
    return [...this.decisionPresses(pressed, levels), ...this.redGestures(pressed, levels, nowMs)];
  }

  /** Time passing with no new frame: detects the red hold. */
  tick(nowMs: number): Gesture[] {
    const red = this.buttons?.red;
    if (red === undefined || !red.down || red.latched || this.redHoldFired) return [];
    if (nowMs - red.sinceMs < ABORT_HOLD_MS) return [];
    this.redHoldFired = true;
    this.redPrimedAtMs = null;
    return [{ kind: "abort", via: "hold" }];
  }

  private decisionPresses(pressed: readonly ButtonName[], levels: ButtonLevels): Gesture[] {
    const chord = levels.green && levels.yellow;
    if (chord) return [];
    const out: Gesture[] = [];
    if (pressed.includes("green")) out.push({ kind: "approve" });
    if (pressed.includes("yellow")) out.push({ kind: "reject" });
    return out;
  }

  private redGestures(pressed: readonly ButtonName[], levels: ButtonLevels, nowMs: number): Gesture[] {
    if (!levels.red) this.redHoldFired = false;
    if (!pressed.includes("red")) return [];
    if (this.abortPrimed(nowMs)) {
      this.redPrimedAtMs = null;
      // This press already aborted; holding it on must not abort again.
      this.redHoldFired = true;
      return [{ kind: "abort", via: "double_press" }];
    }
    this.redPrimedAtMs = nowMs;
    return [{ kind: "abort_primed" }];
  }
}

function baseline(levels: ButtonLevels, nowMs: number): Record<ButtonName, PerButton> {
  const out = {} as Record<ButtonName, PerButton>;
  for (const name of BUTTON_NAMES) out[name] = { down: levels[name], sinceMs: nowMs, latched: levels[name] };
  return out;
}
