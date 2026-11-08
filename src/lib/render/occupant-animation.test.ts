/**
 * Occupant animation logic: clip selection, crossfade continuity, speed-matched walk rate, the frozen
 * (capture / reduced-motion) pose, and consistency with the built asset (public/actors/occupant.glb and
 * its provenance: hash, budgets, clips, grounding, native speeds, label, licences and credits). Rendering
 * and skinning themselves are verified in the browser, not here.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { BlendState, ClipName } from "./occupant-animation.ts";
import { CHARACTER_LABEL, CLIP_NAMES, FADE_S, FROZEN_TIME_S, NATIVE_SPEED_MPS, TICK_HZ, blendWeights, clipFor, frozenWeights, initialBlend, playbackRate, stepBlend, updateSpeed } from "./occupant-animation.ts";

const durations: Record<ClipName, number> = { idle: 2.7333, crouch: 6.8667, cough: 3.6667, walk: 1.2, follow: 1.4667 };
const weightOf = (s: BlendState, clip: ClipName) => blendWeights(s).find(w => w.clip === clip)?.weight ?? 0;
const total = (s: BlendState) => blendWeights(s).reduce((sum, w) => sum + w.weight, 0);

describe("clip selection", () => {
  test("each snapshot animation has its own clip; unknown values fall back to idle", () => {
    for (const clip of CLIP_NAMES) assert.equal(clipFor(clip), clip);
    assert.equal(clipFor("run"), "idle");
    assert.equal(clipFor(""), "idle");
  });
});

describe("crossfade", () => {
  test("a switch fades over FADE_S with weights summing to 1 and no jump at the start", () => {
    let s = stepBlend(initialBlend("idle"), "idle", 0.5, durations);
    s = stepBlend(s, "walk", 0, durations);
    assert.equal(weightOf(s, "idle"), 1);
    assert.equal(weightOf(s, "walk"), 0);
    assert.equal(s.times.walk, 0, "the incoming clip starts from its beginning");
    for (let i = 0; i < 5; i++) {
      s = stepBlend(s, "walk", FADE_S / 10, durations);
      assert.ok(Math.abs(total(s) - 1) < 1e-9);
    }
    assert.ok(Math.abs(weightOf(s, "walk") - 0.5) < 1e-9);
    s = stepBlend(s, "walk", FADE_S, durations);
    assert.deepEqual(blendWeights(s).map(w => [w.clip, w.weight]), [["walk", 1]]);
    assert.equal(s.previous, null);
  });

  test("going back mid-fade reverses the fade without a weight discontinuity", () => {
    let s = stepBlend(initialBlend("idle"), "crouch", 0, durations);
    s = stepBlend(s, "crouch", FADE_S * 0.3, durations);
    const before = weightOf(s, "idle");
    s = stepBlend(s, "idle", 0, durations);
    assert.ok(Math.abs(weightOf(s, "idle") - before) < 1e-9);
    assert.equal(s.current, "idle");
  });

  test("a third clip interrupting a fade fades out from the dominant clip", () => {
    let s = stepBlend(initialBlend("idle"), "walk", 0, durations);
    s = stepBlend(s, "walk", FADE_S * 0.8, durations);
    s = stepBlend(s, "cough", 0, durations);
    assert.equal(s.previous, "walk");
    assert.equal(weightOf(s, "walk"), 1);
  });

  test("clip time advances by rate and wraps at the clip duration; invalid dt does not advance", () => {
    let s = initialBlend("walk");
    s = stepBlend(s, "walk", 1.0, durations, 1.5);
    assert.ok(Math.abs((s.times.walk ?? 0) - (1.5 % durations.walk)) < 1e-9);
    const frozen = stepBlend(s, "walk", Number.NaN, durations);
    assert.equal(frozen.times.walk, s.times.walk);
    assert.equal(stepBlend(s, "walk", -1, durations).times.walk, s.times.walk);
  });

  test("stepping is pure: the input state is not modified", () => {
    const s = initialBlend("idle");
    const copy = JSON.stringify(s);
    stepBlend(s, "follow", 0.1, durations);
    assert.equal(JSON.stringify(s), copy);
  });
});

describe("walk rate", () => {
  test("locomotion matches ground speed within limits; other clips and unknown speed play at 1", () => {
    assert.ok(Math.abs(playbackRate("walk", NATIVE_SPEED_MPS.walk ?? 0) - 1) < 1e-9);
    assert.ok(Math.abs(playbackRate("follow", 0.6) - 0.6 / (NATIVE_SPEED_MPS.follow ?? 1)) < 1e-9);
    assert.equal(playbackRate("walk", 5), 1.6);
    assert.equal(playbackRate("walk", 0.2), 0.6);
    assert.equal(playbackRate("walk", null), 1);
    assert.equal(playbackRate("walk", 0), 1, "a stalled walker keeps a natural cadence");
    assert.equal(playbackRate("idle", 1), 1);
  });

  test("speed comes from simulation ticks, ignores repeated ticks and restarts on reset or gaps", () => {
    let e = updateSpeed(null, 100, 0, 0);
    assert.equal(e.speedMps, null);
    e = updateSpeed(e, 110, 0.1, 0);
    assert.ok(Math.abs((e.speedMps ?? 0) - 0.1 / (10 / TICK_HZ)) < 1e-9);
    assert.equal(updateSpeed(e, 110, 5, 5), e, "the same tick is not a new sample");
    const smoothed = updateSpeed(e, 120, 0.1, 0);
    assert.ok((smoothed.speedMps ?? 0) < (e.speedMps ?? 0) && (smoothed.speedMps ?? 0) > 0);
    assert.equal(updateSpeed(e, 50, 0, 0).speedMps, null);
    assert.equal(updateSpeed(e, 110 + TICK_HZ + 1, 9, 9).speedMps, null);
  });
});

describe("frozen pose", () => {
  test("depends only on the animation: a fixed representative clip time at full weight", () => {
    const a = frozenWeights("cough", durations);
    assert.deepEqual(frozenWeights("cough", durations), a);
    assert.deepEqual(a, [{ clip: "cough", time: FROZEN_TIME_S.cough, weight: 1 }]);
    assert.equal(frozenWeights("nonsense", durations)[0].clip, "idle");
  });
});

describe("built asset", () => {
  const glb = readFileSync(new URL("../../../public/actors/occupant.glb", import.meta.url));
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8")) as {
    animations: { name: string; samplers: { input: number }[] }[];
    accessors: { max?: number[]; count: number }[];
    meshes: { primitives: { indices?: number; attributes: Record<string, number>; targets?: unknown[] }[] }[];
    skins?: { joints: number[] }[];
  };
  const provenance = JSON.parse(readFileSync(new URL("../../../public/actors/occupant.provenance.json", import.meta.url), "utf8")) as {
    label: string;
    isScan: boolean;
    export: {
      sha256: string;
      bytes: number;
      triangles: number;
      joints: number;
      textures: { size: number[] }[];
      animations: { name: string; durationS: number; nativeSpeedMps: number; minFootZ: number; pelvisHorizontalMaxM: number }[];
    };
    licences: { spdx: string; covers: string; text: string }[];
    attribution: { character: string; sketchfabCredit: string; animations: string };
  };
  const clipEnd = (a: (typeof json.animations)[number]) => Math.max(...a.samplers.map(s => json.accessors[s.input].max?.[0] ?? 0));

  test("the GLB has exactly the snapshot's animation clips", () => {
    assert.equal(glb.readUInt32LE(0), 0x46546c67);
    assert.deepEqual(json.animations.map(a => a.name).sort(), [...CLIP_NAMES].sort());
  });

  test("the provenance describes this exact GLB", () => {
    assert.equal(createHash("sha256").update(glb).digest("hex"), provenance.export.sha256, "rebuild with assets/actors/build_scan_occupant.py");
    assert.equal(glb.length, provenance.export.bytes);
    const triangles = json.meshes.flatMap(m => m.primitives).reduce((n, p) => n + json.accessors[p.indices ?? p.attributes.POSITION].count / 3, 0);
    assert.equal(triangles, provenance.export.triangles);
    assert.equal(json.skins?.[0].joints.length, provenance.export.joints);
    for (const a of json.animations) {
      const recorded = provenance.export.animations.find(p => p.name === a.name);
      assert.ok(recorded !== undefined && Math.abs(clipEnd(a) - recorded.durationS) < 1e-3, a.name);
    }
  });

  test("asset budgets and contract: scanned adult within 30k-60k triangles, <= 2K textures, <= 8 MB, no morph targets, grounded in-place clips", () => {
    assert.ok(provenance.export.triangles >= 30000 && provenance.export.triangles <= 60000, String(provenance.export.triangles));
    assert.ok(provenance.export.textures.every(t => t.size.every(px => px <= 2048)));
    assert.ok(glb.length <= 8 * 1024 * 1024);
    assert.ok(json.meshes.every(m => m.primitives.every(p => p.targets === undefined)), "facial shape keys are not exported");
    for (const a of provenance.export.animations) {
      assert.ok(Math.abs(a.minFootZ) <= 0.05, `${a.name} lowest point ${a.minFootZ} m`);
      assert.ok(a.pelvisHorizontalMaxM <= 0.12, `${a.name} pelvis drift ${a.pelvisHorizontalMaxM} m`);
    }
  });

  test("the runtime label and the recorded licences and credits match the asset", () => {
    assert.equal(provenance.label, CHARACTER_LABEL);
    assert.equal(provenance.isScan, true);
    assert.deepEqual(provenance.licences.map(l => l.spdx).sort(), ["CC-BY-4.0", "MIT"]);
    assert.ok(provenance.licences.every(l => l.text.length > 200), "full licence texts are recorded");
    assert.match(provenance.attribution.sketchfabCredit, /^This work is based on "Rigged T-Pose Human Male w 50 Face Blendshapes" .* by Mike Alger .* licensed under CC-BY-4\.0/);
    assert.match(provenance.attribution.character, /does not endorse/);
    assert.match(provenance.attribution.animations, /Copyright \(c\) 2020 Microsoft, MIT License/);
  });

  test("frozen times fall inside each clip and native speeds match the provenance", () => {
    for (const a of json.animations) {
      const end = clipEnd(a);
      const clip = clipFor(a.name);
      assert.ok(FROZEN_TIME_S[clip] < end, `${clip} frozen time ${FROZEN_TIME_S[clip]} within ${end}`);
    }
    for (const a of provenance.export.animations) {
      const native = NATIVE_SPEED_MPS[clipFor(a.name)];
      if (a.nativeSpeedMps > 0) assert.equal(native, a.nativeSpeedMps, a.name);
      else assert.equal(native, undefined, a.name);
    }
  });
});
