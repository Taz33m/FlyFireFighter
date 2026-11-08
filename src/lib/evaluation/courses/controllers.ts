/**
 * The comparison's controller conditions, built with the same camera, goals, speed limits and harness:
 * - flow_baseline: conventional dense Lucas–Kanade optical flow (tuned on train/validation; tuned config
 *   in BASELINE_TUNING when present, else the committed defaults);
 * - engineered_readout: FlyVis horizontal-motion/expansion features → hand-set engineered readout (defaults);
 * - fly_readout: FlyVis features → trained readout loaded from models/readout/*.json.
 * FlyVis features come from the runner's FeatureHolder, which the runner fills from the live service.
 */
import { readFileSync } from "node:fs";
import type { CommandConfig } from "../../navigation/reflex/command.ts";
import { DEFAULT_COMMAND_CONFIG } from "../../navigation/reflex/command.ts";
import { EngineeredReadoutController } from "../../navigation/reflex/engineered-readout.ts";
import type { FlowConfig } from "../../navigation/reflex/flow.ts";
import { DEFAULT_FLOW_CONFIG } from "../../navigation/reflex/flow.ts";
import { FlowBaselineController } from "../../navigation/reflex/flow-baseline.ts";
import type { TrainedReadoutModel } from "../../navigation/reflex/trained-readout.ts";
import { parseTrainedReadout, TrainedReadoutController } from "../../navigation/reflex/trained-readout.ts";
import type { MotionController } from "../../navigation/reflex/types.ts";
import type { FeatureHolder } from "./runner.ts";

export type ControllerKind = "flow_baseline" | "engineered_readout" | "fly_readout";

export interface FlowTuning {
  readonly flow: Partial<FlowConfig>;
  readonly command: Partial<CommandConfig>;
}

export function flowController(tuning: FlowTuning | null, id = "flow-baseline-lk80x45"): FlowBaselineController {
  return new FlowBaselineController({ id: tuning ? `${id}-tuned` : id, flow: { ...DEFAULT_FLOW_CONFIG, ...(tuning?.flow ?? {}) }, command: { ...DEFAULT_COMMAND_CONFIG, ...(tuning?.command ?? {}) } });
}

export function engineeredController(holder: FeatureHolder): EngineeredReadoutController {
  return new EngineeredReadoutController({
    features: () => {
      const f = holder.current;
      return f && { leftMotion: f.horizontalMotion[0], centerMotion: f.horizontalMotion[1], rightMotion: f.horizontalMotion[2], expansion: f.expansion };
    },
  });
}

export function loadReadoutModel(path: string): TrainedReadoutModel {
  return parseTrainedReadout(JSON.parse(readFileSync(path, "utf8")));
}

export function trainedController(holder: FeatureHolder, model: TrainedReadoutModel): TrainedReadoutController {
  return new TrainedReadoutController({ model, features: () => holder.current });
}

export function loadFlowTuning(path: string): FlowTuning | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { selected?: FlowTuning };
    return parsed.selected ?? null;
  } catch {
    return null;
  }
}

export function needsNeural(kind: ControllerKind): boolean {
  return kind !== "flow_baseline";
}

export function makeController(kind: ControllerKind, holder: FeatureHolder, options: { flowTuning: FlowTuning | null; model: TrainedReadoutModel | null }): MotionController {
  if (kind === "flow_baseline") return flowController(options.flowTuning);
  if (kind === "engineered_readout") return engineeredController(holder);
  if (!options.model) throw new Error("fly_readout needs a trained model file");
  return trainedController(holder, options.model);
}
