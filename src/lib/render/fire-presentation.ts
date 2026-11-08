/**
 * Presentation-only fire cues for the audience views (Exterior, Follow drone, Cutaway, Auto): an exterior
 * smoke plume above the burning room, plus a flickering warm light and an additive glow at the fire.
 *
 * Everything lives under `object`, which WorldEffects parents to its presentation group. The twin renderer
 * hides that group for every drone-camera capture, the drone preview and the thermal pass (see
 * sensor-view.ts), so none of this reaches the frames the flight is steered from. The physical flames the
 * drone does see stay in WorldEffects.physical, unchanged.
 *
 * The plume is a display scaling of heatReleaseKW, not a smoke model: emission rate and opacity grow with
 * log heat release. Puffs leave the roof above the fire (and any open or broken window of the fire room),
 * rise, expand, drift downwind and fade with age. When a fire is extinguished its emission stops and the
 * puffs already in the air keep rising and fade out over their remaining lifetime (≤ PUFF_LIFE_S). Puffs
 * are camera-facing quads batched into one dynamic mesh: one draw call, one material, one procedural
 * texture, at most PLUME_MAX_PUFFS quads. Reduced motion slows the plume and the flicker.
 */
import type { Camera, Plane } from "three";
import { AdditiveBlending, BufferAttribute, BufferGeometry, DataTexture, DynamicDrawUsage, Group, LinearFilter, Mesh, MeshBasicMaterial, PointLight, RGBAFormat, Sphere, Sprite, SpriteMaterial, UnsignedByteType, Vector3 } from "three";
import { regionBounds } from "../contracts/geometry.ts";
import type { JsonPoint2, SceneMetaJson } from "../contracts/scene.ts";
import type { RenderSnapshot } from "../mission/protocol.ts";

export const PLUME_MAX_PUFFS = 120;
/** Upper bound of a puff's life: puffs alive at extinguishment are gone this long afterwards. */
export const PUFF_LIFE_S = 12;
const MIN_LIFE_S = 9.5;
/** Puffs per second for one fire at full display intensity (9.5/s × ≤ 12 s stays within the cap). */
const MAX_RATE = 9.5;
export const REDUCED_MOTION_SCALE = 0.35;
/** Render-frame wind (x, up, −worldY), m/s: a light breeze. */
const WIND = new Vector3(0.55, 0, -0.22);
const TEXTURE_SIZE = 64;
const CORNERS: readonly (readonly [number, number])[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

/** 0..1 display intensity from heat release: log-scaled so a 60 kW start reads and ~1 MW saturates. */
export function plumeIntensity(heatReleaseKW: number): number {
  if (!(heatReleaseKW > 0)) return 0;
  // Display scaling for the audience view (never a sensor input): a floor of 0.55 keeps the plume legible from the first
  // seconds of a small fire, and it still grows with heat release to full strength at about 1 MW.
  return Math.min(1, Math.max(0.55, Math.log10(heatReleaseKW / 20) / Math.log10(50)));
}

/** Puff opacity over its life: quick fade-in at the vent, then a long fade as it rises and dilutes. */
export function puffAlpha(ageS: number, lifeS: number, scale: number): number {
  if (!(ageS >= 0) || ageS >= lifeS) return 0;
  const fadeIn = Math.min(1, ageS / 0.8);
  return scale * fadeIn * (1 - ageS / lifeS) ** 1.6;
}

interface Puff {
  live: boolean;
  readonly position: Vector3;
  readonly velocity: Vector3;
  age: number;
  life: number;
  size0: number;
  size1: number;
  rotation: number;
  spin: number;
  alpha: number;
  shade: number;
  warmth: number;
}

interface Emitter {
  /** Render frame. */
  readonly at: Vector3;
  /** Render-frame outward push (zero for the roof). */
  readonly push: Vector3;
  readonly spreadM: number;
  readonly weight: number;
}

interface Burning {
  readonly kw: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

type MetaRoom = SceneMetaJson["rooms"][number];

function insidePolygon(x: number, y: number, polygon: readonly JsonPoint2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pickEmitter(sources: readonly Emitter[], u: number): Emitter {
  const total = sources.reduce((sum, e) => sum + e.weight, 0);
  let remaining = u * total;
  for (const source of sources) {
    remaining -= source.weight;
    if (remaining <= 0) return source;
  }
  return sources[sources.length - 1];
}

function valueNoise(x: number, y: number): number {
  const hash = (a: number, b: number) => {
    const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const top = hash(x0, y0) * (1 - sx) + hash(x0 + 1, y0) * sx;
  const bottom = hash(x0, y0 + 1) * (1 - sx) + hash(x0 + 1, y0 + 1) * sx;
  return top * (1 - sy) + bottom * sy;
}

/** A square RGBA texture from a per-texel (u, v ∈ −0.5..0.5) → [grey, alpha] function, both 0..1. */
function proceduralTexture(texel: (u: number, v: number, i: number, j: number) => readonly [number, number]): DataTexture {
  const n = TEXTURE_SIZE;
  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const [grey, alpha] = texel((i + 0.5) / n - 0.5, (j + 0.5) / n - 0.5, i, j);
      const k = (j * n + i) * 4;
      data[k] = data[k + 1] = data[k + 2] = Math.round(255 * grey);
      data[k + 3] = Math.round(255 * Math.min(1, Math.max(0, alpha)));
    }
  }
  const texture = new DataTexture(data, n, n, RGBAFormat, UnsignedByteType);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** Soft round puff with billowy lumps; near-white so the vertex colour sets its grey. */
const smokeTexel = (u: number, v: number, i: number, j: number): readonly [number, number] => {
  const r = Math.sqrt(u * u + v * v) * 2;
  const lumps = 0.55 * valueNoise(i / 9, j / 9) + 0.3 * valueNoise(i / 4.5 + 17, j / 4.5 + 5) + 0.15 * valueNoise(i / 2.2 + 3, j / 2.2 + 11);
  return [0.84 + 0.16 * lumps, Math.max(0, 1 - r) ** 1.5 * (0.45 + 0.9 * lumps)];
};

/** Radial glow, tinted warm by the sprite material. */
const glowTexel = (u: number, v: number): readonly [number, number] => [1, (1 - Math.min(1, Math.sqrt(u * u + v * v) * 2)) ** 2.2];

const toRender = (x: number, y: number, z: number, out = new Vector3()) => out.set(x, z, -y);

export class FirePresentation {
  readonly object = new Group();
  /** Warm flickering light at the strongest fire; stays in the scene at zero intensity when nothing burns. */
  readonly light = new PointLight(0xff8a3c, 0, 10, 2);
  readonly glow: Sprite;
  readonly plume: Mesh;
  private readonly puffs: Puff[] = Array.from({ length: PLUME_MAX_PUFFS }, () => ({ live: false, position: new Vector3(), velocity: new Vector3(), age: 0, life: 1, size0: 1, size1: 1, rotation: 0, spin: 0, alpha: 0, shade: 0.05, warmth: 0 }));
  private readonly carry = new Map<string, number>();
  private readonly smokeMap = proceduralTexture(smokeTexel);
  private readonly glowMap = proceduralTexture(glowTexel);
  private readonly geometry = new BufferGeometry();
  private readonly positions = new Float32Array(PLUME_MAX_PUFFS * 4 * 3);
  private readonly colors = new Float32Array(PLUME_MAX_PUFFS * 4 * 4);
  private readonly material = new MeshBasicMaterial({ map: this.smokeMap, vertexColors: true, transparent: true, depthWrite: false });
  private readonly glowMaterial = new SpriteMaterial({ map: this.glowMap, color: 0xff8c3a, blending: AdditiveBlending, transparent: true, depthWrite: false, opacity: 0 });
  private readonly random: () => number;
  private readonly order: number[] = [];
  private readonly depth = new Float32Array(PLUME_MAX_PUFFS);
  private readonly scratch = { right: new Vector3(), up: new Vector3(), forward: new Vector3(), eye: new Vector3(), centre: new Vector3(), offset: new Vector3() };
  private meta: SceneMetaJson | null = null;

  constructor(options: { readonly random?: () => number } = {}) {
    this.random = options.random ?? Math.random;
    this.object.name = "fire-presentation";
    const uvs = new Float32Array(PLUME_MAX_PUFFS * 4 * 2);
    const index = new Uint16Array(PLUME_MAX_PUFFS * 6);
    for (let i = 0; i < PLUME_MAX_PUFFS; i++) {
      uvs.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8);
      const v = i * 4;
      index.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    }
    this.geometry.setAttribute("position", new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage));
    this.geometry.setAttribute("uv", new BufferAttribute(uvs, 2));
    this.geometry.setAttribute("color", new BufferAttribute(this.colors, 4).setUsage(DynamicDrawUsage));
    this.geometry.setIndex(new BufferAttribute(index, 1));
    this.geometry.setDrawRange(0, 0);
    this.geometry.boundingSphere = new Sphere(new Vector3(), 60);
    this.plume = new Mesh(this.geometry, this.material);
    this.plume.name = "fire-plume";
    this.plume.frustumCulled = false;
    this.plume.visible = false;
    this.glow = new Sprite(this.glowMaterial);
    this.glow.name = "fire-glow";
    this.glow.visible = false;
    this.light.name = "fire-glow-light";
    this.object.add(this.plume, this.glow, this.light);
  }

  /** Rooms and windows locate the vents; without metadata the plume rises from above the fire. */
  setMeta(meta: SceneMetaJson | null): void {
    this.meta = meta;
  }

  /**
   * The cutaway plane: when the house is cut open (Cutaway, or Follow indoors) the plume above the cut is
   * clipped like the roof, so it never hangs between the camera and the interior. The glow is not clipped.
   */
  setClippingPlanes(planes: Plane[]): void {
    this.material.clippingPlanes = planes;
  }

  /** Live puffs (for tests and diagnostics). */
  get puffCount(): number {
    return this.puffs.reduce((n, p) => n + (p.live ? 1 : 0), 0);
  }

  /** Highest live puff (render-frame up), or null without puffs. */
  get topM(): number | null {
    let top: number | null = null;
    for (const p of this.puffs) if (p.live && (top === null || p.position.y > top)) top = p.position.y;
    return top;
  }

  /** Advance by wall-clock dtS and draw for `camera`. Display frames only: never called for sensor captures. */
  update(snapshot: RenderSnapshot | null, dtS: number, timeS: number, camera: Camera, reducedMotion: boolean): void {
    const scale = reducedMotion ? REDUCED_MOTION_SCALE : 1;
    const dt = Math.min(0.1, Math.max(0, dtS)) * scale;
    const spraying = snapshot !== null && snapshot.waterJet !== null;
    const live = new Set<string>();
    let strongest: Burning | null = null;
    for (const fire of snapshot?.fires ?? []) {
      if (fire.extinguished || !(fire.heatReleaseKW > 0)) continue; // Extinguished: emission stops.
      live.add(fire.id);
      const b = regionBounds(fire.region);
      const burning: Burning = { kw: fire.heatReleaseKW, x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: b.min.z };
      this.emit(fire.id, burning, dt, spraying, snapshot);
      if (strongest === null || burning.kw > strongest.kw) strongest = burning;
    }
    for (const id of [...this.carry.keys()]) if (!live.has(id)) this.carry.delete(id);
    this.step(dt);
    this.updateGlow(strongest, timeS * scale);
    this.draw(camera);
  }

  private updateGlow(fire: Burning | null, t: number): void {
    if (fire === null) {
      this.light.intensity = 0; // Kept in the scene: toggling it would change the light count.
      this.glow.visible = false;
      return;
    }
    const s = plumeIntensity(fire.kw);
    const flicker = 1 + 0.13 * Math.sin(t * 9.1) + 0.08 * Math.sin(t * 23.7 + 1.3) + 0.05 * Math.sin(t * 41.3 + 0.4);
    toRender(fire.x, fire.y, fire.z + 0.8, this.light.position);
    this.light.intensity = (6 + 34 * s) * flicker;
    // Centred high enough that the floor does not visibly slice the camera-facing quad.
    const size = (1.2 + 2 * s) * (0.94 + 0.06 * flicker);
    toRender(fire.x, fire.y, fire.z + 0.25 + 0.4 * size, this.glow.position);
    this.glow.scale.set(size, size * 1.15, 1);
    this.glowMaterial.opacity = Math.min(1, (0.35 + 0.45 * s) * flicker);
    this.glow.visible = true;
  }

  private emitters(fire: Burning, snapshot: RenderSnapshot | null): Emitter[] {
    const rooms: readonly MetaRoom[] = this.meta === null ? [] : this.meta.rooms;
    const above = rooms.filter(r => r.zMax >= fire.z && insidePolygon(fire.x, fire.y, r.polygon)).map(r => r.zMax);
    const roofZ = above.length > 0 ? Math.max(...above) + 1.1 : fire.z + 3.5;
    const roof: Emitter = { at: toRender(fire.x, fire.y, roofZ), push: new Vector3(), spreadM: 1.3, weight: 1 };
    const room = rooms.find(r => fire.z >= r.zMin - 0.3 && fire.z <= r.zMax && insidePolygon(fire.x, fire.y, r.polygon));
    return room === undefined ? [roof] : [roof, ...this.windowVents(room, snapshot)];
  }

  /** Open or broken windows of the fire room vent smoke from their top edge; closed glass does not. */
  private windowVents(room: MetaRoom, snapshot: RenderSnapshot | null): Emitter[] {
    const openings: RenderSnapshot["openings"] = snapshot === null ? [] : snapshot.openings;
    const states = new Map(openings.map(o => [o.id, o.state] as const));
    const vents: Emitter[] = [];
    for (const opening of this.meta === null ? [] : this.meta.openings) {
      if (opening.kind !== "window" || !opening.rooms.includes(room.id)) continue;
      const state = states.get(opening.id) ?? opening.initialState;
      if (state !== "open" && state !== "broken") continue;
      const [cx, cy, cz] = opening.center;
      const [nx, ny] = opening.outwardNormal;
      const top = cz + opening.heightM / 2 - 0.15;
      vents.push({ at: toRender(cx + 0.25 * nx, cy + 0.25 * ny, top), push: toRender(0.7 * nx, 0.7 * ny, 0), spreadM: Math.min(0.6, opening.widthM / 2), weight: 1.6 });
    }
    return vents;
  }

  private emit(id: string, fire: Burning, dt: number, spraying: boolean, snapshot: RenderSnapshot | null): void {
    const s = plumeIntensity(fire.kw);
    let carry = (this.carry.get(id) ?? this.random()) + dt * MAX_RATE * (0.35 + 0.65 * s);
    if (carry >= 1) {
      const sources = this.emitters(fire, snapshot);
      for (; carry >= 1; carry -= 1) this.spawn(pickEmitter(sources, this.random()), s, spraying);
    }
    this.carry.set(id, carry);
  }

  private freeSlot(): Puff {
    const free = this.puffs.find(p => !p.live);
    if (free !== undefined) return free;
    return this.puffs.reduce((oldest, p) => (p.age / p.life > oldest.age / oldest.life ? p : oldest)); // At the cap: recycle the oldest.
  }

  private spawn(source: Emitter, s: number, spraying: boolean): void {
    const puff = this.freeSlot();
    const r = this.random;
    const angle = r() * Math.PI * 2;
    const radius = Math.sqrt(r()) * source.spreadM;
    puff.live = true;
    puff.position.set(source.at.x + Math.cos(angle) * radius, source.at.y + r() * 0.3, source.at.z + Math.sin(angle) * radius);
    puff.velocity.set((r() - 0.5) * 0.3, 0.9 + 0.7 * s + r() * 0.35, (r() - 0.5) * 0.3).add(source.push);
    puff.age = 0;
    puff.life = MIN_LIFE_S + r() * (PUFF_LIFE_S - MIN_LIFE_S);
    puff.size0 = 0.7 + 0.6 * s + r() * 0.3;
    puff.size1 = 3 + 2.6 * s + r() * 1.2;
    puff.rotation = r() * Math.PI * 2;
    puff.spin = (r() - 0.5) * 0.25;
    puff.alpha = (0.32 + 0.43 * s) * (0.75 + 0.25 * r()) * (spraying ? 0.85 : 1);
    // Linear-light grey-black smoke; water on the fire mixes in lighter steam.
    puff.shade = spraying ? 0.2 + 0.08 * r() : 0.025 + 0.025 * r();
    puff.warmth = spraying ? 0 : 0.6 * s;
  }

  private step(dt: number): void {
    if (dt <= 0) return;
    const drag = 1 - Math.exp(-dt / 3);
    const lift = Math.exp(-dt / 6);
    for (const p of this.puffs) {
      if (!p.live) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.live = false;
        continue;
      }
      p.velocity.x += (WIND.x - p.velocity.x) * drag;
      p.velocity.z += (WIND.z - p.velocity.z) * drag;
      p.velocity.y = Math.max(0.22, p.velocity.y * lift); // Buoyancy decays; the plume keeps a slow rise.
      p.position.addScaledVector(p.velocity, dt);
      p.rotation += p.spin * dt;
    }
  }

  private draw(camera: Camera): void {
    const { right, up, forward, eye, centre, offset } = this.scratch;
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    right.set(e[0], e[1], e[2]).normalize();
    up.set(e[4], e[5], e[6]).normalize();
    forward.set(-e[8], -e[9], -e[10]).normalize();
    eye.set(e[12], e[13], e[14]);
    this.order.length = 0;
    centre.set(0, 0, 0);
    this.puffs.forEach((p, i) => {
      if (!p.live) return;
      this.order.push(i);
      this.depth[i] = forward.dot(offset.subVectors(p.position, eye));
      centre.add(p.position);
    });
    const count = this.order.length;
    this.plume.visible = count > 0;
    this.geometry.setDrawRange(0, count * 6);
    if (count === 0) return;
    centre.divideScalar(count);
    this.plume.position.copy(centre); // Sorted against other transparent objects by the plume's centre.
    this.order.sort((a, b) => this.depth[b] - this.depth[a]); // Far to near.
    this.order.forEach((index, slot) => this.writeQuad(this.puffs[index], slot, this.depth[index]));
    this.geometry.getAttribute("position").needsUpdate = true;
    this.geometry.getAttribute("color").needsUpdate = true;
  }

  /** `depthM` is the distance in front of the camera: puffs within a few metres fade so a close camera is never blacked out. */
  private writeQuad(p: Puff, slot: number, depthM: number): void {
    const { right, up, centre } = this.scratch;
    const t = p.age / p.life;
    const half = (p.size0 + (p.size1 - p.size0) * (1 - Math.exp(-p.age / 3.2))) / 2;
    const c = Math.cos(p.rotation) * half;
    const s = Math.sin(p.rotation) * half;
    // Young puffs over a hot fire carry a faint warm cast; older smoke dilutes towards a lighter grey.
    const warm = p.warmth * Math.max(0, 1 - t * 4);
    const grey = p.shade + (0.09 - p.shade) * Math.min(1, t * 1.2) * 0.6;
    const alpha = puffAlpha(p.age, p.life, p.alpha) * Math.min(1, Math.max(0, (depthM - 1) / 4));
    for (let k = 0; k < 4; k++) {
      const [cx, cy] = CORNERS[k];
      const a = cx * c - cy * s;
      const b = cx * s + cy * c;
      const o = (slot * 4 + k) * 3;
      this.positions[o] = p.position.x - centre.x + right.x * a + up.x * b;
      this.positions[o + 1] = p.position.y - centre.y + right.y * a + up.y * b;
      this.positions[o + 2] = p.position.z - centre.z + right.z * a + up.z * b;
      const q = (slot * 4 + k) * 4;
      this.colors[q] = grey + 0.05 * warm;
      this.colors[q + 1] = grey + 0.015 * warm;
      this.colors[q + 2] = grey;
      this.colors[q + 3] = alpha;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.glowMaterial.dispose();
    this.smokeMap.dispose();
    this.glowMap.dispose();
    this.light.dispose();
    this.object.removeFromParent();
    this.carry.clear();
    this.puffs.forEach(p => { p.live = false; });
  }
}
