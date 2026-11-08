/**
 * The run's result bundle (architecture §8, protocol RUN_BUNDLE_FILES): events.jsonl, results.json and
 * replay.jsonl.
 *
 * events.jsonl is the event log exactly as appended (one canonical JSON object per line; events carry the
 * mission tick, never wall time, so the same seed and configuration export byte-identical logs). results.json
 * carries the evaluator's MissionResult (null while the run has not been scored), the configuration and
 * seed, scene and asset hashes from the scene metadata, the controller's exact label and checkpoint hash,
 * the calibration and every renderer that produced controller frames, the SHA-256 of events.jsonl, and
 * wall-clock timing. Timing is the only non-deterministic part and is kept under "timing", apart from
 * everything the run decided. Labels keep simulation, evaluator evidence and fixtures distinct. replay.jsonl
 * is one protocol ReplayFrame per line (privileged render snapshot plus a truth-free summary), recorded by
 * the runtime at REPLAY_PERIOD_TICKS of simulation time; it is for the labelled replay view, not for planning.
 */
import type { JsonValue } from "../contracts/canonical.ts";
import { canonicalJson, sha256Hex } from "../contracts/canonical.ts";
import type { MissionResult } from "../contracts/outcomes.ts";
import { rescueLabel } from "../contracts/outcomes.ts";
import type { SceneMetaJson } from "../contracts/scene.ts";
import type { ControllerView, RunConfig, RUN_BUNDLE_FILES } from "./protocol.ts";
import type { LatencySummary } from "./stats.ts";

export const RESULTS_SCHEMA = "flyfirefighter.results/1";

export interface ExportInputs {
  readonly runId: string;
  readonly config: RunConfig;
  readonly scenarioId: string;
  readonly meta: SceneMetaJson;
  /** SHA-256 of the scene metadata file as served (null when the caller has only the parsed object). */
  readonly metaSha256: string | null;
  readonly controller: ControllerView;
  readonly calibrationId: string;
  readonly renderers: readonly string[];
  readonly decider: { readonly label: string; readonly status: string };
  /** Experimental conditions that differ between paired runs. */
  readonly conditions: { readonly rangeAssist: boolean; readonly initialWaterL: number };
  readonly eventsJsonl: string;
  readonly replayJsonl: string;
  readonly result: MissionResult | null;
  readonly timing: {
    readonly simulatedS: number;
    readonly wallMs: number;
    readonly simToWallRatio: number | null;
    readonly latency: { readonly [name: string]: LatencySummary };
  };
  readonly status: string;
}

/** The two files of the bundle, as text. */
export function exportRun(inputs: ExportInputs): { readonly [file in (typeof RUN_BUNDLE_FILES)[number]]: string } {
  return { "events.jsonl": inputs.eventsJsonl, "results.json": `${JSON.stringify(resultsJson(inputs), null, 2)}\n`, "replay.jsonl": inputs.replayJsonl };
}

export function resultsJson(inputs: ExportInputs): { readonly [key: string]: JsonValue } {
  const { meta, controller, result } = inputs;
  const assets: { [name: string]: JsonValue } = {};
  for (const [name, asset] of Object.entries(meta.assets ?? {})) assets[name] = { sha256: asset.sha256, bytes: asset.bytes };
  const body = {
    schema: RESULTS_SCHEMA,
    label: "simulation — Troy training scene: real exterior reference; fictional interior and incident",
    runId: inputs.runId,
    status: inputs.status,
    scenarioId: inputs.scenarioId,
    seed: inputs.config.seed,
    config: { ...inputs.config },
    conditions: { rangeAssist: inputs.conditions.rangeAssist, initialWaterL: inputs.conditions.initialWaterL },
    scene: { sceneId: meta.sceneId, revision: meta.revision, schema: meta.schema, metaSha256: inputs.metaSha256, metaCanonicalSha256: sha256Hex(canonicalJson(meta)), assets },
    controller: {
      mode: controller.mode,
      label: controller.label,
      source: controller.source,
      model: controller.neural?.model ?? null,
      checkpointSha256: controller.neural?.checkpointSha256 ?? null,
      neuralStatus: controller.neural?.status ?? null,
    },
    decider: { label: inputs.decider.label, status: inputs.decider.status },
    camera: { calibrationId: inputs.calibrationId, renderers: [...inputs.renderers] },
    events: { file: "events.jsonl", sha256: sha256Hex(inputs.eventsJsonl), count: countLines(inputs.eventsJsonl) },
    replay: { file: "replay.jsonl", sha256: sha256Hex(inputs.replayJsonl), frames: countLines(inputs.replayJsonl), label: "simulation truth for the labelled replay view" },
    outcome: result === null ? null : { rescueLabel: rescueLabel(result), droneReturn: result.droneReturn, violations: result.violations.length, evidence: "simulation_evaluator" },
    result: result === null ? null : (JSON.parse(JSON.stringify(result)) as JsonValue),
    timing: {
      note: "Wall-clock measurements on this machine; metrics only, never read by the simulation.",
      simulatedS: round3(inputs.timing.simulatedS),
      wallMs: round3(inputs.timing.wallMs),
      simToWallRatio: inputs.timing.simToWallRatio === null ? null : round3(inputs.timing.simToWallRatio),
      latency: JSON.parse(JSON.stringify(inputs.timing.latency)) as JsonValue,
    },
  };
  return JSON.parse(JSON.stringify(body)) as { readonly [key: string]: JsonValue };
}

function countLines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
