/**
 * Wall-clock latency statistics for results.json and the view's simulated:wall ratio. Metrics only: no
 * simulation decision ever reads them, so measured timing cannot change a run's events or outcome.
 */

export interface LatencySummary {
  readonly count: number;
  readonly meanMs: number | null;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly maxMs: number | null;
}

/** Collects samples into a growable buffer; summaries sort a copy. */
export class LatencyStats {
  private samples = new Float64Array(1024);
  private n = 0;
  private sum = 0;

  add(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    if (this.n === this.samples.length) {
      const grown = new Float64Array(this.samples.length * 2);
      grown.set(this.samples);
      this.samples = grown;
    }
    this.samples[this.n++] = ms;
    this.sum += ms;
  }

  get count(): number {
    return this.n;
  }

  summary(): LatencySummary {
    if (this.n === 0) return { count: 0, meanMs: null, p50Ms: null, p95Ms: null, maxMs: null };
    const sorted = this.samples.slice(0, this.n).sort();
    const at = (q: number) => round3(sorted[Math.min(this.n - 1, Math.floor(q * (this.n - 1) + 0.5))]);
    return { count: this.n, meanMs: round3(this.sum / this.n), p50Ms: at(0.5), p95Ms: at(0.95), maxMs: round3(sorted[this.n - 1]) };
  }
}

/** Simulated seconds advanced per wall second over a sliding window of (wallMs, simulated s) marks. */
export class RatioMeter {
  private readonly marks: { wallMs: number; simS: number }[] = [];
  private readonly windowMs: number;

  constructor(windowMs = 1000) {
    this.windowMs = windowMs;
  }

  mark(wallMs: number, simS: number): void {
    this.marks.push({ wallMs, simS });
    while (this.marks.length > 2 && wallMs - this.marks[1].wallMs >= this.windowMs) this.marks.shift();
  }

  /** Null until the window spans at least a quarter of its length. */
  ratio(): number | null {
    if (this.marks.length < 2) return null;
    const first = this.marks[0];
    const last = this.marks[this.marks.length - 1];
    const wall = last.wallMs - first.wallMs;
    return wall >= this.windowMs / 4 ? (last.simS - first.simS) / (wall / 1000) : null;
  }

  reset(): void {
    this.marks.length = 0;
  }
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
