/**
 * Audience-only fire cues (fire-presentation.ts, sensor-view.ts). Tested scope: scene-graph visibility on
 * the capture path (the same functions TwinRenderer.withSensorView uses for captures, the drone preview
 * and the thermal pass) and the plume's CPU bookkeeping: heat scaling, the sprite cap, the fade after
 * extinguishment and reduced motion. No WebGL rendering is exercised here.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Object3D } from "three";
import { Group, PerspectiveCamera, Scene } from "three";
import type { RenderSnapshot } from "../mission/protocol.ts";
import { FirePresentation, PLUME_MAX_PUFFS, PUFF_LIFE_S, plumeIntensity, puffAlpha } from "./fire-presentation.ts";
import { MaterialLibrary } from "./material-patch.ts";
import { presentationRoots, withRootsHidden } from "./sensor-view.ts";
import { SmokeField } from "./smoke-field.ts";
import { WorldEffects } from "./world-effects.ts";

const FRAME_S = 1 / 30;

type Fire = RenderSnapshot["fires"][number];

function fire(id: string, heatReleaseKW: number, extinguished = false): Fire {
  return { id, region: { kind: "box", min: { x: 20.4, y: 1.6, z: 3.6 }, max: { x: 21.3, y: 2.5, z: 4.2 } }, heatReleaseKW, extinguished };
}

function snapshot(fires: readonly Fire[]): RenderSnapshot {
  return {
    label: "simulation_truth_for_rendering",
    tick: 0,
    drone: { position: { x: 0, y: -10, z: 2 }, yawRad: 0, velocity: { x: 0, y: 0, z: 0 } },
    occupants: [],
    fires,
    rooms: [],
    openings: [],
    removedColliderIds: [],
    addedColliders: [],
    cues: { light: null, audioTemplateId: null },
    actuators: [],
    waterJet: null,
  };
}

/** Seeded PRNG (mulberry32) so particle counts are reproducible. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function viewCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(42, 16 / 9, 0.1, 400);
  camera.position.set(45, 12, 25);
  camera.lookAt(20, 6, -2);
  return camera;
}

function run(fx: FirePresentation, snap: RenderSnapshot, seconds: number, options: { readonly startS?: number; readonly reducedMotion?: boolean; readonly each?: () => void } = {}): void {
  const camera = viewCamera();
  const frames = Math.round(seconds / FRAME_S);
  for (let i = 0; i < frames; i++) {
    fx.update(snap, FRAME_S, (options.startS ?? 0) + i * FRAME_S, camera, options.reducedMotion ?? false);
    options.each?.();
  }
}

function visibleObjects(scene: Scene): Set<Object3D> {
  const seen = new Set<Object3D>();
  scene.traverseVisible(o => seen.add(o)); // Same rule as the renderer: an invisible parent hides its subtree, lights included.
  return seen;
}

describe("fire presentation on the capture path", () => {
  test("captures hide the plume, glow sprite and glow light; the physical flame stays in the drone frame", () => {
    const effects = new WorldEffects(new MaterialLibrary(new SmokeField(), 1));
    const drone = new Group();
    const overlays = new Group();
    const scene = new Scene();
    scene.add(drone, effects.physical, effects.presentation, overlays);
    const snap = snapshot([fire("fire-hall", 400)]);
    effects.update(snap, 0, false);
    run(effects.fireDisplay, snap, 3);
    const audience: Object3D[] = [effects.fireDisplay.plume, effects.fireDisplay.glow, effects.fireDisplay.light];
    const flame = effects.physical.getObjectByName("fire-fire-hall");
    assert.ok(flame !== undefined);
    assert.ok(effects.fireDisplay.puffCount > 0 && effects.fireDisplay.light.intensity > 0);

    const display = visibleObjects(scene);
    for (const o of audience) assert.ok(display.has(o), `${o.name} is drawn for the audience`);
    assert.ok(display.has(flame));

    const roots = presentationRoots({ drone, effects, overlays });
    const sensor = withRootsHidden(roots, () => visibleObjects(scene));
    for (const o of audience) assert.ok(!sensor.has(o), `${o.name} is hidden from the sensor render`);
    assert.ok(sensor.has(flame), "the physical flame is still in the drone camera frame");

    const restored = visibleObjects(scene);
    for (const o of audience) assert.ok(restored.has(o), `${o.name} is restored after the capture`);
    effects.dispose();
  });

  test("visibility is restored when a capture throws, and a root hidden beforehand stays hidden", () => {
    const shown = new Group();
    const alreadyHidden = new Group();
    alreadyHidden.visible = false;
    assert.throws(() => withRootsHidden([shown, alreadyHidden], () => {
      assert.equal(shown.visible, false);
      throw new Error("capture failed");
    }), /capture failed/);
    assert.equal(shown.visible, true);
    assert.equal(alreadyHidden.visible, false);
  });
});

describe("exterior smoke plume", () => {
  test("emission grows with heat release and never exceeds the sprite cap", () => {
    const puffsAfter = (fires: readonly Fire[]) => {
      const fx = new FirePresentation({ random: seeded(7) });
      run(fx, snapshot(fires), 20);
      const n = fx.puffCount;
      fx.dispose();
      return n;
    };
    const early = puffsAfter([fire("a", 60)]);
    const developed = puffsAfter([fire("a", 900)]);
    const many = puffsAfter([fire("a", 5000), fire("b", 5000), fire("c", 5000)]);
    assert.ok(early >= 20, `a 60 kW fire still shows a plume (${early} puffs)`);
    // The display floor (0.55) keeps a small fire's plume legible, so growth to 900 kW is smaller but must stay visible.
    assert.ok(developed > early * 1.25, `900 kW (${developed}) emits clearly more than 60 kW (${early})`);
    assert.ok(developed <= PLUME_MAX_PUFFS && many <= PLUME_MAX_PUFFS, `capped at ${PLUME_MAX_PUFFS} (${developed}, ${many})`);
    assert.equal(plumeIntensity(0), 0);
    assert.ok(plumeIntensity(60) < plumeIntensity(900) && plumeIntensity(1e6) === 1);
  });

  test("after extinguishment emission stops, the glow goes out and the plume fades over ~10–12 s", () => {
    const fx = new FirePresentation({ random: seeded(11) });
    run(fx, snapshot([fire("a", 400)]), 20);
    const out = snapshot([fire("a", 0, true)]);
    let previous = fx.puffCount;
    const counts: number[] = [];
    run(fx, out, PUFF_LIFE_S + 0.5, {
      startS: 20,
      each: () => {
        const n = fx.puffCount;
        assert.ok(n <= previous, "no new puffs once extinguished");
        previous = n;
        counts.push(n);
      },
    });
    assert.equal(fx.light.intensity, 0);
    assert.equal(fx.glow.visible, false);
    assert.ok(counts[0] > 40, `the plume is still there right after extinguishment (${counts[0]})`);
    assert.ok(counts[Math.round(8 / FRAME_S)] > 0, "puffs are still fading 8 s later");
    assert.equal(fx.puffCount, 0, `gone within ${PUFF_LIFE_S + 0.5} s`);
    assert.equal(fx.plume.visible, false);
    fx.dispose();
  });

  test("reduced motion slows the rise", () => {
    const top = (reducedMotion: boolean) => {
      const fx = new FirePresentation({ random: seeded(3) });
      run(fx, snapshot([fire("a", 400)]), 4, { reducedMotion });
      const value = fx.topM;
      fx.dispose();
      return value;
    };
    const normal = top(false);
    const reduced = top(true);
    assert.ok(normal !== null && reduced !== null && normal > reduced + 1, `normal ${normal} m vs reduced ${reduced} m`);
  });

  test("puff opacity fades in at the vent and out to zero at the end of its life", () => {
    assert.equal(puffAlpha(0, 10, 0.6), 0);
    assert.ok(puffAlpha(1, 10, 0.6) > puffAlpha(6, 10, 0.6));
    assert.equal(puffAlpha(10, 10, 0.6), 0);
    for (let t = 0; t <= 10; t += 0.25) assert.ok(puffAlpha(t, 10, 0.6) <= 0.6);
  });
});
