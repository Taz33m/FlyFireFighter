/**
 * Actuator motion guard.
 *
 * Every motion request (fly-model readout, engineered readout, optical-flow baseline, classical fallback,
 * contingency controller or operator) passes through guardMotion once per simulation tick. The guard only
 * limits: apart from the harness-owned terminal brake-and-descend behaviour it never raises a component's
 * magnitude or flips its sign, so it cannot fly the aircraft anywhere the requester did not ask to go. It
 * returns the request, the executed command and the limits that shaped the command, so command can show
 * when the harness limited a request.
 *
 * Limits run in this order; each step can only shrink the result of the previous one:
 *   1. gates that replace the request: terminal failure, mission abort, no validated goal, ended time box;
 *   2. non-finite components are dropped (a NaN readout never reaches an actuator);
 *   3. station keeping while an intervention, a hold or a scan executes;
 *   4. unsupported localization: no horizontal advancement; vertical motion only to descend for a landing;
 *   5. speed, vertical-speed and yaw-rate clamps, preserving direction;
 *   6. acceleration: growth toward the request is bounded per tick; decreases pass at once;
 *   7. envelope: components that would carry the aircraft farther outside the envelope are zeroed;
 *   8. person clearance: the closing component toward a current possible occupant is removed — braked or
 *      slid, never redirected — so the aircraft never closes inside the person clearance (the guidance
 *      clearance while a guide executes) and slows as it nears it. Motion that opens every distance, turning
 *      in place and hovering always pass, so the aircraft is never trapped. Contingencies obey it too.
 *
 * Gates are always reported. Other limits are reported only when they changed the command.
 */
import type { ActionProposal, GuardedMotion, MotionCommand, MotionLimit, MotionRequest } from "../contracts/actions.ts";
import { TICK_S } from "../contracts/clock.ts";
import type { MissionEnvelope } from "../contracts/envelope.ts";
import { envelopeContains } from "../contracts/envelope.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { add, distance, dot, isFiniteVec3, norm, rotateBodyToWorld, rotateWorldToBody, scale, sub, vec3 } from "../contracts/frames.ts";
import { distanceToRegion } from "../contracts/geometry.ts";
import { isCurrentOccupant, personClearanceFor, possibleOccupants, requiredPersonDistanceM } from "./person-clearance.ts";
import type { HarnessContext } from "./policy.ts";
import { CONTINGENCY_KINDS, MOTION_KINDS } from "./policy.ts";

export interface MotionGuardState {
  /** The executing action that owns the aircraft's motion, if any. */
  readonly activeMotion: ActionProposal | null;
  /** A breach, spray or payload release is executing: hold station. */
  readonly interventionActive: boolean;
  /** A spray is executing: the hold may command up to policy.sprayHoldSpeedMps against the jet's reaction. */
  readonly sprayActive: boolean;
  readonly missionAborted: boolean;
  /** No supported maneuver remains: brake and descend (explicitly not a safe landing). */
  readonly terminalFailure: boolean;
  /** Command executed on the previous tick; zero after a tick in which the guard returned null. */
  readonly previous: MotionCommand;
}

const OUTWARD_EPSILON_M = 1e-9;

export function guardMotion(request: MotionRequest | null, ctx: HarnessContext, state: MotionGuardState): GuardedMotion | null {
  if (state.terminalFailure) return terminalMotion(request, ctx);
  if (request === null) return null;
  const requested = copyRequest(request);
  const gate = gateLimit(ctx, state);
  if (gate !== null) return { requested, executed: still(), limits: [gate] };

  const limits: MotionLimit[] = [];
  let command = finiteCommand(request, limits);
  if (state.interventionActive || holdsStation(state.activeMotion)) command = stationKeeping(command, state.sprayActive ? ctx.policy.sprayHoldSpeedMps : ctx.policy.stationKeepingSpeedMps, limits);
  if (!localizationSupportsAdvance(ctx)) command = withoutLocalization(command, state.activeMotion, limits);
  command = clampSpeeds(command, ctx, state.activeMotion, limits);
  command = limitAcceleration(command, state.previous, ctx.profile.hardLimits.maxAccelMps2 * TICK_S, limits);
  command = holdEnvelope(command, ctx, state.activeMotion, limits);
  command = keepPersonClearance(command, ctx, state.activeMotion, limits);
  return { requested, executed: command, limits };
}

/**
 * The limit reported when person clearance changed the command. MotionLimit (contracts/actions.ts) has no
 * person member yet, so the step reports itself as the speed limit it applies toward the person; switch this
 * to a dedicated "person_clearance" member once the contract and its display words carry one.
 */
export const PERSON_CLEARANCE_LIMIT: MotionLimit = "person_clearance";

/** True when the pose estimate supports continued horizontal movement. A NaN or negative uncertainty is unsupported. */
export function localizationSupportsAdvance(ctx: HarnessContext): boolean {
  const pose = ctx.belief.pose;
  return pose.supported && pose.sigmaM >= 0 && pose.sigmaM <= ctx.policy.maxSigmaForAdvanceM;
}

/** A contingency action: proposed by the contingency selector and of a contingency kind. */
function isContingency(proposal: ActionProposal | null): boolean {
  return proposal !== null && proposal.proposer === "contingency" && CONTINGENCY_KINDS.has(proposal.action.kind);
}

/** A hold or a scan stays where it is: only station-keeping corrections, never travel. */
function holdsStation(proposal: ActionProposal | null): boolean {
  return proposal !== null && (proposal.action.kind === "hold" || proposal.action.kind === "scan");
}

/* Gates. */

function gateLimit(ctx: HarnessContext, state: MotionGuardState): MotionLimit | null {
  const contingency = isContingency(state.activeMotion);
  if (state.missionAborted && !contingency) return "mission_aborted";
  // Reflexes cannot fly the aircraft anywhere without a validated goal; a non-motion action is not one.
  const goal = state.activeMotion !== null && MOTION_KINDS.has(state.activeMotion.action.kind);
  if (!goal && !state.interventionActive) return "no_active_goal";
  // The envelope time box ends autonomous mission motion; contingencies remain available.
  if (ctx.tick > ctx.envelope.endTick && !contingency) return "envelope_boundary";
  return null;
}

/** Harness-owned terminal behaviour: zero horizontal velocity, no yaw, bounded descent. */
function terminalMotion(request: MotionRequest | null, ctx: HarnessContext): GuardedMotion {
  const descentMps = Math.min(positiveOrZero(ctx.policy.terminalDescentMps), positiveOrZero(ctx.profile.hardLimits.maxVerticalSpeedMps));
  const executed: MotionCommand = { velocityBody: vec3(0, 0, -descentMps), yawRateRadps: 0 };
  const requested: MotionRequest = request
    ? copyRequest(request)
    : { source: "contingency", tick: ctx.tick, velocityBody: vec3(0, 0, -descentMps), yawRateRadps: 0 };
  return { requested, executed, limits: ["mission_aborted"] };
}

/* Per-component limits. */

function finiteCommand(request: MotionRequest, limits: MotionLimit[]): MotionCommand {
  const v = request.velocityBody;
  const finiteVelocity = isFiniteVector(v);
  const finiteYaw = Number.isFinite(request.yawRateRadps);
  // A non-finite component leaves the direction undefined, so the whole velocity is dropped.
  if (!finiteVelocity) addLimit(limits, "speed");
  if (!finiteYaw) addLimit(limits, "yaw_rate");
  return { velocityBody: finiteVelocity ? vec3(v.x, v.y, v.z) : vec3(0, 0, 0), yawRateRadps: finiteYaw ? request.yawRateRadps : 0 };
}

function stationKeeping(command: MotionCommand, maxSpeedMps: number, limits: MotionLimit[]): MotionCommand {
  const v = command.velocityBody;
  const horizontal = clampHorizontal(v, maxSpeedMps);
  const z = clampMagnitude(v.z, maxSpeedMps);
  if (horizontal.x !== v.x || horizontal.y !== v.y || z !== v.z) addLimit(limits, "speed");
  return { velocityBody: vec3(horizontal.x, horizontal.y, z), yawRateRadps: command.yawRateRadps };
}

function withoutLocalization(command: MotionCommand, activeMotion: ActionProposal | null, limits: MotionLimit[]): MotionCommand {
  const v = command.velocityBody;
  // Without supported localization there is no advancing and no assumed perfect hover: the only
  // translation left is the descent of an active landing. Yaw in place does not advance the aircraft.
  const z = activeMotion?.action.kind === "land" ? Math.min(v.z, 0) : 0;
  if (v.x !== 0 || v.y !== 0 || z !== v.z) addLimit(limits, "localization");
  return { velocityBody: vec3(0, 0, z), yawRateRadps: command.yawRateRadps };
}

function clampSpeeds(command: MotionCommand, ctx: HarnessContext, activeMotion: ActionProposal | null, limits: MotionLimit[]): MotionCommand {
  const hard = ctx.profile.hardLimits;
  const moveCapMps = activeMotion?.action.kind === "move" ? activeMotion.action.maxSpeedMps : Infinity;
  const v = command.velocityBody;
  const horizontal = clampHorizontal(v, Math.min(hard.maxSpeedMps, ctx.envelope.maxSpeedMps, moveCapMps));
  const z = clampMagnitude(v.z, hard.maxVerticalSpeedMps);
  const yaw = clampMagnitude(command.yawRateRadps, hard.maxYawRateRadps);
  if (horizontal.x !== v.x || horizontal.y !== v.y) addLimit(limits, "speed");
  if (z !== v.z) addLimit(limits, "vertical_speed");
  if (yaw !== command.yawRateRadps) addLimit(limits, "yaw_rate");
  return { velocityBody: vec3(horizontal.x, horizontal.y, z), yawRateRadps: yaw };
}

/**
 * Bounds how fast the commanded velocity grows: the step from the part of the previous command that the
 * request still allows toward the request is at most maxStepMps per tick (|executed − previous| ≤ step
 * whenever the request asks for no decrease). Requested decreases, brakes and dropped components pass at
 * once, because the guard never holds the aircraft above what was requested; the simulator's dynamics
 * bound the actual deceleration. Yaw rate has no acceleration hard limit, so none is applied to it.
 */
function limitAcceleration(command: MotionCommand, previous: MotionCommand, maxStepMps: number, limits: MotionLimit[]): MotionCommand {
  const target = command.velocityBody;
  const prior = isFiniteVector(previous?.velocityBody) ? previous.velocityBody : vec3(0, 0, 0);
  const start = vec3(clampTowardZero(prior.x, target.x), clampTowardZero(prior.y, target.y), clampTowardZero(prior.z, target.z));
  const growth = sub(target, start);
  const growthMps = norm(growth);
  const stepMps = positiveOrZero(maxStepMps);
  if (growthMps <= stepMps) return command;
  addLimit(limits, "acceleration");
  return { velocityBody: add(start, scale(growth, stepMps / growthMps)), yawRateRadps: command.yawRateRadps };
}

/* Envelope boundary. */

function holdEnvelope(command: MotionCommand, ctx: HarnessContext, activeMotion: ActionProposal | null, limits: MotionLimit[]): MotionCommand {
  const pose = ctx.belief.pose;
  const marginM = positiveOrZero(pose.sigmaM);
  const lookaheadS = positiveOrZero(ctx.policy.envelopeLookaheadS);
  const predict = (velocityBody: Vec3): Vec3 => add(pose.position, scale(rotateBodyToWorld(pose.yawRad, velocityBody), lookaheadS));
  const v = command.velocityBody;
  if (isFiniteVec3(pose.position) && envelopeContains(ctx.envelope, predict(v), marginM)) return command;

  const here = outsideDepthM(ctx.envelope, pose.position, marginM);
  // Without a finite position or any permitted region, every translation counts as outward.
  const outward = (velocityBody: Vec3): boolean =>
    norm(velocityBody) > 0 && !(Number.isFinite(here) && outsideDepthM(ctx.envelope, predict(velocityBody), marginM) <= here + OUTWARD_EPSILON_M);
  // A landing descends to its site; the site itself is checked by the landing rules, not here.
  const landingDescent = activeMotion?.action.kind === "land" && v.z < 0;
  const translation = landingDescent ? vec3(v.x, v.y, 0) : v;
  if (!outward(translation)) return command;

  let keepHorizontal = !outward(vec3(v.x, v.y, 0));
  let keepVertical = landingDescent || !outward(vec3(0, 0, v.z));
  if (keepHorizontal && keepVertical) {
    // Outward only in combination (toward an edge or corner): stop both unless the vertical part is a landing descent.
    keepHorizontal = false;
    keepVertical = landingDescent;
  }
  addLimit(limits, "envelope_boundary");
  return {
    velocityBody: vec3(keepHorizontal ? v.x : 0, keepHorizontal ? v.y : 0, keepVertical ? v.z : 0),
    yawRateRadps: command.yawRateRadps,
  };
}

/**
 * How far the point, inflated by marginM along each axis (the same probes envelopeContains uses), sticks out
 * of the envelope: 0 when contained, Infinity for an envelope without regions or a non-finite point.
 */
function outsideDepthM(envelope: MissionEnvelope, p: Vec3, marginM: number): number {
  if (!isFiniteVec3(p) || envelope.regions.length === 0) return Infinity;
  const probes = marginM > 0
    ? [p, vec3(p.x + marginM, p.y, p.z), vec3(p.x - marginM, p.y, p.z), vec3(p.x, p.y + marginM, p.z), vec3(p.x, p.y - marginM, p.z), vec3(p.x, p.y, p.z + marginM), vec3(p.x, p.y, p.z - marginM)]
    : [p];
  return Math.max(...probes.map(probe => Math.min(...envelope.regions.map(region => distanceToRegion(region, probe)))));
}

/* Person clearance. */

/** A closing rate this small is numerical noise in tangential motion, not closing in. */
const CLOSING_EPSILON_MPS = 1e-9;

/** Keep (1) or drop (0) each body component: the full request first, then pairs, then single components. */
const KEPT_COMPONENTS: readonly (readonly [number, number, number])[] = [[1, 1, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1]];

interface ClosingLimit {
  /** Unit vector from the occupant to the aircraft, in the body frame (zero when they coincide). */
  readonly awayBody: Vec3;
  /** Highest closing speed allowed: (distance − required distance) / lookahead outside it, 0 inside it. */
  readonly maxClosingMps: number;
}

/**
 * Removes the closing component toward current possible occupants. Outside the required distance the closing
 * speed is at most (distance − required) / envelopeLookaheadS, so the aircraft slows as it nears the clearance
 * and stops at it; inside it nothing may close at all. When the request closes too fast, the guard keeps the
 * fastest of: the request scaled down (brake), or the request with some body components dropped and the rest
 * scaled (slide). It never redirects, raises or flips a component, and a candidate the envelope step would
 * change again is not used, so this step cannot undo the envelope limit. Yaw is never limited here.
 */
function keepPersonClearance(command: MotionCommand, ctx: HarnessContext, activeMotion: ActionProposal | null, limits: MotionLimit[]): MotionCommand {
  const v = command.velocityBody;
  const speedMps = norm(v);
  if (!(speedMps > 0)) return command;
  const closingLimits = personClosingLimits(ctx, activeMotion, speedMps);
  if (closingLimits === null) {
    addLimit(limits, PERSON_CLEARANCE_LIMIT);
    return { velocityBody: vec3(0, 0, 0), yawRateRadps: command.yawRateRadps };
  }
  if (closingLimits.length === 0 || closingScale(v, closingLimits) >= 1) return command;
  let best: MotionCommand = { velocityBody: vec3(0, 0, 0), yawRateRadps: command.yawRateRadps };
  let bestSpeedMps = 0;
  for (const [kx, ky, kz] of KEPT_COMPONENTS) {
    const kept = vec3(kx * v.x, ky * v.y, kz * v.z);
    const k = closingScale(kept, closingLimits);
    if (!(k > 0)) continue;
    const candidate: MotionCommand = { velocityBody: scale(kept, k), yawRateRadps: command.yawRateRadps };
    const candidateSpeedMps = norm(candidate.velocityBody);
    if (candidateSpeedMps > bestSpeedMps && holdEnvelope(candidate, ctx, activeMotion, []) === candidate) {
      best = candidate;
      bestSpeedMps = candidateSpeedMps;
    }
  }
  addLimit(limits, PERSON_CLEARANCE_LIMIT);
  return best;
}

/**
 * Closing limits for the occupants a command of this speed could bring inside the required distance within
 * the lookahead; null when the pose is not finite and some possible occupant exists (no direction can be
 * shown not to close in, so translation stops; turning in place remains).
 */
function personClosingLimits(ctx: HarnessContext, activeMotion: ActionProposal | null, speedMps: number): ClosingLimit[] | null {
  const occupants = possibleOccupants(ctx);
  if (occupants.length === 0) return [];
  const pose = ctx.belief.pose;
  if (!isFiniteVec3(pose.position) || !Number.isFinite(pose.yawRad)) return null;
  const lookaheadS = positiveOrZero(ctx.policy.envelopeLookaheadS);
  const reachM = speedMps * lookaheadS;
  const clearanceM = personClearanceFor(ctx, activeMotion?.action.kind ?? null);
  const closingLimits: ClosingLimit[] = [];
  for (const occupant of occupants) {
    // An occupant without a finite position defines no direction to close along.
    if (!isFiniteVec3(occupant.position)) continue;
    const distanceM = distance(pose.position, occupant.position);
    const slackM = distanceM - requiredPersonDistanceM(ctx, occupant.uncertaintyM, clearanceM);
    // Written so a NaN slack (NaN uncertainty or clearance) is checked, and then allows no closing at all.
    if (slackM >= reachM || !isCurrentOccupant(occupant, ctx)) continue;
    const away = distanceM > 0 ? scale(sub(pose.position, occupant.position), 1 / distanceM) : vec3(0, 0, 0);
    const maxClosingMps = slackM > 0 ? (lookaheadS > 0 ? slackM / lookaheadS : Infinity) : 0;
    closingLimits.push({ awayBody: rotateWorldToBody(pose.yawRad, away), maxClosingMps });
  }
  return closingLimits;
}

/** Largest k in [0, 1] such that k·velocity closes on no occupant faster than allowed. */
function closingScale(velocityBody: Vec3, closingLimits: readonly ClosingLimit[]): number {
  let k = 1;
  for (const limit of closingLimits) {
    const closingMps = -dot(velocityBody, limit.awayBody);
    if (closingMps > CLOSING_EPSILON_MPS) k = Math.min(k, limit.maxClosingMps / closingMps);
  }
  return k;
}

/* Helpers. */

function clampHorizontal(v: Vec3, maxSpeedMps: number): { readonly x: number; readonly y: number } {
  const cap = positiveOrZero(maxSpeedMps);
  const speed = Math.hypot(v.x, v.y);
  if (speed <= cap) return { x: v.x, y: v.y };
  const k = cap / speed;
  return { x: v.x * k, y: v.y * k };
}

function clampMagnitude(value: number, max: number): number {
  const cap = positiveOrZero(max);
  return Math.abs(value) <= cap ? value : Math.sign(value) * cap;
}

/** Clamp `value` into the interval between 0 and `bound` (what a request of `bound` still allows). */
function clampTowardZero(value: number, bound: number): number {
  return Math.min(Math.max(value, Math.min(0, bound)), Math.max(0, bound));
}

/** Non-positive and NaN limits become 0, so a broken limit stops motion instead of disabling the limit. */
function positiveOrZero(value: number): number {
  return value > 0 ? value : 0;
}

function addLimit(limits: MotionLimit[], limit: MotionLimit): void {
  if (!limits.includes(limit)) limits.push(limit);
}

function isFiniteVector(v: unknown): v is Vec3 {
  return typeof v === "object" && v !== null && isFiniteVec3(v as Vec3);
}

function still(): MotionCommand {
  return { velocityBody: vec3(0, 0, 0), yawRateRadps: 0 };
}

/** A copy of the request as received; malformed components are recorded as NaN, never thrown on. */
function copyRequest(request: MotionRequest): MotionRequest {
  const v: Partial<Vec3> | null | undefined = request.velocityBody;
  const component = (value: unknown): number => (typeof value === "number" ? value : NaN);
  return {
    source: request.source,
    tick: request.tick,
    velocityBody: vec3(component(v?.x), component(v?.y), component(v?.z)),
    yawRateRadps: component(request.yawRateRadps),
  };
}
