/**
 * Simulated actuators: apply one tick's harness-issued commands to world truth.
 *
 * Commands carry targets in the ESTIMATED world frame. The aircraft points its nozzle, breaker arm and light
 * through its own pose estimate (truth + estimator drift) into the body frame, and the physical effect
 * leaves from the TRUE pose — so localization error produces a real miss, never a corrected one.
 *
 * - water: draws the tank down (at most the module's maximum flow per tick), sprays the true jet sector
 *   (module cone half-angle, full module range) into the fire model, records water reaching an occupant,
 *   and returns the jet reaction F = ρQ²/A opposite the jet.
 * - strike: breaks a window only when the physical strike point is within reach and on that window's
 *   intact glass; the opening becomes "broken" for good and its panes stop colliding.
 * - release: the payload leaves the aircraft (nothing about receipt or use).
 * - light_cue / audio: update world.cues from the aircraft's true position.
 * Commands that cannot take effect change nothing; the reason is kept in actuationNotes(world).
 */
import type { ActuatorCommand } from "../contracts/actions.ts";
import { TICK_S } from "../contracts/clock.ts";
import type { Pose, Vec3 } from "../contracts/frames.ts";
import { add, bodyPointToWorld, distance, norm, normalize, rotateBodyToWorld, scale, sub, vec3, worldPointToBody, wrapAngle, ZERO } from "../contracts/frames.ts";
import type { Region } from "../contracts/geometry.ts";
import { distanceToRegion, sector } from "../contracts/geometry.ts";
import { boxProximity } from "./collisions.ts";
import { jetReactionN } from "./dynamics.ts";
import { deliverWater } from "./fire.ts";
import { OCCUPANT_RADIUS_M, occupantBodyPoints } from "./occupant-body.ts";
import { lineOfSight } from "./raycast.ts";
import { clearOpeningAreaM2, findOpening } from "./scene.ts";
import type { WorldState } from "./world-state.ts";
import { activeColliders } from "./world-state.ts";

/** The strike point must lie within this distance of an intact pane, m. */
export const STRIKE_TOLERANCE_M = 0.05;

export interface ActuationNote {
  readonly tick: number;
  readonly command: ActuatorCommand["kind"];
  readonly proposalId: string;
  readonly reason: string;
}

const notes = new WeakMap<WorldState, ActuationNote[]>();

/** Commands that had no effect, with the reason (truth-side diagnostics; never shown to planners). */
export function actuationNotes(world: WorldState): readonly ActuationNote[] {
  return notes.get(world) ?? [];
}

function noEffect(world: WorldState, command: ActuatorCommand, reason: string): Vec3 {
  const list = notes.get(world) ?? [];
  list.push({ tick: world.tick, command: command.kind, proposalId: command.proposalId, reason });
  notes.set(world, list);
  return ZERO;
}

function aircraftPose(world: WorldState): Pose {
  return { position: world.drone.position, yawRad: world.drone.yawRad };
}

/** The pose the onboard controller aims with: truth plus estimator drift (without the reporting jitter of localization.estimatedPose). */
export function aimingPose(world: WorldState): Pose {
  return { position: add(world.drone.position, world.estimator.driftM), yawRad: wrapAngle(world.drone.yawRad + world.estimator.yawDriftRad) };
}

/** Where the aircraft physically points when it aims at `estimatedPoint`: estimated pose → body → true pose. */
export function physicalPoint(world: WorldState, estimatedPoint: Vec3): Vec3 {
  return bodyPointToWorld(aircraftPose(world), worldPointToBody(aimingPose(world), estimatedPoint));
}

/** Applies the commands in order and returns the total jet reaction force in the world frame, N. */
export function applyActuatorCommands(world: WorldState, commands: readonly ActuatorCommand[]): Vec3 {
  let recoilN = ZERO;
  for (const command of commands) recoilN = add(recoilN, applyOne(world, command));
  return recoilN;
}

function applyOne(world: WorldState, command: ActuatorCommand): Vec3 {
  switch (command.kind) {
    case "water":
      return water(world, command);
    case "strike":
      return strike(world, command);
    case "release":
      return release(world, command);
    case "light_cue":
      if (!world.profile.modules.lightCue) return noEffect(world, command, "Aircraft has no light-cue module.");
      world.cues.light = { origin: world.drone.position, target: physicalPoint(world, command.target), tick: world.tick };
      return ZERO;
    case "audio":
      if (!world.profile.modules.speaker) return noEffect(world, command, "Aircraft has no speaker.");
      world.cues.audio = { templateId: command.templateId, origin: world.drone.position, tick: world.tick };
      return ZERO;
  }
}

function water(world: WorldState, command: Extract<ActuatorCommand, { kind: "water" }>): Vec3 {
  const nozzle = world.profile.modules.water;
  if (!nozzle) return noEffect(world, command, "Aircraft has no water module.");
  const drone = world.drone;
  const volumeL = Math.min(command.volumeL, drone.waterRemainingL, nozzle.maxFlowLps * TICK_S);
  if (!(volumeL > 0)) return noEffect(world, command, drone.waterRemainingL > 0 ? "Non-positive discharge volume." : "Water tank is empty.");
  drone.waterRemainingL = Math.max(0, drone.waterRemainingL - volumeL);
  const apex = drone.position;
  const offset = sub(physicalPoint(world, command.aimPoint), apex);
  const axis = norm(offset) > 1e-6 ? normalize(offset) : rotateBodyToWorld(drone.yawRad, vec3(1, 0, 0));
  const jet = sector(apex, axis, (nozzle.coneHalfAngleDeg * Math.PI) / 180, nozzle.rangeM);
  const reachedFireL = deliverWater(world, jet, volumeL, world.tick);
  world.truthEvents.push({
    tick: world.tick,
    kind: "water_delivered",
    detail: `Jet discharged ${volumeL.toFixed(4)} L; ${reachedFireL.toFixed(4)} L reached a fire.`,
    data: { proposalId: command.proposalId, volumeL, reachedFireL, apex: { ...apex }, axis: { ...axis }, rangeM: nozzle.rangeM },
  });
  wetOccupants(world, jet, volumeL, command.proposalId);
  return scale(axis, -jetReactionN(volumeL / TICK_S, nozzle.nozzleDiameterMm));
}

/** Records water reaching any occupant body point inside the true jet with a clear line from the nozzle. */
function wetOccupants(world: WorldState, jet: Region, volumeL: number, proposalId: string): void {
  if (jet.kind !== "sector" || world.occupants.length === 0) return;
  const colliders = activeColliders(world);
  for (const occupant of world.occupants) {
    const hit = occupantBodyPoints(occupant).find(p => distanceToRegion(jet, p) <= OCCUPANT_RADIUS_M && lineOfSight(colliders, jet.apex, p));
    if (!hit) continue;
    world.truthEvents.push({
      tick: world.tick,
      kind: "water_on_occupant",
      detail: `Water jet reached occupant ${occupant.key}.`,
      data: { occupantKey: occupant.key, proposalId, volumeL, point: { ...hit } },
    });
  }
}

function strike(world: WorldState, command: Extract<ActuatorCommand, { kind: "strike" }>): Vec3 {
  const breaker = world.profile.modules.glassBreaker;
  if (!breaker) return noEffect(world, command, "Aircraft has no glass breaker.");
  const point = physicalPoint(world, command.point);
  const reachM = distance(point, world.drone.position);
  if (reachM > breaker.reachM) return noEffect(world, command, `Strike point is ${reachM.toFixed(2)} m from the aircraft; reach is ${breaker.reachM} m.`);
  const pane = activeColliders(world).find(c => c.kind === "glass" && c.openingId !== null
    && findOpening(world.scene, c.openingId)?.kind === "window"
    && boxProximity(c.min, c.max, point).distanceM <= STRIKE_TOLERANCE_M);
  if (!pane || pane.openingId === null) return noEffect(world, command, "No intact window glass at the physical strike point.");
  breakWindow(world, pane.openingId, command.openingId, command.proposalId, point);
  return ZERO;
}

/** Irreversible: the opening stays broken and its panes never collide again. */
function breakWindow(world: WorldState, openingId: string, commandedOpeningId: string, proposalId: string, point: Vec3): void {
  const opening = findOpening(world.scene, openingId);
  const truth = world.openings.find(o => o.id === openingId);
  if (!opening || !truth) return;
  truth.state = "broken";
  truth.openAreaM2 = clearOpeningAreaM2(opening);
  for (const collider of world.scene.colliders) {
    if (collider.kind === "glass" && collider.openingId === openingId) world.activeColliderIds.delete(collider.id);
  }
  world.truthEvents.push({
    tick: world.tick,
    kind: "glass_broken",
    detail: openingId === commandedOpeningId ? `Window ${openingId} broken.` : `Window ${openingId} broken by a strike commanded at ${commandedOpeningId}.`,
    data: { openingId, commandedOpeningId, proposalId, point: { ...point }, openAreaM2: truth.openAreaM2 },
  });
}

function release(world: WorldState, command: Extract<ActuatorCommand, { kind: "release" }>): Vec3 {
  if (!world.profile.modules.payloadBay) return noEffect(world, command, "Aircraft has no payload bay.");
  const index = world.drone.payloads.indexOf(command.payloadId);
  if (index < 0) return noEffect(world, command, `Payload ${command.payloadId} is not aboard.`);
  world.drone.payloads.splice(index, 1);
  world.truthEvents.push({
    tick: world.tick,
    kind: "payload_released",
    detail: `Payload ${command.payloadId} left the aircraft; receipt is not established.`,
    data: { payloadId: command.payloadId, proposalId: command.proposalId, position: { ...world.drone.position }, requestedPoint: { ...command.point } },
  });
  return ZERO;
}
