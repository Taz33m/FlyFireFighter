/**
 * UI fixture: hand-authored RenderSnapshot states for exercising the renderer while the mission worker is
 * unavailable. Nothing here is simulated. Poses, fire and smoke values are static illustrations chosen to
 * sit inside the troy-training scene, and every screen that shows them carries the
 * "UI fixture — not a simulation run" banner.
 */
import type { ActuatorCommand } from "@/lib/contracts/actions";
import type { FloorPlanPrior } from "@/lib/contracts/evidence";
import type { Vec3 } from "@/lib/contracts/frames";
import { vec3 } from "@/lib/contracts/frames";
import type { RunId } from "@/lib/contracts/ids";
import type { MissionStatus, RenderSnapshot, RunConfig } from "@/lib/mission/protocol";

export type FixtureStep = "idle" | "reported" | "breach_pending" | "spray_pending" | "spraying" | "guiding";

export const FIXTURE_STEPS: readonly FixtureStep[] = ["idle", "reported", "breach_pending", "spray_pending", "spraying", "guiding"];

/** Mission-clock tick shown for each fixture step (100 ticks per simulated second). */
export const STEP_TICK: Readonly<Record<FixtureStep, number>> = { idle: 0, reported: 600, breach_pending: 4200, spray_pending: 7800, spraying: 9400, guiding: 11800 };

export const FIXTURE_IDS = {
  breachProposal: "fx-prop-breach",
  sprayProposal: "fx-prop-spray",
  guideProposal: "fx-prop-guide",
  window: "win-u-rear-bedroom",
  windowCollider: "col-glass-win-u-rear-bedroom",
  fire: "fx-fire-hall",
  track: "fx-track-1",
  route: "fx-route-evac",
} as const;

export interface FixtureContext {
  readonly runId: RunId;
  readonly config: RunConfig;
  readonly prior: FloorPlanPrior;
  readonly step: FixtureStep;
  readonly status: MissionStatus;
  readonly reportText: string | null;
  readonly rejected: readonly string[];
  readonly smoke: Readonly<Record<string, number>>;
  readonly obstructions: readonly { readonly id: string; readonly min: Vec3; readonly max: Vec3 }[];
  readonly extraOccupants: readonly Vec3[];
  readonly sigmaIncreaseM: number;
  readonly lastFrameId: string | null;
}

const LAUNCH = { position: vec3(30.5, 28, 0.1), yawRad: -Math.PI / 2 };

const DRONE_POSE: Readonly<Record<FixtureStep, { readonly position: Vec3; readonly yawRad: number }>> = {
  idle: LAUNCH,
  reported: LAUNCH,
  breach_pending: { position: vec3(24.2, -4.6, 5.1), yawRad: Math.PI / 2 },
  spray_pending: { position: vec3(23.2, 0.2, 4.6), yawRad: 2.46 },
  spraying: { position: vec3(22.4, 0.55, 4.4), yawRad: 2.39 },
  guiding: { position: vec3(20.6, 3.4, 4.7), yawRad: Math.PI },
};

export const SPRAY_AIM: Vec3 = vec3(20.85, 2.0, 3.8);
export const STAIR_TOP: Vec3 = vec3(19.55, 3.76, 3.6);
export const FIRE_BOX = { min: vec3(20.45, 1.7, 3.6), max: vec3(21.25, 2.5, 4.3) };

const HEAT_KW: Readonly<Record<FixtureStep, number>> = { idle: 25, reported: 30, breach_pending: 60, spray_pending: 80, spraying: 35, guiding: 0 };

const BASE_SMOKE: Readonly<Record<FixtureStep, Readonly<Record<string, number>>>> = {
  idle: { "room-u-hall": 0.2 },
  reported: { "room-u-hall": 0.25 },
  breach_pending: { "room-u-hall": 0.6, "room-u-rear-bedroom": 0.18, "room-u-study": 0.12 },
  spray_pending: { "room-u-hall": 0.7, "room-u-rear-bedroom": 0.22, "room-u-study": 0.15, "room-stair": 0.1 },
  spraying: { "room-u-hall": 0.55, "room-u-rear-bedroom": 0.2, "room-u-study": 0.15, "room-stair": 0.12 },
  guiding: { "room-u-hall": 0.3, "room-u-rear-bedroom": 0.12, "room-u-study": 0.1, "room-stair": 0.1 },
};

const atOrAfter = (step: FixtureStep, from: FixtureStep) => FIXTURE_STEPS.indexOf(step) >= FIXTURE_STEPS.indexOf(from);

export function fixtureDronePose(step: FixtureStep) {
  return DRONE_POSE[step];
}

function occupants(ctx: FixtureContext): RenderSnapshot["occupants"] {
  const main = ctx.step === "guiding"
    ? { key: "fx-occupant-1", position: vec3(21.3, 1.4, 3.6), yawRad: 2.2, animation: "follow" as const, activity: "Following the light toward the stairs" }
    : atOrAfter(ctx.step, "spray_pending")
      ? { key: "fx-occupant-1", position: vec3(23.9, 0.0, 3.6), yawRad: -2.4, animation: "crouch" as const, activity: "Sheltering low, away from the hall" }
      : { key: "fx-occupant-1", position: vec3(23.7, 0.2, 3.6), yawRad: -1.9, animation: "cough" as const, activity: "Sheltering in the rear bedroom" };
  const extra = ctx.extraOccupants.map((position, i) => ({ key: `fx-occupant-extra-${i + 1}`, position, yawRad: 0, animation: "idle" as const, activity: "Added by an experiment control" }));
  return [main, ...extra];
}

function rooms(ctx: FixtureContext): RenderSnapshot["rooms"] {
  const base = BASE_SMOKE[ctx.step];
  return ctx.prior.rooms.map(room => ({
    id: room.id,
    smokeExtinctionPerM: (base[room.id] ?? 0) + (ctx.smoke[room.id] ?? 0),
    temperatureC: room.id === "room-u-hall" ? 40 + HEAT_KW[ctx.step] * 1.4 : 22 + (base[room.id] ?? 0) * 60,
  }));
}

function actuators(ctx: FixtureContext): ActuatorCommand[] {
  if (ctx.step === "spraying") return [{ kind: "water", proposalId: FIXTURE_IDS.sprayProposal, flowLps: 0.2, volumeL: 0.002, aimPoint: SPRAY_AIM }];
  if (ctx.step === "guiding") return [{ kind: "light_cue", proposalId: FIXTURE_IDS.guideProposal, target: STAIR_TOP }];
  return [];
}

/** The fixture's illustrative world state for the current step. */
export function fixtureRender(ctx: FixtureContext): RenderSnapshot {
  const pose = DRONE_POSE[ctx.step];
  const broken = atOrAfter(ctx.step, "spray_pending");
  return {
    label: "simulation_truth_for_rendering",
    tick: STEP_TICK[ctx.step],
    drone: { position: pose.position, yawRad: pose.yawRad, velocity: vec3(0, 0, 0) },
    occupants: occupants(ctx),
    fires: [{ id: FIXTURE_IDS.fire, region: { kind: "box", min: FIRE_BOX.min, max: FIRE_BOX.max }, heatReleaseKW: HEAT_KW[ctx.step], extinguished: ctx.step === "guiding" }],
    rooms: rooms(ctx),
    openings: [{ id: FIXTURE_IDS.window, state: broken ? "broken" : "closed" }, { id: "door-front", state: ctx.step === "guiding" ? "open" : "closed" }],
    removedColliderIds: broken ? [FIXTURE_IDS.windowCollider] : [],
    addedColliders: ctx.obstructions,
    cues: {
      light: ctx.step === "guiding" ? { origin: pose.position, target: STAIR_TOP } : null,
      audioTemplateId: ctx.step === "guiding" ? "follow-light" : null,
    },
    actuators: actuators(ctx),
    // The fixture models no true jet geometry; the twin falls back to drawing toward the commanded aim.
    waterJet: null,
  };
}
