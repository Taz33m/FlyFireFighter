/**
 * Failure injections for paired runs. Each injector watches the run from OUTSIDE (it is the operator or
 * judge, not the planner) and issues ordinary protocol `experiment` commands through MissionRuntime.command,
 * so the world changes at a tick boundary and planners learn of it only through normal sensing. Injectors
 * may read simulation truth to place a change (where the aircraft really is, which window is broken);
 * nothing they read flows into the run except the experiment itself.
 *
 * - stale_evidence: the judge challenge. When a spray proposal first awaits approval, a mobile person is
 *   placed on the floor under the line from the spray standoff to the aim point (inside a room), i.e. in the
 *   pending spray region. The approval the commander is about to give was shown evidence without them.
 * - localization_loss: localization uncertainty +3 m at tick LOCALIZATION_LOSS_TICK.
 * - blocked_return: at evaluator arrival (or the first return proposal, if earlier), every exterior opening
 *   that is broken or open is boxed in, so the aircraft's way out is blocked. Applied only once no box would
 *   contain the aircraft; whether it was still inside (so the block mattered) is recorded.
 * - payload_exhaustion: configured through the runtime's initial water option (runner.ts), not here.
 */
import type { Vec3 } from "../../contracts/frames.ts";
import { vec3 } from "../../contracts/frames.ts";
import { regionContains } from "../../contracts/geometry.ts";
import type { Experiment } from "../../mission/protocol.ts";
import type { MissionRuntime } from "../../mission/runtime.ts";
import { EXTERIOR, spaceOf } from "../../mission/steering-graph.ts";
import { roomAt } from "../../simulation/scene.ts";
import type { RuntimeOpening } from "../../simulation/world-state.ts";
import type { InjectionKind } from "./conditions.ts";

export const LOCALIZATION_LOSS_TICK = 1200;
export const LOCALIZATION_LOSS_SIGMA_M = 3;
const BLOCK_DEPTH_M = 0.2;
const BLOCK_MARGIN_M = 0.05;
const AIRCRAFT_CLEARANCE_M = 0.4;
/** Proposal records are polled every few ticks (the commander answers 300 ticks after a proposal waits). */
const CHECK_PERIOD_TICKS = 5;
/** Fractions along standoff → aim point tried for the judge's person, nearest the middle first. */
const SPRAY_FRACTIONS = [0.5, 0.6, 0.4, 0.7, 0.3, 0.8];

export interface InjectionRecord {
  readonly kind: InjectionKind;
  readonly applied: boolean;
  readonly tick: number | null;
  readonly detail: string;
  /** Whether the change could matter when applied (e.g. the aircraft was still inside); null if not judged. */
  readonly effective: boolean | null;
  readonly experiments: readonly Experiment[];
}

export interface Injector {
  readonly kind: InjectionKind;
  /** Called after every advanced step. */
  afterStep(runtime: MissionRuntime): void;
  record(): InjectionRecord;
}

class BaseInjector {
  protected applied = false;
  protected tick: number | null = null;
  protected detail: string;
  protected effective: boolean | null = null;
  protected readonly experiments: Experiment[] = [];
  readonly kind: InjectionKind;

  constructor(kind: InjectionKind, pending: string) {
    this.kind = kind;
    this.detail = pending;
  }

  protected issue(runtime: MissionRuntime, experiment: Experiment): void {
    runtime.command({ type: "experiment", runId: runtime.runId, experiment });
    this.experiments.push(experiment);
  }

  record(): InjectionRecord {
    return { kind: this.kind, applied: this.applied, tick: this.tick, detail: this.detail, effective: this.effective, experiments: [...this.experiments] };
  }
}

class StaleEvidenceInjector extends BaseInjector {
  constructor() {
    super("stale_evidence", "Not applied: no spray proposal ever awaited approval.");
  }

  afterStep(runtime: MissionRuntime): void {
    if (this.applied || runtime.world.tick % CHECK_PERIOD_TICKS !== 0) return;
    const record = runtime.harness.records().find(r => r.status === "awaiting_approval" && r.proposal.action.kind === "spray");
    if (!record || record.proposal.action.kind !== "spray") return;
    const { standoff, aimPoint } = record.proposal.action;
    const region = runtime.view().affectedRegions.find(a => a.proposalId === record.proposal.id)?.region ?? null;
    const floors = runtime.meta.floors.map(f => f.elevationM);
    for (const fraction of SPRAY_FRACTIONS) {
      const along = lerp(standoff, aimPoint, fraction);
      const floor = Math.max(...floors.filter(z => z <= along.z + 0.05), Math.min(...floors));
      const feet = vec3(along.x, along.y, floor);
      if (roomAt(runtime.preset.scene, vec3(feet.x, feet.y, floor + 0.5), 0) === null) continue;
      const inRegion = region === null ? null : [0.5, 1.0, 1.5].some(h => regionContains(region, vec3(feet.x, feet.y, floor + h)));
      this.issue(runtime, { kind: "add_occupant", position: feet });
      this.applied = true;
      this.tick = runtime.world.tick;
      this.effective = inRegion;
      this.detail = `Person placed at (${fmt(feet)}) while spray ${record.proposal.id} awaited approval${inRegion === null ? "" : inRegion ? " (inside its harness-derived affected region)" : " (on the spray line but outside the harness-derived affected region)"}.`;
      return;
    }
    this.applied = true;
    this.tick = runtime.world.tick;
    this.effective = false;
    this.detail = `Not applied: no point on the spray line of ${record.proposal.id} lies inside a room.`;
  }
}

class LocalizationLossInjector extends BaseInjector {
  constructor() {
    super("localization_loss", `Not applied: the run ended before tick ${LOCALIZATION_LOSS_TICK}.`);
  }

  afterStep(runtime: MissionRuntime): void {
    if (this.applied || runtime.world.tick < LOCALIZATION_LOSS_TICK) return;
    this.issue(runtime, { kind: "degrade_localization", sigmaIncreaseM: LOCALIZATION_LOSS_SIGMA_M });
    this.applied = true;
    this.tick = runtime.world.tick;
    this.effective = true;
    this.detail = `Localization uncertainty increased by ${LOCALIZATION_LOSS_SIGMA_M} m at tick ${this.tick}.`;
  }
}

class BlockedReturnInjector extends BaseInjector {
  private armedAt: number | null = null;
  private seenSeq = 0;

  constructor() {
    super("blocked_return", "Not applied: neither evaluator arrival nor a return proposal occurred.");
  }

  afterStep(runtime: MissionRuntime): void {
    if (this.applied) return;
    if (this.armedAt === null) {
      const fresh = runtime.log.since(this.seenSeq);
      this.seenSeq = runtime.log.length;
      const arrived = fresh.some(e => e.kind === "evaluator.occupant_arrived");
      if (!arrived && runtime.world.tick % CHECK_PERIOD_TICKS !== 0) return;
      const returning = runtime.harness.records().some(r => r.proposal.action.kind === "return");
      if (!arrived && !returning) return;
      this.armedAt = runtime.world.tick;
    }
    const drone = runtime.world.drone.position;
    const boxes = exteriorOpeningsOpen(runtime).map(o => ({ opening: o, ...openingBox(o) }));
    if (boxes.some(b => inside(drone, b.min, b.max, AIRCRAFT_CLEARANCE_M))) return; // wait until the aircraft is clear of every opening
    const indoors = spaceOf(runtime.preset.prior, drone) !== EXTERIOR;
    for (const b of boxes) this.issue(runtime, { kind: "add_obstruction", min: b.min, max: b.max });
    this.applied = true;
    this.tick = runtime.world.tick;
    this.effective = indoors && boxes.length > 0;
    this.detail = boxes.length === 0
      ? "Armed but nothing to block: no exterior opening was open or broken."
      : `Blocked ${boxes.map(b => b.opening.id).join(", ")} (armed at tick ${this.armedAt}); the aircraft was ${indoors ? "inside" : "already outside"}.`;
  }
}

/** Openings between a room and the exterior whose world state lets the aircraft through. */
function exteriorOpeningsOpen(runtime: MissionRuntime): RuntimeOpening[] {
  const states = new Map(runtime.world.openings.map(o => [o.id, o.state]));
  return runtime.preset.scene.openings.filter(o => o.rooms.includes(EXTERIOR) && (states.get(o.id) === "broken" || states.get(o.id) === "open"));
}

/** A thin box filling the opening's aperture. */
export function openingBox(o: RuntimeOpening): { readonly min: Vec3; readonly max: Vec3 } {
  const n = o.outwardNormal;
  const halfW = o.widthM / 2 + BLOCK_MARGIN_M;
  const halfH = o.heightM / 2 + BLOCK_MARGIN_M;
  const hx = Math.abs(n.x) > Math.abs(n.y) ? BLOCK_DEPTH_M : halfW;
  const hy = Math.abs(n.x) > Math.abs(n.y) ? halfW : BLOCK_DEPTH_M;
  return { min: vec3(o.center.x - hx, o.center.y - hy, o.center.z - halfH), max: vec3(o.center.x + hx, o.center.y + hy, o.center.z + halfH) };
}

function inside(p: Vec3, min: Vec3, max: Vec3, margin: number): boolean {
  return p.x >= min.x - margin && p.x <= max.x + margin && p.y >= min.y - margin && p.y <= max.y + margin && p.z >= min.z - margin && p.z <= max.z + margin;
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
}

function fmt(v: Vec3): string {
  return [v.x, v.y, v.z].map(n => n.toFixed(2)).join(", ");
}

/** The injector for a condition's injection; payload exhaustion has none (it is a runtime option). */
export function createInjector(kind: InjectionKind | null): Injector | null {
  switch (kind) {
    case "stale_evidence":
      return new StaleEvidenceInjector();
    case "localization_loss":
      return new LocalizationLossInjector();
    case "blocked_return":
      return new BlockedReturnInjector();
    case "payload_exhaustion":
    case null:
      return null;
  }
}
