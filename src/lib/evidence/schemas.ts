/**
 * Boundary schemas for everything the evidence store accepts.
 *
 * Built on the strict contract schemas: unknown members are rejected, so an observation, report or prior
 * cannot carry extra fields such as a true position, an occupant key or scenario-only anchors into the
 * belief. Semantic checks cover what the schema language cannot express (box ordering, unit sector axes,
 * unique and resolvable identifiers in the floor-plan prior).
 */
import type { FloorPlanPrior } from "../contracts/evidence.ts";
import type { Region } from "../contracts/geometry.ts";
import { depthImageProblems, MAX_DEPTH_IMAGE_CELLS, MAX_UNION_PARTS, polygonArea } from "../contracts/geometry.ts";
import type { Observation } from "../contracts/observation.ts";
import type { Schema } from "../contracts/schema.ts";
import { arr, int, lit, num, obj, positive, str, validate, vec3Schema } from "../contracts/schema.ts";

const nullable = (inner: Schema): Schema => ({ type: "nullable", inner });
const id = str(256);
const point2 = arr(num(), 2, 2);
const floorIndex = int(-20, 200);

const simpleRegionVariants = {
  box: obj({ kind: lit("box"), min: vec3Schema, max: vec3Schema }),
  sphere: obj({ kind: lit("sphere"), center: vec3Schema, radiusM: num(0) }),
  sector: obj({ kind: lit("sector"), apex: vec3Schema, axis: vec3Schema, halfAngleRad: num(0, Math.PI), rangeM: num(0) }),
  prism: obj({ kind: lit("prism"), polygon: arr(point2, 1024, 3), zMin: num(), zMax: num() }),
  depth_image: obj({
    kind: lit("depth_image"),
    apex: vec3Schema,
    forward: vec3Schema,
    up: vec3Schema,
    hfovRad: num(0, Math.PI),
    vfovRad: num(0, Math.PI),
    cols: int(1, MAX_DEPTH_IMAGE_CELLS),
    rows: int(1, MAX_DEPTH_IMAGE_CELLS),
    depthsM: arr(num(0), MAX_DEPTH_IMAGE_CELLS, 1),
    floorZM: arr({ type: "nullable", inner: num() }, MAX_DEPTH_IMAGE_CELLS, 1),
  }),
};

const simpleRegionSchema: Schema = { type: "tagged", tag: "kind", variants: simpleRegionVariants };

/** Regions, including flat unions (occlusion-aware footprints); a union never nests another union. */
export const regionSchema: Schema = {
  type: "tagged",
  tag: "kind",
  variants: {
    ...simpleRegionVariants,
    union: obj({ kind: lit("union"), parts: arr(simpleRegionSchema, MAX_UNION_PARTS, 1) }),
  },
};

const detectionSchema: Schema = {
  type: "tagged",
  tag: "kind",
  variants: {
    possible_person: obj({
      kind: lit("possible_person"),
      position: vec3Schema,
      uncertaintyM: num(0),
      confidence: num(0, 1),
      method: lit("oracle_fixture", "thermal_blob", "image_detector"),
    }),
    hazard: obj({ kind: lit("hazard"), hazard: lit("fire", "smoke", "heat", "obstruction"), region: regionSchema, intensity: num() }),
    opening_state: obj({ kind: lit("opening_state"), openingId: id, state: lit("closed", "open", "broken", "blocked") }),
  },
};

export const observationSchema: Schema = obj({
  id,
  runId: id,
  sensorId: str(128),
  modality: lit("rgb", "thermal", "lidar", "ultrasound", "imu"),
  captureTick: int(),
  arrivalTick: int(),
  frameId: nullable(id),
  calibrationId: nullable(id),
  provenance: lit("simulated_sensor", "fixture", "recording"),
  sensorPose: obj({ position: vec3Schema, yawRad: num(), sigmaM: num(0) }),
  quality: num(0, 1),
  footprint: nullable(regionSchema),
  personSearch: nullable(lit("oracle_fixture", "thermal_blob", "image_detector")),
  detections: arr(detectionSchema, 64),
  supersedes: nullable(id),
});

export const reportSchema: Schema = obj({
  id,
  runId: id,
  receivedTick: int(),
  source: lit("caller", "judge", "crew_radio"),
  channel: lit("typed", "voice"),
  originalText: str(20_000),
  roomHint: nullable(id),
  countText: nullable(str(2000)),
  interpretation: lit("rules", "model", "none"),
  supersedes: nullable(id),
});

export const crewConfirmationSchema: Schema = obj({
  id,
  tick: int(),
  crewId: str(128),
  trackId: nullable(id),
  reportIds: arr(id, 64),
  roomId: nullable(id),
  text: str(4000, 0),
});

export const routeSchema: Schema = obj({
  id,
  purpose: lit("return", "alternate_return", "evacuation"),
  waypoints: arr(vec3Schema, 512),
  status: lit("supported", "unsupported", "unknown"),
  assessedTick: int(),
  evidenceIds: arr(id, 512),
  estimatedDurationS: num(0),
  reason: str(1000),
});

export const mapChangeInputSchema: Schema = obj({ tick: int(), region: regionSchema, reason: str(1000), observationIds: arr(id, 512) });

const priorSchema: Schema = obj({
  revision: int(),
  source: str(500),
  floors: arr(obj({ index: floorIndex, elevationM: num(), ceilingM: num() }), 64),
  rooms: arr(obj({ id, name: str(128), floor: floorIndex, polygon: arr(point2, 256, 3), zMin: num(), zMax: num() }), 512, 1),
  openings: arr(
    obj({
      id,
      kind: lit("door", "window", "opening"),
      rooms: arr(id, 2, 2),
      center: vec3Schema,
      widthM: num(0),
      heightM: num(0),
      outwardNormal: vec3Schema,
      priorState: lit("closed", "open", "broken", "blocked", "unknown"),
    }),
    1024,
  ),
  exits: arr(obj({ id, openingId: id }), 64),
  assemblyPoint: regionSchema,
  stairs: arr(obj({ id, bottomRoomId: id, topRoomId: id, bottom: vec3Schema, top: vec3Schema, widthM: num(0) }), 64),
}, ["stairs"]);

export const configSchema: Schema = obj({
  runId: id,
  mapPrior: priorSchema,
  adequateQuality: { type: "number", min: 0, exclusiveMin: true, max: 1 },
  coverageSpacingM: positive(10),
  observationWindowTicks: int(),
  associationGateMaxM: num(0, 100),
  occupantSpeedMps: num(0, 20),
  minTrackConfidence: num(0, 1),
});

/** Constraints a region schema cannot express. */
export function regionProblems(region: Region, path: string): string[] {
  switch (region.kind) {
    case "union":
      return region.parts.flatMap((part, index) => regionProblems(part, `${path}.parts[${index}]`));
    case "box":
      return region.min.x <= region.max.x && region.min.y <= region.max.y && region.min.z <= region.max.z ? [] : [`${path}: box min exceeds max`];
    case "sphere":
      return [];
    case "sector":
      return Math.abs(Math.hypot(region.axis.x, region.axis.y, region.axis.z) - 1) <= 1e-6 ? [] : [`${path}: sector axis must be a unit vector`];
    case "prism":
      return region.zMin <= region.zMax ? [] : [`${path}: prism zMin exceeds zMax`];
    case "depth_image":
      return depthImageProblems(region).map(problem => `${path}: depth image ${problem}`);
  }
}

/** Every reason `value` is not an acceptable observation; empty when it is. */
export function observationProblems(value: unknown): string[] {
  const errors = validate(observationSchema, value);
  if (errors.length > 0) return errors;
  const observation = value as Observation;
  const problems = observation.footprint ? regionProblems(observation.footprint, "$.footprint") : [];
  observation.detections.forEach((detection, index) => {
    if (detection.kind === "hazard") problems.push(...regionProblems(detection.region, `$.detections[${index}].region`));
    if (detection.kind === "possible_person" && detection.method !== observation.personSearch) {
      problems.push(`$.detections[${index}].method: a possible-person detection must use the frame's personSearch method (${String(observation.personSearch)})`);
    }
  });
  return problems;
}

/** Identifier and geometry consistency of a floor-plan prior that already passed its schema. */
export function priorProblems(prior: FloorPlanPrior): string[] {
  const roomIds = new Set<string>();
  const problems: string[] = [];
  for (const room of prior.rooms) {
    if (roomIds.has(room.id)) problems.push(`duplicate room id ${room.id}`);
    roomIds.add(room.id);
    if (!(room.zMin < room.zMax)) problems.push(`room ${room.id}: zMin must be below zMax`);
    if (polygonArea(room.polygon) === 0) problems.push(`room ${room.id}: polygon has no area`);
  }
  const floors = new Set(prior.floors.map(floor => floor.index));
  if (floors.size > 0) {
    for (const room of prior.rooms) if (!floors.has(room.floor)) problems.push(`room ${room.id}: floor ${room.floor} is not listed`);
  }
  return [...problems, ...openingProblems(prior, roomIds), ...regionProblems(prior.assemblyPoint, "$.mapPrior.assemblyPoint")];
}

function openingProblems(prior: FloorPlanPrior, roomIds: ReadonlySet<string>): string[] {
  const openingIds = new Set<string>();
  const problems: string[] = [];
  for (const opening of prior.openings) {
    if (openingIds.has(opening.id)) problems.push(`duplicate opening id ${opening.id}`);
    openingIds.add(opening.id);
    const [inside, outside] = opening.rooms;
    if (!roomIds.has(inside)) problems.push(`opening ${opening.id}: unknown room ${inside}`);
    if (outside !== "exterior" && !roomIds.has(outside)) problems.push(`opening ${opening.id}: unknown room ${outside}`);
  }
  for (const exit of prior.exits) {
    if (!openingIds.has(exit.openingId)) problems.push(`exit ${exit.id}: unknown opening ${exit.openingId}`);
  }
  return problems;
}
