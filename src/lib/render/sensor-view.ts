/**
 * Which scene roots the drone camera never sees. Every sensor capture, the drone-camera preview and
 * every auxiliary pass (the thermal view) draw with these roots hidden, so audience-only objects (the
 * aircraft's own body, belief overlays, the light-cue beam, the fire glow and the exterior smoke plume
 * under WorldEffects.presentation) cannot steer the flight.
 */
import type { Object3D } from "three";

export interface PresentationParts {
  /** The aircraft body: the lens is inside it. */
  readonly drone: Object3D;
  /** WorldEffects: `presentation` holds the cue beam and the FirePresentation group. */
  readonly effects: { readonly presentation: Object3D };
  readonly overlays: Object3D;
}

export function presentationRoots(parts: PresentationParts): readonly Object3D[] {
  return [parts.drone, parts.effects.presentation, parts.overlays];
}

/** Hide `roots` while `draw` runs, then restore exactly the ones that were visible (also on throw). */
export function withRootsHidden<T>(roots: readonly Object3D[], draw: () => T): T {
  const hidden = roots.filter(o => o.visible);
  hidden.forEach(o => { o.visible = false; });
  try {
    return draw();
  } finally {
    hidden.forEach(o => { o.visible = true; });
  }
}
