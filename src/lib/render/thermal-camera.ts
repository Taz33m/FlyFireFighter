/**
 * Synthetic thermal view of the drone's thermal camera (thermal-front: 160 × 120, 57° HFOV, 10° pitch down,
 * from the aircraft profile). It is a presentation of simulated temperatures, not a radiometric sensor model
 * and not an input to any controller, planner or harness.
 *
 * It uses the twin's single WebGL renderer: an auxiliary pass swaps each mesh's material for a thermal
 * material, renders the true camera pose into a fixed-size render target, restores every material in a
 * `finally`, and reads back one channel. No second context is created.
 *
 * Temperature model (display approximations, all documented here):
 * - Surfaces inside a room volume take that room's simulated gas temperature (snapshot.rooms); surfaces
 *   outside every room take an assumed exterior ambient (EXTERIOR_AMBIENT_C). The sky is SKY_C.
 * - Surfaces inside an active fire's region show a fuel-bed temperature, and flames a flame temperature,
 *   both scaled from heatReleaseKW (fuelBedTemperatureC, flameTemperatureC). Extinguished fires drop back to
 *   the room temperature: cooling is not modelled.
 * - Occupants render at OCCUPANT_SURFACE_C (clothed adult surface). Glass is opaque to long-wave infrared,
 *   so panes show their own temperature and hide what is behind them; walls hide people as well.
 * - Smoke attenuates weakly: the same per-room optical depth τ as the RGB camera, scaled by
 *   THERMAL_SMOKE_RATIO, blends the surface toward the gas temperature around the camera. The blend is in
 *   temperature, not radiance (a simplification).
 */
import type { Material, Mesh, Object3D, WebGLProgramParametersWithUniforms } from "three";
import { AdditiveBlending, Color, FloatType, Matrix4, MeshBasicMaterial, NearestFilter, PerspectiveCamera, RGBAFormat, UnsignedByteType, Vector3, WebGLRenderTarget } from "three";
import { AIRCRAFT_PROFILES } from "../contracts/aircraft.ts";
import { calibrationFromSensor } from "../contracts/camera.ts";
import type { CameraCalibration } from "../contracts/camera.ts";
import { regionBounds } from "../contracts/geometry.ts";
import type { SceneMetaJson } from "../contracts/scene.ts";
import type { RenderSnapshot } from "../mission/protocol.ts";
import { projectionFromIntrinsics, renderCameraPose } from "./camera-math.ts";
import { roomBoxes } from "./room-boxes.ts";
import { SMOKE_MAX_BOXES } from "./smoke-field.ts";
import type { AuxiliaryPass, AuxiliaryPassContext } from "./twin-renderer.ts";

export const THERMAL_SENSOR_ID = "thermal-front";
export const THERMAL_CALIBRATION_VERSION = 1;
export const THERMAL_RENDERER = "three-thermal-override/v1";

/** Encoded range written by the shader: value = (T − MIN) / (MAX − MIN). */
export const ENCODE_MIN_C = -20;
export const ENCODE_MAX_C = 1000;
export const SKY_C = -20;
export const EXTERIOR_AMBIENT_C = 10;
export const OCCUPANT_SURFACE_C = 32;
export const WATER_JET_C = 15;
/**
 * Long-wave infrared extinction in smoke relative to visible light. Soot extinguishes 8–14 µm radiation
 * far less than visible light; 0.1 is a stated display assumption, not a measured coefficient.
 */
export const THERMAL_SMOKE_RATIO = 0.1;
/** Fixed display span for the "fixed" mode. */
export const FIXED_SPAN = { minC: 0, maxC: 300 } as const;
/** Smallest auto span, so sensor-uniform scenes are not stretched into noise-like banding. */
export const MIN_AUTO_SPAN_C = 10;

export type SpanMode = "auto" | "fixed";

/** Calibration of the thermal camera for an aircraft, or null if the profile has none. */
export function thermalCalibration(aircraftId: string): CameraCalibration | null {
  const spec = AIRCRAFT_PROFILES.find(p => p.id === aircraftId)?.sensors.find(s => s.id === THERMAL_SENSOR_ID);
  return spec === undefined ? null : calibrationFromSensor(spec, THERMAL_CALIBRATION_VERSION);
}

export function encodeTemperature(celsius: number): number {
  return Math.min(1, Math.max(0, (celsius - ENCODE_MIN_C) / (ENCODE_MAX_C - ENCODE_MIN_C)));
}

export function decodeTemperature(encoded: number): number {
  return ENCODE_MIN_C + encoded * (ENCODE_MAX_C - ENCODE_MIN_C);
}

/** Visible-flame temperature for display: 500 °C rising toward 800 °C with heat release. */
export function flameTemperatureC(heatReleaseKW: number): number {
  if (!(heatReleaseKW > 0)) return EXTERIOR_AMBIENT_C;
  return 500 + 300 * (1 - Math.exp(-heatReleaseKW / 150));
}

/** Burning fuel-bed surface temperature for display: 150 °C rising toward 450 °C with heat release. */
export function fuelBedTemperatureC(heatReleaseKW: number): number {
  if (!(heatReleaseKW > 0)) return EXTERIOR_AMBIENT_C;
  return 150 + 300 * (1 - Math.exp(-heatReleaseKW / 150));
}

/** Thermal transmittance for the RGB camera's optical depth τ along the same ray. */
export function thermalTransmittance(visibleOpticalDepth: number): number {
  return Math.exp(-Math.max(0, visibleOpticalDepth) * THERMAL_SMOKE_RATIO);
}

/** Apparent temperature of a surface seen through smoke whose gas temperature is gasC. */
export function apparentTemperatureC(surfaceC: number, gasC: number, visibleOpticalDepth: number): number {
  const t = thermalTransmittance(visibleOpticalDepth);
  return gasC + (surfaceC - gasC) * t;
}

/** World-frame box (metres, Z up) tagged with the room it belongs to. */
export interface RoomBox {
  readonly roomId: string;
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** Simulated temperature of the room containing `point`, or the exterior ambient when outside every room. */
export function roomTemperatureAt(point: { readonly x: number; readonly y: number; readonly z: number }, boxes: readonly RoomBox[], temperatures: ReadonlyMap<string, number>): number {
  for (const b of boxes) {
    if (point.x >= b.min[0] && point.x <= b.max[0] && point.y >= b.min[1] && point.y <= b.max[1] && point.z >= b.min[2] && point.z <= b.max[2]) {
      return temperatures.get(b.roomId) ?? EXTERIOR_AMBIENT_C;
    }
  }
  return EXTERIOR_AMBIENT_C;
}

/**
 * Display span: fixed, or the 2nd–99.5th percentile of the frame widened to at least MIN_AUTO_SPAN_C. Sky
 * pixels (SKY_C, a constant background rather than a surface) are left out of the auto span when the frame
 * has anything else, so open ground is not stretched to the top of the palette.
 */
export function displaySpan(temperatures: ArrayLike<number>, mode: SpanMode): { readonly minC: number; readonly maxC: number } {
  if (mode === "fixed" || temperatures.length === 0) return FIXED_SPAN;
  const all = Float64Array.from(temperatures);
  const surfaces = all.filter(c => c > SKY_C + 0.5);
  const sorted = (surfaces.length > 0 ? surfaces : all).sort();
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
  let minC = at(0.02);
  let maxC = at(0.995);
  if (maxC - minC < MIN_AUTO_SPAN_C) {
    const mid = (minC + maxC) / 2;
    minC = mid - MIN_AUTO_SPAN_C / 2;
    maxC = mid + MIN_AUTO_SPAN_C / 2;
  }
  return { minC, maxC };
}

/** Iron-style false-colour stops: black → indigo → magenta → orange → yellow → white (luminance rises monotonically). */
export const PALETTE_STOPS: readonly (readonly [number, number, number, number])[] = [
  [0.0, 0, 0, 0],
  [0.18, 38, 10, 92],
  [0.38, 128, 18, 128],
  [0.58, 214, 64, 40],
  [0.78, 250, 160, 20],
  [0.92, 255, 226, 90],
  [1.0, 255, 255, 240],
];

/** Palette colour (0–255 RGB) for a normalised value t, clamped to [0, 1]. */
export function paletteColor(t: number): [number, number, number] {
  const x = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  for (let i = 1; i < PALETTE_STOPS.length; i++) {
    const [p1, r1, g1, b1] = PALETTE_STOPS[i];
    if (x <= p1) {
      const [p0, r0, g0, b0] = PALETTE_STOPS[i - 1];
      const f = (x - p0) / (p1 - p0);
      return [Math.round(r0 + (r1 - r0) * f), Math.round(g0 + (g1 - g0) * f), Math.round(b0 + (b1 - b0) * f)];
    }
  }
  const last = PALETTE_STOPS[PALETTE_STOPS.length - 1];
  return [last[1], last[2], last[3]];
}

/** Palette colour for a temperature within a display span. */
export function temperatureColor(celsius: number, span: { readonly minC: number; readonly maxC: number }): [number, number, number] {
  return paletteColor((celsius - span.minC) / Math.max(1e-6, span.maxC - span.minC));
}

export interface ThermalImage {
  /** RGBA, row 0 at the top. */
  readonly rgba: Uint8ClampedArray;
  /** Apparent temperatures, row 0 at the top. */
  readonly temperatures: Float32Array;
  readonly span: { readonly minC: number; readonly maxC: number };
  readonly minC: number;
  readonly maxC: number;
  /** Apparent temperature at the image centre (spot meter). */
  readonly centreC: number;
}

/**
 * Turn a WebGL readback (row 0 at the BOTTOM, encoded temperature in channel 0; floats in [0, 1] or bytes in
 * [0, 255]) into a top-down false-colour image.
 */
export function colorizeReadback(readback: Float32Array | Uint8Array, width: number, height: number, mode: SpanMode): ThermalImage {
  const scale = readback instanceof Uint8Array ? 1 / 255 : 1;
  const temperatures = new Float32Array(width * height);
  let minC = Infinity;
  let maxC = -Infinity;
  for (let row = 0; row < height; row++) {
    const src = (height - 1 - row) * width;
    for (let col = 0; col < width; col++) {
      const c = decodeTemperature(readback[(src + col) * 4] * scale);
      temperatures[row * width + col] = c;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
    }
  }
  const span = displaySpan(temperatures, mode);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < temperatures.length; i++) {
    const [r, g, b] = temperatureColor(temperatures[i], span);
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  const centreC = temperatures[Math.floor(height / 2) * width + Math.floor(width / 2)] ?? NaN;
  return { rgba, temperatures, span, minC, maxC, centreC };
}

/* ---------------------------------------------------------------------------------------------------------
 * GPU pass. Everything below needs WebGL and runs only in the browser.
 * ------------------------------------------------------------------------------------------------------- */

const MAX_FIRES = 4;
/**
 * Surfaces this close to a room box (walls, floors) take its temperature. Room polygons can run along wall
 * centrelines, so a margin equal to half a wall puts wall faces exactly on the box edge and they speckle
 * between two temperatures; 0.25 m keeps them clearly inside.
 */
const ROOM_MARGIN_M = 0.25;
const FIRE_MARGIN_M = 0.3;
const MIN_INTERVAL_MS = 100; // ≤ 10 Hz, the thermal sensor's rate.
const REFRESH_MS = 1000;

type ThermalClass = "surface" | "occupant" | "flame" | "water";

const SHARED_PARS = `#include <fog_pars_fragment>
#define SMOKE_MAX_BOXES ${SMOKE_MAX_BOXES}
#define THERMAL_MAX_ROOMS ${SMOKE_MAX_BOXES}
#define THERMAL_MAX_FIRES ${MAX_FIRES}
uniform int smokeCount;
uniform vec3 smokeMin[SMOKE_MAX_BOXES];
uniform vec3 smokeMax[SMOKE_MAX_BOXES];
uniform float smokeSigma[SMOKE_MAX_BOXES];
uniform int thermalRoomCount;
uniform vec3 thermalRoomMin[THERMAL_MAX_ROOMS];
uniform vec3 thermalRoomMax[THERMAL_MAX_ROOMS];
uniform float thermalRoomC[THERMAL_MAX_ROOMS];
uniform int thermalFireCount;
uniform vec3 thermalFireMin[THERMAL_MAX_FIRES];
uniform vec3 thermalFireMax[THERMAL_MAX_FIRES];
uniform float thermalFireC[THERMAL_MAX_FIRES];
uniform float thermalAmbientC;
uniform float thermalGasC;
uniform float thermalSmokeRatio;
uniform vec2 thermalEncode;
uniform float thermalFixedC;
varying vec3 vThermalWorld;
float thermalTau(vec3 a, vec3 b) {
  vec3 d = b - a;
  float len = length(d);
  if (smokeCount == 0 || len < 1e-4) return 0.0;
  vec3 safe = mix(d, vec3(1e-6), vec3(lessThan(abs(d), vec3(1e-6))));
  vec3 inv = 1.0 / safe;
  float tau = 0.0;
  for (int i = 0; i < SMOKE_MAX_BOXES; i++) {
    if (i >= smokeCount) break;
    vec3 t0 = (smokeMin[i] - a) * inv;
    vec3 t1 = (smokeMax[i] - a) * inv;
    vec3 lo = min(t0, t1);
    vec3 hi = max(t0, t1);
    float enter = max(max(lo.x, lo.y), max(lo.z, 0.0));
    float leave = min(min(hi.x, hi.y), min(hi.z, 1.0));
    float zMid = a.y + 0.5 * (enter + leave) * d.y;
    float profile = 0.5 + clamp((zMid - smokeMin[i].y) / max(smokeMax[i].y - smokeMin[i].y, 1e-3), 0.0, 1.0);
    tau += smokeSigma[i] * profile * max(leave - enter, 0.0) * len;
  }
  return tau;
}
float thermalSurfaceC(vec3 p) {
  float t = thermalAmbientC;
  float room = -1e9;
  for (int i = 0; i < THERMAL_MAX_ROOMS; i++) {
    if (i >= thermalRoomCount) break;
    if (all(greaterThanEqual(p, thermalRoomMin[i] - ${ROOM_MARGIN_M.toFixed(2)})) && all(lessThanEqual(p, thermalRoomMax[i] + ${ROOM_MARGIN_M.toFixed(2)}))) room = max(room, thermalRoomC[i]);
  }
  if (room > -1e8) t = room;
  for (int i = 0; i < THERMAL_MAX_FIRES; i++) {
    if (i >= thermalFireCount) break;
    if (all(greaterThanEqual(p, thermalFireMin[i] - ${FIRE_MARGIN_M.toFixed(2)})) && all(lessThanEqual(p, thermalFireMax[i] + ${FIRE_MARGIN_M.toFixed(2)}))) t = max(t, thermalFireC[i]);
  }
  return t;
}`;

const SHARED_MAIN = `#include <fog_fragment>
{
#ifdef THERMAL_FIXED
  float surfaceC = thermalFixedC;
#else
  float surfaceC = thermalSurfaceC(vThermalWorld);
#endif
  float transmittance = exp(-thermalTau(cameraPosition, vThermalWorld) * thermalSmokeRatio);
  float apparentC = mix(thermalGasC, surfaceC, transmittance);
  gl_FragColor = vec4(clamp((apparentC - thermalEncode.x) / (thermalEncode.y - thermalEncode.x), 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

export interface ThermalFrame extends ThermalImage {
  readonly tick: number;
  readonly width: number;
  readonly height: number;
  readonly calibrationId: string;
  readonly format: "rgba32f" | "rgba8";
}

/** Auxiliary pass for TwinRenderer.addPass: renders the thermal camera at ≤ 10 Hz and reports colourised frames. */
export class ThermalPass implements AuxiliaryPass {
  readonly calibration: CameraCalibration;
  private readonly onFrame: (frame: ThermalFrame) => void;
  private readonly onError: (message: string) => void;
  private readonly camera = new PerspectiveCamera();
  private readonly basis = new Matrix4();
  private readonly sky = new Color(encodeTemperature(SKY_C), 0, 0);
  private target: WebGLRenderTarget | null = null;
  private readback: Float32Array | Uint8Array | null = null;
  private format: "rgba32f" | "rgba8" = "rgba8";
  private readonly materials = new Map<string, MeshBasicMaterial>();
  private readonly uniforms = {
    thermalRoomCount: { value: 0 },
    thermalRoomMin: { value: Array.from({ length: SMOKE_MAX_BOXES }, () => new Vector3()) },
    thermalRoomMax: { value: Array.from({ length: SMOKE_MAX_BOXES }, () => new Vector3()) },
    thermalRoomC: { value: new Float32Array(SMOKE_MAX_BOXES) },
    thermalFireCount: { value: 0 },
    thermalFireMin: { value: Array.from({ length: MAX_FIRES }, () => new Vector3()) },
    thermalFireMax: { value: Array.from({ length: MAX_FIRES }, () => new Vector3()) },
    thermalFireC: { value: new Float32Array(MAX_FIRES) },
    thermalAmbientC: { value: EXTERIOR_AMBIENT_C },
    thermalGasC: { value: EXTERIOR_AMBIENT_C },
    thermalSmokeRatio: { value: THERMAL_SMOKE_RATIO },
    thermalEncode: { value: { x: ENCODE_MIN_C, y: ENCODE_MAX_C } },
  };
  private meta: SceneMetaJson | null = null;
  private rooms: RoomBox[] = [];
  private spanMode: SpanMode = "auto";
  private lastTick = -1;
  private lastWall = -Infinity;
  private failed = false;

  constructor(calibration: CameraCalibration, onFrame: (frame: ThermalFrame) => void, onError: (message: string) => void) {
    this.calibration = calibration;
    this.onFrame = onFrame;
    this.onError = onError;
    this.camera.projectionMatrix.fromArray(projectionFromIntrinsics(calibration));
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
  }

  setSpanMode(mode: SpanMode): void {
    this.spanMode = mode;
    this.lastWall = -Infinity; // Re-render promptly with the new span.
  }

  render(context: AuxiliaryPassContext): void {
    if (this.failed) return;
    const { snapshot } = context;
    const now = performance.now();
    if (now - this.lastWall < MIN_INTERVAL_MS) return;
    if (snapshot.tick === this.lastTick && now - this.lastWall < REFRESH_MS) return;
    this.lastWall = now;
    this.lastTick = snapshot.tick;
    try {
      this.draw(context);
    } catch (error) {
      this.failed = true; // Stop retrying every frame; the panel shows the reason.
      this.onError(error instanceof Error ? error.message : String(error));
    }
  }

  private ensureTarget(context: AuxiliaryPassContext): WebGLRenderTarget {
    if (this.target !== null) return this.target;
    const { width, height } = this.calibration;
    const float = context.renderer.extensions.has("EXT_color_buffer_float");
    this.format = float ? "rgba32f" : "rgba8";
    this.target = new WebGLRenderTarget(width, height, {
      type: float ? FloatType : UnsignedByteType, format: RGBAFormat, samples: 4, depthBuffer: true,
      minFilter: NearestFilter, magFilter: NearestFilter, generateMipmaps: false,
    });
    this.readback = float ? new Float32Array(width * height * 4) : new Uint8Array(width * height * 4);
    return this.target;
  }

  private draw(context: AuxiliaryPassContext): void {
    const { renderer, scene, snapshot } = context;
    const target = this.ensureTarget(context);
    this.updateUniforms(context);
    this.placeCamera(snapshot);
    const swapped = new Map<Mesh, Material | Material[]>();
    const hidden: Object3D[] = [];
    const background = scene.background;
    const previous = renderer.getRenderTarget();
    try {
      this.swapMaterials(context, swapped, hidden);
      scene.background = this.sky;
      context.physicalOnly(() => {
        renderer.setRenderTarget(target);
        renderer.render(scene, this.camera);
        renderer.readRenderTargetPixels(target, 0, 0, this.calibration.width, this.calibration.height, this.readback!);
      });
    } finally {
      for (const [mesh, material] of swapped) mesh.material = material;
      hidden.forEach(o => { o.visible = true; });
      scene.background = background;
      renderer.setRenderTarget(previous);
    }
    const image = colorizeReadback(this.readback!, this.calibration.width, this.calibration.height, this.spanMode);
    this.onFrame({ ...image, tick: snapshot.tick, width: this.calibration.width, height: this.calibration.height, calibrationId: this.calibration.id, format: this.format });
  }

  private placeCamera(snapshot: RenderSnapshot): void {
    const p = renderCameraPose(this.calibration, { position: snapshot.drone.position, yawRad: snapshot.drone.yawRad });
    this.camera.position.set(p.position.x, p.position.y, p.position.z);
    this.basis.makeBasis(new Vector3(p.right.x, p.right.y, p.right.z), new Vector3(p.up.x, p.up.y, p.up.z), new Vector3(p.back.x, p.back.y, p.back.z));
    this.camera.quaternion.setFromRotationMatrix(this.basis);
    this.camera.updateMatrixWorld(true);
  }

  private updateUniforms(context: AuxiliaryPassContext): void {
    const { snapshot, meta } = context;
    if (meta !== this.meta) {
      this.meta = meta;
      this.rooms = (meta?.rooms ?? []).flatMap(room => roomBoxes(room.polygon, room.zMin, room.zMax).map(b => ({ roomId: room.id, min: b.min, max: b.max })));
    }
    const temps = new Map(snapshot.rooms.map(r => [r.id, r.temperatureC]));
    const u = this.uniforms;
    const rooms = this.rooms.slice(0, SMOKE_MAX_BOXES);
    rooms.forEach((b, i) => {
      // world (x, y, z) → render (x, z, −y)
      u.thermalRoomMin.value[i].set(b.min[0], b.min[2], -b.max[1]);
      u.thermalRoomMax.value[i].set(b.max[0], b.max[2], -b.min[1]);
      u.thermalRoomC.value[i] = temps.get(b.roomId) ?? EXTERIOR_AMBIENT_C;
    });
    u.thermalRoomCount.value = rooms.length;
    const fires = snapshot.fires.filter(f => !f.extinguished && f.heatReleaseKW > 0).slice(0, MAX_FIRES);
    fires.forEach((f, i) => {
      const b = regionBounds(f.region);
      u.thermalFireMin.value[i].set(b.min.x, b.min.z, -b.max.y);
      u.thermalFireMax.value[i].set(b.max.x, b.max.z, -b.min.y);
      u.thermalFireC.value[i] = fuelBedTemperatureC(f.heatReleaseKW);
    });
    u.thermalFireCount.value = fires.length;
    u.thermalGasC.value = roomTemperatureAt(snapshot.drone.position, this.rooms, temps);
    const hottest = Math.max(0, ...fires.map(f => f.heatReleaseKW));
    this.material("flame", 0, context).uniforms.thermalFixedC.value = flameTemperatureC(hottest);
  }

  /** Swap visible meshes to thermal materials by role; hide other renderables (lines, points, sprites). */
  private swapMaterials(context: AuxiliaryPassContext, swapped: Map<Mesh, Material | Material[]>, hidden: Object3D[]): void {
    const { occupants, effects } = context.roots;
    const visit = (object: Object3D, role: "scene" | "occupant" | "effect") => {
      if (!object.visible) return;
      const nextRole = object === occupants ? "occupant" : object === effects ? "effect" : role;
      const mesh = object as Mesh;
      if (mesh.isMesh === true) {
        const originals = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        if (originals.every(m => m.visible)) {
          const replace = (m: Material) => this.material(classify(m, nextRole), m.side, context).material;
          swapped.set(mesh, mesh.material);
          mesh.material = Array.isArray(mesh.material) ? mesh.material.map(replace) : replace(mesh.material);
        }
      } else if ((object as { isLine?: boolean; isPoints?: boolean; isSprite?: boolean }).isLine === true || (object as { isPoints?: boolean }).isPoints === true || (object as { isSprite?: boolean }).isSprite === true) {
        object.visible = false;
        hidden.push(object);
      }
      for (const child of object.children) visit(child, nextRole);
    };
    visit(context.scene, "scene");
  }

  private material(cls: ThermalClass, side: Material["side"], context: AuxiliaryPassContext): { readonly material: MeshBasicMaterial; readonly uniforms: { thermalFixedC: { value: number } } } {
    const key = `${cls}/${side}`;
    let material = this.materials.get(key);
    if (material === undefined) {
      const fixed = cls !== "surface";
      const own = { thermalFixedC: { value: cls === "occupant" ? OCCUPANT_SURFACE_C : cls === "water" ? WATER_JET_C : EXTERIOR_AMBIENT_C } };
      // Flames share one temperature across sides.
      if (cls === "flame") own.thermalFixedC = this.flameUniform;
      const created = new MeshBasicMaterial({ color: 0xffffff, side, fog: false, toneMapped: false });
      created.userData.thermalUniforms = own;
      const shared = this.uniforms;
      const smoke = context.smoke.uniforms;
      created.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
        Object.assign(shader.uniforms, smoke, shared, own);
        const define = fixed ? "#define THERMAL_FIXED\n" : "";
        shader.vertexShader = define + shader.vertexShader
          .replace("#include <fog_pars_vertex>", "#include <fog_pars_vertex>\nvarying vec3 vThermalWorld;")
          .replace("#include <fog_vertex>", "#include <fog_vertex>\nvThermalWorld = cameraPosition + transpose(mat3(viewMatrix)) * mvPosition.xyz;");
        shader.fragmentShader = define + shader.fragmentShader.replace("#include <fog_pars_fragment>", SHARED_PARS).replace("#include <fog_fragment>", SHARED_MAIN);
      };
      created.customProgramCacheKey = () => `ffft-thermal-${fixed ? "fixed" : "surface"}`;
      this.materials.set(key, created);
      material = created;
    }
    return { material, uniforms: material.userData.thermalUniforms as { thermalFixedC: { value: number } } };
  }

  private readonly flameUniform = { value: flameTemperatureC(0) };

  dispose(): void {
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
    this.target?.dispose();
    this.target = null;
    this.readback = null;
  }
}

/** Thermal role of a material: occupants are warm; additive effects are flames; other translucent effects are the water jet. Glass and walls are ordinary opaque surfaces. */
function classify(material: Material, role: "scene" | "occupant" | "effect"): ThermalClass {
  if (role === "occupant") return "occupant";
  if (role === "effect") {
    if (material.blending === AdditiveBlending) return "flame";
    if (material.transparent) return "water";
  }
  return "surface";
}
