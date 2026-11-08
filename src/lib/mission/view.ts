/**
 * What the worker posts: the truth-free MissionView for command panels and the privileged RenderSnapshot
 * for the 3D renderer and the drone camera. The two are built from different inputs on purpose: the view
 * from the belief snapshot, harness records and controller/decider status; the render snapshot from world
 * truth. Nothing from the render snapshot flows into planning, the harness or the controller.
 */
import type { ActuatorCommand, GuardedMotion, ProposalRecord } from "../contracts/actions.ts";
import type { Tick } from "../contracts/clock.ts";
import type { BeliefSnapshot } from "../contracts/evidence.ts";
import type { Region } from "../contracts/geometry.ts";
import type { Observation } from "../contracts/observation.ts";
import { affectedRegion } from "../harness/effects.ts";
import { INTERVENTION_KINDS } from "../harness/policy.ts";
import type { DecisionRecord } from "../navigation/planner/broker.ts";
import type { CloudDecider } from "../navigation/planner/types.ts";
import { DECIDER_LABELS } from "../navigation/planner/types.ts";
import { AUDIO_CUE_MEMORY_TICKS, LIGHT_CUE_MEMORY_TICKS } from "../simulation/occupant.ts";
import { OBSTRUCTION_ID_PREFIX } from "../simulation/occupant-route.ts";
import type { WorldState } from "../simulation/world-state.ts";
import type { DeciderMode, DeciderView, RenderSnapshot } from "./protocol.ts";

/** At most this many observations ride along in the view's belief (the full window stays in the worker). */
export const VIEW_OBSERVATION_LIMIT = 48;
const DETECTION_WINDOW_TICKS = 200;

/** The belief for panels: everything but the observation window, which is cut to recent, relevant frames. */
export function viewBelief(belief: BeliefSnapshot): BeliefSnapshot {
  return { ...belief, observations: recentObservations(belief.observations, belief.tick) };
}

/** The newest observation of each sensor plus recent frames with detections, newest first, bounded. */
export function recentObservations(observations: readonly Observation[], tick: Tick): Observation[] {
  const latestBySensor = new Map<string, Observation>();
  const withDetections: Observation[] = [];
  for (const observation of observations) {
    const known = latestBySensor.get(observation.sensorId);
    if (known === undefined || observation.captureTick >= known.captureTick) latestBySensor.set(observation.sensorId, observation);
    if (observation.detections.length > 0 && tick - observation.captureTick <= DETECTION_WINDOW_TICKS) withDetections.push(observation);
  }
  const chosen = new Map<string, Observation>();
  for (const observation of [...latestBySensor.values(), ...withDetections.reverse()]) {
    if (chosen.size >= VIEW_OBSERVATION_LIMIT) break;
    chosen.set(observation.id, observation);
  }
  return [...chosen.values()].sort((a, b) => b.captureTick - a.captureTick || (a.id < b.id ? -1 : 1));
}

/** Affected regions of every intervention proposal, derived by the harness's own model. */
export function affectedRegions(records: readonly ProposalRecord[], world: Pick<WorldState, "profile">, belief: BeliefSnapshot): { proposalId: string; region: Region }[] {
  return records.flatMap(record => {
    if (!INTERVENTION_KINDS.has(record.proposal.action.kind)) return [];
    const region = affectedRegion(record.proposal.action, world.profile, belief.mapPrior);
    return region === null ? [] : [{ proposalId: record.proposal.id, region }];
  });
}

/** The single decision waiting for the commander: the oldest proposal awaiting approval. */
export function pendingApproval(records: readonly ProposalRecord[]): ProposalRecord | null {
  return records.find(record => record.status === "awaiting_approval") ?? null;
}

export function waterDischargedL(records: readonly ProposalRecord[]): number {
  return records.reduce((sum, record) => sum + (record.execution?.effects.waterDischargedL ?? 0), 0);
}

const MODE_SUBJECTS: { readonly [mode in DeciderMode]: string } = {
  local: "Cloud planning",
  decisions: "OpenAI Decisions",
  gemini: "Gemini",
  consensus: "Consensus (OpenAI Decisions + Gemini)",
};

/** The command view of the decider. The label comes from the decision record alone, so it names only a model whose choice was used. */
export function deciderView(decision: DecisionRecord | null, mode: DeciderMode, cloudActive: boolean, inFlight: boolean): DeciderView {
  const subject = MODE_SUBJECTS[mode];
  const status = mode === "local"
    ? "Local planner (no cloud model selected for this run)"
    : inFlight
      ? `${subject} request in flight; local goals continue`
      : !cloudActive
        ? `Local planner (${mode === "consensus" ? "consensus not reached: a model is not configured on the server" : `${subject} not configured on the server`})`
        : decision === null
          ? "Waiting for the first planning event"
          : decision.fallbackReason ?? `${DECIDER_LABELS[decision.decider]} answered`;
  return {
    label: deciderLabel(decision),
    status,
    lastChoice: decision === null ? null : { candidateId: decision.candidateId, description: `${DECIDER_LABELS[decision.decider]}: ${decision.description}`, tick: decision.tick },
  };
}

/** The broker's cloud decider for a run's decider mode; null keeps every decision local. */
export function cloudDeciderOf(mode: DeciderMode): CloudDecider | null {
  switch (mode) {
    case "decisions":
      return "openai_decisions";
    case "gemini":
      return "gemini";
    case "consensus":
      return "consensus";
    default:
      return null;
  }
}

/** How the run.started event names the decider mode. */
export const DECIDER_MODE_TEXT: { readonly [mode in DeciderMode]: string } = {
  local: "local planner",
  decisions: "OpenAI Decisions gateway (local planner fallback)",
  gemini: "Gemini gateway (local planner fallback)",
  consensus: "OpenAI Decisions + Gemini consensus gateway (local planner fallback when they do not agree)",
};

/** The label for the decision whose choice was used; "Local planner" for every fallback and before any decision. */
export function deciderLabel(decision: DecisionRecord | null): DeciderView["label"] {
  switch (decision?.decider) {
    case "openai_decisions":
      return "OpenAI Decisions";
    case "gemini":
      return "Gemini";
    case "consensus":
      return "Consensus: OpenAI Decisions + Gemini";
    default:
      return "Local planner";
  }
}

export interface RenderInputs {
  readonly actuators: readonly ActuatorCommand[];
  readonly motion: GuardedMotion | null;
}

/** World truth for the renderer at the world's current tick. */
export function renderSnapshot(world: WorldState, inputs: RenderInputs): RenderSnapshot {
  const tick = world.tick;
  const light = world.cues.light;
  const audio = world.cues.audio;
  return {
    label: "simulation_truth_for_rendering",
    tick,
    drone: { position: world.drone.position, yawRad: world.drone.yawRad, velocity: world.drone.velocity },
    occupants: world.occupants.map(o => ({ key: o.key, position: o.position, yawRad: o.yawRad, animation: o.animation, activity: o.activity })),
    fires: world.fires.map(fire => ({ id: fire.id, region: fire.region, heatReleaseKW: fire.heatReleaseKW, extinguished: fire.extinguished })),
    rooms: world.compartments.filter(c => c.id !== "exterior").map(c => ({ id: c.id, smokeExtinctionPerM: c.smokeExtinctionPerM, temperatureC: c.temperatureC })),
    openings: world.openings.map(o => ({ id: o.id, state: o.state })),
    removedColliderIds: world.scene.colliders.filter(c => !world.activeColliderIds.has(c.id)).map(c => c.id),
    addedColliders: world.scene.colliders.filter(c => c.id.startsWith(OBSTRUCTION_ID_PREFIX)).map(c => ({ id: c.id, min: c.min, max: c.max })),
    cues: {
      light: light !== null && tick - light.tick <= LIGHT_CUE_MEMORY_TICKS ? { origin: light.origin, target: light.target } : null,
      audioTemplateId: audio !== null && tick - audio.tick <= AUDIO_CUE_MEMORY_TICKS ? audio.templateId : null,
    },
    actuators: inputs.actuators,
    waterJet: trueJet(world),
  };
}

/** The jet the simulator actually discharged on the last stepped tick (from its truth record), else null. */
function trueJet(world: WorldState): RenderSnapshot["waterJet"] {
  const water = world.profile.modules.water;
  if (water === null) return null;
  for (let i = world.truthEvents.length - 1; i >= 0; i--) {
    const event = world.truthEvents[i];
    if (event.tick < world.tick - 1) break;
    if (event.kind !== "water_delivered") continue;
    const { apex, axis, rangeM } = event.data as { apex: { x: number; y: number; z: number }; axis: { x: number; y: number; z: number }; rangeM: number };
    return { origin: { x: apex.x, y: apex.y, z: apex.z }, axis: { x: axis.x, y: axis.y, z: axis.z }, halfAngleRad: (water.coneHalfAngleDeg * Math.PI) / 180, rangeM };
  }
  return null;
}
