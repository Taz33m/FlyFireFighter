/**
 * Shared cue → command mapping for the flow baseline and the engineered readout (each keeps its own
 * instance, source and label; this mapping is conventional control, not fly-model inference).
 *
 * Braking. Looming 1/τ divided by the efference-copy forward speed is a nearness 1/D, so the controller
 * keeps a metric free distance ahead. It starts from a clear prior (clearDistanceM) and moves toward each
 * measurement with a gain that grows with speed² (looming SNR ∝ speed, so one noisy sample at walking pace
 * cannot block the aircraft), is dead-reckoned with its own speed once supported by evidence and while it
 * cannot measure (slow or blind), and is forgotten after the aircraft has turned away or after the forward
 * view has been unmeasurable (blind) for memoryStaleS, so a stale memory cannot hold it forever; it then
 * re-senses at exploration speed. Stationary in front of a measured surface, the memory holds. An
 * unmeasurable forward view also limits the base speed to exploration speed. Speed is limited to
 * (D − stopDistance)/brakeTime, so braking engages when τ < brakeTime + stopDistance/v — a τ threshold
 * that still holds position once motion (and therefore flow) has stopped. Forward range assistance, when
 * present, limits speed the same way with its own clearance.
 *
 * Steering. Goal bearing (attenuated when blocked or poorly localised) + centering away from the side
 * with more outward motion + an avoidance turn while blocked. Range assistance, when present, adds a
 * lateral push and a turn away inside the lateral clearance, vetoes any yaw toward a side inside that
 * clearance (metric ranges outrank visual cues up close) and forces a brake-and-turn inside the forward
 * clearance. Frame quality and measured visual confidence scale speed; pose uncertainty scales speed and
 * goal steering. Requests are clamped to the configured ReflexLimits; the harness applies real limits.
 *
 * Holding facing a focus. When the goal carries a face bearing (GoalEstimate.faceBearingRad) and lies within
 * holdRadiusM, the aircraft holds instead of flying at the goal: it yaws toward the face bearing at goalGain
 * and, only while it is outside the arrival radius, drifts back toward the goal in any body direction at
 * approachGain × (distance − arrivalRadius), within the speed ceiling. Turning toward the goal point itself
 * from a few centimetres away would spin the aircraft away from what it is meant to watch. Range assistance
 * keeps its precedence (yaw veto, lateral push, brake-and-turn). Without a face bearing nothing changes.
 *
 * Sensor-covered translation. The range readings cover forward (±30°), left and right (60°–120°) only, so every
 * translation is bounded by the reading on its side, measured against contactClearanceM (the aircraft's
 * collision radius plus a margin), not the comfort clearances above:
 * - flank: a lateral return can sit as far forward as 60° off the nose, where forward travel closes on it at
 *   half its speed, so forward speed is limited to 2 × (side − contactClearance) / rangeBrakeTime (measured on
 *   Troy: leaving a doorway at 0.25 m/s with a jamb corner 70° to the right, the 0.3 m docking push of 3 cm/s
 *   could not stop the corner closing and the aircraft struck it at 0.06 m/s);
 * - lateral: sideways velocity toward a side is limited to (side − contactClearance) / rangeBrakeTime, and the
 *   lateral push acts out to contactClearance + contactPushBandM even when the comfort clearance is smaller;
 * - backward: nothing measures behind the aircraft, so backward travel (the range brake's back-off, a hold
 *   drifting back to its goal) is capped at blindSpeedMps.
 */
import type { MotionRequest, MotionSource } from "../../contracts/actions.ts";
import { TICK_S, VISUAL_PERIOD_TICKS } from "../../contracts/clock.ts";
import { wrapAngle } from "../../contracts/frames.ts";
import type { ControllerInput, GoalEstimate, RangeAssist, ReflexCues, ReflexLimits } from "./types.ts";
import { DEFAULT_REFLEX_LIMITS } from "./types.ts";

export interface CommandConfig {
  readonly limits: ReflexLimits;
  readonly cruiseSpeedMps: number;
  /** Speed while nothing is known about the space ahead (motion is needed to perceive it). */
  readonly exploreSpeedMps: number;
  readonly stopDistanceM: number;
  readonly brakeTimeS: number;
  readonly clearDistanceM: number;
  readonly nearnessAlpha: number;
  /** Below this forward speed looming cannot be converted to a distance. */
  readonly minMeasureSpeedMps: number;
  /** Speed at which a nearness measurement gets half the full gain (gain ∝ v² / (v² + half²)). */
  readonly measureHalfSpeedMps: number;
  /**
   * No looming measurement while |vertical speed| exceeds this fraction of the forward speed: looming / forward
   * speed is a nearness only for forward translation, and climbing or descending over a surface whose depth
   * varies down the image adds divergence (measured on Troy: climbing onto the stair at vz/vx ≈ 0.4 in smoke,
   * the free distance fell from 8 m to 0.30 m in under a second with the stair 2.5 m ahead, and the aircraft
   * sat braked at the stair foot for 20 s).
   */
  readonly maxLoomClimbRatio: number;
  /** Accumulated measurement gain above which the free distance counts as known (cruise instead of explore). */
  readonly knownEvidence: number;
  /** Forget the free distance once the net heading change since the last measurement exceeds this. */
  readonly memoryYawResetRad: number;
  /** Forget the free distance after the forward view has been unmeasurable for this long (s). */
  readonly memoryStaleS: number;
  readonly goalGain: number;
  readonly centeringGain: number;
  readonly avoidGain: number;
  readonly arrivalRadiusM: number;
  /** With a face bearing, inside this goal distance (≥ arrivalRadiusM) the aircraft holds and turns to face. */
  readonly holdRadiusM: number;
  readonly approachGain: number;
  readonly heightGain: number;
  readonly minVisualConfidence: number;
  readonly fullVisualConfidence: number;
  readonly poseSigmaOkM: number;
  readonly poseSigmaMaxM: number;
  readonly rangeClearanceM: number;
  readonly rangeBrakeTimeS: number;
  readonly rangeTurnRateRadps: number;
  /**
   * Turning in place (goal abeam or behind) with a forward return within rangeClearanceM + this, keep the
   * range brake's turn toward the open side instead of the goal turn, so the two do not alternate at the
   * clearance threshold. Once started, that turn is latched (same direction, whatever the forward reading)
   * until the goal is within 60° of the nose: a band on the reading alone still cycled (measured on Troy,
   * turning in place in the study with a wall 0.52–0.63 m ahead: range turn right, goal turn left, for 19 s).
   */
  readonly rangeTurnHysteresisM: number;
  readonly lateralClearanceM: number;
  readonly lateralGain: number;
  /**
   * Ceiling when vision is unusable but forward range assistance is present: a forward return, or none while the
   * same sensor returns to the side (nothing ahead within its range; measured on Troy: moving out from the facade
   * into open ground in smoke venting from a broken window, the forward sector returned nothing, vision read
   * 0.06 and the aircraft crept at 0.01 m/s until its return was aborted). With no return anywhere the sensor's
   * view proves nothing and the vision ceiling alone applies.
   */
  readonly rangeOnlySpeedMps: number;
  readonly minHeightM: number;
  /** Range at which the aircraft's body would touch a surface, plus a margin (Tender T1: 0.275 m radius + 0.045 m). */
  readonly contactClearanceM: number;
  /** The lateral push acts at least out to contactClearanceM + this, whatever lateralClearanceM is. */
  readonly contactPushBandM: number;
  /** Largest backward speed: no range reading covers the rear. */
  readonly blindSpeedMps: number;
}

export const DEFAULT_COMMAND_CONFIG: CommandConfig = Object.freeze({
  limits: DEFAULT_REFLEX_LIMITS,
  cruiseSpeedMps: 1.2, exploreSpeedMps: 0.6, stopDistanceM: 0.8, brakeTimeS: 1.2, clearDistanceM: 8,
  nearnessAlpha: 0.4, minMeasureSpeedMps: 0.2, measureHalfSpeedMps: 0.5, maxLoomClimbRatio: 0.25, knownEvidence: 0.3, memoryYawResetRad: 0.35, memoryStaleS: 2,
  goalGain: 1.2, centeringGain: 1.0, avoidGain: 0.8, arrivalRadiusM: 0.3, holdRadiusM: 0.5, approachGain: 0.8, heightGain: 1.0,
  minVisualConfidence: 0.15, fullVisualConfidence: 0.6, poseSigmaOkM: 0.3, poseSigmaMaxM: 1.5,
  rangeClearanceM: 0.6, rangeBrakeTimeS: 1.0, rangeTurnRateRadps: 0.6, rangeTurnHysteresisM: 0.3, lateralClearanceM: 0.6, lateralGain: 1.5,
  rangeOnlySpeedMps: 0.4, minHeightM: 0.5, contactClearanceM: 0.32, contactPushBandM: 0.05, blindSpeedMps: 0.15,
});

export interface CommandResult {
  readonly request: MotionRequest;
  readonly mode: string;
  readonly features: Readonly<Record<string, number>>;
}

interface Ranges { forward: number | null; left: number | null; right: number | null; down: number | null }

/**
 * Speed ceilings (m/s) before the pose-reliability scale; the request uses min(...) × poseScale. `vision`
 * is the base speed (cruise, or exploration while the space ahead is unknown) × the vision scale.
 */
interface SpeedLimits { vision: number; looming: number; range: number; poseScale: number; ceiling: number; visionScale: number }

/** Mode label for whichever limit holds speed below the goal approach speed. */
function bindingLimit(l: SpeedLimits, desired: number): string {
  const smallest = Math.min(l.vision, l.looming, l.range);
  if (smallest >= desired) return "slow_pose";
  if (smallest === l.looming) return "brake_looming";
  if (smallest === l.range) return "slow_range";
  return l.visionScale < 0.999 ? "slow_low_vision" : "explore";
}

const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);
const clamp = (value: number, lo: number, hi: number): number => (value < lo ? lo : value > hi ? hi : value);
const smoothstep = (value: number, lo: number, hi: number): number => {
  const t = clamp((value - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
};
const rangeOrNull = (value: number | null): number | null => (finite(value) && value >= 0 ? value : null);

function sanitizeRanges(ranges: RangeAssist | null): Ranges | null {
  if (!ranges) return null;
  return { forward: rangeOrNull(ranges.forwardM), left: rangeOrNull(ranges.leftM), right: rangeOrNull(ranges.rightM), down: rangeOrNull(ranges.downM) };
}

/** The forward sector has no return while a lateral sector has one: the range sensor is working and sees nothing ahead within its range. */
function lidarClearAhead(r: Ranges | null): boolean {
  return r !== null && r.forward === null && (r.left !== null || r.right !== null);
}

function sanitizeGoal(goal: GoalEstimate | null): GoalEstimate | null {
  return goal && finite(goal.bearingRad) && finite(goal.distanceM) && finite(goal.heightErrorM) ? goal : null;
}

/**
 * The wrapped face bearing when the goal carries one and lies within the hold radius (holding facing a
 * focus), else null: the caller then flies its ordinary goal behaviour.
 */
export function holdFaceBearing(c: CommandConfig, goal: GoalEstimate | null): number | null {
  if (goal === null || !finite(goal.faceBearingRad) || !finite(goal.distanceM)) return null;
  if (goal.distanceM > Math.max(c.holdRadiusM, c.arrivalRadiusM)) return null;
  return wrapAngle(goal.faceBearingRad);
}

/**
 * Body-frame velocity back toward the goal while holding facing a focus: zero inside the arrival radius,
 * else approachGain × (distance − arrivalRadius) along the goal bearing, at most `ceilingMps`.
 */
export function holdTranslation(c: CommandConfig, goal: GoalEstimate, ceilingMps: number): { forward: number; lateral: number } {
  const speed = Math.min(c.approachGain * Math.max(0, goal.distanceM - c.arrivalRadiusM), Math.max(0, ceilingMps));
  if (!(speed > 0) || !finite(goal.bearingRad)) return { forward: 0, lateral: 0 };
  return { forward: speed * Math.cos(goal.bearingRad), lateral: speed * Math.sin(goal.bearingRad) };
}

/** Turn direction for a range brake: toward the more open side, else away from the nearer flow, else toward the goal. */
function rangeTurnDirection(r: Ranges, cues: ReflexCues | null, goal: GoalEstimate | null): 1 | -1 {
  if (r.left !== null && r.right !== null && Math.abs(r.left - r.right) > 0.1) return r.left > r.right ? 1 : -1;
  if (cues && cues.centeringWeight * Math.abs(cues.centering) > 0.1) return cues.centering > 0 ? -1 : 1;
  return goal && goal.bearingRad < 0 ? -1 : 1;
}

export class ReflexCommandMapper {
  readonly source: MotionSource;
  readonly config: CommandConfig;
  private nearness: number;
  private evidence = 0;
  private yawSinceMeasure = 0;
  private memoryAgeS = 0;
  private lastTick: number | null = null;
  /** Direction of a latched range turn while turning in place (+1 left, −1 right), else null. */
  private turnLatch: 1 | -1 | null = null;

  constructor(source: MotionSource, config: CommandConfig = DEFAULT_COMMAND_CONFIG) {
    this.source = source;
    this.config = config;
    this.nearness = 1 / config.clearDistanceM;
  }

  reset(): void {
    this.forget();
    this.turnLatch = null;
    this.lastTick = null;
  }

  private forget(): void {
    this.nearness = 1 / this.config.clearDistanceM;
    this.evidence = 0;
    this.yawSinceMeasure = 0;
    this.memoryAgeS = 0;
  }

  /** Free distance ahead from looming (m); the clear prior until measurements arrive. */
  get freeDistanceM(): number {
    return 1 / this.nearness;
  }

  get freeDistanceKnown(): boolean {
    return this.evidence >= this.config.knownEvidence;
  }

  /**
   * @param cueSpeedMps forward speed during the interval the looming cue measured (efference copy aligned
   *   with the frame pair); defaults to the previous executed command.
   */
  map(input: ControllerInput, cues: ReflexCues | null, cueSpeedMps?: number): CommandResult {
    const c = this.config;
    if (this.lastTick !== null && input.tick < this.lastTick) this.reset();
    const dtS = this.lastTick === null || input.tick === this.lastTick ? VISUAL_PERIOD_TICKS * TICK_S : (input.tick - this.lastTick) * TICK_S;
    this.lastTick = input.tick;
    const forwardSpeed = finite(input.previous.velocityBody.x) ? input.previous.velocityBody.x : 0;
    const yawRate = finite(input.previous.yawRateRadps) ? input.previous.yawRateRadps : 0;
    // Missing vision arrives as null cues from each controller; frame quality is the sensor adapter's estimate.
    const frameQuality = finite(input.quality.frame) ? clamp(input.quality.frame, 0, 1) : 0;
    const vision = cues ? Math.min(clamp(cues.visualConfidence, 0, 1), frameQuality) : 0;
    const verticalSpeed = finite(input.previous.velocityBody.z) ? input.previous.velocityBody.z : 0;
    this.updateMemory(cues, vision, { latest: forwardSpeed, cue: finite(cueSpeedMps) ? cueSpeedMps : forwardSpeed, vertical: verticalSpeed }, yawRate, dtS);
    const ranges = sanitizeRanges(input.ranges);
    const goal = sanitizeGoal(input.goal);
    const visionScale = smoothstep(vision, c.minVisualConfidence, c.fullVisualConfidence);
    const sigma = finite(input.quality.poseSigmaM) ? input.quality.poseSigmaM : Infinity;
    const poseReliability = clamp((c.poseSigmaMaxM - sigma) / (c.poseSigmaMaxM - c.poseSigmaOkM), 0, 1);
    return this.compose(input, cues, { ranges, goal, visionScale, poseReliability });
  }

  private updateMemory(cues: ReflexCues | null, vision: number, speed: { latest: number; cue: number; vertical: number }, yawRate: number, dtS: number): void {
    const c = this.config;
    this.yawSinceMeasure += yawRate * dtS;
    if (this.freeDistanceKnown) this.nearness = 1 / clamp(1 / this.nearness - speed.latest * dtS, 0.05, c.clearDistanceM);
    const looming = cues?.loomingRateHz;
    const forwardMotion = Math.abs(speed.vertical) <= c.maxLoomClimbRatio * speed.cue;
    if (finite(looming) && speed.cue >= c.minMeasureSpeedMps && vision >= c.minVisualConfidence && forwardMotion) {
      const measured = clamp(looming / speed.cue, 1 / c.clearDistanceM, 20);
      const v2 = speed.cue * speed.cue;
      const gain = (c.nearnessAlpha * v2) / (v2 + c.measureHalfSpeedMps * c.measureHalfSpeedMps);
      this.nearness += gain * (measured - this.nearness);
      this.evidence = Math.min(1, this.evidence + gain);
      this.yawSinceMeasure = 0;
      this.memoryAgeS = 0;
    }
    const blind = !cues || cues.loomingRateHz === null;
    if (blind) this.memoryAgeS += dtS;
    if (Math.abs(this.yawSinceMeasure) > c.memoryYawResetRad || (this.evidence > 0 && this.memoryAgeS > c.memoryStaleS)) this.forget();
  }

  private compose(input: ControllerInput, cues: ReflexCues | null, s: { ranges: Ranges | null; goal: GoalEstimate | null; visionScale: number; poseReliability: number }): CommandResult {
    const c = this.config;
    const free = this.freeDistanceM;
    const forwardRange = s.ranges?.forward ?? null;
    const aheadKnown = this.freeDistanceKnown && cues !== null && cues.loomingRateHz !== null;
    const limits = this.speedLimits(free, aheadKnown, { forward: forwardRange, clearAhead: lidarClearAhead(s.ranges) }, s.visionScale, s.poseReliability);
    const ceiling = limits.ceiling;
    const blocked = 1 - smoothstep(free, c.stopDistanceM, c.stopDistanceM + 1.5);
    const face = holdFaceBearing(c, s.goal);
    const { terms, desired, forward: planned, lateral: holdLateral } = this.guidance(cues, s, face, blocked, ceiling);
    const override = this.rangeOverride(planned, this.rangeYaw(terms.goal + terms.center + terms.avoid, s.ranges), cues, s.goal, s.ranges, face !== null);
    const { yaw, rangeBrake, rangeTurn } = override;
    const covered = this.coveredTranslation(override.forward, holdLateral, s.ranges);
    const { forward, lateral } = covered;
    const vertical = this.vertical(s.goal, s.ranges);
    const held = face !== null && !rangeBrake && limits.vision > 0;
    const mode = held ? "hold_face" : rangeTurn ? "range_turn" : covered.flankLimited && !rangeBrake ? "slow_flank" : this.mode({ goal: s.goal, rangeBrake, desired, limits, terms });
    const request = this.request(input.tick, forward, lateral, vertical, yaw);
    const features = { visionScale: s.visionScale, poseReliability: s.poseReliability, freeDistanceM: free, freeDistanceKnown: this.freeDistanceKnown ? 1 : 0, nearnessEvidence: this.evidence, speedCeilingMps: ceiling, flankLimitMps: Math.min(covered.flankLimitMps, 10), blocked, yawGoal: terms.goal, yawCenter: terms.center, yawAvoid: terms.avoid };
    return { request, mode, features };
  }

  /**
   * Yaw terms and body velocity before range assistance: goal steering and the goal approach speed, or,
   * holding facing a focus, the turn to face and the drift back toward the goal.
   */
  private guidance(cues: ReflexCues | null, s: { goal: GoalEstimate | null; visionScale: number; poseReliability: number }, face: number | null, blocked: number, ceiling: number): { terms: { goal: number; center: number; avoid: number }; desired: number; forward: number; lateral: number } {
    if (face !== null && s.goal !== null) {
      const hold = holdTranslation(this.config, s.goal, ceiling);
      return { terms: { goal: this.config.goalGain * face, center: 0, avoid: 0 }, desired: 0, forward: hold.forward, lateral: hold.lateral };
    }
    const desired = this.desiredSpeed(s.goal);
    return { terms: this.steering(cues, s.goal, s.visionScale * (cues ? 1 : 0), blocked, s.poseReliability), desired, forward: Math.min(desired, ceiling), lateral: 0 };
  }

  /**
   * Forward range assistance: brake-and-turn toward the open side inside the clearance and, turning in place
   * just beyond it, keep that turn (not while holding facing a focus, which keeps its own turn).
   */
  private rangeOverride(forward: number, yaw: number, cues: ReflexCues | null, goal: GoalEstimate | null, r: Ranges | null, holding: boolean): { forward: number; yaw: number; rangeBrake: boolean; rangeTurn: boolean } {
    const c = this.config;
    const forwardRange = r?.forward ?? null;
    const inPlace = !holding && goal !== null && goal.distanceM > c.arrivalRadiusM && Math.cos(goal.bearingRad) < 0.5;
    if (!inPlace) this.turnLatch = null;
    const direction = (): 1 | -1 => this.turnLatch ?? (r === null ? (goal !== null && goal.bearingRad < 0 ? -1 : 1) : rangeTurnDirection(r, cues, goal));
    if (r !== null && forwardRange !== null && forwardRange < c.rangeClearanceM) {
      const dir = direction();
      if (inPlace) this.turnLatch = dir;
      return { forward: forwardRange < 0.5 * c.rangeClearanceM ? -0.2 : 0, yaw: c.rangeTurnRateRadps * dir, rangeBrake: true, rangeTurn: false };
    }
    if (inPlace && (this.turnLatch !== null || this.turnsInPlaceNearFront(goal, forwardRange))) {
      this.turnLatch = direction();
      return { forward, yaw: c.rangeTurnRateRadps * this.turnLatch, rangeBrake: false, rangeTurn: true };
    }
    return { forward, yaw, rangeBrake: false, rangeTurn: false };
  }

  /** The goal is abeam or behind (the aircraft turns in place) and a forward return is just beyond the range-brake clearance. */
  private turnsInPlaceNearFront(goal: GoalEstimate | null, forwardRange: number | null): boolean {
    const c = this.config;
    return goal !== null && goal.distanceM > c.arrivalRadiusM && Math.cos(goal.bearingRad) <= 0 && forwardRange !== null && forwardRange < c.rangeClearanceM + c.rangeTurnHysteresisM;
  }

  /** Speed ceiling from vision quality, exploration, the looming free distance, forward range and pose reliability. */
  private speedLimits(free: number, aheadKnown: boolean, ahead: { forward: number | null; clearAhead: boolean }, visionScale: number, poseReliability: number): SpeedLimits {
    const forwardRange = ahead.forward;
    const c = this.config;
    const base = aheadKnown ? c.cruiseSpeedMps : c.exploreSpeedMps;
    const vision = Math.max(base * visionScale, forwardRange !== null || ahead.clearAhead ? c.rangeOnlySpeedMps : 0);
    const looming = Math.max(0, (free - c.stopDistanceM) / c.brakeTimeS);
    const range = forwardRange === null ? Infinity : Math.max(0, (forwardRange - c.rangeClearanceM) / c.rangeBrakeTimeS);
    const poseScale = 0.4 + 0.6 * poseReliability;
    return { vision, looming, range, poseScale, ceiling: Math.min(vision, looming, range) * poseScale, visionScale };
  }

  /** Goal approach speed before limits: slows inside the approach zone and turns in place when the goal is abeam or behind. */
  private desiredSpeed(goal: GoalEstimate | null): number {
    const c = this.config;
    if (goal === null || goal.distanceM <= c.arrivalRadiusM) return 0;
    return Math.min(c.approachGain * goal.distanceM, c.cruiseSpeedMps) * Math.max(0, Math.cos(goal.bearingRad));
  }

  private steering(cues: ReflexCues | null, goal: GoalEstimate | null, visionScale: number, blocked: number, poseReliability: number): { goal: number; center: number; avoid: number } {
    const c = this.config;
    const goalTerm = goal && goal.distanceM > c.arrivalRadiusM ? c.goalGain * goal.bearingRad * poseReliability * (1 - 0.7 * blocked) : 0;
    const center = cues ? -c.centeringGain * clamp(cues.centering, -1, 1) * clamp(cues.centeringWeight, 0, 1) * visionScale : 0;
    const avoid = cues ? c.avoidGain * clamp(cues.avoidTurn, -1, 1) * blocked * visionScale : 0;
    return { goal: goalTerm, center: finite(center) ? center : 0, avoid: finite(avoid) ? avoid : 0 };
  }

  /**
   * Metric lateral ranges outrank visual steering near obstacles: never yaw toward a side whose range is
   * inside the lateral clearance, and add a turn away proportional to the intrusion.
   */
  private rangeYaw(yaw: number, r: Ranges | null): number {
    if (!r) return yaw;
    const c = this.config;
    const leftIntrusion = r.left === null ? 0 : Math.max(0, c.lateralClearanceM - r.left);
    const rightIntrusion = r.right === null ? 0 : Math.max(0, c.lateralClearanceM - r.right);
    let out = yaw + c.lateralGain * (rightIntrusion - leftIntrusion);
    if (leftIntrusion > 0) out = Math.min(out, 0);
    if (rightIntrusion > 0) out = Math.max(out, 0);
    return out;
  }

  /** Push away from a side inside the lateral clearance, or inside the contact band when that reaches farther. */
  private lateralPush(r: Ranges | null): number {
    if (!r) return 0;
    const c = this.config;
    const clearance = Math.max(c.lateralClearanceM, c.contactClearanceM + c.contactPushBandM);
    const intrusion = (range: number | null) => (range === null ? 0 : Math.max(0, clearance - range));
    return c.lateralGain * (intrusion(r.right) - intrusion(r.left));
  }

  /**
   * Translation bounded by the readings that cover it: forward speed by the flank limit, sideways speed toward
   * a side by that side's reading, backward speed by blindSpeedMps (no rear coverage). The lateral push away
   * from a near side is added before the bound, so it is never cut by the reading on the side it moves away from.
   */
  private coveredTranslation(forward: number, holdLateral: number, r: Ranges | null): { forward: number; lateral: number; flankLimitMps: number; flankLimited: boolean } {
    const c = this.config;
    const room = (range: number | null) => (range === null ? Infinity : Math.max(0, range - c.contactClearanceM) / c.rangeBrakeTimeS);
    const left = room(r?.left ?? null);
    const right = room(r?.right ?? null);
    const flankLimitMps = 2 * Math.min(left, right);
    let vx = forward;
    if (vx > flankLimitMps) vx = flankLimitMps;
    vx = Math.max(vx, -c.blindSpeedMps);
    const vy = clamp(this.lateralPush(r) + holdLateral, -right, left);
    return { forward: vx, lateral: vy, flankLimitMps, flankLimited: forward > flankLimitMps + 1e-9 };
  }

  private vertical(goal: GoalEstimate | null, r: Ranges | null): number {
    const c = this.config;
    let vz = goal ? c.heightGain * goal.heightErrorM : 0;
    if (r && r.down !== null && r.down < c.minHeightM) vz = Math.max(vz, c.heightGain * (c.minHeightM - r.down));
    return vz;
  }

  private mode(m: { goal: GoalEstimate | null; rangeBrake: boolean; desired: number; limits: SpeedLimits; terms: { goal: number; center: number } }): string {
    const l = m.limits;
    if (m.rangeBrake) return "range_brake";
    if (l.vision === 0) return "hold_no_vision";
    if (m.goal === null) return "hold_no_goal";
    if (m.goal.distanceM <= this.config.arrivalRadiusM) return "hold_arrived";
    if (l.ceiling < m.desired) return bindingLimit(l, m.desired);
    if (Math.abs(m.terms.center) > Math.max(0.1, Math.abs(m.terms.goal))) return "center";
    return Math.abs(m.goal.bearingRad) > Math.PI / 3 ? "goal_turn" : "goal";
  }

  private request(tick: number, forward: number, lateral: number, vertical: number, yaw: number): MotionRequest {
    const { maxSpeedMps, maxVerticalSpeedMps, maxYawRateRadps } = this.config.limits;
    const safe = (value: number) => (finite(value) ? value : 0);
    let vx = safe(forward);
    let vy = safe(lateral);
    const horizontal = Math.hypot(vx, vy);
    if (horizontal > maxSpeedMps) {
      vx *= maxSpeedMps / horizontal;
      vy *= maxSpeedMps / horizontal;
    }
    const vz = clamp(safe(vertical), -maxVerticalSpeedMps, maxVerticalSpeedMps);
    return { source: this.source, tick, velocityBody: { x: vx, y: vy, z: vz }, yawRateRadps: clamp(safe(yaw), -maxYawRateRadps, maxYawRateRadps) };
  }
}
