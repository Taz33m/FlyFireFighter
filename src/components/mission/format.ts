/** Plain-language formatting for command panels. Inputs come only from MissionView and protocol messages. */
import type { ActionSpec, MotionLimit, ProposalStatus } from "../../lib/contracts/actions.ts";
import { secondsFromTicks } from "../../lib/contracts/clock.ts";
import type { FloorPlanPrior } from "../../lib/contracts/evidence.ts";
import type { Vec3 } from "../../lib/contracts/frames.ts";
import type { Region } from "../../lib/contracts/geometry.ts";
import { regionBounds } from "../../lib/contracts/geometry.ts";

export function formatSeconds(ticks: number): string {
  return `${secondsFromTicks(ticks).toFixed(1)} s`;
}

export function formatClock(ticks: number): string {
  // Round to tenths before splitting, so 599.96 s reads 10:00.0 rather than 9:60.0.
  const tenths = Math.round(secondsFromTicks(ticks) * 10);
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths - minutes * 600) / 10;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

export function formatNumber(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

export function formatVec(v: Vec3, digits = 1): string {
  return `(${v.x.toFixed(digits)}, ${v.y.toFixed(digits)}, ${v.z.toFixed(digits)}) m`;
}

export function roomName(prior: FloorPlanPrior | null | undefined, roomId: string | null): string {
  if (roomId === null) return "Unassigned room";
  return prior?.rooms.find(r => r.id === roomId)?.name ?? roomId;
}

export function openingName(prior: FloorPlanPrior | null | undefined, openingId: string): string {
  const opening = prior?.openings.find(o => o.id === openingId);
  if (opening === undefined) return openingId;
  const room = roomName(prior, opening.rooms[0]);
  return `${room} ${opening.kind}`;
}

export function actionTitle(action: ActionSpec, prior?: FloorPlanPrior | null): string {
  switch (action.kind) {
    case "breach_opening": return `Break the glass: ${openingName(prior, action.openingId)}`;
    case "spray": return `Spray water: ${(action.flowLps * secondsFromTicks(action.durationTicks)).toFixed(2)} L jet`;
    case "release_payload": return `Release payload ${action.payloadId}`;
    case "move": return "Move to a goal";
    case "scan": return "Scan a viewpoint";
    case "hold": return `Hold for ${formatSeconds(action.durationTicks)}`;
    case "return": return `Return by route ${action.routeId}`;
    case "land": return "Land at a site";
    case "speak": return `Speak template ${action.templateId}`;
    case "guide": return `Guide the occupant along ${action.routeId}`;
  }
}

/** Target point of an action, when it has one. */
export function actionTarget(action: ActionSpec): Vec3 | null {
  switch (action.kind) {
    case "breach_opening": return action.strikePoint;
    case "spray": return action.aimPoint;
    case "release_payload": return action.releasePoint;
    case "move": return action.goal;
    case "scan": return action.lookAt;
    case "land": return action.site;
    default: return null;
  }
}

export function describeRegion(region: Region): string {
  switch (region.kind) {
    case "sphere": return `Sphere of ${region.radiusM.toFixed(2)} m radius around ${formatVec(region.center)}`;
    case "sector": return `Cone of ${((region.halfAngleRad * 180) / Math.PI).toFixed(0)}° half-angle, ${region.rangeM.toFixed(1)} m long, from ${formatVec(region.apex)}`;
    case "box": return `Box ${formatVec(region.min)} to ${formatVec(region.max)}`;
    case "prism": return `Floor area of ${region.polygon.length} vertices, z ${region.zMin.toFixed(1)}–${region.zMax.toFixed(1)} m`;
    case "union": {
      const b = regionBounds(region);
      return `${region.parts.length} parts within ${formatVec(b.min)} to ${formatVec(b.max)}`;
    }
    case "depth_image": {
      const b = regionBounds(region);
      return `Camera view of ${region.cols} × ${region.rows} cells from ${formatVec(region.apex)}, within ${formatVec(b.min)} to ${formatVec(b.max)}`;
    }
  }
}

const STATUS_WORDS: Readonly<Record<ProposalStatus, string>> = {
  proposed: "Proposed", validated: "Validated", awaiting_approval: "Awaiting approval", approved: "Approved", executing: "Executing",
  completed: "Completed", rejected: "Rejected", expired: "Expired", invalidated: "Invalidated", aborted: "Aborted",
};

export function statusWord(status: ProposalStatus): string {
  return STATUS_WORDS[status];
}

const LIMIT_WORDS: Readonly<Record<MotionLimit, string>> = {
  speed: "Speed limit", person_clearance: "Person clearance", vertical_speed: "Vertical speed limit", yaw_rate: "Yaw-rate limit", acceleration: "Acceleration limit",
  no_active_goal: "No active goal", localization: "Localization not supported", envelope_boundary: "Mission envelope boundary", mission_aborted: "Mission aborted",
};

export function limitWord(limit: MotionLimit): string {
  return LIMIT_WORDS[limit];
}
