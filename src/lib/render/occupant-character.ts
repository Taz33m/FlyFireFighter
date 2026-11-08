/**
 * The rigged occupant character: public/actors/occupant.glb (built by assets/actors/build_scan_occupant.py).
 *
 * A licensed scanned character (Mike Alger, CC BY 4.0; credits in assets/actors/THIRD_PARTY_NOTICES.md)
 * with Microsoft Rocketbox clips (MIT) retargeted onto its skeleton. It depicts a fictional occupant. The
 * GLB's origin is the feet point, it faces glTF +X, and locomotion is in place, so the simulator's
 * position and yaw drive it directly.
 *
 * One template is loaded per renderer; each occupant gets a SkeletonUtils clone (shared geometry,
 * materials and textures; its own bones and skeleton) and an AnimationMixer. The mixer never runs on
 * its own clock: every frame the blend state (occupant-animation.ts) sets each action's time and weight
 * and the mixer is evaluated with dt = 0. A drone-camera capture or reduced motion applies the frozen
 * pose instead, which depends only on the snapshot, so identical snapshots give identical frames.
 */
import type { AnimationAction, AnimationClip, Material, Mesh, Object3D, Skeleton, SkinnedMesh } from "three";
import { AnimationMixer } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { disposeObject } from "./dispose.ts";
import type { MaterialLibrary } from "./material-patch.ts";
import type { BlendState, ClipName, ClipWeight, SpeedEstimate } from "./occupant-animation.ts";
import { CLIP_NAMES, blendWeights, clipFor, frozenWeights, initialBlend, playbackRate, stepBlend, updateSpeed } from "./occupant-animation.ts";

export { CHARACTER_LABEL } from "./occupant-animation.ts";
export const OCCUPANT_GLB_URL = "/actors/occupant.glb";

function skeletonsOf(root: Object3D): Set<Skeleton> {
  const skeletons = new Set<Skeleton>();
  root.traverse(o => {
    const mesh = o as SkinnedMesh;
    if (mesh.isSkinnedMesh === true) skeletons.add(mesh.skeleton);
  });
  return skeletons;
}

export class CharacterTemplate {
  readonly scene: Object3D;
  readonly clips: ReadonlyMap<ClipName, AnimationClip>;
  readonly durations: Readonly<Partial<Record<ClipName, number>>>;

  private constructor(scene: Object3D, clips: Map<ClipName, AnimationClip>) {
    this.scene = scene;
    this.clips = clips;
    this.durations = Object.fromEntries([...clips].map(([name, clip]) => [name, clip.duration]));
  }

  /** Load and prepare the template; rejects if the file is missing or lacks any snapshot clip. */
  static async load(url: string, library: MaterialLibrary): Promise<CharacterTemplate> {
    const gltf = await new GLTFLoader().loadAsync(url);
    const clips = new Map<ClipName, AnimationClip>();
    for (const clip of gltf.animations) if ((CLIP_NAMES as readonly string[]).includes(clip.name)) clips.set(clip.name as ClipName, clip);
    const missing = CLIP_NAMES.filter(name => !clips.has(name));
    if (missing.length > 0) {
      disposeObject(gltf.scene);
      throw new Error(`occupant.glb lacks clips: ${missing.join(", ")}`);
    }
    gltf.scene.traverse(object => {
      const mesh = object as Mesh;
      if (mesh.isMesh !== true) return;
      // Skinned bounds follow the bind pose; never let a crouch or stride be culled from a capture.
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      const materials: Material[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach(m => library.patch(m)); // Smoke attenuation; textured, so no detail map.
    });
    gltf.scene.name = "occupant-character";
    return new CharacterTemplate(gltf.scene, clips);
  }

  /** Dispose shared geometry, materials and textures. Call after every instance is disposed. */
  dispose(): void {
    skeletonsOf(this.scene).forEach(s => s.dispose());
    disposeObject(this.scene);
  }
}

export interface CharacterPoseInput {
  readonly animation: string;
  readonly position: { readonly x: number; readonly y: number };
}

export class CharacterInstance {
  readonly object: Object3D;
  private readonly template: CharacterTemplate;
  private readonly mixer: AnimationMixer;
  private readonly actions = new Map<ClipName, AnimationAction>();
  private blend: BlendState | null = null;
  private speed: SpeedEstimate | null = null;

  constructor(template: CharacterTemplate) {
    this.template = template;
    this.object = cloneSkinned(template.scene);
    this.mixer = new AnimationMixer(this.object);
    for (const [name, clip] of template.clips) {
      const action = this.mixer.clipAction(clip);
      action.enabled = false;
      action.play();
      this.actions.set(name, action);
    }
  }

  /**
   * Pose for one frame. `animate` advances the crossfade by dtS (display frames); otherwise the frozen
   * pose for the snapshot animation is applied without touching the blend or speed history, so a
   * capture between display frames has no side effects.
   */
  update(occupant: CharacterPoseInput, tick: number, dtS: number, animate: boolean): void {
    if (!animate) {
      this.apply(frozenWeights(occupant.animation, this.template.durations));
      return;
    }
    const target = clipFor(occupant.animation);
    this.speed = updateSpeed(this.speed, tick, occupant.position.x, occupant.position.y);
    this.blend = stepBlend(this.blend ?? initialBlend(target), target, dtS, this.template.durations, playbackRate(target, this.speed.speedMps));
    this.apply(blendWeights(this.blend));
  }

  private apply(weights: readonly ClipWeight[]): void {
    for (const [name, action] of this.actions) {
      const w = weights.find(x => x.clip === name);
      action.enabled = w !== undefined && w.weight > 0;
      if (w === undefined) continue;
      action.setEffectiveWeight(w.weight);
      action.time = w.time;
    }
    this.mixer.update(0);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    for (const clip of this.template.clips.values()) this.mixer.uncacheAction(clip, this.object);
    this.mixer.uncacheRoot(this.object);
    skeletonsOf(this.object).forEach(s => s.dispose()); // Bone textures; geometry and materials are the template's.
    this.object.removeFromParent();
  }
}
