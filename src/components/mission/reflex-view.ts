/**
 * Pure derivations for the fly reflex view in FlyReflexPanel: a short callout for the controller's reported mode and
 * for each harness limit, how strongly each image sector moved (left / centre / right), which image columns each
 * sector covers, and the top-down geometry of a body-frame move. Inputs come only from the truth-free MissionView.
 *
 * Honesty: the modes belong to the hand-set cue → command mapping (navigation/reflex/command.ts) that the optical-flow
 * baseline and the engineered readout of FlyVis features both fly. A callout describes that mapping's state; it is not
 * the fly deciding, and the panel says so beside it.
 */
import type { GuardedMotion, MotionCommand, MotionLimit, MotionSource } from "../../lib/contracts/actions.ts";
import { DEFAULT_FLOW_CUE_CONFIG } from "../../lib/navigation/reflex/flow-cues.ts";
import { DEFAULT_REFLEX_LIMITS, RGB_FRONT_CAMERA } from "../../lib/navigation/reflex/types.ts";
import { limitWord } from "./format.ts";

export type Triple<T> = readonly [T, T, T];

function triple<T, U>(values: Triple<T>, map: (value: T, index: number) => U): Triple<U> {
  return [map(values[0], 0), map(values[1], 1), map(values[2], 2)];
}

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));

/* Controller modes → callouts. */

/**
 * Every mode a motion controller reports after the slash of its step label ("<source>/<mode>", ControllerOutput.label).
 * The first fifteen come from the shared cue → command mapping (command.ts) flown by the optical-flow baseline and the
 * engineered readout; the last three from the trained readout (trained-readout.ts), which a mission cannot fly yet.
 */
export const REFLEX_MODES = [
  "goal", "goal_turn", "center", "explore", "slow_low_vision", "slow_pose", "slow_range", "brake_looming",
  "slow_flank", "range_turn", "range_brake", "hold_face", "hold_arrived", "hold_no_goal", "hold_no_vision",
  "readout", "capped", "hold_no_features",
] as const;

export type ReflexMode = (typeof REFLEX_MODES)[number];

/** What the move does, for the chip's accent: fly on, turn, slow or brake, hold; "other" when no reflex mode describes it. */
export type CalloutTone = "fly" | "turn" | "slow" | "hold" | "other";

export interface Callout {
  /** What the aircraft does, e.g. "Slowed". */
  readonly verb: string;
  /** Why, e.g. "range limit". */
  readonly reason: string;
  readonly tone: CalloutTone;
  /** One plain sentence for the tooltip. */
  readonly detail: string;
}

const MODE_CALLOUTS: Readonly<Record<ReflexMode, Callout>> = {
  goal: { verb: "Flying", reason: "toward goal", tone: "fly", detail: "Goal within 60° of the nose and no limit binding: fly toward it." },
  goal_turn: { verb: "Turning", reason: "toward goal", tone: "turn", detail: "Goal more than 60° off the nose: turn toward it." },
  center: { verb: "Centering", reason: "side motion", tone: "turn", detail: "Side motion outweighs goal steering: turn away from the side with more outward image motion." },
  explore: { verb: "Slowed", reason: "ahead not yet seen", tone: "slow", detail: "Free space ahead not measured yet: hold to exploration speed." },
  slow_low_vision: { verb: "Slowed", reason: "low visibility", tone: "slow", detail: "Low visual confidence (smoke, darkness, little texture) scales the speed down." },
  slow_pose: { verb: "Slowed", reason: "position uncertain", tone: "slow", detail: "The position estimate is uncertain: speed and goal steering are scaled down." },
  slow_range: { verb: "Slowed", reason: "range limit", tone: "slow", detail: "The forward range reading limits speed so the aircraft can stop before its clearance." },
  brake_looming: { verb: "Braking", reason: "looming", tone: "slow", detail: "Looming ahead puts the free distance close: speed is limited so the aircraft can stop in time." },
  slow_flank: { verb: "Slowed", reason: "flank close", tone: "slow", detail: "A side range reading is close: forward speed is limited so that side cannot close on the aircraft." },
  range_turn: { verb: "Turning away", reason: "obstacle ahead", tone: "turn", detail: "Turning in place with a return just beyond the brake clearance: keep turning toward the open side." },
  range_brake: { verb: "Braking", reason: "range too close", tone: "slow", detail: "A forward range reading is inside the brake clearance: stop, or back off, and turn toward the open side." },
  hold_face: { verb: "Holding", reason: "facing target", tone: "hold", detail: "Within the hold radius of the goal: hold there and turn to face the target bearing." },
  hold_arrived: { verb: "Holding", reason: "at goal", tone: "hold", detail: "Within the arrival radius of the goal: hold." },
  hold_no_goal: { verb: "Holding", reason: "no goal", tone: "hold", detail: "No goal estimate: hold." },
  hold_no_vision: { verb: "Holding", reason: "no usable vision", tone: "hold", detail: "No usable vision and no range reading to fall back on: hold." },
  readout: { verb: "Flying", reason: "trained readout", tone: "fly", detail: "Trained readout output, within the speed ceiling." },
  capped: { verb: "Slowed", reason: "speed ceiling", tone: "slow", detail: "The trained readout asked for more than the speed ceiling: capped." },
  hold_no_features: { verb: "Holding", reason: "no FlyVis features", tone: "hold", detail: "No FlyVis features this step: hold." },
};

/** Requests that did not come from a reflex controller: the chip names who asked instead of a reflex mode. */
const NOT_REFLEX: Readonly<Partial<Record<MotionSource, Callout>>> = {
  contingency: { verb: "Contingency", reason: "not the reflex", tone: "other", detail: "A contingency requested this move; the reflex did not." },
  operator: { verb: "Operator", reason: "not the reflex", tone: "other", detail: "An operator command requested this move; the reflex did not." },
};

function isReflexMode(mode: string): mode is ReflexMode {
  return (REFLEX_MODES as readonly string[]).includes(mode);
}

/** The mode in a "<source>/<mode>" step label (ControllerOutput.label); null when there is none or it is malformed. */
export function stepMode(stepLabel: string | null | undefined): string | null {
  if (typeof stepLabel !== "string") return null;
  const slash = stepLabel.lastIndexOf("/");
  if (slash <= 0) return null;
  const mode = stepLabel.slice(slash + 1);
  return /^[a-z][a-z0-9_]*$/.test(mode) ? mode : null;
}

/** The callout for a controller mode; a mode this panel does not know still reads, as an undescribed "Reflex" mode. */
export function modeCallout(mode: string | null): Callout | null {
  if (mode === null) return null;
  if (isReflexMode(mode)) return MODE_CALLOUTS[mode];
  return { verb: "Reflex", reason: mode.replace(/_/g, " "), tone: "other", detail: `The controller reported mode "${mode}", which this panel does not describe yet.` };
}

/** The chip for this tick: a request the reflex did not make says who made it; otherwise the controller's reported mode. */
export function primaryCallout(stepLabel: string | null | undefined, requestSource: MotionSource | null | undefined): Callout | null {
  const other = requestSource == null ? undefined : NOT_REFLEX[requestSource];
  return other ?? modeCallout(stepMode(stepLabel));
}

export function calloutText(callout: Callout): string {
  return `${callout.verb} · ${callout.reason}`;
}

/* Harness limits → callouts. */

const HARNESS_DETAIL: Readonly<Record<MotionLimit, string>> = {
  speed: "The harness clamped the speed, keeping its direction.",
  person_clearance: "The harness removed the closing component toward a possible person to keep the person clearance.",
  vertical_speed: "The harness clamped the vertical speed.",
  yaw_rate: "The harness clamped the yaw rate.",
  acceleration: "The harness bounded how fast the command may grow toward the request.",
  no_active_goal: "No validated goal: the harness lets the reflex fly nowhere.",
  localization: "Localization does not support advancing: the harness allows no horizontal motion.",
  envelope_boundary: "The harness zeroed motion that would leave the mission envelope or outlast its time box.",
  mission_aborted: "Mission aborted: the harness flies its terminal brake and descent.",
};

export interface HarnessCallout {
  readonly limit: MotionLimit;
  /** e.g. "Harness · acceleration limit". */
  readonly text: string;
  readonly detail: string;
}

/** One "Harness · <limit>" callout per distinct limit that shaped the executed motion, in the harness's order. */
export function harnessCallouts(limits: readonly MotionLimit[] | null | undefined): HarnessCallout[] {
  const callouts: HarnessCallout[] = [];
  for (const limit of new Set(limits ?? [])) {
    const word = limitWord(limit);
    callouts.push({ limit, text: `Harness · ${word.charAt(0).toLowerCase()}${word.slice(1)}`, detail: HARNESS_DETAIL[limit] });
  }
  return callouts;
}

/* Left / centre / right sector readings. */

/** Which features fed a sector reading: FlyVis sector motion (engineered readout) or the optical-flow baseline's cues. */
export type SectorSource = "flyvis" | "flow";

export interface SectorReading {
  /** Null when the controller reported no sector features (UI fixture, trained readout). */
  readonly source: SectorSource | null;
  /** Magnitude per sector (≥ 0; FlyVis sectors as |signed motion|); null where nothing was measured this step. */
  readonly values: Triple<number | null>;
  /** Values as reported (FlyVis: positive = rightward image motion); null where nothing was measured. */
  readonly signed: Triple<number | null>;
  /** Display intensity 0..1: each value over max(brightest value, the source's floor); 0 where not measured. */
  readonly levels: Triple<number>;
  /** True when at least one sector was measured this step. */
  readonly measured: boolean;
  /** Why nothing was measured; null when measured. */
  readonly note: string | null;
}

/** FRAME_STATUS.flow in flow-baseline.ts: a flow field was computed this step (the tests check it). */
const FLOW_MEASURED = 4;

const FLOW_STATUS_NOTES: Readonly<Record<number, string>> = {
  0: "No camera frame this step.",
  1: "Frame unusable for flow.",
  2: "Same frame again: no new flow.",
  3: "First frame of a pair: flow starts with the next frame.",
};

/**
 * Below these a reading stays dim, so sensor noise never lights a band at full strength: flow at the baseline's
 * full-trust centering sum (0.15 s⁻¹, flow-cues.ts), FlyVis at the engineered readout's avoidance scale (0.1 model
 * units, engineered-readout.ts).
 */
const LEVEL_FLOOR: Readonly<Record<SectorSource, number>> = { flow: 0.15, flyvis: 0.1 };

const NONE: Triple<null> = [null, null, null];

function read(features: Readonly<Record<string, number>>, key: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(features, key) ? features[key] : undefined;
}

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegative(value: number | undefined): number | null {
  const finite = finiteOrNull(value);
  return finite === null ? null : Math.max(0, finite);
}

function unmeasured(source: SectorSource | null, note: string): SectorReading {
  return { source, values: NONE, signed: NONE, levels: [0, 0, 0], measured: false, note };
}

function measuredReading(source: SectorSource, signed: Triple<number | null>, values: Triple<number | null>): SectorReading {
  if (values.every(value => value === null)) return unmeasured(source, "No finite sector values this step.");
  const scale = Math.max(LEVEL_FLOOR[source], ...values.map(value => value ?? 0));
  return { source, values, signed, levels: triple(values, value => (value === null ? 0 : Math.min(1, value / scale))), measured: true, note: null };
}

function flyvisReading(features: Readonly<Record<string, number>>): SectorReading {
  if (read(features, "featuresPresent") === 0) return unmeasured("flyvis", "No FlyVis features this step.");
  const signed = triple(["leftMotion", "centerMotion", "rightMotion"] as const, key => finiteOrNull(read(features, key)));
  return measuredReading("flyvis", signed, triple(signed, value => (value === null ? null : Math.abs(value))));
}

function flowReading(features: Readonly<Record<string, number>>): SectorReading {
  const status = read(features, "frameStatus");
  if (status !== undefined && status !== FLOW_MEASURED) return unmeasured("flow", FLOW_STATUS_NOTES[status] ?? "No flow this step.");
  const looming = read(features, "loomingValid") === 0 ? null : nonNegative(read(features, "loomingRateHz"));
  const values: Triple<number | null> = [nonNegative(read(features, "flowLeftHz")), looming, nonNegative(read(features, "flowRightHz"))];
  return measuredReading("flow", values, values);
}

/** Shown before the controller has reported any features (no camera frame processed yet). */
export const WAITING_FOR_FRAME = "Waiting for the first camera frame.";

/**
 * Left / centre / right motion from the controller's reported features. FlyVis sectors (engineered readout) give the
 * magnitude of each sector's horizontal motion; the optical-flow baseline gives outward flow in the left and right
 * peripheries and the looming rate ahead. Missing, non-finite or unmeasured values never light a sector.
 */
export function sectorReading(features: Readonly<Record<string, number>> | null | undefined): SectorReading {
  const f = features ?? {};
  if (read(f, "leftMotion") !== undefined || read(f, "rightMotion") !== undefined) return flyvisReading(f);
  if (read(f, "flowLeftHz") !== undefined || read(f, "flowRightHz") !== undefined) return flowReading(f);
  // Nothing at all yet is the normal start of a run; features without sector values are a real gap.
  return unmeasured(null, Object.keys(f).length === 0 ? WAITING_FOR_FRAME : "No sector motion reported.");
}

export const SECTOR_LETTERS: Triple<string> = ["L", "C", "R"];

export interface SectorMeta {
  readonly title: string;
  readonly unit: string;
  readonly sectors: Triple<string>;
}

const SECTOR_META: Readonly<Record<SectorSource, SectorMeta>> = {
  flyvis: { title: "FlyVis motion", unit: "model units", sectors: ["Left sector", "Centre sector", "Right sector"] },
  flow: { title: "Optical flow", unit: "s⁻¹", sectors: ["Left outward flow", "Looming ahead (1/τ)", "Right outward flow"] },
};

export function sectorMeta(source: SectorSource | null): SectorMeta | null {
  return source === null ? null : SECTOR_META[source];
}

export function formatSectorValue(value: number | null): string {
  if (value === null) return "—";
  return value < 10 ? value.toFixed(2) : value.toFixed(1);
}

function imageDirection(signed: number | null): string {
  if (signed === null || signed === 0) return "";
  return signed > 0 ? ", rightward image motion" : ", leftward image motion";
}

/** Tooltip for one sector meter. */
export function sectorTitle(reading: SectorReading, index: 0 | 1 | 2): string {
  const meta = sectorMeta(reading.source);
  if (meta === null) return reading.note ?? "No sector motion reported.";
  const value = reading.values[index];
  if (value === null) return `${meta.sectors[index]}: not measured this step.`;
  const direction = reading.source === "flyvis" ? imageDirection(reading.signed[index]) : "";
  return `${meta.sectors[index]}: ${formatSectorValue(value)} ${meta.unit}${direction}.`;
}

/** One sentence for the meter group's accessible name. */
export function sectorSummary(reading: SectorReading): string {
  const meta = sectorMeta(reading.source);
  if (meta === null) return reading.note ?? "No sector motion reported.";
  if (!reading.measured) return `${meta.title}: ${reading.note ?? "not measured this step."}`;
  const [left, centre, right] = triple(reading.values, formatSectorValue);
  return `${meta.title} (${meta.unit}): left ${left}, centre ${centre}, right ${right}.`;
}

/* Image columns each sector covers. */

/** A span of image columns as fractions of the frame width (0 = left edge, 1 = right edge). */
export interface Band {
  readonly start: number;
  readonly end: number;
}

/**
 * The FlyVis service's eye (services/flyvis/flyvis_service/eye.py, features.py): the central square crop of side
 * min(width, height) is resized to a 417 px canvas whose receptor columns sit 13 px apart, columns −15..15 each sampling
 * a 13 px box (so the lattice spans ±15.5 columns), split 10 | 11 | 10 into sectors at ±5.5 columns.
 */
const FLYVIS_EYE = Object.freeze({ canvasPx: 417, columnPx: 13, outerColumns: 15.5, centreColumns: 5.5 });

const DEFAULT_FRAME = Object.freeze({ width: 16, height: 9 });

function flowBands(): Triple<Band> {
  // The baseline's camera model (RGB_FRONT_CAMERA) maps a tangent of azimuth x to frame fraction 0.5 + x / (2 tan(hfov/2)).
  const halfTan = Math.tan((RGB_FRONT_CAMERA.horizontalFovDeg * Math.PI) / 360);
  const at = (tangent: number) => clamp(0.5 + tangent / (2 * halfTan), 0, 1);
  const { lateralInner, centralHalfWidth } = DEFAULT_FLOW_CUE_CONFIG;
  return [{ start: 0, end: at(-lateralInner) }, { start: at(-centralHalfWidth), end: at(centralHalfWidth) }, { start: at(lateralInner), end: 1 }];
}

function flyvisBands(frame: { readonly width: number; readonly height: number } | null): Triple<Band> {
  const usable = frame !== null && frame.width > 0 && frame.height > 0 && Number.isFinite(frame.width) && Number.isFinite(frame.height);
  const { width, height } = usable ? frame : DEFAULT_FRAME;
  const cropHalf = Math.min(width, height) / width / 2;
  const column = FLYVIS_EYE.columnPx / (FLYVIS_EYE.canvasPx / 2);
  const at = (columns: number) => clamp(0.5 + columns * column * cropHalf, 0, 1);
  const { outerColumns: outer, centreColumns: centre } = FLYVIS_EYE;
  return [{ start: at(-outer), end: at(-centre) }, { start: at(-centre), end: at(centre) }, { start: at(centre), end: at(outer) }];
}

/**
 * The image columns each sector reads, left to right. Optical flow: the left and right peripheries beyond ±25° of
 * azimuth and the central looming window within ±12° (DEFAULT_FLOW_CUE_CONFIG in the baseline's 90° camera model).
 * FlyVis: three column sectors inside the central square crop, so they depend on the frame's aspect ratio (16:9 when
 * no frame has been seen).
 */
export function sectorBands(source: SectorSource, frame: { readonly width: number; readonly height: number } | null): Triple<Band> {
  return source === "flow" ? flowBands() : flyvisBands(frame);
}

/* Top-down move diagram. */

export const MOVE_DIAGRAM = Object.freeze({
  /** The aircraft glyph sits inside this radius; arrows start at it and speed is measured outward from it. */
  innerRadius: 13,
  /** Where a full-speed arrow ends (diagram units); the rings sit at half and full speed (speedRadius). */
  radius: 44,
  /** Radius of the yaw arc around the aircraft, outside the longest arrow. */
  arcRadius: 54,
  fullSpeedMps: DEFAULT_REFLEX_LIMITS.maxSpeedMps,
  fullYawRadps: DEFAULT_REFLEX_LIMITS.maxYawRateRadps,
  maxSweepRad: (2 * Math.PI) / 3,
  /** Shortest arrow and smallest sweep drawn, so a slow move stays visible. */
  minLength: 6,
  minSweepRad: 0.25,
  /** Below these a component counts as still and is not drawn. */
  stillSpeedMps: 0.02,
  stillYawRadps: 0.02,
  /** Arrowhead length. */
  head: 6,
});

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface MoveArrow {
  /** Where the shaft leaves the aircraft glyph. */
  readonly start: Point;
  readonly tip: Point;
  /** Where the shaft stops, under the head. */
  readonly shaftEnd: Point;
  /** SVG polygon points of the head. */
  readonly head: string;
}

export interface YawArc {
  /** Signed sweep: positive is counter-clockwise on screen (turning left). */
  readonly sweepRad: number;
  /** Tip of the arc's head. */
  readonly end: Point;
  /** SVG path of the arc, stopping where the head begins. */
  readonly path: string;
  readonly head: string;
}

export interface MoveGeometry {
  readonly arrow: MoveArrow | null;
  readonly yaw: YawArc | null;
}

const fmt = (value: number): string => String(Math.round(value * 100) / 100 + 0);

function headPoints(tip: Point, direction: Point, size: number): string {
  const base = { x: tip.x - direction.x * size, y: tip.y - direction.y * size };
  const half = size * 0.6;
  const normal = { x: -direction.y * half, y: direction.x * half };
  return [tip, { x: base.x + normal.x, y: base.y + normal.y }, { x: base.x - normal.x, y: base.y - normal.y }].map(p => `${fmt(p.x)},${fmt(p.y)}`).join(" ");
}

/**
 * Distance from the diagram's centre at which an arrow for this speed ends; the rings use it too. The scale is the
 * square root of speed over full speed, so indoor moves of a few tenths of a metre per second keep a visible shaft
 * (on a linear 2 m/s scale they drew as a bare arrowhead); it is monotonic, so a limited move is still shorter.
 */
export function speedRadius(speedMps: number): number {
  const d = MOVE_DIAGRAM;
  return d.innerRadius + Math.sqrt(clamp(speedMps / d.fullSpeedMps, 0, 1)) * (d.radius - d.innerRadius);
}

function moveArrow(forward: number, left: number): MoveArrow | null {
  const d = MOVE_DIAGRAM;
  if (!Number.isFinite(forward) || !Number.isFinite(left)) return null;
  const speed = Math.hypot(forward, left);
  if (speed < d.stillSpeedMps) return null;
  const reach = Math.max(speedRadius(speed) - d.innerRadius, d.minLength);
  // Screen axes: forward is up (−y) and the body's left (+y) is screen left (−x).
  const direction = { x: -left / speed, y: -forward / speed };
  const at = (distance: number): Point => ({ x: direction.x * distance, y: direction.y * distance });
  const tip = at(d.innerRadius + reach);
  return { start: at(d.innerRadius), tip, shaftEnd: at(d.innerRadius + reach - d.head * 0.8), head: headPoints(tip, direction, d.head) };
}

function yawArc(yawRate: number): YawArc | null {
  const d = MOVE_DIAGRAM;
  if (!Number.isFinite(yawRate) || Math.abs(yawRate) < d.stillYawRadps) return null;
  const sign = yawRate > 0 ? 1 : -1;
  const sweep = sign * clamp((Math.abs(yawRate) / d.fullYawRadps) * d.maxSweepRad, d.minSweepRad, d.maxSweepRad);
  const r = d.arcRadius;
  // Angle φ from the nose, counter-clockwise on screen: the point (−r sin φ, −r cos φ).
  const at = (phi: number): Point => ({ x: -r * Math.sin(phi), y: -r * Math.cos(phi) });
  const end = at(sweep);
  const arcEnd = at(sweep - (sign * d.head) / r);
  const travel = { x: -sign * Math.cos(sweep), y: sign * Math.sin(sweep) };
  // SVG sweep-flag 1 draws clockwise on screen (y down), so a left turn uses 0.
  const path = `M 0 ${fmt(-r)} A ${r} ${r} 0 0 ${sign > 0 ? 0 : 1} ${fmt(arcEnd.x)} ${fmt(arcEnd.y)}`;
  return { sweepRad: sweep, end, path, head: headPoints(end, travel, d.head) };
}

/**
 * Top-down geometry of a body-frame command in diagram units: origin at the aircraft, +x to the right of the screen,
 * +y down, nose up. Forward speed points up and leftward speed (body +y) points left, from the glyph's edge outward;
 * a positive yaw rate (turning left, counter-clockwise seen from above) sweeps an arc from the nose toward the left.
 * Requested and executed commands share this one (square-root) scale, so a limited move is visibly shorter.
 */
export function moveGeometry(command: Pick<MotionCommand, "velocityBody" | "yawRateRadps"> | null | undefined): MoveGeometry {
  if (command == null) return { arrow: null, yaw: null };
  return { arrow: moveArrow(command.velocityBody.x, command.velocityBody.y), yaw: yawArc(command.yawRateRadps) };
}

function axisWords(value: number, positive: string, negative: string): string {
  if (!Number.isFinite(value)) return `${positive} not finite`;
  return `${Math.abs(value).toFixed(2)} m/s ${value <= -0.005 ? negative : positive}`;
}

function yawWords(rate: number): string {
  if (!Number.isFinite(rate)) return "yaw not finite";
  const degrees = (Math.abs(rate) * 180) / Math.PI;
  return degrees < 0.5 ? "no turn" : `turning ${rate > 0 ? "left" : "right"} ${degrees.toFixed(0)}°/s`;
}

function commandWords(command: MotionCommand): string {
  const v = command.velocityBody;
  return [axisWords(v.x, "forward", "back"), axisWords(v.y, "left", "right"), axisWords(v.z, "up", "down"), yawWords(command.yawRateRadps)].join(", ");
}

/** The move diagram's accessible description: executed first, then what was requested. */
export function describeMove(motion: GuardedMotion | null): string {
  if (motion === null) return "No motion request this tick.";
  return `Executed after the harness: ${commandWords(motion.executed)}. Requested: ${commandWords(motion.requested)}.`;
}

/* Who chose the move. */

const SOURCE_NOTES: Readonly<Record<MotionSource, string>> = {
  engineered_readout: "Engineered readout: hand-set weights turn FlyVis motion features into this move. The fly model supplies the features; it does not decide.",
  fly_readout: "Trained readout: a fitted mapping turns FlyVis features into this move.",
  flow_baseline: "Optical-flow baseline: conventional flow cues chose this move. No fly model in this run.",
  classical_fallback: "Classical fallback: FlyVis is unavailable, so conventional optical flow chose this move; not fly-model output.",
  contingency: "A contingency requested this move, not the reflex.",
  operator: "An operator command requested this move, not the reflex.",
};

/**
 * One plain line saying what chose the move, shown beside the callout. A reflex controller is credited only once it
 * has reported a step (a UI fixture tags its illustrative motion with a controller source but runs no controller).
 */
export function provenanceNote(source: MotionSource | null | undefined, stepLabel: string | null | undefined): string | null {
  if (source == null) return null;
  return NOT_REFLEX[source] !== undefined || stepMode(stepLabel) !== null ? SOURCE_NOTES[source] : null;
}
