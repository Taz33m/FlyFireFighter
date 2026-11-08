import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const LIB = fileURLToPath(new URL("..", import.meta.url));
/** Code that decides, actuates or keeps evidence: it must never see evaluator outcomes or simulator truth. */
const GUARDED = ["harness", "navigation", "evidence"];
const IMPORT = /(?:import|export)\s[^"']*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
/** Pure simulation helpers that carry no world truth. */
const NEUTRAL_SIMULATION = new Set(["raycast.ts", "random.ts"]);

function forbidden(specifier: string): boolean {
  if (/(^|\/)evaluation\//.test(specifier)) return true;
  const simulation = /(?:^|\/)simulation\/(.+)$/.exec(specifier);
  return simulation !== null && !NEUTRAL_SIMULATION.has(simulation[1]);
}

function sourceFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("evaluator and truth boundary", () => {
  test("planner, harness and evidence code import neither the evaluator nor any truth-bearing simulator module", () => {
    const offenders: string[] = [];
    for (const area of GUARDED) {
      for (const file of sourceFiles(join(LIB, area))) {
        for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
          const specifier = match[1] ?? match[2];
          if (forbidden(specifier)) offenders.push(`${file}: ${specifier}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });
});
