/**
 * Static import-graph checks over src/lib (module boundaries from architecture.md and AGENTS.md):
 * - harness, evidence and navigation never import simulation or evaluation, directly or transitively
 *   (planners, the evidence store and the harness are truth-free);
 * - contracts import only contracts (and Node built-ins in tests);
 * - only simulation, evaluation and mission import simulation/world-state.ts (hidden world truth);
 * - no import of an existing module goes unresolved, so no edge of the graph is silently missing (imports
 *   of files that do not exist at all are reported as diagnostics: the typecheck fails on those).
 * Specifiers are parsed from file text with regular expressions after stripping comments: static
 * import/export-from (type-only included), side-effect imports and dynamic import().
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const LIB = dirname(fileURLToPath(import.meta.url));
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts"];
const TRUTH_FREE = ["harness", "evidence", "navigation"];
const TRUTH = ["simulation", "evaluation"];
const WORLD_STATE_IMPORTERS = ["simulation", "evaluation", "mission"];

const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /^\s*(?:import|export)\b[^;'"`]*?\bfrom\s*(["'])([^"'\n]+)\1/gm,
  /^\s*import\s*(["'])([^"'\n]+)\1/gm,
  /\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g,
];

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\"'`])\/\/[^\n]*/g, "$1");
}

function importSpecifiers(text: string): string[] {
  const code = stripComments(text);
  return SPECIFIER_PATTERNS.flatMap(pattern => [...code.matchAll(pattern)].map(match => match[2]));
}

interface ModuleGraph {
  readonly root: string;
  /** Resolved project imports per module. */
  readonly imports: ReadonlyMap<string, readonly string[]>;
  /** Bare package specifiers (e.g. "node:test", "three") per module. */
  readonly external: ReadonlyMap<string, readonly string[]>;
  /** Imports naming a module that exists under a form the resolver does not try: a gap that could hide an edge. */
  readonly unresolved: readonly string[];
  /** Imports of files that do not exist at all (broken imports). */
  readonly missing: readonly string[];
}

/** Project-relative ("./", "../") and "@/" (src/) specifiers resolve; anything else is an external package. */
type Resolution = { readonly kind: "external" } | { readonly kind: "module"; readonly path: string } | { readonly kind: "none"; readonly base: string };

function resolveSpecifier(root: string, from: string, specifier: string, known: ReadonlySet<string>): Resolution {
  const base = specifier.startsWith(".") ? resolve(dirname(from), specifier) : specifier.startsWith("@/") ? resolve(dirname(root), specifier.slice(2)) : null;
  if (base === null) return { kind: "external" };
  const stem = base.replace(/\.js$/, "");
  const candidates = [base, ...SOURCE_EXTENSIONS.map(ext => stem + ext), ...SOURCE_EXTENSIONS.map(ext => join(base, `index${ext}`))];
  const path = candidates.find(candidate => known.has(candidate)) ?? candidates.find(isFile);
  return path ? { kind: "module", path } : { kind: "none", base };
}

/** A file with the specifier's name and some other extension exists (in the scan or on disk). */
function existsUnderAnotherName(base: string, known: ReadonlySet<string>): boolean {
  const stem = base.replace(/\.[cm]?[jt]sx?$/, "");
  const sameStem = (path: string): boolean => dirname(path) === dirname(stem) && path.startsWith(`${stem}.`);
  if ([...known].some(sameStem)) return true;
  try {
    return readdirSync(dirname(stem)).some(name => sameStem(join(dirname(stem), name)));
  } catch {
    return false;
  }
}

/** Files outside the scanned tree (JSON data, app code) still resolve; directories do not. */
function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

function buildGraph(root: string, sources: ReadonlyMap<string, string>): ModuleGraph {
  const known = new Set(sources.keys());
  const imports = new Map<string, string[]>();
  const external = new Map<string, string[]>();
  const unresolved: string[] = [];
  const missing: string[] = [];
  for (const [file, text] of sources) {
    imports.set(file, []);
    external.set(file, []);
    for (const specifier of importSpecifiers(text)) {
      const target = resolveSpecifier(root, file, specifier, known);
      if (target.kind === "external") external.get(file)?.push(specifier);
      else if (target.kind === "module") imports.get(file)?.push(target.path);
      else if (existsUnderAnotherName(target.base, known)) unresolved.push(`${display(root, file)} imports "${specifier}", which resolves to no file although a module of that name exists`);
      else missing.push(`${display(root, file)} imports missing "${specifier}"`);
    }
  }
  return { root, imports, external, unresolved, missing };
}

function display(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}

function under(root: string, file: string, dirs: readonly string[]): boolean {
  return dirs.some(dir => file.startsWith(join(root, dir) + sep));
}

/** Shortest import chain from `start` to a module satisfying `target`, or null. */
function chainTo(graph: ModuleGraph, start: string, target: (file: string) => boolean): string[] | null {
  const via = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    for (const next of [...(graph.imports.get(queue[i]) ?? [])].sort()) {
      if (via.has(next)) continue;
      via.set(next, queue[i]);
      if (target(next)) {
        const chain = [next];
        for (let at = via.get(next) ?? null; at !== null; at = via.get(at) ?? null) chain.unshift(at);
        return chain;
      }
      queue.push(next);
    }
  }
  return null;
}

function truthLeaks(graph: ModuleGraph): string[] {
  return [...graph.imports.keys()].sort().filter(file => under(graph.root, file, TRUTH_FREE)).flatMap(file => {
    const chain = chainTo(graph, file, target => under(graph.root, target, TRUTH));
    return chain ? [chain.map(f => display(graph.root, f)).join(" -> ")] : [];
  });
}

function contractLeaks(graph: ModuleGraph): string[] {
  return [...graph.imports.keys()].sort().filter(file => under(graph.root, file, ["contracts"])).flatMap(file => [
    ...(graph.imports.get(file) ?? []).filter(target => !under(graph.root, target, ["contracts"])).map(target => `${display(graph.root, file)} imports ${display(graph.root, target)}`),
    ...(graph.external.get(file) ?? []).filter(specifier => !specifier.startsWith("node:")).map(specifier => `${display(graph.root, file)} imports package "${specifier}"`),
  ]);
}

function worldStateImporters(graph: ModuleGraph): string[] {
  const worldState = join(graph.root, "simulation", "world-state.ts");
  return [...graph.imports.entries()]
    .filter(([file, targets]) => targets.includes(worldState) && !under(graph.root, file, WORLD_STATE_IMPORTERS))
    .map(([file]) => display(graph.root, file))
    .sort();
}

function libSources(dir: string, out = new Map<string, string>()): Map<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") libSources(path, out);
    else if (entry.isFile() && SOURCE_EXTENSIONS.some(ext => entry.name.endsWith(ext)) && !entry.name.endsWith(".d.ts")) out.set(path, readFileSync(path, "utf8"));
  }
  return out;
}

describe("import parsing and the boundary checker", () => {
  test("finds static, type-only, multi-line, re-export, side-effect and dynamic specifiers; ignores comments", () => {
    const text = [
      'import assert from "node:assert/strict";',
      'import type { A } from "./a.ts";',
      "import {\n  b,\n  c,\n} from '../b.ts';",
      'export { d } from "./d.ts";',
      'export * from "./e.ts";',
      'import "./side-effect.ts";',
      // Assembled from parts so this file's own text holds no dynamic import for the real scan to find.
      ["const lazy = await ", "import", '("../lazy.ts");'].join(""),
      '// import { hidden } from "../simulation/world.ts";',
      '/* export { gone } from "../evaluation/evaluate.ts"; */',
      'const url = "https://example.com"; export const f = 1;',
      ' * a doc comment mentioning from "no information"',
    ].join("\n");
    assert.deepEqual(importSpecifiers(text).sort(), ["../b.ts", "../lazy.ts", "./a.ts", "./d.ts", "./e.ts", "./side-effect.ts", "node:assert/strict"]);
  });

  test("reports transitive truth leaks with their chains, contract leaks and world-state importers", () => {
    const root = join(sep, "virtual", "src", "lib");
    const file = (path: string): string => join(root, ...path.split("/"));
    const sources = new Map([
      [file("navigation/a.ts"), 'import { b } from "./b.ts";'],
      [file("navigation/b.ts"), 'import type { C } from "../mission/c.ts";'],
      [file("mission/c.ts"), 'export { createWorld } from "../simulation/world.ts";'],
      [file("simulation/world.ts"), 'import type { WorldState } from "./world-state.ts";'],
      [file("simulation/world-state.ts"), "export interface WorldState { readonly tick: number }"],
      [file("render/r.ts"), 'import type { WorldState } from "../simulation/world-state.ts";'],
      [file("contracts/k.ts"), 'import { DEFAULT_POLICY } from "../harness/policy.ts";\nimport * as THREE from "three";\nimport { createHash } from "node:crypto";'],
      [file("harness/policy.ts"), 'import type { K } from "../contracts/k.ts";\nimport { missing } from "./missing.ts";'],
      [file("contracts/j.ts"), 'import type { K } from "./k.mjs";'],
    ]);
    const graph = buildGraph(root, sources);
    assert.deepEqual(truthLeaks(graph), ["navigation/a.ts -> navigation/b.ts -> mission/c.ts -> simulation/world.ts", "navigation/b.ts -> mission/c.ts -> simulation/world.ts"]);
    assert.deepEqual(contractLeaks(graph), ["contracts/k.ts imports harness/policy.ts", 'contracts/k.ts imports package "three"']);
    assert.deepEqual(worldStateImporters(graph), ["render/r.ts"]);
    assert.deepEqual(graph.missing, ['harness/policy.ts imports missing "./missing.ts"']);
    assert.deepEqual(graph.unresolved, ['contracts/j.ts imports "./k.mjs", which resolves to no file although a module of that name exists']);
  });
});

describe("src/lib module boundaries", () => {
  const graph = buildGraph(LIB, libSources(LIB));

  test("the scan covers the truth-free and truth modules", () => {
    for (const dir of [...TRUTH_FREE, ...TRUTH, "contracts"]) assert.ok([...graph.imports.keys()].some(file => under(LIB, file, [dir])), `no modules found under ${dir}`);
  });

  test("no import of an existing module goes unresolved (imports of files that do not exist are reported)", t => {
    for (const broken of graph.missing) t.diagnostic(broken);
    assert.deepEqual(graph.unresolved, []);
  });

  test("harness, evidence and navigation never reach simulation or evaluation", () => {
    assert.deepEqual(truthLeaks(graph), []);
  });

  test("contracts import only contracts", () => {
    assert.deepEqual(contractLeaks(graph), []);
  });

  test("only simulation, evaluation and mission import the hidden world state", () => {
    assert.deepEqual(worldStateImporters(graph), []);
  });
});
