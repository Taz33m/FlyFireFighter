/**
 * Drone and occupant actors drawn from the privileged RenderSnapshot.
 *
 * The drone uses the Blender export's aircraft model when available (its local +X is body forward, +Y
 * up), otherwise a simple quadcopter built here. Occupants use the rigged character from
 * public/actors/occupant.glb (a scanned character, Mike Alger, CC BY 4.0, with Rocketbox animations, MIT;
 * a fictional person), with a labelled placeholder figure while it loads or if it fails. Figures are
 * physical in the simulation, so the drone camera sees them only where geometry and smoke allow. Yaw ψ about world +Z is a rotation by ψ about
 * render +Y, and world (x, y, z) maps to render (x, z, -y).
 */
import type { Material, Object3D } from "three";
import { BoxGeometry, CapsuleGeometry, CylinderGeometry, Group, Mesh, MeshLambertMaterial, SphereGeometry, Vector3 } from "three";
import type { RenderSnapshot } from "../mission/protocol.ts";
import { disposeObject } from "./dispose.ts";
import type { MaterialLibrary } from "./material-patch.ts";
import { CharacterInstance, CharacterTemplate, OCCUPANT_GLB_URL } from "./occupant-character.ts";

const toRender = (v: { x: number; y: number; z: number }, out: Vector3) => out.set(v.x, v.z, -v.y);

function patchTree(root: Object3D, library: MaterialLibrary): void {
  root.traverse(object => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    const materials: Material[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach(m => library.patch(m));
    mesh.castShadow = false;
  });
}

/** A small quadcopter in body axes (X forward, Y up in render-local terms), about 0.55 m span. */
function buildQuad(): Group {
  const quad = new Group();
  const body = new MeshLambertMaterial({ color: 0x2b3530 });
  const accent = new MeshLambertMaterial({ color: 0xd2f484 });
  quad.add(new Mesh(new BoxGeometry(0.22, 0.07, 0.16), body));
  const arm = new BoxGeometry(0.36, 0.02, 0.025);
  const rotor = new CylinderGeometry(0.1, 0.1, 0.008, 24);
  for (const angle of [Math.PI / 4, -Math.PI / 4]) {
    const mesh = new Mesh(arm, body);
    mesh.rotation.y = angle;
    quad.add(mesh);
  }
  for (const [x, z] of [[0.13, 0.13], [0.13, -0.13], [-0.13, 0.13], [-0.13, -0.13]]) {
    const disc = new Mesh(rotor, accent);
    disc.position.set(x, 0.035, z);
    disc.name = "drone-prop";
    quad.add(disc);
  }
  const lens = new Mesh(new SphereGeometry(0.025, 12, 8), accent);
  lens.position.set(0.12, 0.01, 0);
  quad.add(lens);
  quad.name = "drone-quad";
  return quad;
}

export class DroneActor {
  readonly object = new Group();
  private model: Object3D;
  /** The built quad owns its GPU resources; a template clone shares them with SceneAssets. */
  private ownsModel = true;
  private readonly library: MaterialLibrary;
  private props: Object3D[] = [];

  constructor(library: MaterialLibrary) {
    this.library = library;
    this.object.name = "drone";
    this.model = buildQuad();
    patchTree(this.model, library);
    this.object.add(this.model);
    this.collectProps();
  }

  /** Swap in the exported aircraft model (cloned; the template stays owned by SceneAssets). */
  useTemplate(template: Object3D): void {
    if (this.ownsModel) disposeObject(this.model);
    else this.model.removeFromParent();
    this.ownsModel = false;
    this.model = template.clone(true);
    patchTree(this.model, this.library);
    this.object.add(this.model);
    this.collectProps();
  }

  private collectProps(): void {
    this.props = [];
    this.model.traverse(o => {
      if (o.name.startsWith("drone-prop")) this.props.push(o);
    });
  }

  update(snapshot: RenderSnapshot | null, timeS: number, animate: boolean): void {
    this.object.visible = snapshot !== null;
    if (snapshot === null) return;
    toRender(snapshot.drone.position, this.object.position);
    this.object.rotation.set(0, snapshot.drone.yawRad, 0);
    const spin = animate ? timeS * 60 : 0;
    this.props.forEach((p, i) => { p.rotation.y = i % 2 === 0 ? spin : -spin; });
  }

  dispose(): void {
    if (this.ownsModel) disposeObject(this.model);
    this.object.removeFromParent();
  }
}

type CharacterState = "loading" | "loaded" | "error" | "disabled";

/** The placeholder's stand-in for each animation: squashed crouch, walking bob, cough tilt. */
function posePlaceholder(placeholder: Group, animation: string, timeS: number, animate: boolean): void {
  const walking = animation === "walk" || animation === "follow";
  placeholder.scale.set(1, animation === "crouch" ? 0.62 : 1, 1);
  placeholder.position.y = walking && animate ? Math.abs(Math.sin(timeS * 6)) * 0.04 : 0;
  placeholder.rotation.z = animation === "cough" ? 0.12 : 0;
}

/** One occupant: a root at the feet point with the simulator's yaw, holding the character or a placeholder. */
interface Figure {
  readonly root: Group;
  placeholder: Group | null;
  character: CharacterInstance | null;
}

export interface OccupantActorsOptions {
  /** URL of the rigged character GLB; null keeps the labelled placeholder (no network). */
  readonly characterUrl?: string | null;
}

/**
 * Occupants keyed by evaluator key. The rigged character (occupant-character.ts) is used once its GLB
 * has loaded; until then, or if it fails to load, a labelled placeholder capsule (about 1.7 m) stands in.
 * Both are physical scene objects, so the drone camera sees them wherever geometry and smoke allow.
 */
export class OccupantActors {
  readonly object = new Group();
  private readonly figures = new Map<string, Figure>();
  private readonly bodyGeometry = new CapsuleGeometry(0.2, 0.95, 4, 12);
  private readonly headGeometry = new SphereGeometry(0.12, 16, 12);
  private readonly material: MeshLambertMaterial;
  private template: CharacterTemplate | null = null;
  private state: CharacterState = "disabled";
  private lastTimeS: number | null = null;
  private disposed = false;

  constructor(library: MaterialLibrary, options: OccupantActorsOptions = {}) {
    this.object.name = "occupants";
    this.material = new MeshLambertMaterial({ color: 0xd9a441 });
    library.patch(this.material, { detail: "fabric" });
    const url = options.characterUrl === undefined ? OCCUPANT_GLB_URL : options.characterUrl;
    if (url !== null && typeof window !== "undefined") void this.loadCharacter(url, library);
  }

  /** "loaded" once the rigged character replaced the placeholder; "error" means the placeholder stays. */
  get characterState(): CharacterState {
    return this.state;
  }

  /** Label detail when the rendered figure is a placeholder. */
  get labelDetail(): string | null {
    if (this.state === "loaded") return null;
    if (this.state === "loading") return "Placeholder figure while the character loads";
    if (this.state === "error") return "Placeholder figure; character asset failed to load";
    return "Placeholder figure; character asset not loaded";
  }

  private async loadCharacter(url: string, library: MaterialLibrary): Promise<void> {
    this.state = "loading";
    try {
      const template = await CharacterTemplate.load(url, library);
      if (this.disposed) {
        template.dispose();
        return;
      }
      this.template = template;
      this.state = "loaded";
    } catch (error) {
      if (this.disposed) return;
      this.state = "error";
      console.warn(`Occupant character unavailable, using the placeholder: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private buildPlaceholder(): Group {
    const group = new Group();
    const body = new Mesh(this.bodyGeometry, this.material);
    body.position.y = 0.2 + 0.475;
    const head = new Mesh(this.headGeometry, this.material);
    head.position.y = 1.55;
    group.add(body, head);
    group.name = "occupant-placeholder";
    return group;
  }

  private figure(key: string): Figure {
    let figure = this.figures.get(key);
    if (figure === undefined) {
      const root = new Group();
      root.name = `occupant-${key}`;
      this.object.add(root);
      figure = { root, placeholder: null, character: null };
      this.figures.set(key, figure);
    }
    if (this.template !== null && figure.character === null) {
      figure.placeholder?.removeFromParent(); // Shared geometry and material: nothing to dispose.
      figure.placeholder = null;
      figure.character = new CharacterInstance(this.template);
      figure.root.add(figure.character.object);
    } else if (figure.character === null && figure.placeholder === null) {
      figure.placeholder = this.buildPlaceholder();
      figure.root.add(figure.placeholder);
    }
    return figure;
  }

  /**
   * `animate` false (drone-camera captures, reduced motion) gives a pose that depends only on the
   * snapshot; display frames advance clips by the wall-clock step between calls.
   */
  update(snapshot: RenderSnapshot | null, timeS: number, animate: boolean): void {
    const dtS = animate ? this.step(timeS) : 0;
    const live = new Set<string>();
    for (const occupant of snapshot?.occupants ?? []) {
      live.add(occupant.key);
      const figure = this.figure(occupant.key);
      toRender(occupant.position, figure.root.position);
      figure.root.rotation.set(0, occupant.yawRad, 0);
      figure.root.visible = true;
      if (figure.character !== null) figure.character.update(occupant, snapshot?.tick ?? 0, dtS, animate);
      if (figure.placeholder !== null) posePlaceholder(figure.placeholder, occupant.animation, timeS, animate);
    }
    for (const [key, figure] of this.figures) {
      if (live.has(key)) continue;
      this.removeFigure(figure);
      this.figures.delete(key);
    }
  }

  /** Wall-clock step since the previous animated frame, bounded so a stalled tab does not jump. */
  private step(timeS: number): number {
    const dtS = this.lastTimeS === null ? 0 : Math.min(0.25, Math.max(0, timeS - this.lastTimeS));
    this.lastTimeS = timeS;
    return dtS;
  }

  private removeFigure(figure: Figure): void {
    figure.character?.dispose();
    figure.root.removeFromParent();
  }

  /** Label anchors (render frame, above the head) for the DOM overlay. */
  anchors(snapshot: RenderSnapshot | null): { readonly key: string; readonly position: Vector3; readonly activity: string; readonly detail: string | null }[] {
    const detail = this.labelDetail;
    return (snapshot?.occupants ?? []).map(o => ({ key: o.key, activity: o.activity, detail, position: toRender(o.position, new Vector3()).add(new Vector3(0, o.animation === "crouch" ? 1.25 : 1.95, 0)) }));
  }

  dispose(): void {
    this.disposed = true;
    for (const figure of this.figures.values()) this.removeFigure(figure);
    this.figures.clear();
    this.template?.dispose();
    this.template = null;
    this.bodyGeometry.dispose();
    this.headGeometry.dispose();
    this.material.dispose();
    this.object.removeFromParent();
  }
}
