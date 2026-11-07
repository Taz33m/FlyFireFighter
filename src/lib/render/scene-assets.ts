/**
 * Static scene for the twin and the drone camera: the Blender export (scene.glb) when present, and a box
 * view built from scene.meta.json colliders that is always available as a fallback and debug view.
 *
 * glTF is already in the render frame (Y up; gltf (x, y, z) = world (x, z, -y)); collider boxes are in
 * the world frame and converted here. Glass panes and door leaves are found by their `openingId` extras
 * (or `<openingId>_glass` / `_leaf` names) so opening states and removed colliders can hide them.
 */
import type { Material, Object3D, Plane } from "three";
import { BoxGeometry, Group, Mesh, MeshLambertMaterial } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { ColliderKind, SceneMetaJson } from "../contracts/scene.ts";
import { SCENE_META_SCHEMA } from "../contracts/scene.ts";
import type { RenderSnapshot } from "../mission/protocol.ts";
import { disposeObject } from "./dispose.ts";
import type { MaterialLibrary } from "./material-patch.ts";
import type { DetailClass } from "./procedural-textures.ts";
import { classifyMaterial } from "./procedural-textures.ts";

export type AssetState = "loading" | "loaded" | "missing" | "error";
export type StaticView = "scene" | "colliders";

const COLLIDER_COLORS: Readonly<Record<ColliderKind, number>> = {
  ground: 0x3c4a40, wall: 0xc9c2b4, floor: 0x8b7355, ceiling: 0xd9d4c7, roof: 0x6b4f3f, stair: 0x9a8060,
  furniture: 0x7d8c99, glass: 0x8fc7d6, door: 0x7b5a3c, tree: 0x3f6b3a, street_furniture: 0x5a5f5c,
};
const COLLIDER_DETAIL: Readonly<Record<ColliderKind, DetailClass | null>> = {
  ground: "stone", wall: "plaster", floor: "wood", ceiling: "plaster", roof: "roof", stair: "wood",
  furniture: "fabric", glass: null, door: "wood", tree: "foliage", street_furniture: "stone",
};
const CUTAWAY_KINDS: ReadonlySet<ColliderKind> = new Set<ColliderKind>(["wall", "roof", "ceiling", "glass", "door", "floor", "stair", "furniture"]);
const OUTDOOR_PREFIXES = ["tree", "conifer", "ext_ground", "ext_shrubs", "ext_street_furniture"];

interface OpeningNodes {
  readonly glass: Object3D[];
  readonly leaf: Object3D[];
}

function topLevelName(object: Object3D, root: Object3D): string {
  let node = object;
  while (node.parent !== null && node.parent !== root) node = node.parent;
  return node.name;
}

/** Breakable panes and door leaves: glTF extras first, then the `<openingId>_glass` / `_leaf` node names. */
function openingRole(object: Object3D): { readonly openingId: string; readonly role: "glass" | "leaf" } | null {
  const data = object.userData as { openingId?: unknown; role?: unknown };
  if (typeof data.openingId === "string" && (data.role === "glass" || data.role === "leaf")) return { openingId: data.openingId, role: data.role };
  const match = /^(.+)_(glass|leaf)$/.exec(object.name);
  return match === null ? null : { openingId: match[1], role: match[2] as "glass" | "leaf" };
}

function materialsOf(mesh: Mesh): Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

export class SceneAssets {
  readonly root = new Group();
  meta: SceneMetaJson | null = null;
  glb: Object3D | null = null;
  colliders: Group | null = null;
  droneTemplate: Object3D | null = null;
  status: { meta: AssetState; glb: AssetState; message: string | null } = { meta: "loading", glb: "loading", message: null };
  private readonly openings = new Map<string, OpeningNodes>();
  private readonly colliderMeshes = new Map<string, Mesh>();
  private readonly colliderOpening = new Map<string, string>();
  private readonly materials: MaterialLibrary;
  private readonly clipPlanes: Plane[];
  private view: StaticView = "scene";
  private disposed = false;

  constructor(materials: MaterialLibrary, clipPlanes: Plane[]) {
    this.materials = materials;
    this.clipPlanes = clipPlanes;
    this.root.name = "static-scene";
  }

  async load(baseUrl: string, onChange: () => void): Promise<void> {
    await this.loadMeta(baseUrl);
    if (this.disposed) return;
    onChange();
    await this.loadGlb(baseUrl);
    if (!this.disposed) onChange();
  }

  private async loadMeta(baseUrl: string): Promise<void> {
    try {
      const response = await fetch(`${baseUrl}scene.meta.json`);
      if (!response.ok) {
        this.status = { ...this.status, meta: response.status === 404 ? "missing" : "error", message: `scene.meta.json: HTTP ${response.status}` };
        return;
      }
      const meta = (await response.json()) as SceneMetaJson;
      if (meta.schema !== SCENE_META_SCHEMA) throw new Error(`unexpected schema ${String(meta.schema)}`);
      if (this.disposed) return;
      this.meta = meta;
      this.materials.smoke.setRooms(meta.rooms);
      for (const c of meta.colliders) if (c.openingId !== undefined) this.colliderOpening.set(c.id, c.openingId);
      this.colliders = this.buildColliders(meta);
      this.root.add(this.colliders);
      this.status = { ...this.status, meta: "loaded" };
    } catch (error) {
      this.status = { ...this.status, meta: "error", message: `scene.meta.json: ${error instanceof Error ? error.message : String(error)}` };
    }
    this.applyView();
  }

  private buildColliders(meta: SceneMetaJson): Group {
    const group = new Group();
    group.name = "collider-view";
    const geometry = new BoxGeometry(1, 1, 1);
    const materials = new Map<ColliderKind, MeshLambertMaterial>();
    for (const c of meta.colliders) {
      let material = materials.get(c.kind);
      if (material === undefined) {
        const glass = c.kind === "glass";
        material = new MeshLambertMaterial({ color: COLLIDER_COLORS[c.kind], transparent: glass, opacity: glass ? 0.35 : 1, depthWrite: !glass });
        if (CUTAWAY_KINDS.has(c.kind)) material.clippingPlanes = this.clipPlanes;
        this.materials.patch(material, { detail: COLLIDER_DETAIL[c.kind] });
        materials.set(c.kind, material);
      }
      const mesh = new Mesh(geometry, material);
      const [x0, y0, z0] = c.min;
      const [x1, y1, z1] = c.max;
      mesh.position.set((x0 + x1) / 2, (z0 + z1) / 2, -(y0 + y1) / 2);
      mesh.scale.set(Math.max(x1 - x0, 0.01), Math.max(z1 - z0, 0.01), Math.max(y1 - y0, 0.01));
      mesh.name = c.id;
      mesh.castShadow = c.kind !== "ground" && c.kind !== "glass";
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      group.add(mesh);
      this.colliderMeshes.set(c.id, mesh);
    }
    return group;
  }

  private async loadGlb(baseUrl: string): Promise<void> {
    try {
      const gltf = await new GLTFLoader().loadAsync(`${baseUrl}scene.glb`);
      if (this.disposed) {
        disposeObject(gltf.scene);
        return;
      }
      this.adoptGlb(gltf.scene);
      this.status = { ...this.status, glb: "loaded" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status = { ...this.status, glb: /\b404\b/.test(message) ? "missing" : "error", message: `scene.glb: ${message}` };
    }
    this.applyView();
  }

  private adoptGlb(scene: Group): void {
    const drone = scene.getObjectByName("drone") ?? null;
    if (drone !== null) {
      drone.removeFromParent();
      drone.position.set(0, 0, 0);
      drone.quaternion.identity();
      this.droneTemplate = drone;
    }
    const outdoor = new Set<Material>();
    const indoorMeshes: Mesh[] = [];
    scene.traverse(object => {
      const opening = openingRole(object);
      if (opening !== null) this.indexOpening(opening.openingId, opening.role, object);
      if (!(object as Mesh).isMesh) return;
      const mesh = object as Mesh;
      const isOutdoor = OUTDOOR_PREFIXES.some(prefix => topLevelName(mesh, scene).startsWith(prefix));
      mesh.receiveShadow = true;
      mesh.castShadow = !materialsOf(mesh).some(m => m.transparent);
      if (isOutdoor) materialsOf(mesh).forEach(m => outdoor.add(m));
      else indoorMeshes.push(mesh);
    });
    // Building materials get the cutaway plane; clone any material that outdoor meshes also use.
    const clones = new Map<Material, Material>();
    for (const mesh of indoorMeshes) {
      const swap = (m: Material) => {
        if (!outdoor.has(m)) return m;
        const clone = clones.get(m) ?? m.clone();
        clones.set(m, clone);
        return clone;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
      materialsOf(mesh).forEach(m => { m.clippingPlanes = this.clipPlanes; });
    }
    scene.traverse(object => {
      if ((object as Mesh).isMesh) materialsOf(object as Mesh).forEach(m => this.materials.patch(m, { detail: classifyMaterial(m.name) }));
    });
    this.glb = scene;
    this.root.add(scene);
  }

  private indexOpening(openingId: string, role: "glass" | "leaf", object: Object3D): void {
    const entry = this.openings.get(openingId) ?? { glass: [], leaf: [] };
    entry[role].push(object);
    this.openings.set(openingId, entry);
  }

  /** "colliders" shows the metadata boxes; "scene" shows the GLB, falling back to boxes when it is absent. */
  setView(view: StaticView): void {
    this.view = view;
    this.applyView();
  }

  private applyView(): void {
    const showGlb = this.view === "scene" && this.glb !== null;
    if (this.glb !== null) this.glb.visible = showGlb;
    if (this.colliders !== null) this.colliders.visible = !showGlb;
  }

  /** Hide broken glass, open door leaves and removed colliders according to the snapshot. */
  applyOpenings(snapshot: RenderSnapshot | null): void {
    const removed = new Set(snapshot?.removedColliderIds ?? []);
    const removedOpenings = new Set([...removed].flatMap(id => this.colliderOpening.get(id) ?? []));
    const states = new Map((snapshot?.openings ?? []).map(o => [o.id, o.state]));
    for (const [openingId, nodes] of this.openings) {
      const state = states.get(openingId);
      const gone = removedOpenings.has(openingId);
      nodes.glass.forEach(n => { n.visible = !gone && state !== "broken" && state !== "open"; });
      nodes.leaf.forEach(n => { n.visible = !gone && state !== "open" && state !== "broken"; });
    }
    for (const [id, mesh] of this.colliderMeshes) mesh.visible = !removed.has(id);
  }

  dispose(): void {
    this.disposed = true;
    if (this.droneTemplate !== null) disposeObject(this.droneTemplate);
    disposeObject(this.root);
    this.openings.clear();
    this.colliderMeshes.clear();
  }
}
