/**
 * The simulation view: one WebGL renderer and context for the main twin view, the drone-camera preview
 * and every drone-camera capture. The display is capped at 1280 × 720 drawing-buffer pixels (preview at
 * most 640 × 360) and paced to ~30 fps; the sensor target has a fixed calibrated size. Everything is
 * disposed and the WebGL context released on teardown.
 *
 * It draws privileged simulation truth (RenderSnapshot). The drone camera sees only physical things:
 * presentation objects (labels, light beam, the aircraft's own body, the cutaway) are removed for captures.
 */
import type { Object3D } from "three";
import { ACESFilmicToneMapping, Color, DirectionalLight, HemisphereLight, PCFShadowMap, PerspectiveCamera, Plane, Scene, Vector3, WebGLRenderer } from "three";
import type { SceneMetaJson } from "../contracts/scene.ts";
import type { CameraFrameMessage, MissionView, RenderRequest, RenderSnapshot } from "../mission/protocol.ts";
import { BeliefOverlays } from "./belief-overlays.ts";
import { lockedCalibration } from "./camera-math.ts";
import { DroneCamera } from "./drone-camera.ts";
import { MaterialLibrary } from "./material-patch.ts";
import type { AssetState, StaticView } from "./scene-assets.ts";
import { SceneAssets } from "./scene-assets.ts";
import { SmokeField } from "./smoke-field.ts";
import type { CameraFocus, CameraMode, ScreenLabel } from "./view-cameras.ts";
import { LabelLayer, NO_CUT, ViewCameras } from "./view-cameras.ts";
import { DroneActor, OccupantActors } from "./world-actors.ts";
import { WorldEffects } from "./world-effects.ts";

export interface TwinStatus {
  readonly meta: AssetState;
  readonly glb: AssetState;
  readonly message: string | null;
  readonly context: "ok" | "lost";
  readonly sensorFormat: "rgba32f" | "rgba8";
  readonly calibrationId: string;
  /** Procedural detail texture set seen by the drone camera (identical for every controller and run). */
  readonly textureSetVersion: string;
  readonly drawingBuffer: { readonly width: number; readonly height: number };
}

export interface TwinElements {
  readonly container: HTMLElement;
  readonly labels: HTMLElement;
  readonly previewFrame: HTMLElement | null;
  readonly previewClock: HTMLElement | null;
}

/**
 * What an auxiliary pass may use: the single renderer and scene with the frame's world already applied.
 * `physicalOnly` hides presentation objects (aircraft body, overlays, cutaway) exactly as for sensor captures.
 */
export interface AuxiliaryPassContext {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly snapshot: RenderSnapshot;
  readonly meta: SceneMetaJson | null;
  readonly smoke: SmokeField;
  readonly roots: { readonly staticScene: Object3D; readonly occupants: Object3D; readonly effects: Object3D };
  physicalOnly<T>(draw: () => T): T;
}

/** An extra fixed-size render (e.g. the synthetic thermal view) drawn after the display frame; never a second context. */
export interface AuxiliaryPass {
  render(context: AuxiliaryPassContext): void;
  dispose(): void;
}

const MAX_MAIN = { width: 1280, height: 720 };
const FRAME_MS = 1000 / 30;
const toRender = (v: { x: number; y: number; z: number }) => new Vector3(v.x, v.z, -v.y);

export class TwinRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly clip = new Plane(new Vector3(0, -1, 0), NO_CUT);
  private readonly smoke = new SmokeField();
  private readonly materials: MaterialLibrary;
  private readonly assets: SceneAssets;
  private readonly drone: DroneActor;
  private readonly occupants: OccupantActors;
  private readonly effects: WorldEffects;
  private readonly cameras: ViewCameras;
  private readonly labels: LabelLayer;
  private readonly overlays = new BeliefOverlays();
  private missionView: MissionView | null = null;
  private readonly sun = new DirectionalLight(0xfff4e0, 1.5);
  private readonly previewCamera = new PerspectiveCamera();
  private droneCamera: DroneCamera;
  private readonly elements: TwinElements;
  private readonly observer: ResizeObserver;
  private readonly onStatus: (status: TwinStatus) => void;
  private readonly reducedMotion: boolean;
  private getSnapshot: () => RenderSnapshot | null = () => null;
  private size = { width: 1, height: 1 };
  private raf = 0;
  private lastFrame = 0;
  private contextLost = false;
  private showPreview = true;
  private readonly passes = new Set<AuxiliaryPass>();

  constructor(elements: TwinElements, options: { readonly reducedMotion: boolean; readonly aircraftId: string; readonly onStatus: (status: TwinStatus) => void }) {
    this.elements = elements;
    this.onStatus = options.onStatus;
    this.reducedMotion = options.reducedMotion;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "twin-canvas";
    this.canvas.setAttribute("aria-hidden", "true");
    elements.container.prepend(this.canvas);
    try {
      this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: "default" });
    } catch (error) {
      this.canvas.remove(); // No WebGL: leave nothing behind; the caller shows the failure.
      throw error;
    }
    this.renderer.toneMapping = ACESFilmicToneMapping; // Display only: render targets are never tone mapped.
    this.renderer.localClippingEnabled = true;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false; // Static geometry only; refreshed on demand.
    this.scene.background = new Color(0x9db4c6);
    this.setupLights();
    this.materials = new MaterialLibrary(this.smoke, this.renderer.capabilities.getMaxAnisotropy());
    this.assets = new SceneAssets(this.materials, [this.clip]);
    this.drone = new DroneActor(this.materials);
    this.occupants = new OccupantActors(this.materials);
    this.effects = new WorldEffects(this.materials);
    this.scene.add(this.assets.root, this.drone.object, this.occupants.object, this.effects.physical, this.effects.presentation, this.overlays.object);
    this.cameras = new ViewCameras(this.canvas, this.clip, this.reducedMotion);
    this.labels = new LabelLayer(elements.labels);
    this.droneCamera = new DroneCamera(this.renderer, lockedCalibration(options.aircraftId));
    this.droneCamera.applyIntrinsics(this.previewCamera);
    this.canvas.addEventListener("webglcontextlost", this.onContextLost);
    this.canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(elements.container);
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  private setupLights(): void {
    const hemi = new HemisphereLight(0xdfe8f0, 0x4a5546, 0.9);
    this.sun.position.set(48, 62, 30);
    this.sun.target.position.set(18, 0, -3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -46, right: 46, top: 46, bottom: -46, near: 1, far: 180 });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(hemi, this.sun, this.sun.target);
  }

  load(baseUrl: string): void {
    void this.assets.load(baseUrl, () => {
      this.cameras.setMeta(this.assets.meta);
      if (this.assets.droneTemplate !== null) this.drone.useTemplate(this.assets.droneTemplate);
      this.renderer.shadowMap.needsUpdate = true;
      this.emitStatus();
    });
  }

  setSnapshotSource(get: () => RenderSnapshot | null): void {
    this.getSnapshot = get;
  }

  /** Truth-free command state for the overlays (affected region, estimated pose, routes). */
  setMissionView(view: MissionView | null): void {
    this.missionView = view;
  }

  setMode(mode: CameraMode): void {
    this.cameras.setMode(mode);
  }

  /** Camera-director framing for exterior and cutaway; null restores the default house views. */
  setCameraFocus(focus: CameraFocus | null): void {
    this.cameras.setFocus(focus);
  }

  setStaticView(view: StaticView): void {
    this.assets.setView(view);
    this.renderer.shadowMap.needsUpdate = true;
  }

  setPreviewVisible(visible: boolean): void {
    this.showPreview = visible;
  }

  setAircraft(aircraftId: string): void {
    const calibration = lockedCalibration(aircraftId);
    if (calibration.id === this.droneCamera.calibration.id) return;
    this.droneCamera.dispose();
    this.droneCamera = new DroneCamera(this.renderer, calibration);
    this.droneCamera.applyIntrinsics(this.previewCamera);
    this.emitStatus();
  }

  /** Register an auxiliary pass; the returned function unregisters and disposes it. */
  addPass(pass: AuxiliaryPass): () => void {
    this.passes.add(pass);
    return () => {
      if (this.passes.delete(pass)) pass.dispose();
    };
  }

  /** Render the request's true pose and world with the locked calibration and return the luminance frame. */
  captureFrame(request: RenderRequest): { readonly frame: CameraFrameMessage; readonly renderMs: number } {
    if (this.contextLost) throw new Error("the WebGL context is lost");
    const started = performance.now();
    this.applyWorld(request.world, 0, false); // Deterministic: no wall-clock animation in sensor frames.
    const frame = this.withSensorView("sensor", () => this.droneCamera.capture(this.renderer, this.scene, request));
    return { frame, renderMs: performance.now() - started };
  }

  private applyWorld(snapshot: RenderSnapshot | null, timeS: number, animate: boolean): void {
    this.assets.applyOpenings(snapshot);
    this.smoke.update(snapshot?.rooms ?? null);
    this.drone.update(snapshot, timeS, animate);
    this.occupants.update(snapshot, timeS, animate);
    this.effects.update(snapshot, timeS, animate);
  }

  /** Physical scene only: no aircraft body (the lens is inside it), no cutaway, no presentation overlays. */
  private withSensorView<T>(output: "sensor" | "display", draw: () => T): T {
    const hidden: Object3D[] = [this.drone.object, this.effects.presentation, this.overlays.object].filter(o => o.visible);
    const cut = this.clip.constant;
    hidden.forEach(o => { o.visible = false; });
    this.clip.constant = NO_CUT;
    this.smoke.setOutput(output);
    try {
      return draw();
    } finally {
      hidden.forEach(o => { o.visible = true; });
      this.clip.constant = cut;
      this.smoke.setOutput("display");
    }
  }

  private readonly frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    if (this.contextLost || now - this.lastFrame < FRAME_MS - 2) return;
    this.lastFrame = now;
    const snapshot = this.getSnapshot();
    this.applyWorld(snapshot, now / 1000, !this.reducedMotion);
    this.overlays.setView(this.missionView);
    this.overlays.updateTrail(snapshot);
    this.cameras.update(snapshot);
    const { width, height } = this.size;
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, width, height);
    this.renderer.render(this.scene, this.cameras.camera);
    if (this.elements.previewFrame !== null) this.elements.previewFrame.hidden = !this.showPreview || snapshot === null;
    if (this.showPreview && snapshot !== null) this.renderPreview(snapshot);
    if (snapshot !== null && this.passes.size > 0) this.renderPasses(snapshot);
    this.labels.update(this.labelList(snapshot), this.cameras.camera, width, height);
  };

  private renderPreview(snapshot: RenderSnapshot): void {
    const { width } = this.size;
    const w = Math.round(Math.min(width * 0.3, 352));
    const h = Math.round((w * 9) / 16);
    const x = width - w - 12;
    this.droneCamera.placeAt(this.previewCamera, { position: snapshot.drone.position, yawRad: snapshot.drone.yawRad });
    this.withSensorView("display", () => {
      this.renderer.setScissorTest(true);
      this.renderer.setScissor(x, 12, w, h);
      this.renderer.setViewport(x, 12, w, h);
      this.renderer.render(this.scene, this.previewCamera);
    });
    this.renderer.setScissorTest(false);
    const frame = this.elements.previewFrame;
    if (frame !== null) Object.assign(frame.style, { width: `${w}px`, height: `${h}px`, right: "12px", bottom: "12px" });
    if (this.elements.previewClock !== null) this.elements.previewClock.textContent = `t ${(snapshot.tick / 100).toFixed(2)} s`;
  }

  private renderPasses(snapshot: RenderSnapshot): void {
    const context: AuxiliaryPassContext = {
      renderer: this.renderer,
      scene: this.scene,
      snapshot,
      meta: this.assets.meta,
      smoke: this.smoke,
      roots: { staticScene: this.assets.root, occupants: this.occupants.object, effects: this.effects.physical },
      physicalOnly: draw => this.withSensorView("sensor", draw),
    };
    for (const pass of this.passes) pass.render(context);
  }

  private labelList(snapshot: RenderSnapshot | null): ScreenLabel[] {
    if (snapshot === null) return [];
    const drone: ScreenLabel = { id: "drone", text: "Drone", detail: "true pose", at: toRender(snapshot.drone.position).add(new Vector3(0, 0.3, 0)), side: "left" };
    const people = this.occupants.anchors(snapshot).map((a): ScreenLabel => ({ id: `occupant-${a.key}`, text: "Simulated occupant", detail: a.detail, at: a.position, side: "right" }));
    return [drone, ...people];
  }

  private resize(): void {
    const rect = this.elements.container.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    const ratio = Math.min(window.devicePixelRatio || 1, MAX_MAIN.width / width, MAX_MAIN.height / height);
    this.size = { width, height };
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height, false);
    this.cameras.resize(width, height);
    this.emitStatus();
  }

  private emitStatus(): void {
    const { meta, glb, message } = this.assets.status;
    const buffer = { width: this.canvas.width, height: this.canvas.height };
    this.onStatus({ meta, glb, message, context: this.contextLost ? "lost" : "ok", sensorFormat: this.droneCamera.pixelFormat, calibrationId: this.droneCamera.calibration.id, textureSetVersion: this.materials.textureSetVersion, drawingBuffer: buffer });
  }

  private readonly onContextLost = (event: Event) => {
    event.preventDefault();
    this.contextLost = true;
    this.emitStatus();
  };

  private readonly onContextRestored = () => {
    this.contextLost = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.emitStatus();
  };

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.passes.forEach(pass => pass.dispose());
    this.passes.clear();
    this.labels.dispose();
    this.overlays.dispose();
    this.cameras.dispose();
    this.drone.dispose();
    this.occupants.dispose();
    this.effects.dispose();
    this.assets.dispose();
    this.materials.dispose();
    this.droneCamera.dispose();
    this.sun.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}
