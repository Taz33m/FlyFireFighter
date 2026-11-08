/**
 * Headless batch runner: one MissionRuntime per (condition, seed) with the headless collider camera, the
 * LOCAL planner, the bounded scripted commander (DEFAULT_SCRIPTED_COMMANDER: approve each proposal 300 ticks
 * after it starts waiting; recall on evaluator arrival) and the condition's single stated difference. Each
 * run writes the runtime's own bundle (events.jsonl, results.json, replay.jsonl) plus run.json (condition,
 * commander policy, injection record, metrics). batch.ts schedules runs and writes the summary. This is a
 * thin adapter over the runtime's public API.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../../contracts/canonical.ts";
import type { NeuralConnector } from "../../mission/controller-slot.ts";
import { DEFAULT_SCRIPTED_COMMANDER } from "../../mission/commander.ts";
import { runConfig, troyMeta } from "../../mission/mission-driver.ts";
import type { RuntimeOptions } from "../../mission/runtime.ts";
import { MissionRuntime } from "../../mission/runtime.ts";
import type { RunRecord } from "./aggregate.ts";
import type { Capabilities } from "./capabilities.ts";
import { missingRequirements } from "./capabilities.ts";
import type { Condition, RunSpec } from "./conditions.ts";
import { createInjector } from "./injections.ts";
import type { InjectionRecord, Injector } from "./injections.ts";
import { computeRunMetrics } from "./metrics.ts";

/** Water load for the payload-exhaustion arm (the Tender T1 tank holds 1.0 L). */
export const PAYLOAD_EXHAUSTION_WATER_L = 0.05;
/** Ticks beyond the preset budget before the runner stops an unscored run. */
export const TICK_CAP_MARGIN = 2000;

export interface RunEnvironment {
  readonly outDir: string | null;
  readonly capabilities: Capabilities;
  readonly connectNeural: NeuralConnector | null;
  /** Override the tick cap (tests); default budget + TICK_CAP_MARGIN. */
  readonly maxTicks?: number;
  readonly log?: (line: string) => void;
}

export interface RunOutcome {
  readonly record: RunRecord;
  readonly files: { readonly [name: string]: string } | null;
  readonly runtime: MissionRuntime | null;
}

/** The runtime options for a condition: everything identical across conditions except the stated factor. */
export function runtimeOptions(spec: RunSpec, connectNeural: NeuralConnector | null): RuntimeOptions {
  const c = spec.condition;
  const base: RuntimeOptions = {
    runId: spec.runId,
    config: runConfig({ variant: c.variant, seed: spec.seed, controller: c.controller, commander: DEFAULT_SCRIPTED_COMMANDER }),
    meta: troyMeta().meta,
    commander: DEFAULT_SCRIPTED_COMMANDER,
    recallOnArrival: true,
    neural: c.controller === "engineered_readout" ? connectNeural : null,
    // Set only when the condition varies them, so every other arm runs on the runtime defaults.
    ...(c.rangeAssist ? {} : { rangeAssist: false }),
    ...(c.injection === "payload_exhaustion" ? { initialWaterL: PAYLOAD_EXHAUSTION_WATER_L } : {}),
  };
  return base;
}

export async function runOne(spec: RunSpec, env: RunEnvironment): Promise<RunOutcome> {
  const missing = missingRequirements(spec.condition, env.capabilities);
  if (missing.length > 0) return { record: emptyRecord(spec, "not_run", missing.join(" ")), files: null, runtime: null };
  let runtime: MissionRuntime | null = null;
  const started = performance.now();
  try {
    runtime = await MissionRuntime.create(runtimeOptions(spec, env.connectNeural));
    const injector = createInjector(spec.condition.injection);
    const pausedReason = await drive(runtime, spec, env, injector, started);
    return finish(runtime, spec, env, injector?.record() ?? payloadRecord(spec.condition), pausedReason, performance.now() - started);
  } catch (error) {
    return { record: emptyRecord(spec, "error", error instanceof Error ? error.message : String(error)), files: null, runtime };
  } finally {
    runtime?.close();
  }
}

/** Report, authorize, then step until the evaluator ends the run, it pauses itself or the tick cap. */
async function drive(runtime: MissionRuntime, spec: RunSpec, env: RunEnvironment, injector: Injector | null, started: number): Promise<string | null> {
  runtime.command({ type: "report", runId: runtime.runId, text: runtime.preset.defaultReport, channel: "typed", source: "judge" });
  runtime.command({ type: "authorize_mission", runId: runtime.runId, commanderId: runtime.config.commanderId });
  const maxTicks = env.maxTicks ?? runtime.preset.budgetTick + TICK_CAP_MARGIN;
  while (runtime.world.tick < maxTicks) {
    const step = await runtime.step();
    if (step.advanced) injector?.afterStep(runtime);
    if (step.pausedReason !== null) return step.pausedReason;
    if (step.ended || (!step.advanced && !runtime.advancing && runtime.world.tick > 0)) break;
    if (env.log && runtime.world.tick % 6000 === 0) env.log(`  ${spec.runId}: t=${runtime.world.tick / 100}s, ${((performance.now() - started) / 1000).toFixed(0)} s wall`);
  }
  return null;
}

function finish(runtime: MissionRuntime, spec: RunSpec, env: RunEnvironment, injection: InjectionRecord | null, pausedReason: string | null, wallMs: number): RunOutcome {
  const c = spec.condition;
  const files = runtime.exportRun(sha256Hex(troyMeta().text));
  const results = JSON.parse(files["results.json"]) as { events: { sha256: string }; controller: { label: string; source: string } };
  const events = runtime.log.entries();
  const metrics = computeRunMetrics({ events, records: runtime.harness.records(), result: runtime.outcome(), simulatedS: runtime.timing().simulatedS, wallMs });
  const invalidReason = invalidity(c, events.filter(e => e.kind === "controller.fallback").map(e => e.reason), results.controller.source, pausedReason) ?? conditionMismatch(runtime, c);
  const record: RunRecord = {
    runId: spec.runId, seed: spec.seed, conditionId: c.id,
    status: invalidReason === null ? "ran" : "invalid", reason: invalidReason,
    metrics, injection, bundleDir: null, eventsSha256: results.events.sha256, controllerLabel: results.controller.label,
  };
  const runJson = { schema: "flyfirefighter.batch-run/1", runId: spec.runId, seed: spec.seed, condition: c, commanderPolicy: DEFAULT_SCRIPTED_COMMANDER, recallOnArrival: true, decider: "local", capabilities: env.capabilities, injection, metrics, status: record.status, reason: record.reason };
  const all = { ...files, "run.json": `${JSON.stringify(runJson, null, 2)}\n` };
  const bundleDir = env.outDir === null ? null : writeBundle(env.outDir, spec.runId, all);
  return { record: { ...record, bundleDir }, files: all, runtime };
}


function invalidity(c: Condition, fallbacks: readonly string[], source: string, pausedReason: string | null): string | null {
  if (pausedReason !== null) return `Run paused itself: ${pausedReason}`;
  if (c.controller === "engineered_readout" && (fallbacks.length > 0 || source !== "engineered_readout")) return `Not run as configured: the FlyVis readout fell back to the classical controller (${fallbacks[0] ?? source}). Not substituted into the readout arm.`;
  return null;
}

/** The runtime's own record of the experimental conditions must match what the condition asked for. */
function conditionMismatch(runtime: MissionRuntime, c: Condition): string | null {
  if (runtime.rangeAssist !== c.rangeAssist) return `Not run as configured: range assistance ${runtime.rangeAssist} (condition asks ${c.rangeAssist}).`;
  const expectedWater = c.injection === "payload_exhaustion" ? PAYLOAD_EXHAUSTION_WATER_L : runtime.profile.modules.water?.tankL ?? 0;
  if (Math.abs(runtime.initialWaterL - expectedWater) > 1e-9) return `Not run as configured: initial water ${runtime.initialWaterL} L (condition asks ${expectedWater} L).`;
  return null;
}

function payloadRecord(c: Condition): InjectionRecord | null {
  if (c.injection !== "payload_exhaustion") return null;
  return { kind: "payload_exhaustion", applied: true, tick: 0, detail: `Run started with ${PAYLOAD_EXHAUSTION_WATER_L} L of water (runtime initialWaterL option).`, effective: null, experiments: [] };
}

function emptyRecord(spec: RunSpec, status: "not_run" | "error", reason: string): RunRecord {
  return { runId: spec.runId, seed: spec.seed, conditionId: spec.condition.id, status, reason, metrics: null, injection: null, bundleDir: null, eventsSha256: null, controllerLabel: null };
}

function writeBundle(outDir: string, runId: string, files: { readonly [name: string]: string }): string {
  const dir = join(outDir, runId);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}
