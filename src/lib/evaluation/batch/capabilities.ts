/**
 * What this machine and this checkout can run, detected before a batch:
 * - flyvisService: a FlyVis service answering a reset on ws://127.0.0.1:3201 (the engineered-readout arm
 *   needs it; without it that arm is recorded as not run, never substituted);
 * - runtime options: whether MissionRuntime's RuntimeOptions declares `rangeAssist` (range assistance off)
 *   and `initialWaterL` (payload exhaustion). TypeScript types are erased at run time, so this reads the
 *   declaration in src/lib/mission/runtime.ts; an undeclared option would be silently ignored, which would
 *   make the arm identical to the baseline while labelled otherwise.
 */
import { readFileSync } from "node:fs";
import { calibrationFromSensor } from "../../contracts/camera.ts";
import { TENDER_T1 } from "../../contracts/aircraft.ts";
import { NeuralClient } from "../../navigation/neural/client.ts";
import { connectWebSocketTransport } from "../../navigation/neural/transport.ts";
import type { NeuralConnector } from "../../mission/controller-slot.ts";
import type { Condition, Requirement } from "./conditions.ts";

export const RUNTIME_SOURCE_URL = new URL("../../mission/runtime.ts", import.meta.url);

export interface Capabilities {
  readonly flyvisService: { readonly available: boolean; readonly detail: string };
  readonly runtimeRangeAssistOption: boolean;
  readonly runtimeInitialWaterOption: boolean;
}

/** Batch deadlines: the simulation waits for each step in lockstep, so these bound a hung service only. */
export const BATCH_NEURAL_DEADLINES = Object.freeze({ stepDeadlineMs: 2000, firstStepDeadlineMs: 10_000, resetDeadlineMs: 10_000 });

export const connectNeural: NeuralConnector = async () => new NeuralClient(await connectWebSocketTransport({ connectTimeoutMs: 3000 }), BATCH_NEURAL_DEADLINES);

/** Connect, reset one probe run and close. */
export async function probeFlyVis(connect: NeuralConnector = connectNeural): Promise<Capabilities["flyvisService"]> {
  let client: NeuralClient | null = null;
  try {
    client = await connect();
    const rgb = TENDER_T1.sensors.find(s => s.id === "rgb-front");
    if (!rgb) return { available: false, detail: "Tender T1 has no rgb-front camera" };
    const ready = await client.reset("ev-probe", calibrationFromSensor(rgb, 1));
    return { available: true, detail: `FlyVis service ready: ${JSON.stringify(ready).slice(0, 200)}` };
  } catch (error) {
    return { available: false, detail: `FlyVis service unavailable: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    client?.close();
  }
}

/** Whether the RuntimeOptions interface in runtime.ts declares an optional field `name`. */
export function runtimeDeclaresOption(name: string, source: string = readFileSync(RUNTIME_SOURCE_URL, "utf8")): boolean {
  const body = /export interface RuntimeOptions\s*\{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
  return new RegExp(`\\breadonly\\s+${name}\\??\\s*:`).test(body);
}

export async function detectCapabilities(options: { readonly probeService?: boolean } = {}): Promise<Capabilities> {
  return {
    flyvisService: options.probeService === false ? { available: false, detail: "not probed" } : await probeFlyVis(),
    runtimeRangeAssistOption: runtimeDeclaresOption("rangeAssist"),
    runtimeInitialWaterOption: runtimeDeclaresOption("initialWaterL"),
  };
}

const REQUIREMENT_TEXT: { readonly [r in Requirement]: string } = {
  flyvis_service: "Not run: the FlyVis service was unavailable (no substitute controller is used).",
  runtime_range_assist_option: "Not run (gap): MissionRuntime has no option to run without range assistance.",
  runtime_initial_water_option: "Not run (gap): MissionRuntime has no option to start with a reduced water load.",
};

export function missingRequirements(condition: Condition, caps: Capabilities): string[] {
  const met: { readonly [r in Requirement]: boolean } = {
    flyvis_service: caps.flyvisService.available,
    runtime_range_assist_option: caps.runtimeRangeAssistOption,
    runtime_initial_water_option: caps.runtimeInitialWaterOption,
  };
  return condition.requires.filter(r => !met[r]).map(r => r === "flyvis_service" ? `${REQUIREMENT_TEXT[r]} ${caps.flyvisService.detail}` : REQUIREMENT_TEXT[r]);
}
