/**
 * After a fire goes out, through the runtime's own sensor → evidence → planner/route path (no simulator truth
 * past the sensors): the cameras report the place with intensity 0, the latest sighting decides, the planner
 * offers no further spray at that fire, and the route assessor's fire blocker lifts.
 *
 * Regression (main E2E, spray completed at 188.61 s): only burning fires were reported, so the last flame
 * sighting stood for 30 s, another spray was proposed two seconds later and the evacuation route stayed
 * unsupported with "Fire observed after the intervention ... overlaps the walking corridor".
 *
 * Scope: the staged_spray world of the Troy scene (a test tool, scenario.ts) with the aircraft held in the
 * upstairs hall 1.5 m south of the fire, facing it; the clock is advanced without flying. The fire is put out by
 * water reaching it through the fire model's own suppression rule.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BeliefSnapshot } from "../contracts/evidence.ts";
import { EventLog } from "../contracts/events.ts";
import { vec3 } from "../contracts/frames.ts";
import { defaultEvidenceConfig } from "../evidence/config.ts";
import { EvidenceStore } from "../evidence/store.ts";
import { DEFAULT_POLICY } from "../harness/policy.ts";
import { buildCandidateSet } from "../navigation/planner/candidates.ts";
import { assessRoute } from "../navigation/routes/index.ts";
import { deliverWater } from "../simulation/fire.ts";
import { aircraftStatus, estimatedPose, landingSupport } from "../simulation/localization.ts";
import { troyMeta } from "./mission-driver.ts";
import { createPresetWorld, loadPreset } from "./scenario.ts";
import { SensingPipeline } from "./sensing.ts";

const RUN = "run-fire-out";

describe("a fire put out is seen out", () => {
  test("the latest sighting shows no flame, no spray is offered at it and the route's fire blocker lifts", () => {
    const preset = loadPreset(troyMeta().meta, "staged_spray", "troy-seed-1", RUN);
    const world = createPresetWorld(preset);
    world.drone.position = vec3(20.85, 0.6, 4.6);
    world.drone.yawRad = Math.PI / 2;
    const evidence = new EvidenceStore(defaultEvidenceConfig(RUN, preset.prior));
    const sensing = new SensingPipeline(preset.prior);
    const log = new EventLog(RUN);
    const envelope = preset.envelope(RUN, "commander", 0);
    const advanceTo = (end: number): BeliefSnapshot => {
      for (let tick = world.tick; tick <= end; tick++) {
        world.tick = tick;
        sensing.sense(world);
        sensing.ingest(tick, evidence, log, preset.prior);
      }
      return evidence.snapshot({ tick: end, pose: estimatedPose(world), aircraft: aircraftStatus(world), landing: landingSupport(world) });
    };
    const fireSightings = (belief: BeliefSnapshot) => belief.hazards.filter(h => h.hazard === "fire").sort((a, b) => a.tick - b.tick);
    const sprays = (belief: BeliefSnapshot, lastInterventionTick: number | null) =>
      buildCandidateSet({ belief, profile: preset.scenario.profile, envelope, policy: DEFAULT_POLICY, lastInterventionTick, proposer: "local_planner" }).candidates.filter(c => c.tool === "request_suppression");
    const evacuation = (belief: BeliefSnapshot, lastInterventionTick: number | null) =>
      assessRoute({ belief, tick: belief.tick, lastInterventionTick, policy: DEFAULT_POLICY }, preset.evacuationRouteRequest(world.occupants[0].position));

    const burning = advanceTo(100);
    const flames = fireSightings(burning);
    assert.ok(flames.length > 0 && flames.every(h => h.intensity > 0), "the burning fire is seen burning");
    assert.ok(sprays(burning, null).length > 0, "a spray is offered while it burns");
    assert.equal(evacuation(burning, null).status, "unsupported");
    assert.match(evacuation(burning, null).reason, /Fire observed/);

    deliverWater(world, world.fires[0].region, 1, world.tick);
    assert.equal(world.fires[0].extinguished, true);
    const outTick = world.tick;
    const after = advanceTo(outTick + 100);
    const latest = fireSightings(after).at(-1);
    assert.ok(latest !== undefined && latest.tick > outTick && latest.intensity === 0, "the cameras report the place with no flame");
    assert.deepEqual(sprays(after, outTick).map(c => c.id), [], "no further spray at a fire seen out");
    const route = evacuation(after, outTick);
    assert.notEqual(route.status, "unsupported", route.reason);
    assert.doesNotMatch(route.reason, /Fire observed/);
  });
});
