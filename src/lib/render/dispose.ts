/**
 * GPU resource release. Geometries, materials and their textures are disposed once each, even when
 * shared between meshes, so resets and unmounts do not leak GPU memory on the shared Mac.
 */
import type { BufferGeometry, Material, Object3D, Texture } from "three";

function isTexture(value: unknown): value is Texture {
  return typeof value === "object" && value !== null && (value as { isTexture?: boolean }).isTexture === true;
}

export function disposeMaterial(material: Material, seen: Set<object> = new Set()): void {
  if (seen.has(material)) return;
  seen.add(material);
  for (const value of Object.values(material)) {
    if (isTexture(value) && !seen.has(value)) {
      seen.add(value);
      value.dispose();
    }
  }
  material.dispose();
}

/** Dispose everything reachable from `root` and detach it from its parent. */
export function disposeObject(root: Object3D): void {
  const seen = new Set<object>();
  root.traverse(object => {
    const mesh = object as Object3D & { geometry?: BufferGeometry; material?: Material | Material[] };
    if (mesh.geometry !== undefined && !seen.has(mesh.geometry)) {
      seen.add(mesh.geometry);
      mesh.geometry.dispose();
    }
    const materials = mesh.material === undefined ? [] : Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) disposeMaterial(material, seen);
  });
  root.removeFromParent();
}
