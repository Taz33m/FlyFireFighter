/**
 * Executed-command history for aligning the efference copy with a frame pair's capture interval.
 *
 * ControllerInput.previous is the command executed since the last step. Camera frames arrive with
 * latency, so the motion between two delivered frames happened earlier than `previous`. Using the wrong
 * interval for derotation feeds the controller's own turning back as apparent lateral flow (a sign-
 * alternating yaw limit cycle in closed loop) and biases τ → distance conversion while braking.
 */
import type { MotionCommand } from "../../contracts/actions.ts";
import { VISUAL_PERIOD_TICKS } from "../../contracts/clock.ts";

interface Entry {
  readonly from: number;
  readonly to: number;
  readonly yawRateRadps: number;
  readonly forwardMps: number;
}

export interface EfferenceMean {
  readonly yawRateRadps: number;
  readonly forwardMps: number;
}

const finiteOr = (value: number, fallback: number): number => (Number.isFinite(value) ? value : fallback);

export class EfferenceHistory {
  private readonly capacity: number;
  private entries: Entry[] = [];
  private lastTick: number | null = null;

  constructor(capacity = 32) {
    this.capacity = capacity;
  }

  clear(): void {
    this.entries = [];
    this.lastTick = null;
  }

  /** Record the command executed over (last recorded tick, tick]. Repeated ticks are ignored; a tick that goes back clears the history. */
  record(tick: number, previous: MotionCommand): void {
    if (this.lastTick !== null && tick <= this.lastTick) {
      if (tick < this.lastTick) this.clear();
      else return;
    }
    const from = this.lastTick ?? tick - VISUAL_PERIOD_TICKS;
    this.entries.push({ from, to: tick, yawRateRadps: finiteOr(previous.yawRateRadps, 0), forwardMps: finiteOr(previous.velocityBody.x, 0) });
    if (this.entries.length > this.capacity) this.entries.shift();
    this.lastTick = tick;
  }

  /** Time-weighted mean over [from, to], or null when the recorded history covers less than half of it. */
  mean(from: number, to: number): EfferenceMean | null {
    let covered = 0;
    let yaw = 0;
    let forward = 0;
    for (const entry of this.entries) {
      const overlap = Math.min(to, entry.to) - Math.max(from, entry.from);
      if (overlap <= 0) continue;
      covered += overlap;
      yaw += overlap * entry.yawRateRadps;
      forward += overlap * entry.forwardMps;
    }
    if (!(to > from) || covered < 0.5 * (to - from)) return null;
    return { yawRateRadps: yaw / covered, forwardMps: forward / covered };
  }
}
