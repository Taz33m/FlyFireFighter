/**
 * UI fixture: hand-authored, truth-free belief content (observations, reports, tracks, coverage, routes)
 * for exercising the command panels while the mission worker is unavailable. Observations are labelled
 * `provenance: "fixture"` and person detections `oracle_fixture`, so nothing here is sensor or detector
 * evidence.
 */
import type { BeliefSnapshot, CallerReport, FloorPlanPrior, OccupantTrack, RoomCoverage, RouteAssessment } from "@/lib/contracts/evidence";
import type { Vec3 } from "@/lib/contracts/frames";
import { vec3 } from "@/lib/contracts/frames";
import type { Observation } from "@/lib/contracts/observation";
import type { SceneMetaJson } from "@/lib/contracts/scene";
import { fromJsonVec3 } from "@/lib/contracts/scene";
import type { FixtureContext, FixtureStep } from "./fixture-world";
import { FIRE_BOX, FIXTURE_IDS, FIXTURE_STEPS, STAIR_TOP, STEP_TICK, fixtureDronePose } from "./fixture-world";

const after = (step: FixtureStep, from: FixtureStep) => FIXTURE_STEPS.indexOf(step) >= FIXTURE_STEPS.indexOf(from);

/** Floor-plan prior from the scene metadata. Scenario anchors are deliberately not copied. */
export function priorFromSceneMeta(meta: SceneMetaJson): FloorPlanPrior {
  return {
    revision: meta.revision,
    source: `Scene metadata ${meta.sceneId} revision ${meta.revision} (authored fictional interior)`,
    floors: meta.floors,
    rooms: meta.rooms.map(r => ({ id: r.id, name: r.name, floor: r.floor, polygon: r.polygon, zMin: r.zMin, zMax: r.zMax })),
    openings: meta.openings.map(o => ({
      id: o.id, kind: o.kind, rooms: [o.rooms[0], o.rooms[1]], center: fromJsonVec3(o.center), widthM: o.widthM, heightM: o.heightM,
      outwardNormal: fromJsonVec3(o.outwardNormal), priorState: o.initialState,
    })),
    exits: meta.exits,
    assemblyPoint: { kind: "box", min: fromJsonVec3(meta.assemblyPoint.min), max: fromJsonVec3(meta.assemblyPoint.max) },
  };
}

export const EMPTY_PRIOR: FloorPlanPrior = {
  revision: 0,
  source: "No floor plan loaded (scene metadata unavailable)",
  floors: [],
  rooms: [],
  openings: [],
  exits: [],
  assemblyPoint: { kind: "box", min: vec3(0, 0, 0), max: vec3(0, 0, 0) },
};

function fixtureObservation(ctx: FixtureContext, id: string, modality: Observation["modality"], captureTick: number, partial: Pick<Observation, "footprint" | "detections" | "personSearch" | "quality">): Observation {
  const pose = fixtureDronePose(ctx.step);
  return {
    id, runId: ctx.runId, sensorId: `${modality}-front`, modality, captureTick, arrivalTick: captureTick + 5,
    frameId: null, calibrationId: null, provenance: "fixture",
    sensorPose: { position: pose.position, yawRad: pose.yawRad, sigmaM: 0.15 + ctx.sigmaIncreaseM },
    supersedes: null, ...partial,
  };
}

const PERSON_POSITION: Vec3 = vec3(23.8, 0.1, 4.0);

function observations(ctx: FixtureContext): Observation[] {
  const list: Observation[] = [];
  if (after(ctx.step, "breach_pending")) {
    list.push(fixtureObservation(ctx, "fx-obs-window", "rgb", 4100, {
      footprint: { kind: "box", min: vec3(23.4, -3.4, 4.2), max: vec3(25.0, -2.6, 6.0) }, quality: 0.8, personSearch: null,
      detections: [{ kind: "opening_state", openingId: FIXTURE_IDS.window, state: after(ctx.step, "spray_pending") ? "broken" : "closed" }],
    }));
  }
  if (after(ctx.step, "spray_pending")) {
    list.push(fixtureObservation(ctx, "fx-obs-person", "thermal", 7300, {
      footprint: { kind: "box", min: vec3(22.2, -2.7, 3.6), max: vec3(26.2, 1.4, 6.4) }, quality: 0.7, personSearch: "oracle_fixture",
      detections: [{ kind: "possible_person", position: PERSON_POSITION, uncertaintyM: 0.6, confidence: 0.55, method: "oracle_fixture" }],
    }));
    list.push(fixtureObservation(ctx, "fx-obs-fire", "thermal", 7700, {
      footprint: { kind: "box", min: vec3(19.7, -0.2, 3.6), max: vec3(22.0, 4.36, 6.5) }, quality: 0.65, personSearch: "oracle_fixture",
      detections: [{ kind: "hazard", hazard: "fire", region: { kind: "box", min: FIRE_BOX.min, max: FIRE_BOX.max }, intensity: 0.7 }],
    }));
  }
  if (ctx.step === "guiding") {
    list.push(fixtureObservation(ctx, "fx-obs-route", "lidar", 11700, {
      footprint: { kind: "box", min: vec3(13.9, -0.2, 0), max: vec3(22.0, 4.36, 6.5) }, quality: 0.75, personSearch: null, detections: [],
    }));
  }
  return list;
}

function reports(ctx: FixtureContext): CallerReport[] {
  if (ctx.reportText === null) return [];
  const rear = /rear\s+bed\s*room/i.test(ctx.reportText);
  return [{
    id: "fx-report-1", runId: ctx.runId, receivedTick: STEP_TICK.reported, source: "judge", channel: "typed", originalText: ctx.reportText,
    roomHint: rear ? "room-u-rear-bedroom" : null, countText: null, interpretation: rear ? "rules" : "none", supersedes: null,
  }];
}

function tracks(ctx: FixtureContext): OccupantTrack[] {
  if (!after(ctx.step, "spray_pending")) return [];
  return [{
    id: FIXTURE_IDS.track, status: "possible", observationIds: ["fx-obs-person"], position: PERSON_POSITION, uncertaintyM: 0.6,
    roomId: "room-u-rear-bedroom", firstSeenTick: 7300, lastSeenTick: 7300, confidence: 0.55, mergedInto: null, ambiguousWith: [],
  }];
}

const COVERED: Readonly<Partial<Record<FixtureStep, Readonly<Record<string, RoomCoverage["state"]>>>>> = {
  breach_pending: { "room-u-rear-bedroom": "degraded" },
  spray_pending: { "room-u-rear-bedroom": "observed", "room-u-hall": "degraded" },
  spraying: { "room-u-rear-bedroom": "observed", "room-u-hall": "degraded" },
  guiding: { "room-u-rear-bedroom": "observed", "room-u-hall": "observed", "room-stair": "degraded" },
};

function coverage(ctx: FixtureContext): RoomCoverage[] {
  const states = COVERED[ctx.step] ?? {};
  return ctx.prior.rooms.map(room => {
    const state = states[room.id] ?? "unobserved";
    const seen = state !== "unobserved";
    return {
      roomId: room.id, state, fractionAdequate: state === "observed" ? 0.8 : 0, fractionAny: seen ? 0.85 : 0,
      lastObservedTick: seen ? STEP_TICK[ctx.step] - 50 : null, bestModality: seen ? "thermal" : null,
    };
  });
}

function routes(ctx: FixtureContext): RouteAssessment[] {
  if (ctx.step !== "guiding") return [];
  return [{
    id: FIXTURE_IDS.route, purpose: "evacuation", status: "supported", assessedTick: 11700, evidenceIds: ["fx-obs-route"], estimatedDurationS: 45,
    waypoints: [vec3(21.3, 1.4, 3.6), STAIR_TOP, vec3(14.23, 3.76, 0), vec3(12.8, 6.2, 0), vec3(14.5, 6.2, 0), vec3(19, 25.5, 0)],
    reason: "Fresh fixture frames show the hall passable after suppression and the front door open.",
  }];
}

export function fixtureBelief(ctx: FixtureContext): BeliefSnapshot {
  const pose = fixtureDronePose(ctx.step);
  const tick = STEP_TICK[ctx.step];
  const obs = observations(ctx);
  const sigma = 0.15 + ctx.sigmaIncreaseM;
  return {
    runId: ctx.runId, tick, evidenceRevision: 1 + obs.length * 3 + (ctx.reportText === null ? 0 : 1),
    mapPrior: ctx.prior, mapRevision: ctx.prior.revision, mapChanges: [],
    pose: { tick, position: vec3(pose.position.x + 0.08, pose.position.y - 0.05, pose.position.z), yawRad: pose.yawRad + 0.01, velocity: vec3(0, 0, 0), sigmaM: sigma, yawSigmaRad: 0.02, supported: sigma < 1 },
    aircraft: { enduranceRemainingS: 900 - tick / 100, waterRemainingL: ctx.step === "guiding" ? 0.6 : ctx.step === "spraying" ? 0.62 : 1, payloadsOnboard: [], ambientC: 24, thrustAvailableN: 60 },
    landing: { supported: false, site: null, evidenceIds: [], reason: "UI fixture: no landing assessment." },
    observations: obs,
    reports: reports(ctx),
    tracks: tracks(ctx),
    crewConfirmations: [],
    coverage: coverage(ctx),
    hazards: obs.flatMap(o => o.detections.flatMap(d => (d.kind === "hazard" ? [{ observationId: o.id, tick: o.captureTick, hazard: d.hazard, region: d.region, intensity: d.intensity }] : []))),
    openings: obs.flatMap(o => o.detections.flatMap(d => (d.kind === "opening_state" ? [{ openingId: d.openingId, state: d.state, tick: o.captureTick, observationId: o.id }] : []))),
    routes: routes(ctx),
    dispatchConfirmed: null,
  };
}
