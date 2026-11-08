/** Validate a batch request before probing services, starting workers or writing results. */
import { parseArgs } from "node:util";
import { BASELINE_ID, CONDITIONS, planRuns } from "./conditions.ts";
import type { RunSpec } from "./conditions.ts";

export type EvaluationCommand =
  | { readonly mode: "list" }
  | { readonly mode: "upload"; readonly directory: string }
  | {
    readonly mode: "run";
    readonly smoke: boolean;
    readonly specs: readonly RunSpec[];
    readonly seedCount: number;
    readonly conditionCount: number;
    readonly outDir: string | undefined;
    readonly concurrency: number | undefined;
    readonly maxTicks: number | undefined;
    readonly probeService: boolean;
    readonly saveAtlas: boolean;
  };

function positiveInteger(value: string, option: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new RangeError(`--${option} must be a positive safe integer`);
  return number;
}

export function parseEvaluationCommand(args: readonly string[]): EvaluationCommand {
  const { values } = parseArgs({
    args: [...args],
    options: {
      smoke: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      seeds: { type: "string", default: "5" },
      "seed-prefix": { type: "string", default: "eval-seed" },
      "first-seed": { type: "string", default: "1" },
      conditions: { type: "string" },
      out: { type: "string" },
      "max-ticks": { type: "string" },
      "no-probe": { type: "boolean", default: false },
      concurrency: { type: "string" },
      "save-atlas": { type: "boolean", default: false },
      "upload-dir": { type: "string" },
    },
  });
  if (values["upload-dir"] !== undefined) {
    if (values["upload-dir"].trim() === "") throw new RangeError("--upload-dir must name a directory");
    return { mode: "upload", directory: values["upload-dir"] };
  }
  if (values.list) return { mode: "list" };

  const requestedCount = positiveInteger(values.seeds, "seeds");
  const count = values.smoke ? 1 : requestedCount;
  const first = positiveInteger(values["first-seed"], "first-seed");
  if (!Number.isSafeInteger(first + (count - 1))) throw new RangeError("The last seed index must be a safe integer");
  const concurrency = values.concurrency === undefined ? undefined : positiveInteger(values.concurrency, "concurrency");
  const maxTicks = values["max-ticks"] === undefined ? undefined : positiveInteger(values["max-ticks"], "max-ticks");
  const selected = values.conditions === undefined ? CONDITIONS.map(c => c.id) : values.conditions.split(",").map(s => s.trim()).filter(Boolean);
  if (selected.length === 0) throw new RangeError("--conditions must select at least one condition");
  const conditionIds = values.smoke ? [BASELINE_ID] : selected;
  // Generate just the requested range; a late --first-seed must not allocate all earlier seeds.
  const seeds = Array.from({ length: count }, (_, i) => `${values["seed-prefix"]}-${first + i}`);
  const specs = planRuns(seeds, conditionIds);
  return {
    mode: "run", smoke: values.smoke, specs, seedCount: count, conditionCount: conditionIds.length,
    outDir: values.out, concurrency, maxTicks, saveAtlas: values["save-atlas"],
    probeService: !values["no-probe"] && specs.some(s => s.condition.requires.includes("flyvis_service")),
  };
}
