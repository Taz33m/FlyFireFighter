/**
 * Mission clock.
 *
 * Simulation time is an integer tick count since run start. Physics and the actuator guard step at
 * SIM_HZ; every other loop runs on a fixed cadence of the same clock. Wall-clock time (rendering,
 * cloud latency, neural inference latency) never advances simulation state. Approval expiry and
 * evidence age are measured in ticks; cloud deadlines use monotonic wall time and live elsewhere.
 */

/** Fixed physics / actuator-guard rate. */
export const SIM_HZ = 100;
export const TICK_S = 1 / SIM_HZ;

/** Visual-model input cadence: 50 Hz, dt = 0.02 s. */
export const VISUAL_PERIOD_TICKS = 2;

/** Fire and smoke compartment update cadence: 10 Hz. */
export const FIRE_PERIOD_TICKS = 10;

/** Integer simulation tick since run start (tick 0 is the first step of a run). */
export type Tick = number;

export function ticksFromSeconds(seconds: number): Tick {
  if (!Number.isFinite(seconds)) throw new RangeError(`Duration must be finite, got ${seconds}`);
  return Math.round(seconds * SIM_HZ);
}

export function secondsFromTicks(ticks: Tick): number {
  return ticks / SIM_HZ;
}

export function isTick(value: unknown): value is Tick {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function onCadence(tick: Tick, periodTicks: number): boolean {
  return tick % periodTicks === 0;
}
