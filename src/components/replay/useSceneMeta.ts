"use client";

/**
 * The scene metadata a replay is drawn on, fetched once: its hash against the one the run recorded, and the
 * floor-plan prior built from it (floorPlanPriorFromScene) for room and opening names on the phase rail. The
 * prior carries only what a supplied plan would (no scenario anchors or runtime truth). If it cannot be
 * built, the rail still works with reduced captions.
 */
import { useEffect, useState } from "react";
import type { FloorPlanPrior } from "@/lib/contracts/evidence";
import type { SceneMetaJson } from "@/lib/contracts/scene";
import { floorPlanPriorFromScene } from "@/lib/simulation/prior";
import { sha256Text } from "@/components/results/loaders";

export const SCENE_URL = "/scenes/troy-training/";

export type SceneCheck = "checking" | "match" | "differs" | "unrecorded" | "unavailable";

export const SCENE_WORDS: Readonly<Record<SceneCheck, string>> = {
  checking: "Checking the scene files against the recorded hash",
  match: "Scene metadata matches the recorded run",
  differs: "Scene metadata differs from the recorded run: the replay is drawn on the current scene files",
  unrecorded: "The run did not record a scene hash",
  unavailable: "Scene metadata could not be fetched",
};

export interface SceneMeta {
  readonly check: SceneCheck;
  readonly prior: FloorPlanPrior | null;
  /** Why the prior is missing (the rail then names no rooms or openings); null when it was built. */
  readonly priorProblem: string | null;
}

const CHECKING: SceneMeta = { check: "checking", prior: null, priorProblem: null };

function priorFrom(text: string): { prior: FloorPlanPrior | null; priorProblem: string | null } {
  try {
    return { prior: floorPlanPriorFromScene(JSON.parse(text) as SceneMetaJson), priorProblem: null };
  } catch (error) {
    return { prior: null, priorProblem: `The floor-plan prior could not be built from the scene metadata (${error instanceof Error ? error.message : String(error)}); captions name no rooms.` };
  }
}

export function useSceneMeta(expectedSha256: string | null | undefined): SceneMeta {
  const [state, setState] = useState<SceneMeta>(CHECKING);
  useEffect(() => {
    const controller = new AbortController();
    const expected = expectedSha256 ?? null;
    fetch(`${SCENE_URL}scene.meta.json`, { signal: controller.signal, cache: "no-store" })
      .then(r => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(async text => {
        const check: SceneCheck = expected === null ? "unrecorded" : (await sha256Text(text)) === expected ? "match" : "differs";
        if (!controller.signal.aborted) setState({ check, ...priorFrom(text) });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ check: expected === null ? "unrecorded" : "unavailable", prior: null, priorProblem: "Scene metadata could not be fetched; captions name no rooms." });
      });
    return () => controller.abort();
  }, [expectedSha256]);
  return state;
}
