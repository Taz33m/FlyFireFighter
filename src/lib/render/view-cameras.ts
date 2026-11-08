/**
 * Presentation cameras for the simulation view: exterior orbit, follow-the-drone and cutaway (a clipping
 * plane through building materials just above the drone's floor). None of this affects the drone camera,
 * which always renders the full geometry from the calibrated mount.
 */
import type { Plane } from "three";
import { PerspectiveCamera, Vector3 } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Vec3 } from "../contracts/frames.ts";
import { pointInPolygon } from "../contracts/geometry.ts";
import type { SceneMetaJson } from "../contracts/scene.ts";
import type { RenderSnapshot } from "../mission/protocol.ts";

export type CameraMode = "exterior" | "follow" | "cutaway";

/**
 * A framing request (camera director, src/components/twin/director.ts) in the WORLD frame, Z up. It moves
 * only the presentation camera, in exterior and cutaway modes; follow ignores it.
 */
export interface CameraFocus {
  readonly point: Vec3;
  /** Radius that should fit in view, m. */
  readonly radiusM: number;
  /** Horizontal direction from the point toward where the exterior camera should stand; null = default bearing. */
  readonly viewFrom: Vec3 | null;
}

/** Clip-plane constant that keeps everything (cutaway off). */
export const NO_CUT = 1e6;
const CUT_ABOVE_FLOOR_M = 1.7;
const EXTERIOR_OFFSET = new Vector3(26, 17, -27);
const CUTAWAY_OFFSET = new Vector3(-4, 21, 15);
/** Elevation of the exterior camera above a focus point when the focus gives a view direction. */
const FOCUS_ELEVATION_RAD = (32 * Math.PI) / 180;
const FOCUS_MIN_DISTANCE_M = 6;
const FOCUS_MAX_DISTANCE_M = 120;

/** Render-frame offset from a focus point for the camera: far enough that a sphere of radiusM fits the vertical FOV. */
export function focusOffset(focus: CameraFocus, mode: "exterior" | "cutaway", verticalFovDeg: number): Vector3 {
  const half = (verticalFovDeg * Math.PI) / 360;
  const distance = Math.min(FOCUS_MAX_DISTANCE_M, Math.max(FOCUS_MIN_DISTANCE_M, (1.1 * focus.radiusM) / Math.sin(half)));
  const from = focus.viewFrom;
  const flat = from === null ? 0 : Math.hypot(from.x, from.y);
  if (mode === "cutaway" || from === null || !(flat > 1e-6)) return (mode === "cutaway" ? CUTAWAY_OFFSET : EXTERIOR_OFFSET).clone().normalize().multiplyScalar(distance);
  const c = Math.cos(FOCUS_ELEVATION_RAD);
  // World (x, y) horizontal -> render (x, -y); elevation along render +Y.
  return new Vector3((from.x / flat) * c, Math.sin(FOCUS_ELEVATION_RAD), (-from.y / flat) * c).multiplyScalar(distance);
}

function sameFocus(a: CameraFocus | null, b: CameraFocus | null): boolean {
  if (a === null || b === null) return a === b;
  const close = (u: Vec3 | null, v: Vec3 | null) => (u === null || v === null ? u === v : Math.abs(u.x - v.x) + Math.abs(u.y - v.y) + Math.abs(u.z - v.z) < 1e-3);
  return close(a.point, b.point) && Math.abs(a.radiusM - b.radiusM) < 1e-3 && close(a.viewFrom, b.viewFrom);
}

const toRender = (v: { x: number; y: number; z: number }, out = new Vector3()) => out.set(v.x, v.z, -v.y);

export class ViewCameras {
  readonly camera = new PerspectiveCamera(42, 16 / 9, 0.1, 400);
  readonly controls: OrbitControls;
  private mode: CameraMode = "exterior";
  private readonly clip: Plane;
  private readonly reducedMotion: boolean;
  private meta: SceneMetaJson | null = null;
  private readonly houseCenter = new Vector3(18.2, 2.5, -3.3);
  private readonly followTarget = new Vector3();
  private focus: CameraFocus | null = null;

  constructor(dom: HTMLElement, clip: Plane, reducedMotion: boolean) {
    this.clip = clip;
    this.reducedMotion = reducedMotion;
    this.controls = new OrbitControls(this.camera, dom);
    this.controls.enableDamping = !reducedMotion;
    this.controls.maxPolarAngle = Math.PI * 0.48;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 140;
    this.setExteriorView();
  }

  setMeta(meta: SceneMetaJson | null): void {
    this.meta = meta;
    if (meta === null || meta.rooms.length === 0) return;
    const xs = meta.rooms.flatMap(r => r.polygon.map(p => p[0]));
    const ys = meta.rooms.flatMap(r => r.polygon.map(p => p[1]));
    toRender({ x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2, z: 2.5 }, this.houseCenter);
    if (this.mode !== "follow") this.setMode(this.mode, true);
  }

  getMode(): CameraMode {
    return this.mode;
  }

  setMode(mode: CameraMode, force = false): void {
    if (mode === this.mode && !force) return;
    this.mode = mode;
    this.controls.enabled = mode !== "follow";
    if (mode === "exterior") this.setExteriorView();
    if (mode === "cutaway") this.setCutawayView();
    if (mode !== "cutaway") this.clip.constant = NO_CUT;
  }

  /**
   * Frame a point and radius in exterior and cutaway modes (a cut, not a tween); null restores the default
   * house views. Follow mode ignores the focus. Re-applies the current view only when the focus changed.
   */
  setFocus(focus: CameraFocus | null): void {
    if (sameFocus(this.focus, focus)) return;
    this.focus = focus;
    if (this.mode !== "follow") this.setMode(this.mode, true);
  }

  private setExteriorView(): void {
    this.placeView("exterior");
  }

  private setCutawayView(): void {
    this.placeView("cutaway");
  }

  private placeView(mode: "exterior" | "cutaway"): void {
    const focus = this.focus;
    if (focus === null) {
      this.controls.target.copy(this.houseCenter);
      this.camera.position.copy(this.houseCenter).add(mode === "exterior" ? EXTERIOR_OFFSET : CUTAWAY_OFFSET);
    } else {
      toRender(focus.point, this.controls.target);
      this.camera.position.copy(this.controls.target).add(focusOffset(focus, mode, this.camera.fov));
    }
    this.camera.lookAt(this.controls.target);
  }

  /** Floor-relative cut height for the drone's (or ground) floor, in render Y. */
  private cutHeight(snapshot: RenderSnapshot | null): number {
    const floors = this.meta?.floors ?? [];
    if (floors.length === 0) return 2.2;
    const z = snapshot?.drone.position.z ?? 0;
    const floor = [...floors].sort((a, b) => b.elevationM - a.elevationM).find(f => z >= f.elevationM - 0.3) ?? floors[0];
    return floor.elevationM + CUT_ABOVE_FLOOR_M;
  }

  /** Whether the drone is inside an authored room (the follow camera then cuts away the walls above it). */
  private indoors(snapshot: RenderSnapshot): boolean {
    const p = snapshot.drone.position;
    return (this.meta?.rooms ?? []).some(r => p.z >= r.zMin && p.z <= r.zMax && pointInPolygon(p.x, p.y, r.polygon));
  }

  update(snapshot: RenderSnapshot | null): void {
    if (this.mode === "cutaway") this.clip.constant = this.cutHeight(snapshot);
    if (this.mode === "follow" && snapshot !== null) {
      const inside = this.indoors(snapshot);
      this.clip.constant = inside ? this.cutHeight(snapshot) : NO_CUT;
      const yaw = snapshot.drone.yawRad;
      const drone = toRender(snapshot.drone.position);
      const forward = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      // Indoors: a high, close chase view looking down through the cut; outdoors: a classic chase view.
      const desired = drone.clone().addScaledVector(forward, inside ? -2.2 : -3.4).add(new Vector3(0, inside ? 2.6 : 1.5, 0));
      const look = drone.clone().addScaledVector(forward, inside ? 1.2 : 2.5);
      const k = this.reducedMotion ? 1 : 0.15;
      this.camera.position.lerp(desired, k);
      this.followTarget.lerp(look, k);
      this.camera.lookAt(this.followTarget);
      return;
    }
    this.controls.update();
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.controls.dispose();
  }
}

export interface ScreenLabel {
  readonly id: string;
  readonly text: string;
  readonly detail: string | null;
  readonly at: Vector3;
  /** Which side of the anchor the label sits on, so nearby labels do not cover each other. */
  readonly side: "left" | "right";
}

/** Imperatively positioned DOM labels in a layer React never renders children into. */
export class LabelLayer {
  private readonly layer: HTMLElement;
  private readonly elements = new Map<string, HTMLElement>();
  private readonly scratch = new Vector3();

  constructor(layer: HTMLElement) {
    this.layer = layer;
  }

  update(labels: readonly ScreenLabel[], camera: PerspectiveCamera, width: number, height: number): void {
    const live = new Set<string>();
    for (const label of labels) {
      live.add(label.id);
      let el = this.elements.get(label.id);
      if (el === undefined) {
        el = document.createElement("div");
        el.className = `twin-label ${label.side}`;
        this.layer.appendChild(el);
        this.elements.set(label.id, el);
      }
      const text = label.detail === null ? label.text : `${label.text}\n${label.detail}`;
      if (el.textContent !== text) el.textContent = text;
      const p = this.scratch.copy(label.at).project(camera);
      const visible = p.z > -1 && p.z < 1 && Math.abs(p.x) <= 1.05 && Math.abs(p.y) <= 1.05;
      el.style.display = visible ? "" : "none";
      if (visible) el.style.transform = `translate(${((p.x + 1) / 2) * width}px, ${((1 - p.y) / 2) * height}px)`;
    }
    for (const [id, el] of this.elements) {
      if (!live.has(id)) {
        el.remove();
        this.elements.delete(id);
      }
    }
  }

  dispose(): void {
    for (const el of this.elements.values()) el.remove();
    this.elements.clear();
  }
}
