/**
 * PRIMARY ACCEPTANCE (PRD §3, §7, §8): the whole main rescue on the Troy scene, headless.
 *
 * Scope: loadPreset("main") through MissionRuntime with the headless collider camera ("headless-collider/v1"),
 * the optical-flow baseline controller, the local planner and the scripted commander (approves every
 * proposal 300 ticks after it starts waiting; recalls the aircraft once the evaluator reports arrival). Each
 * stage is checked from the event log, harness records and, for evaluator milestones only, world truth.
 * The test asserts FULL completion; it is never weakened to a partial pass. The compact event timeline is
 * printed with the result so a failing stage can be read directly.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MissionEvent } from "../contracts/events.ts";
import { rescueLabel } from "../contracts/outcomes.ts";
import type { DriveResult } from "./mission-driver.ts";
import { driveMission } from "./mission-driver.ts";

interface Stage {
  readonly name: string;
  readonly tick: number | null;
}

function firstTick(events: readonly MissionEvent[], test: (event: MissionEvent) => boolean, after = -1): number | null {
  return events.find(event => event.tick > after && test(event))?.tick ?? null;
}

/** Ordered stages of the main rescue with the tick each was first reached (null: never). */
export function rescueStages(run: DriveResult): Stage[] {
  const { events, runtime, result } = run;
  const records = runtime.harness.records();
  const ofKind = (kind: string) => records.filter(r => r.proposal.action.kind === kind);
  const statusTick = (kind: string, status: string) => {
    const ticks = ofKind(kind).flatMap(r => r.history.filter(h => h.status === status).map(h => h.tick));
    return ticks.length > 0 ? Math.min(...ticks) : null;
  };
  const breachDone = (() => {
    const done = ofKind("breach_opening").filter(r => r.status === "completed").flatMap(r => r.history.filter(h => h.status === "completed").map(h => h.tick));
    return done.length > 0 ? Math.min(...done) : null;
  })();
  const broken = firstTick(events, e => e.kind === "opening.observed" && e.data.state === "broken");
  const sprayApproved = statusTick("spray", "approved");
  const water = ofKind("spray").reduce((sum, r) => sum + (r.execution?.effects.waterDischargedL ?? 0), 0);
  const sprayDone = statusTick("spray", "completed");
  const extinguished = runtime.world.fires.length > 0 && runtime.world.fires.every(f => f.extinguished) ? (sprayDone ?? runtime.world.tick) : null;
  const evacuationSupported = sprayDone === null ? null : firstTick(events, e => e.kind === "route.status_changed" && e.data.purpose === "evacuation" && e.data.status === "supported", sprayDone);
  const guiding = statusTick("guide", "executing");
  const arrived = firstTick(events, e => e.kind === "evaluator.occupant_arrived");
  const returned = result !== null && (result.droneReturn === "returned" || result.droneReturn === "landed_contingency") ? result.endedTick : null;
  return [
    { name: "report received", tick: firstTick(events, e => e.kind === "report.received") },
    { name: "mission authorized", tick: firstTick(events, e => e.kind === "mission.authorized") },
    { name: "breach proposed (exterior approach)", tick: statusTick("breach_opening", "awaiting_approval") },
    { name: "breach approved", tick: statusTick("breach_opening", "approved") },
    { name: "glass strike completed and window observed broken", tick: breachDone !== null && broken !== null ? Math.max(breachDone, broken) : null },
    { name: "entry into the building", tick: run.firstIndoorTick },
    { name: "possible-occupant track", tick: firstTick(events, e => e.kind === "track.created") },
    { name: "spray proposed", tick: statusTick("spray", "awaiting_approval") },
    { name: "spray approved", tick: sprayApproved },
    { name: "water discharged", tick: water > 0 ? sprayDone ?? statusTick("spray", "executing") : null },
    { name: "fire extinguished (simulation)", tick: extinguished },
    { name: "evacuation route supported after the intervention", tick: evacuationSupported },
    { name: "guidance executing", tick: guiding },
    { name: "evaluator: occupant reached the assembly point", tick: arrived },
    { name: "drone returned or contingency landing", tick: returned },
  ];
}

// The product's primary acceptance test: about 10 minutes of headless simulation, so it is opt-in
// (npm run test:e2e) rather than part of npm run check. Its assertion of full completion is never weakened.
const E2E_ENABLED = process.env.FLYFIREFIGHTER_E2E === "1";

test("main rescue: report → breach → entry → spray → guided evacuation → evaluator arrival → return", { timeout: 30 * 60_000, skip: E2E_ENABLED ? false : "opt-in: set FLYFIREFIGHTER_E2E=1 or run npm run test:e2e (≈10 min full mission)" }, async () => {
  const run = await driveMission({ runId: "run-e2e-main", variant: "main", seed: "troy-seed-1" });
  const stages = rescueStages(run);
  const msPerTick = run.wallMs / Math.max(1, run.ticks);
  const lines = [
    `E2E main rescue: ${run.ticks} ticks (${(run.ticks / 100).toFixed(1)} s simulated) in ${(run.wallMs / 1000).toFixed(1)} s wall, ${msPerTick.toFixed(2)} ms/tick, simulated:wall ${(run.ticks / 100 / (run.wallMs / 1000)).toFixed(2)}`,
    "Stages:",
    ...stages.map(s => `  ${s.tick === null ? "MISSING" : `t=${(s.tick / 100).toFixed(2)}s`.padEnd(10)} ${s.name}`),
    "Timeline:",
    ...run.timeline.map(line => `  ${line}`),
    `Outcome: ${run.result === null ? "not scored" : `${rescueLabel(run.result)}; drone return ${run.result.droneReturn}; ${run.result.violations.length} violation(s)`}`,
    ...(run.result?.violations ?? []).map(v => `  violation t=${(v.tick / 100).toFixed(2)}s ${v.kind}: ${v.detail}`),
  ];
  console.log(lines.join("\n"));
  const missing = stages.filter(s => s.tick === null).map(s => s.name);
  assert.deepEqual(missing, [], `First missing stage: ${missing[0] ?? "none"}`);
  for (let i = 1; i < stages.length; i++) {
    if (i === 6) continue; // a track can precede entry: the rear bedroom is visible once the window is broken
    assert.ok((stages[i].tick as number) >= (stages[i - 1].tick as number), `${stages[i].name} before ${stages[i - 1].name}`);
  }
  assert.ok(run.result !== null);
  assert.equal(rescueLabel(run.result), "simulated_evacuation_completed");
  assert.ok(run.result.droneReturn === "returned" || run.result.droneReturn === "landed_contingency", `drone return ${run.result.droneReturn}`);
});
