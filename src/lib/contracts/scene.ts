/**
 * Scene metadata exported by the Blender recipe (public/scenes/<scene>/scene.meta.json).
 *
 * Coordinates are in the simulation world frame (local site frame: metres, right-handed, Z up; see frames.ts
 * and the scene's origin description for its rotation from true east/north), never glTF Y-up.
 * Colliders are axis-aligned boxes and are the authoritative collision geometry. `scenarioAnchors` is
 * scenario initialization only and must never be copied into a planner's floor-plan prior.
 */
import type { Vec3 } from "./frames.ts";
import { vec3 } from "./frames.ts";

export const SCENE_META_SCHEMA = "flyfirefighter.scene-meta/1";

export type JsonVec3 = readonly [number, number, number];
export type JsonPoint2 = readonly [number, number];

export type ColliderKind = "ground" | "wall" | "floor" | "ceiling" | "roof" | "stair" | "furniture" | "glass" | "door" | "tree" | "street_furniture";

export interface SceneCollider {
  readonly id: string;
  readonly kind: ColliderKind;
  readonly min: JsonVec3;
  readonly max: JsonVec3;
  /** Glass panes and closed door leaves name their opening so the simulator can remove them. */
  readonly openingId?: string;
}

export interface SceneSource {
  readonly title: string;
  readonly url: string;
  readonly license: string;
  readonly retrieved: string;
}

export interface SceneMetaJson {
  readonly schema: typeof SCENE_META_SCHEMA;
  readonly sceneId: string;
  readonly revision: number;
  readonly units: "m";
  readonly frames: { readonly world: string; readonly gltf: string };
  readonly origin: { readonly description: string; readonly latLon: readonly [number, number] | null };
  readonly provenance: {
    readonly exterior: { readonly reference: string; readonly method: string; readonly sources: readonly SceneSource[]; readonly estimated: readonly string[] };
    readonly interior: { readonly kind: "authored_fictional"; readonly statement: string };
    readonly incident: "fictional";
  };
  readonly floors: readonly { readonly index: number; readonly elevationM: number; readonly ceilingM: number }[];
  readonly rooms: readonly {
    readonly id: string;
    readonly name: string;
    readonly floor: number;
    readonly polygon: readonly JsonPoint2[];
    readonly zMin: number;
    readonly zMax: number;
  }[];
  readonly openings: readonly {
    readonly id: string;
    readonly kind: "door" | "window" | "opening";
    readonly rooms: readonly [string, string];
    readonly center: JsonVec3;
    readonly widthM: number;
    readonly heightM: number;
    readonly sillHeightM: number;
    readonly outwardNormal: JsonVec3;
    readonly initialState: "open" | "closed";
    readonly glazed: boolean;
  }[];
  readonly stairs: readonly { readonly id: string; readonly fromFloor: number; readonly toFloor: number; readonly bottom: JsonVec3; readonly top: JsonVec3; readonly widthM: number }[];
  readonly colliders: readonly SceneCollider[];
  readonly exits: readonly { readonly id: string; readonly openingId: string }[];
  readonly assemblyPoint: { readonly id: string; readonly min: JsonVec3; readonly max: JsonVec3 };
  readonly launchPoint: { readonly position: JsonVec3; readonly yawRad: number };
  readonly scenarioAnchors: { readonly scenarioOnly: true; readonly note: string; readonly fireOrigin: JsonVec3; readonly occupantStart: JsonVec3 };
  readonly drone: {
    readonly spanM: number;
    readonly heightM: number;
    readonly camera: { readonly positionBody: JsonVec3; readonly pitchRad: number; readonly horizontalFovDeg: number };
  };
  readonly bounds: { readonly min: JsonVec3; readonly max: JsonVec3 };
  readonly assets: { readonly [file: string]: { readonly sha256: string; readonly bytes: number; readonly triangles: number } };
}

export function fromJsonVec3(v: JsonVec3): Vec3 {
  return vec3(v[0], v[1], v[2]);
}
