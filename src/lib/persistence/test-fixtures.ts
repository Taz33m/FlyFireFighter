/**
 * Hand-built run bundles in the exported format for the persistence tests: events written by the real
 * EventLog (canonical JSON lines), results.json with the SHA-256 of events.jsonl and replay.jsonl as the
 * export records them, and a small replay. Test support only; no simulation runs.
 */
import { sha256Hex } from "../contracts/canonical.ts";
import { EventLog } from "../contracts/events.ts";
import type { ConstraintViolation, MissionResult } from "../contracts/outcomes.ts";
import type { UploadFiles } from "./validate.ts";

export interface FixtureOptions {
  readonly runId: string;
  readonly controller?: string;
  readonly decider?: "local" | "decisions";
  readonly scenarioId?: string;
  readonly seed?: string;
  /** Occupant arrival tick; null leaves the occupant inside (incomplete). */
  readonly arrivalTick?: number | null;
  readonly violations?: readonly ConstraintViolation[];
  readonly evidenceTick?: number;
  readonly breachTick?: number | null;
  readonly sprayTick?: number | null;
  readonly replayFrames?: number;
  readonly withResult?: boolean;
}

const AUTHORIZED = 100;

export function fixtureEvents(o: FixtureOptions): string {
  const log = new EventLog(o.runId);
  log.append({ tick: 0, source: "system", kind: "run.started", reason: `Run ${o.runId} started (simulation).` });
  log.append({ tick: AUTHORIZED, source: "commander", kind: "mission.authorized", reason: "Commander authorized the bounded mission.", subject: "commander-1" });
  log.append({
    tick: AUTHORIZED, source: "planner", kind: "decision.selected", subject: "inspect_room:room-u-rear-bedroom",
    reason: "Local planner selected: Move to observe the upstairs rear bedroom from outside window win-u-rear-bedroom-east.",
    data: { decider: "local_planner", deciderLabel: "Local planner", candidateId: "inspect_room:room-u-rear-bedroom", localChoiceId: "inspect_room:room-u-rear-bedroom", latencyMs: null, gatewayStatus: null, risk: "routine", tool: "inspect_room" },
  });
  log.append({ tick: o.evidenceTick ?? 2100, source: "evidence", kind: "track.created", reason: "Thermal and acoustic cues suggest a possible occupant near the bedroom window.", subject: "track-1" });
  if (o.breachTick !== null) log.append({ tick: o.breachTick ?? 3100, source: "harness", kind: "proposal.executing", reason: "Approved breach of the study window is executing.", subject: "p-breach", data: { proposalId: "p-breach", actionKind: "breach_opening" } });
  log.append({
    tick: (o.breachTick ?? 3100) + 50, source: "decisions_gateway", kind: "decision.selected", subject: "spray_fire:fire-kitchen",
    reason: "OpenAI Decisions selected: suppress the kitchen fire from the hallway standoff.",
    data: { decider: "openai_decisions", deciderLabel: "OpenAI Decisions", model: "gpt-6-luna", candidateId: "spray_fire:fire-kitchen", localChoiceId: "hold:station", rationale: "Water on the kitchen fire reopens the hallway as an exit for the occupant.", latencyMs: 412, agreement: "disagrees_with_local", gatewayStatus: "ok", risk: "consequential", tool: "spray_fire" },
  });
  if (o.sprayTick !== null) log.append({ tick: o.sprayTick ?? 9100, source: "harness", kind: "proposal.executing", reason: "Approved spray on the kitchen fire is executing.", subject: "p-spray", data: { proposalId: "p-spray", actionKind: "spray" } });
  log.append({ tick: 30000, source: "evaluator", kind: "outcome.recorded", reason: "Outcome recorded by the simulation evaluator." });
  return log.toJsonl();
}

export function fixtureReplay(frames: number): string {
  let text = "";
  for (let i = 0; i < frames; i++) {
    text += `${JSON.stringify({ tick: i * 10, render: { label: "simulation_truth_for_rendering", tick: i * 10, drone: { position: { x: i * 0.1, y: 1.5, z: 2 }, yawRad: 0, velocity: { x: 0, y: 0, z: 0 } } }, summary: { status: "running", controllerLabel: "Optical-flow baseline", deciderLabel: "Local planner", waterRemainingL: 10, pendingApprovalId: null, contingency: null, estimatedPosition: null } })}\n`;
  }
  return text;
}

export function fixtureResult(o: FixtureOptions): MissionResult {
  const arrival = o.arrivalTick === undefined ? 20100 : o.arrivalTick;
  return {
    label: "simulation_evaluator", runId: o.runId, seed: o.seed ?? "s1", endedTick: 30000, budgetTick: 60000,
    occupants: [{ label: "simulation_evaluator", occupantKey: "occ-1", outcome: arrival === null ? "inside" : "reached_assembly_point", arrivalTick: arrival }],
    violations: o.violations ?? [], droneReturn: "returned",
  };
}

export function fixtureBundle(o: FixtureOptions): UploadFiles & { readonly "replay.jsonl": string } {
  const events = fixtureEvents(o);
  const replay = fixtureReplay(o.replayFrames ?? 30);
  const result = o.withResult === false ? null : fixtureResult(o);
  const results = {
    schema: "flyfirefighter.results/1",
    label: "simulation — Troy training scene: real exterior reference; fictional interior and incident",
    runId: o.runId,
    status: "ended",
    scenarioId: o.scenarioId ?? "troy-training/main",
    seed: o.seed ?? "s1",
    config: { scenarioId: o.scenarioId ?? "troy-training/main", seed: o.seed ?? "s1", aircraftId: "tender-t1", controller: o.controller ?? "flow_baseline", decider: o.decider ?? "local", commanderId: "commander-1", speed: 1 },
    scene: { sceneId: "troy-training", revision: 3, metaSha256: "a".repeat(64) },
    controller: { mode: o.controller ?? "flow_baseline", label: o.controller === "engineered_readout" ? "FlyVis flow/0000/000 + engineered readout" : "Optical-flow baseline", checkpointSha256: null },
    decider: { label: o.decider === "decisions" ? "OpenAI Decisions" : "Local planner", status: "ok" },
    events: { file: "events.jsonl", sha256: sha256Hex(events), count: events.split("\n").length - 1 },
    replay: { file: "replay.jsonl", sha256: sha256Hex(replay), frames: replay.split("\n").length - 1 },
    outcome: null,
    result,
    timing: { simulatedS: 300, wallMs: 123456.5, simToWallRatio: 2.43 },
  };
  return { "results.json": `${JSON.stringify(results, null, 2)}\n`, "events.jsonl": events, "replay.jsonl": replay };
}
