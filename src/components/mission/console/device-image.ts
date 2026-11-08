/**
 * Browser only: a console screen as the .FWI file legacy firmware shows, rendered with the same Canvas 2D renderer
 * as the on-screen mirror and named by its content (FF + the first 6 hex digits of its SHA-256, an 8.3 name).
 */
import type { DeviceImage } from "./legacy-driver";
import { encodeFwi } from "./fwi";
import { SCREEN_H, SCREEN_W, renderScreen } from "./render";
import type { ScreenSpec } from "./screens";

const MAX_CACHED = 64;
const cache = new Map<string, Promise<DeviceImage>>();

async function render(spec: ScreenSpec): Promise<DeviceImage> {
  const canvas = document.createElement("canvas");
  canvas.width = SCREEN_W;
  canvas.height = SCREEN_H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx === null) throw new Error("Canvas 2D is unavailable");
  renderScreen(ctx, spec);
  const bytes = encodeFwi(ctx.getImageData(0, 0, SCREEN_W, SCREEN_H).data, SCREEN_W, SCREEN_H);
  // Release the backing store at once (bounded pixel allocations).
  canvas.width = 0;
  canvas.height = 0;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  const hex = Array.from(digest.slice(0, 3), b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return { name: `FF${hex}.FWI`, bytes };
}

/** The device image for a screen (cached by screen content). */
export function deviceImage(spec: ScreenSpec): Promise<DeviceImage> {
  const key = JSON.stringify(spec);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const made = render(spec);
  cache.set(key, made);
  made.catch(() => cache.delete(key));
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
  return made;
}
