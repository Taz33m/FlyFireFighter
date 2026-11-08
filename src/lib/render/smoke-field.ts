/**
 * Per-room smoke uniforms shared by every patched material (see material-patch.ts for the shader).
 *
 * Rooms come from scene.meta.json as render-frame boxes (each L-shaped room is split exactly into
 * rectangles); σ comes from the snapshot's smokeExtinctionPerM. The shader integrates optical depth
 * along each camera ray with the fire model's 0.5×–1.5× floor-to-ceiling profile, so the drone camera
 * frame darkens and hazes as the snapshot says. Three.js applies the result after its colour-space
 * conversion: in linear light for the sensor render target, and in display-encoded sRGB on the canvas (a
 * presentation approximation only); the smoke colour uniform is switched to match.
 */
import { Color, Vector3 } from "three";
import type { SceneMetaJson } from "../contracts/scene.ts";
import type { RenderSnapshot } from "../mission/protocol.ts";
import { roomBoxes } from "./room-boxes.ts";

export const SMOKE_MAX_BOXES = 32;

/** In-scattered smoke radiance, linear RGB (a dim, slightly warm grey under interior light). */
const SMOKE_LINEAR = new Color(0.05, 0.048, 0.045);

interface RenderBox {
  readonly min: Vector3;
  readonly max: Vector3;
}

export class SmokeField {
  readonly uniforms = {
    smokeCount: { value: 0 },
    smokeMin: { value: Array.from({ length: SMOKE_MAX_BOXES }, () => new Vector3()) },
    smokeMax: { value: Array.from({ length: SMOKE_MAX_BOXES }, () => new Vector3()) },
    smokeSigma: { value: new Float32Array(SMOKE_MAX_BOXES) },
    smokeColor: { value: new Color() },
  };

  private readonly rooms = new Map<string, readonly RenderBox[]>();
  private readonly displayColor = SMOKE_LINEAR.clone().convertLinearToSRGB();

  constructor() {
    this.setOutput("display");
  }

  /** Room volumes from the scene metadata (world frame) converted to render-frame boxes. */
  setRooms(rooms: SceneMetaJson["rooms"]): void {
    this.rooms.clear();
    for (const room of rooms) {
      // world (x, y, z) -> render (x, z, -y); render Y spans the room's zMin..zMax for the vertical profile.
      this.rooms.set(room.id, roomBoxes(room.polygon, room.zMin, room.zMax).map(b => ({
        min: new Vector3(b.min[0], b.min[2], -b.max[1]),
        max: new Vector3(b.max[0], b.max[2], -b.min[1]),
      })));
    }
  }

  /** Upload the snapshot's extinction coefficients; densest rooms win if the box budget overflows. */
  update(snapshotRooms: RenderSnapshot["rooms"] | null): void {
    const active = (snapshotRooms ?? []).filter(r => r.smokeExtinctionPerM > 0 && this.rooms.has(r.id)).sort((a, b) => b.smokeExtinctionPerM - a.smokeExtinctionPerM);
    let count = 0;
    for (const room of active) {
      for (const box of this.rooms.get(room.id) ?? []) {
        if (count >= SMOKE_MAX_BOXES) break;
        this.uniforms.smokeMin.value[count].copy(box.min);
        this.uniforms.smokeMax.value[count].copy(box.max);
        this.uniforms.smokeSigma.value[count] = room.smokeExtinctionPerM;
        count++;
      }
    }
    this.uniforms.smokeCount.value = count;
  }

  /** The canvas receives display-encoded colour; the sensor render target stays in linear light. */
  setOutput(target: "display" | "sensor"): void {
    this.uniforms.smokeColor.value.copy(target === "display" ? this.displayColor : SMOKE_LINEAR);
  }
}
