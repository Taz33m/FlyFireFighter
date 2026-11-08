/**
 * Aircraft capability profiles: what one fictional aircraft can physically do.
 *
 * Hard limits are never overridable by commander approval or by a mission-envelope revision. Software
 * cannot confer heat tolerance, payload capacity or thrust the aircraft lacks.
 */
import type { Tick } from "./clock.ts";
import type { Vec3 } from "./frames.ts";
import { vec3 } from "./frames.ts";
import type { AircraftId } from "./ids.ts";
import { deepFreeze } from "./ids.ts";
import type { SensorModality } from "./observation.ts";

export interface SensorSpec {
  readonly id: string;
  readonly modality: SensorModality;
  /** Mount in the body frame (X forward, Y left, Z up); positive pitch looks below the horizon. */
  readonly mount: { readonly positionBody: Vec3; readonly yawRad: number; readonly pitchRad: number };
  readonly rateHz: number;
  /** Capture-to-arrival delay on the mission clock. */
  readonly latencyTicks: Tick;
  readonly horizontalFovDeg: number | null;
  readonly verticalFovDeg: number | null;
  readonly maxRangeM: number | null;
  readonly resolution: { readonly width: number; readonly height: number } | null;
}

export interface WaterModuleSpec {
  readonly tankL: number;
  readonly maxFlowLps: number;
  readonly nozzleDiameterMm: number;
  readonly coneHalfAngleDeg: number;
  readonly rangeM: number;
}

export interface GlassBreakerSpec {
  /** Maximum distance from the aircraft to the strike point. */
  readonly reachM: number;
  /** Radius around the strike point that may receive glass debris. */
  readonly debrisRadiusM: number;
  /** Positioning and arming time between execution start and the strike. */
  readonly strikeDelayTicks: Tick;
}

export interface PayloadBaySpec {
  readonly slots: number;
  readonly maxPayloadKg: number;
}

export interface HardLimits {
  readonly maxSpeedMps: number;
  readonly maxVerticalSpeedMps: number;
  readonly maxYawRateRadps: number;
  readonly maxAccelMps2: number;
  readonly warnAmbientC: number;
  readonly maxAmbientC: number;
  readonly maxExposureAboveWarnS: number;
  readonly enduranceS: number;
  /** Endurance that must remain available for the return route. */
  readonly returnReserveS: number;
  readonly maxThrustN: number;
  /** Hover thrust at full payload. Thrust margin = maxThrustN - hoverThrustN. */
  readonly hoverThrustN: number;
  /** Largest allowed jet reaction force as a fraction of the thrust margin. */
  readonly maxReactionFractionOfMargin: number;
  readonly minObstacleClearanceM: number;
}

export interface AircraftModules {
  readonly water: WaterModuleSpec | null;
  readonly glassBreaker: GlassBreakerSpec | null;
  readonly payloadBay: PayloadBaySpec | null;
  readonly lightCue: boolean;
  readonly speaker: boolean;
}

export interface AircraftProfile {
  readonly id: AircraftId;
  /** Increments whenever any capability or limit changes; approvals bind to it. */
  readonly revision: number;
  readonly name: string;
  readonly fictional: true;
  readonly massKg: number;
  readonly spanM: number;
  readonly heightM: number;
  readonly hardLimits: HardLimits;
  readonly sensors: readonly SensorSpec[];
  readonly modules: AircraftModules;
}

const RAD = Math.PI / 180;

const SEARCH_SENSORS: readonly SensorSpec[] = [
  { id: "rgb-front", modality: "rgb", mount: { positionBody: vec3(0.12, 0, 0.02), yawRad: 0, pitchRad: 10 * RAD }, rateHz: 50, latencyTicks: 2, horizontalFovDeg: 90, verticalFovDeg: 58.7, maxRangeM: null, resolution: { width: 320, height: 180 } },
  { id: "thermal-front", modality: "thermal", mount: { positionBody: vec3(0.12, 0.03, 0.02), yawRad: 0, pitchRad: 10 * RAD }, rateHz: 10, latencyTicks: 5, horizontalFovDeg: 57, verticalFovDeg: 44, maxRangeM: null, resolution: { width: 160, height: 120 } },
  { id: "lidar-planar", modality: "lidar", mount: { positionBody: vec3(0, 0, 0.08), yawRad: 0, pitchRad: 0 }, rateHz: 20, latencyTicks: 2, horizontalFovDeg: 360, verticalFovDeg: 0, maxRangeM: 8, resolution: { width: 360, height: 1 } },
  { id: "ultrasound-front", modality: "ultrasound", mount: { positionBody: vec3(0.14, 0, 0), yawRad: 0, pitchRad: 0 }, rateHz: 20, latencyTicks: 3, horizontalFovDeg: 30, verticalFovDeg: 30, maxRangeM: 4, resolution: null },
  { id: "ultrasound-down", modality: "ultrasound", mount: { positionBody: vec3(0, 0, -0.06), yawRad: 0, pitchRad: 90 * RAD }, rateHz: 20, latencyTicks: 3, horizontalFovDeg: 30, verticalFovDeg: 30, maxRangeM: 4, resolution: null },
  { id: "imu", modality: "imu", mount: { positionBody: vec3(0, 0, 0), yawRad: 0, pitchRad: 0 }, rateHz: 100, latencyTicks: 0, horizontalFovDeg: null, verticalFovDeg: null, maxRangeM: null, resolution: null },
  // Downward-looking camera (common on real drones for landing and ground checks): lets the aircraft check the
  // ground below a window or release point while hovering. Metadata-only in the twin; not a controller input.
  // Turned 90° about the vertical so its wide (110°) axis runs fore and aft: its forward edge then meets the
  // forward cameras' lower edges, leaving no blind wedge over the floor just ahead of the aircraft.
  { id: "rgb-down", modality: "rgb", mount: { positionBody: vec3(0, 0, -0.07), yawRad: 90 * RAD, pitchRad: 90 * RAD }, rateHz: 10, latencyTicks: 2, horizontalFovDeg: 110, verticalFovDeg: 90, maxRangeM: null, resolution: { width: 160, height: 120 } },
];

/** Fictional search aircraft: sensing, light and audio cues; no intervention modules. */
export const SCOUT_S1: AircraftProfile = deepFreeze({
  id: "scout-s1",
  revision: 1,
  name: "Scout S1 (fictional)",
  fictional: true,
  massKg: 1.4,
  spanM: 0.45,
  heightM: 0.18,
  hardLimits: {
    maxSpeedMps: 5, maxVerticalSpeedMps: 1.5, maxYawRateRadps: 120 * RAD, maxAccelMps2: 4,
    warnAmbientC: 55, maxAmbientC: 70, maxExposureAboveWarnS: 45,
    enduranceS: 1200, returnReserveS: 150,
    maxThrustN: 30, hoverThrustN: 13.7, maxReactionFractionOfMargin: 0.25, minObstacleClearanceM: 0.25,
  },
  sensors: SEARCH_SENSORS,
  modules: { water: null, glassBreaker: null, payloadBay: null, lightCue: true, speaker: true },
});

/**
 * Fictional modular rescue aircraft with a bounded water module and a glass breaker.
 * Jet example at maximum flow: 0.2 L/s through a 4 mm nozzle gives v ≈ 15.9 m/s and F ≈ 3.2 N.
 */
export const TENDER_T1: AircraftProfile = deepFreeze({
  id: "tender-t1",
  revision: 1,
  name: "Tender T1 (fictional)",
  fictional: true,
  massKg: 2.2,
  spanM: 0.55,
  heightM: 0.2,
  hardLimits: {
    maxSpeedMps: 4, maxVerticalSpeedMps: 1.5, maxYawRateRadps: 120 * RAD, maxAccelMps2: 3,
    warnAmbientC: 60, maxAmbientC: 80, maxExposureAboveWarnS: 60,
    enduranceS: 900, returnReserveS: 120,
    maxThrustN: 60, hoverThrustN: 31.4, maxReactionFractionOfMargin: 0.25, minObstacleClearanceM: 0.3,
  },
  sensors: SEARCH_SENSORS,
  modules: {
    water: { tankL: 1.0, maxFlowLps: 0.2, nozzleDiameterMm: 4, coneHalfAngleDeg: 8, rangeM: 4 },
    // Demo striker: a telescoping glass breaker reaching 1.2 m, so the aircraft strikes from the station it held for
    // the look (no docking at the pane) and the glass breaks about 0.5 s after execution starts.
    glassBreaker: { reachM: 1.2, debrisRadiusM: 1.5, strikeDelayTicks: 50 },
    payloadBay: { slots: 1, maxPayloadKg: 0.3 },
    lightCue: true,
    speaker: true,
  },
});

export const AIRCRAFT_PROFILES: readonly AircraftProfile[] = [SCOUT_S1, TENDER_T1];
