"use client";

import { useEffect, useRef } from "react";
import { SCREEN_H, SCREEN_W, renderScreen } from "./render";
import type { ScreenSpec } from "./screens";

/** At most 2× the 320 × 240 panel: a 640 × 480 backing store, whatever the display density. */
const MAX_SCALE = 2;

/** The console screen drawn at device size with Canvas 2D (no WebGL). */
export function ConsoleScreenCanvas({ spec, className, label }: { readonly spec: ScreenSpec; readonly className?: string; readonly label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const key = JSON.stringify(spec);
  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext("2d");
    if (element === null || ctx === null || ctx === undefined) return;
    const scale = Math.min(MAX_SCALE, Math.max(1, Math.round(window.devicePixelRatio || 1)));
    if (element.width !== SCREEN_W * scale) { element.width = SCREEN_W * scale; element.height = SCREEN_H * scale; }
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    renderScreen(ctx, JSON.parse(key) as ScreenSpec);
  }, [key]);
  return <canvas ref={canvas} className={className} width={SCREEN_W} height={SCREEN_H} role="img" aria-label={label} />;
}
