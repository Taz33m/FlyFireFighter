"use client";

import type { RefObject } from "react";
import { useEffect } from "react";

/**
 * Projector stage layout: keeps the 3D view above the fold. While `enabled`, writes the document offset of
 * `target` (everything above it: the sticky head, banners, the stage-size phase rail and the status strip)
 * to the CSS custom property `--fold-top` on `root`, so CSS can size the view to the rest of the viewport
 * with `calc(100dvh - var(--fold-top))`. Re-measures when anything above the target changes size (a halt
 * banner, a longer caption, a notice) and when the window resizes. Measurement only; no layout decisions.
 */
export function useFoldTop(root: RefObject<HTMLElement | null>, target: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const rootEl = root.current;
    const targetEl = target.current;
    if (!enabled || rootEl === null || targetEl === null) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const top = targetEl.getBoundingClientRect().top + window.scrollY;
        rootEl.style.setProperty("--fold-top", `${Math.max(0, Math.round(top))}px`);
      });
    };
    const observer = new ResizeObserver(measure);
    const observeAbove = () => {
      observer.disconnect();
      for (const child of Array.from(rootEl.children)) {
        if (child === targetEl || child.contains(targetEl)) break;
        observer.observe(child);
      }
    };
    observeAbove();
    // Banners and notices mount and unmount above the target; re-observe the new siblings.
    const mutations = new MutationObserver(() => {
      observeAbove();
      measure();
    });
    mutations.observe(rootEl, { childList: true });
    window.addEventListener("resize", measure);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", measure);
      rootEl.style.removeProperty("--fold-top");
    };
  }, [root, target, enabled]);
}
