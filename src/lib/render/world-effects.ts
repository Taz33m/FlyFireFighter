/**
 * Physical effects from the RenderSnapshot: fire, water jet, the guidance light and experiment
 * obstacles. These are part of the simulated world, so the drone camera sees them (through the same
 * smoke). Only the light-cue beam drawn for command is presentation-only.
 *
 * Flame height follows Heskestad's correlation L = 0.235 Q^(2/5) − 1.02 D (Q in kW, D in m), clamped to
 * a visible range: a display scaling of heatReleaseKW, not a fire model. Extinguished fires are hidden.
 */
import type { Object3D } from "three";
import { AdditiveBlending, BoxGeometry, ConeGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, MeshLambertMaterial, PointLight, SpotLight, Vector3 } from "three";
import type { ActuatorCommand } from "../contracts/actions.ts";
import { regionBounds } from "../contracts/geometry.ts";
import type { RenderSnapshot } from "../mission/protocol.ts";
import type { MaterialLibrary } from "./material-patch.ts";

const UP = new Vector3(0, 1, 0);
const toRender = (v: { x: number; y: number; z: number }, out = new Vector3()) => out.set(v.x, v.z, -v.y);

export function flameHeightM(heatReleaseKW: number, diameterM: number): number {
  if (!(heatReleaseKW > 0)) return 0;
  return Math.min(3, Math.max(0.15, 0.235 * Math.pow(heatReleaseKW, 0.4) - 1.02 * diameterM));
}

/** Point a +Y-aligned unit mesh from `from` to `to`. */
function span(mesh: Object3D, from: Vector3, to: Vector3): void {
  const dir = new Vector3().subVectors(to, from);
  const length = dir.length();
  mesh.position.copy(from);
  mesh.quaternion.setFromUnitVectors(UP, length > 1e-6 ? dir.divideScalar(length) : UP);
  mesh.scale.set(1, Math.max(length, 1e-3), 1);
}

interface Flame {
  readonly group: Group;
  readonly outer: Mesh;
  readonly core: Mesh;
}

export class WorldEffects {
  readonly physical = new Group();
  readonly presentation = new Group();
  private readonly flames = new Map<string, Flame>();
  private readonly flameGeometry = new ConeGeometry(1, 1, 20, 1, true).translate(0, 0.5, 0);
  private readonly outerMaterial = new MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.75, blending: AdditiveBlending, depthWrite: false });
  private readonly coreMaterial = new MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false });
  private readonly fireLight = new PointLight(0xff8a3c, 0, 9, 2);
  private readonly jet: Mesh;
  private readonly spot = new SpotLight(0xfff1c9, 0, 30, 0.2, 0.45, 1.5);
  private readonly beam: Mesh;
  private readonly obstacles = new Map<string, Mesh>();
  private readonly boxGeometry = new BoxGeometry(1, 1, 1);
  private readonly obstacleMaterial = new MeshLambertMaterial({ color: 0xe0703c });
  private readonly jetGeometry = new CylinderGeometry(0.012, 0.06, 1, 10, 1, true).translate(0, 0.5, 0);
  /** Lit, so the stream is only as bright as the light falling on it (an unlit jet would glow in smoke). */
  private readonly jetMaterial = new MeshLambertMaterial({ color: 0xdcecf5, transparent: true, opacity: 0.55, depthWrite: false });
  private readonly beamGeometry = new CylinderGeometry(0.02, 0.6, 1, 16, 1, true).translate(0, 0.5, 0);
  private readonly beamMaterial = new MeshBasicMaterial({ color: 0xfff1c9, transparent: true, opacity: 0.12, blending: AdditiveBlending, depthWrite: false });

  constructor(library: MaterialLibrary) {
    this.physical.name = "effects";
    this.presentation.name = "effects-presentation";
    library.patch(this.outerMaterial, { smoke: "attenuate" });
    library.patch(this.coreMaterial, { smoke: "attenuate" });
    library.patch(this.jetMaterial);
    library.patch(this.obstacleMaterial, { detail: "stone" });
    library.patch(this.beamMaterial, { smoke: "attenuate" });
    this.jet = new Mesh(this.jetGeometry, this.jetMaterial);
    this.jet.visible = false;
    this.beam = new Mesh(this.beamGeometry, this.beamMaterial);
    this.beam.visible = false;
    this.physical.add(this.fireLight, this.jet, this.spot, this.spot.target);
    this.presentation.add(this.beam);
  }

  private flame(id: string): Flame {
    const existing = this.flames.get(id);
    if (existing !== undefined) return existing;
    const group = new Group();
    const outer = new Mesh(this.flameGeometry, this.outerMaterial);
    const core = new Mesh(this.flameGeometry, this.coreMaterial);
    group.add(outer, core);
    group.name = `fire-${id}`;
    this.physical.add(group);
    const created = { group, outer, core };
    this.flames.set(id, created);
    return created;
  }

  private updateFires(snapshot: RenderSnapshot | null, timeS: number, animate: boolean): void {
    const live = new Set<string>();
    let strongest: { kw: number; at: Vector3 } | null = null;
    for (const fire of snapshot?.fires ?? []) {
      const visible = !fire.extinguished && fire.heatReleaseKW > 0;
      const flame = this.flame(fire.id);
      flame.group.visible = visible;
      live.add(fire.id);
      if (!visible) continue;
      const b = regionBounds(fire.region);
      const diameter = Math.max(0.2, Math.max(b.max.x - b.min.x, b.max.y - b.min.y));
      const height = flameHeightM(fire.heatReleaseKW, diameter);
      const flicker = animate ? 1 + 0.08 * Math.sin(timeS * 13 + fire.id.length) : 1;
      toRender({ x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: b.min.z }, flame.group.position);
      flame.outer.scale.set(diameter / 2, height * flicker, diameter / 2);
      flame.core.scale.set(diameter / 4, height * 0.6 * flicker, diameter / 4);
      if (strongest === null || fire.heatReleaseKW > strongest.kw) strongest = { kw: fire.heatReleaseKW, at: flame.group.position.clone().add(new Vector3(0, height / 2, 0)) };
    }
    for (const [id, flame] of this.flames) {
      if (live.has(id)) continue;
      flame.group.removeFromParent(); // Shared geometry and materials: nothing to dispose here.
      this.flames.delete(id);
    }
    this.fireLight.intensity = strongest === null ? 0 : 0.06 * strongest.kw;
    if (strongest !== null) this.fireLight.position.copy(strongest.at);
  }

  private updateJet(snapshot: RenderSnapshot | null): void {
    const water = snapshot?.actuators.find((a): a is Extract<ActuatorCommand, { kind: "water" }> => a.kind === "water") ?? null;
    this.jet.visible = water !== null && snapshot !== null;
    if (water === null || snapshot === null) return;
    // Drawn from the true nozzle toward the commanded aim point (see the protocol note on actual jet direction).
    const yaw = snapshot.drone.yawRad;
    const nozzle = toRender({ x: snapshot.drone.position.x + 0.16 * Math.cos(yaw), y: snapshot.drone.position.y + 0.16 * Math.sin(yaw), z: snapshot.drone.position.z - 0.06 });
    span(this.jet, nozzle, toRender(water.aimPoint));
  }

  private updateCue(snapshot: RenderSnapshot | null): void {
    const light = snapshot?.cues.light ?? null;
    this.spot.intensity = light === null ? 0 : 30;
    this.beam.visible = light !== null;
    if (light === null) return;
    const origin = toRender(light.origin);
    const target = toRender(light.target);
    this.spot.position.copy(origin);
    this.spot.target.position.copy(target);
    this.spot.target.updateMatrixWorld();
    span(this.beam, origin, target);
  }

  private updateObstacles(snapshot: RenderSnapshot | null): void {
    const live = new Set<string>();
    for (const added of snapshot?.addedColliders ?? []) {
      live.add(added.id);
      let mesh = this.obstacles.get(added.id);
      if (mesh === undefined) {
        mesh = new Mesh(this.boxGeometry, this.obstacleMaterial);
        mesh.name = `obstacle-${added.id}`;
        this.physical.add(mesh);
        this.obstacles.set(added.id, mesh);
      }
      toRender({ x: (added.min.x + added.max.x) / 2, y: (added.min.y + added.max.y) / 2, z: (added.min.z + added.max.z) / 2 }, mesh.position);
      mesh.scale.set(Math.max(0.02, added.max.x - added.min.x), Math.max(0.02, added.max.z - added.min.z), Math.max(0.02, added.max.y - added.min.y));
      mesh.visible = true;
    }
    for (const [id, mesh] of this.obstacles) {
      if (live.has(id)) continue;
      mesh.removeFromParent();
      this.obstacles.delete(id);
    }
  }

  update(snapshot: RenderSnapshot | null, timeS: number, animate: boolean): void {
    this.updateFires(snapshot, timeS, animate);
    this.updateJet(snapshot);
    this.updateCue(snapshot);
    this.updateObstacles(snapshot);
  }

  dispose(): void {
    for (const resource of [this.flameGeometry, this.outerMaterial, this.coreMaterial, this.jetGeometry, this.jetMaterial, this.beamGeometry, this.beamMaterial, this.boxGeometry, this.obstacleMaterial]) resource.dispose();
    this.fireLight.dispose();
    this.spot.dispose();
    this.physical.removeFromParent();
    this.presentation.removeFromParent();
    this.flames.clear();
    this.obstacles.clear();
  }
}
