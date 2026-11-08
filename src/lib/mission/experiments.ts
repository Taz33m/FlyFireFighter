/**
 * Operator experiments: protocol requests → the simulator's documented experiment hooks.
 *
 * Experiments change the environment (smoke, obstructions, a person, a door, localization conditions)
 * between ticks and never actuate the aircraft. The mission runtime applies them at a tick boundary and logs
 * them with source "operator"; planners only learn about their consequences through normal sensing.
 */
import type { JsonValue } from "../contracts/canonical.ts";
import type { Experiment as SimulationExperiment } from "../simulation/experiments.ts";
import type { Experiment } from "./protocol.ts";

/** The simulator form of a protocol experiment; `index` (1-based, per run) names added obstructions and people. */
export function toSimulationExperiment(experiment: Experiment, index: number): SimulationExperiment {
  switch (experiment.kind) {
    case "add_smoke":
      return { kind: "add_smoke", roomId: experiment.roomId, extinctionPerM: experiment.extinctionPerM };
    case "add_obstruction":
      return { kind: "add_obstruction", id: `experiment-${index}`, min: experiment.min, max: experiment.max };
    case "degrade_localization":
      return { kind: "degrade_localization", sigmaM: experiment.sigmaIncreaseM };
    case "add_occupant":
      // A person who walks in: mobile, sheltering until a cue and a passable route reach them like anyone else.
      return { kind: "add_occupant", key: `experiment-person-${index}`, position: experiment.position, mobility: "mobile" };
    case "set_door":
      return { kind: "set_door", openingId: experiment.openingId, state: experiment.state };
  }
}

/** Plain-language description for the mission timeline. */
export function describeExperiment(experiment: Experiment): string {
  switch (experiment.kind) {
    case "add_smoke":
      return `Operator experiment: smoke extinction in ${experiment.roomId} changed by ${experiment.extinctionPerM} per metre.`;
    case "add_obstruction":
      return `Operator experiment: an obstruction was placed between (${fmtVec(experiment.min)}) and (${fmtVec(experiment.max)}).`;
    case "degrade_localization":
      return `Operator experiment: localization uncertainty increased by ${experiment.sigmaIncreaseM} m.`;
    case "add_occupant":
      return `Operator experiment: a person was placed at (${fmtVec(experiment.position)}); sensors must detect them through the normal observation path.`;
    case "set_door":
      return `Operator experiment: door ${experiment.openingId} set ${experiment.state}.`;
  }
}

/** JSON copy of the request for event data. */
export function experimentData(experiment: Experiment): { readonly [key: string]: JsonValue } {
  return JSON.parse(JSON.stringify(experiment)) as { readonly [key: string]: JsonValue };
}

function fmtVec(v: { readonly x: number; readonly y: number; readonly z: number }): string {
  const f = (n: number) => String(Math.round(n * 100) / 100);
  return `${f(v.x)}, ${f(v.y)}, ${f(v.z)}`;
}
