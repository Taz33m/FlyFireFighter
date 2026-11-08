/**
 * Headless batch driver for tests and paired evaluation: one MissionRuntime on a preset of the Troy scene
 * with the headless collider camera, a chosen controller, the local planner and (optionally) the scripted
 * commander, stepped as fast as the CPU allows. It also keeps a compact, human-readable timeline of the key
 * mission events. It reads world truth only for the evaluator-side milestones it reports (entry into the
 * building, fire state); nothing from those flows back into the run.
 */
import { readFileSync } from "node:fs";
import type { MissionEvent } from "../contracts/events.ts";
import type { MissionResult } from "../contracts/outcomes.ts";
import type { SceneMetaJson } from "../contracts/scene.ts";
import { parseSceneMeta } from "../simulation/scene.ts";
import { spaceOf } from "./steering-graph.ts";
import type { ScriptedCommanderConfig } from "./commander.ts";
import type { NeuralConnector } from "./controller-slot.ts";
import { DEFAULT_SCRIPTED_COMMANDER } from "./commander.ts";
import type { ControllerMode, RunConfig, UiCommand } from "./protocol.ts";
import { MissionRuntime } from "./runtime.ts";

export const TROY_META_URL = new URL("../../../public/scenes/troy-training/scene.meta.json", import.meta.url);

let cachedMeta: { readonly meta: SceneMetaJson; readonly text: string } | null = null;

export function troyMeta(): { readonly meta: SceneMetaJson; readonly text: string } {
  if (cachedMeta === null) {
    const text = readFileSync(TROY_META_URL, "utf8");
    cachedMeta = { meta: parseSceneMeta(JSON.parse(text)), text };
  }
  return cachedMeta;
}

export interface DriveOptions {
  readonly runId?: string;
  readonly variant?: string;
  readonly seed?: string;
  readonly controller?: ControllerMode;
  readonly commander?: ScriptedCommanderConfig | null;
  readonly recallOnArrival?: boolean;
  readonly report?: string | null;
  /** Commands queued (with the run's id filled in) when the given tick is reached. */
  readonly script?: readonly { readonly tick: number; readonly command: (runId: string) => UiCommand }[];
  /** Stop after this many ticks even if the run has not ended. */
  readonly maxTicks?: number;
  /** Range assistance for motion (RuntimeOptions.rangeAssist; default true). */
  readonly rangeAssist?: boolean;
  /** Water aboard at launch (RuntimeOptions.initialWaterL; default full tank). */
  readonly initialWaterL?: number;
  /** FlyVis connection for the engineered readout (RuntimeOptions.neural). */
  readonly neural?: NeuralConnector | null;
  /** Called after every advanced step; return true to stop. */
  readonly until?: (runtime: MissionRuntime) => boolean;
}

export interface DriveResult {
  readonly runtime: MissionRuntime;
  readonly result: MissionResult | null;
  readonly events: readonly MissionEvent[];
  readonly timeline: readonly string[];
  /** First tick the TRUE aircraft position was inside a room of the prior (evaluator-side milestone). */
  readonly firstIndoorTick: number | null;
  readonly wallMs: number;
  readonly ticks: number;
}

export function runConfig(options: DriveOptions = {}): RunConfig {
  return {
    scenarioId: `troy-training/${options.variant ?? "main"}`,
    seed: options.seed ?? "troy-seed-1",
    aircraftId: "tender-t1",
    controller: options.controller ?? "flow_baseline",
    decider: "local",
    commanderId: options.commander?.commanderId ?? DEFAULT_SCRIPTED_COMMANDER.commanderId,
    speed: 1,
  };
}

/** Run a mission headless: report, authorize, then step until it ends, maxTicks or `until`. */
export async function driveMission(options: DriveOptions = {}): Promise<DriveResult> {
  const runtime = await createRuntime(options);
  const started = performance.now();
  const script = [...(options.script ?? [])].sort((a, b) => a.tick - b.tick);
  const maxTicks = options.maxTicks ?? runtime.preset.budgetTick + 2000;
  let firstIndoorTick: number | null = null;
  while (runtime.world.tick < maxTicks) {
    while (script.length > 0 && script[0].tick <= runtime.world.tick) runtime.command((script.shift() as (typeof script)[number]).command(runtime.runId));
    const step = await runtime.step();
    if (firstIndoorTick === null && spaceOf(runtime.preset.prior, runtime.world.drone.position) !== "exterior") firstIndoorTick = runtime.world.tick;
    if (stopped(step, runtime) || options.until?.(runtime) === true) break;
  }
  const events = runtime.log.entries();
  return { runtime, result: runtime.outcome(), events, timeline: compactTimeline(events), firstIndoorTick, wallMs: performance.now() - started, ticks: runtime.world.tick };
}

async function createRuntime(options: DriveOptions): Promise<MissionRuntime> {
  const config = runConfig(options);
  const runtime = await MissionRuntime.create({
    runId: options.runId ?? "run-headless",
    config,
    meta: troyMeta().meta,
    commander: options.commander === undefined ? DEFAULT_SCRIPTED_COMMANDER : options.commander,
    recallOnArrival: options.recallOnArrival ?? true,
    rangeAssist: options.rangeAssist,
    initialWaterL: options.initialWaterL,
    neural: options.neural ?? null,
  });
  const report = options.report === undefined ? runtime.preset.defaultReport : options.report;
  if (report !== null) runtime.command({ type: "report", runId: runtime.runId, text: report, channel: "typed", source: "judge" });
  runtime.command({ type: "authorize_mission", runId: runtime.runId, commanderId: config.commanderId });
  return runtime;
}

function stopped(step: { readonly advanced: boolean; readonly ended: boolean; readonly pausedReason: string | null }, runtime: MissionRuntime): boolean {
  return step.ended || step.pausedReason !== null || (!step.advanced && !runtime.advancing && runtime.world.tick > 0);
}

const TIMELINE_KINDS = new Set([
  "report.received", "mission.authorized", "track.created", "opening.observed", "hazard.fire_observed", "hazard.fire_out_observed", "route.status_changed",
  "proposal.awaiting_approval", "proposal.approved", "proposal.rejected", "proposal.invalidated", "proposal.expired",
  "evaluator.occupant_arrived", "contingency.selected", "outcome.recorded", "controller.fallback", "run.paused", "experiment.applied",
]);
const INTERVENTION_WORDS = /^(breach_opening|spray|release_payload|guide|return|land)$/;

/**
 * Key events as "t=12.34s kind [action] subject — reason" lines. Every lifecycle event of an intervention,
 * guidance, return or landing proposal is kept; routine moves and scans are not. Repeats of the same event
 * kind and reason (e.g. the same submission refused every planning period) collapse into one line with a count.
 */
export function compactTimeline(events: readonly MissionEvent[]): string[] {
  const kinds = new Map<string, string>();
  const lines: { key: string; text: string; count: number; lastTick: number }[] = [];
  for (const event of events) {
    if (event.kind === "proposal.proposed" && event.subject !== null) kinds.set(event.subject, /: (\w+)\./.exec(event.reason)?.[1] ?? "");
    const action = event.subject === null ? "" : kinds.get(event.subject) ?? "";
    const keep = event.kind.startsWith("proposal.") ? INTERVENTION_WORDS.test(action) : TIMELINE_KINDS.has(event.kind);
    if (!keep) continue;
    const reason = event.reason.replace(/run-[\w-]+\/p\d+/g, "#").replace(/tick \d+/g, "tick …").slice(0, 150);
    const key = `${event.kind}|${action}|${reason}`;
    const last = lines[lines.length - 1];
    if (last !== undefined && last.key === key) {
      last.count += 1;
      last.lastTick = event.tick;
      continue;
    }
    lines.push({ key, count: 1, lastTick: event.tick, text: `t=${(event.tick / 100).toFixed(2)}s ${event.kind}${action === "" ? "" : ` [${action}]`} ${event.subject ?? ""} — ${event.reason.slice(0, 150)}` });
  }
  return lines.map(line => (line.count > 1 ? `${line.text} (×${line.count}, last t=${(line.lastTick / 100).toFixed(2)}s)` : line.text));
}
