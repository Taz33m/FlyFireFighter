/**
 * Import boundary of the Atlas persistence module (src/lib/persistence), checked over the whole src tree:
 * - nothing a browser bundle can load reaches persistence or the `mongodb` driver, directly or transitively:
 *   no "use client" module, no component, no hook and no Web Worker;
 * - no other src/lib module (simulation, harness, evidence, navigation/planner, mission, evaluation, …)
 *   reaches persistence or the driver, so the simulation, harness and planner stay storage-free;
 * - only persistence imports the driver;
 * - and, so these checks cannot pass vacuously, the /api/runs route handlers do reach persistence and
 *   persistence does reach the driver.
 * Specifiers are parsed from file text (static, type-only, re-export, side-effect and dynamic imports) with
 * comments stripped, like src/lib/architecture.test.ts; "@/" resolves to src/.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PERSISTENCE = join(SRC, "lib", "persistence");
const DRIVER = "mongodb";
const EXTENSIONS = [".ts", ".tsx", ".mts"];
const PATTERNS: readonly RegExp[] = [
  /^\s*(?:import|export)\b[^;'"`]*?\bfrom\s*(["'])([^"'\n]+)\1/gm,
  /^\s*import\s*(["'])([^"'\n]+)\1/gm,
  /\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g,
];

const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\"'`])\/\/[^\n]*/g, "$1");
const specifiers = (text: string): string[] => PATTERNS.flatMap(p => [...stripComments(text).matchAll(p)].map(m => m[2]));
const isFile = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
const show = (file: string): string => (file.startsWith(SRC) ? relative(SRC, file).split(sep).join("/") : file);
const inDir = (file: string, dir: string): boolean => file.startsWith(dir + sep);

function sources(dir: string, out = new Map<string, string>()): Map<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") sources(path, out);
    else if (entry.isFile() && EXTENSIONS.some(ext => entry.name.endsWith(ext)) && !entry.name.endsWith(".d.ts")) out.set(path, readFileSync(path, "utf8"));
  }
  return out;
}

/** Project modules resolve to paths; bare package specifiers keep their package name (e.g. "mongodb"). */
function resolveSpecifier(from: string, specifier: string): string | null {
  const base = specifier.startsWith(".") ? resolve(dirname(from), specifier) : specifier.startsWith("@/") ? join(SRC, specifier.slice(2)) : null;
  if (base === null) return specifier.split("/")[0];
  const stem = base.replace(/\.js$/, "");
  return [base, ...EXTENSIONS.map(ext => stem + ext), ...EXTENSIONS.map(ext => join(base, `index${ext}`))].find(isFile) ?? null;
}

function graphOf(files: ReadonlyMap<string, string>): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const [file, text] of files) graph.set(file, specifiers(text).map(s => resolveSpecifier(file, s)).filter((t): t is string => t !== null));
  return graph;
}

function chainTo(graph: ReadonlyMap<string, readonly string[]>, start: string, target: (node: string) => boolean): string[] | null {
  const via = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    for (const next of graph.get(queue[i]) ?? []) {
      if (via.has(next)) continue;
      via.set(next, queue[i]);
      if (target(next)) {
        const chain = [next];
        for (let at = via.get(next) ?? null; at !== null; at = via.get(at) ?? null) chain.unshift(at);
        return chain.map(show);
      }
      queue.push(next);
    }
  }
  return null;
}

const isClientModule = (text: string): boolean => /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*\s*["']use client["']/.test(text);
const reachesStore = (node: string): boolean => node === DRIVER || inDir(node, PERSISTENCE);

describe("persistence import boundary", () => {
  const files = sources(SRC);
  const graph = graphOf(files);

  const leaks = (entries: readonly string[]): string[] => [...entries].sort().flatMap(file => {
    const chain = chainTo(graph, file, reachesStore);
    return chain === null ? [] : [chain.join(" -> ")];
  });

  test("no client module, component, hook or Web Worker reaches persistence or the driver", () => {
    const browser = [...files].filter(([file, text]) => isClientModule(text) || [join(SRC, "components"), join(SRC, "hooks"), join(SRC, "workers")].some(dir => inDir(file, dir))).map(([file]) => file);
    assert.ok(browser.length > 20, `expected to scan the browser modules, found ${browser.length}`);
    assert.ok(browser.some(f => inDir(f, join(SRC, "workers"))), "the Web Worker is scanned");
    assert.deepEqual(leaks(browser), []);
  });

  test("simulation, harness, planner, mission and every other src/lib module stay storage-free", () => {
    const lib = [...files.keys()].filter(file => inDir(file, join(SRC, "lib")) && !inDir(file, PERSISTENCE) && !file.endsWith("persistence-boundary.test.ts"));
    for (const dir of ["simulation", "harness", "navigation", "mission", "evaluation"]) assert.ok(lib.some(f => inDir(f, join(SRC, "lib", dir))), `no modules found under src/lib/${dir}`);
    assert.deepEqual(leaks(lib), []);
  });

  test("only persistence imports the MongoDB driver", () => {
    const importers = [...graph].filter(([, targets]) => targets.includes(DRIVER)).map(([file]) => show(file)).sort();
    assert.ok(importers.length > 0, "the driver import is found");
    assert.deepEqual(importers.filter(file => !file.startsWith("lib/persistence/")), []);
  });

  test("the run routes are server modules that reach persistence (the checks above see real edges)", () => {
    const routes = [...files].filter(([file]) => inDir(file, join(SRC, "app", "api", "runs")));
    assert.ok(routes.length >= 4, `expected the /api/runs route handlers, found ${routes.length}`);
    for (const [file, text] of routes) {
      assert.equal(isClientModule(text), false, `${show(file)} must not be a client module`);
      assert.ok(chainTo(graph, file, node => inDir(node, PERSISTENCE)) !== null, `${show(file)} does not reach persistence`);
    }
    assert.ok(chainTo(graph, join(PERSISTENCE, "server.ts"), node => node === DRIVER) !== null);
  });

  test("the client-module detector recognizes the directive after leading comments only", () => {
    assert.equal(isClientModule('"use client";\nimport x from "y";'), true);
    assert.equal(isClientModule('/** doc */\n// note\n"use client";'), true);
    assert.equal(isClientModule('import a from "b";\nconst s = "use client";'), false);
  });
});
