/**
 * One shader patch per material for everything the twin and the drone camera draw:
 *
 * - Smoke (all patched materials): Beer–Lambert transmission along the camera→fragment ray through room
 *   boxes, T = exp(-τ). Each room's extinction follows the fire model's vertical profile, σ(z) = σ_room ·
 *   (0.5 + (z − zMin)/(zMax − zMin)) — 0.5× at the floor to 1.5× at the ceiling. σ is linear along a
 *   straight segment, so the segment integral is exactly σ at the segment midpoint times its length.
 *   Opaque surfaces blend toward the in-scattered smoke colour; additive effects are only attenuated.
 * - Detail (lit materials with a class): the procedural texture for the material class, projected
 *   triplanar in world metres (the GLB has no UVs), modulating albedo by 1 + strength · (2d − 1).
 *
 * Uniform objects for smoke are shared by all materials (see SmokeField); detail uniforms are per
 * material, with one texture per class. Texture set: TEXTURE_SET_VERSION.
 */
import type { Material, WebGLProgramParametersWithUniforms } from "three";
import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RedFormat, RepeatWrapping, UnsignedByteType } from "three";
import type { DetailClass } from "./procedural-textures.ts";
import { DETAIL_SIZE, DETAIL_SPECS, TEXTURE_SET_VERSION, generateDetail } from "./procedural-textures.ts";
import type { SmokeField } from "./smoke-field.ts";
import { SMOKE_MAX_BOXES } from "./smoke-field.ts";

export type SmokeMode = "scatter" | "attenuate";

const VERTEX_PARS = "#include <fog_pars_vertex>\nvarying vec3 vSmokeWorld;\n#ifdef USE_DETAIL\nvarying vec3 vDetailNormal;\n#endif";
const VERTEX_MAIN = "#include <fog_vertex>\nvSmokeWorld = cameraPosition + transpose(mat3(viewMatrix)) * mvPosition.xyz;";
const VERTEX_NORMAL = "#include <defaultnormal_vertex>\n#ifdef USE_DETAIL\nvDetailNormal = normalize(mat3(modelMatrix) * objectNormal);\n#endif";

const FRAGMENT_PARS = `#include <fog_pars_fragment>
#define SMOKE_MAX_BOXES ${SMOKE_MAX_BOXES}
uniform int smokeCount;
uniform vec3 smokeMin[SMOKE_MAX_BOXES];
uniform vec3 smokeMax[SMOKE_MAX_BOXES];
uniform float smokeSigma[SMOKE_MAX_BOXES];
uniform vec3 smokeColor;
varying vec3 vSmokeWorld;
#ifdef USE_DETAIL
uniform sampler2D detailMap;
uniform float detailTile;
uniform float detailStrength;
varying vec3 vDetailNormal;
#endif
float smokeTransmittance(vec3 a, vec3 b) {
  vec3 d = b - a;
  float len = length(d);
  if (smokeCount == 0 || len < 1e-4) return 1.0;
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
  return exp(-tau);
}`;

const FRAGMENT_DETAIL = `#include <color_fragment>
#ifdef USE_DETAIL
{
  vec3 w = abs(normalize(vDetailNormal));
  w = w * w * w * w;
  w /= max(w.x + w.y + w.z, 1e-5);
  vec3 p = vSmokeWorld / detailTile;
  float d = texture2D(detailMap, p.zy).r * w.x + texture2D(detailMap, p.xz).r * w.y + texture2D(detailMap, p.xy).r * w.z;
  diffuseColor.rgb *= 1.0 + detailStrength * (2.0 * d - 1.0);
}
#endif`;

const FRAGMENT_MAIN = `#include <fog_fragment>
{
  float smokeT = smokeTransmittance(cameraPosition, vSmokeWorld);
#ifdef SMOKE_ATTENUATE
  gl_FragColor.rgb *= smokeT;
#else
  gl_FragColor.rgb = mix(smokeColor, gl_FragColor.rgb, smokeT);
#endif
}`;

interface LitMaterial extends Material {
  readonly isMeshStandardMaterial?: boolean;
  readonly isMeshLambertMaterial?: boolean;
  readonly isMeshPhongMaterial?: boolean;
}

export class MaterialLibrary {
  readonly smoke: SmokeField;
  readonly textureSetVersion = TEXTURE_SET_VERSION;
  private readonly textures = new Map<DetailClass, DataTexture>();
  private readonly anisotropy: number;

  constructor(smoke: SmokeField, anisotropy: number) {
    this.smoke = smoke;
    this.anisotropy = Math.max(1, Math.min(4, anisotropy));
  }

  private texture(cls: DetailClass): DataTexture {
    const existing = this.textures.get(cls);
    if (existing !== undefined) return existing;
    const texture = new DataTexture(generateDetail(cls), DETAIL_SIZE, DETAIL_SIZE, RedFormat, UnsignedByteType);
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.magFilter = LinearFilter;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = this.anisotropy;
    texture.needsUpdate = true;
    this.textures.set(cls, texture);
    return texture;
  }

  /** Patch a material once. Detail applies only to lit materials, which have per-vertex normals. */
  patch(material: Material, options: { readonly smoke?: SmokeMode; readonly detail?: DetailClass | null } = {}): void {
    if (material.userData.patched === true) return;
    material.userData.patched = true;
    const mode = options.smoke ?? "scatter";
    const lit = material as LitMaterial;
    const detail = options.detail != null && (lit.isMeshStandardMaterial === true || lit.isMeshLambertMaterial === true || lit.isMeshPhongMaterial === true) ? options.detail : null;
    const smokeUniforms = this.smoke.uniforms;
    const detailUniforms = detail === null ? null : { detailMap: { value: this.texture(detail) }, detailTile: { value: DETAIL_SPECS[detail].tileM }, detailStrength: { value: DETAIL_SPECS[detail].strength } };
    material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
      Object.assign(shader.uniforms, smokeUniforms, detailUniforms ?? {});
      const defines = `${mode === "attenuate" ? "#define SMOKE_ATTENUATE\n" : ""}${detail === null ? "" : "#define USE_DETAIL\n"}`;
      shader.vertexShader = defines + shader.vertexShader.replace("#include <fog_pars_vertex>", VERTEX_PARS).replace("#include <fog_vertex>", VERTEX_MAIN).replace("#include <defaultnormal_vertex>", VERTEX_NORMAL);
      shader.fragmentShader = defines + shader.fragmentShader.replace("#include <fog_pars_fragment>", FRAGMENT_PARS).replace("#include <color_fragment>", FRAGMENT_DETAIL).replace("#include <fog_fragment>", FRAGMENT_MAIN);
    };
    material.customProgramCacheKey = () => `ffft-${mode}-${detail === null ? "flat" : "detail"}`;
    material.needsUpdate = true;
  }

  dispose(): void {
    for (const texture of this.textures.values()) texture.dispose();
    this.textures.clear();
  }
}
