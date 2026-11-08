/**
 * A small in-memory evaluator for the subset of the MongoDB query and aggregation language this module's
 * pipelines use, so the real pipelines from pipelines.ts run in offline tests against fixture documents.
 *
 * Supported: $match (equality, $eq/$ne/$gt/$gte/$lt/$lte/$in/$nin/$exists/$regex, $and/$or); stages $match,
 * $group, $project (inclusion, _id exclusion, computed fields), $sort, $limit, $skip, $unwind and $facet;
 * expressions $cond, $eq, $ne, $gt, $gte, $lt, $lte, $divide, $size, $ifNull, $isNumber, $and, $or, $not and
 * $literal; accumulators $sum, $avg, $min, $max, $first, $push, $addToSet and $median. Anything else throws,
 * so a pipeline that grows beyond what the tests can evaluate fails loudly rather than passing vacuously.
 *
 * Differences from Atlas, by design: $median here is the exact (interpolated) median, whereas the pipelines
 * ask Atlas for its approximate method; tests use odd-sized groups where the two agree. $search is not
 * evaluated (Atlas Search exists only on Atlas).
 */
import type { Doc } from "./model.ts";

type Stage = Doc;

const isRecord = (v: unknown): v is Doc => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Uint8Array);

export function getPath(doc: unknown, path: string): unknown {
  let current: unknown = doc;
  for (const part of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function setPath(target: Doc, path: string, value: unknown): void {
  const parts = path.split(".");
  let current = target;
  parts.slice(0, -1).forEach(part => {
    if (!isRecord(current[part])) current[part] = {};
    current = current[part] as Doc;
  });
  current[parts[parts.length - 1]] = value;
}

/* Ordering and equality (BSON comparison order for the types used here). */

function typeRank(v: unknown): number {
  if (v === null || v === undefined) return 1;
  if (typeof v === "number") return 2;
  if (typeof v === "string") return 3;
  if (Array.isArray(v)) return 5;
  if (typeof v === "boolean") return 8;
  if (v instanceof Date) return 9;
  return 4;
}

export function compareValues(a: unknown, b: unknown): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (ra === 1) return 0;
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  return ja < jb ? -1 : ja > jb ? 1 : 0;
}

const truthy = (v: unknown): boolean => !(v === false || v === null || v === undefined || v === 0);

/* Queries ($match and find filters). */

const RANGE: Readonly<Record<string, (c: number) => boolean>> = { $gt: c => c > 0, $gte: c => c >= 0, $lt: c => c < 0, $lte: c => c <= 0 };

function operatorMatches(value: unknown, op: string, arg: unknown, cond: Doc): boolean {
  const values = Array.isArray(value) ? [value, ...value] : [value];
  const any = (test: (v: unknown) => boolean) => values.some(test);
  const range = RANGE[op];
  if (range !== undefined) return any(v => typeRank(v) === typeRank(arg) && range(compareValues(v, arg)));
  switch (op) {
    case "$eq": return any(v => compareValues(v, arg) === 0);
    case "$ne": return !any(v => compareValues(v, arg) === 0);
    case "$in": return Array.isArray(arg) && arg.some(a => any(v => compareValues(v, a) === 0));
    case "$nin": return Array.isArray(arg) && !arg.some(a => any(v => compareValues(v, a) === 0));
    case "$exists": return (value !== undefined) === truthy(arg);
    case "$regex": return typeof arg === "string" && any(v => typeof v === "string" && new RegExp(arg, typeof cond.$options === "string" ? cond.$options : "").test(v));
    case "$options": return true;
    default: throw new Error(`memory-aggregate: unsupported query operator ${op}`);
  }
}

export function matches(doc: Doc, query: Doc): boolean {
  return Object.entries(query).every(([key, cond]) => {
    if (key === "$and") return (cond as Doc[]).every(q => matches(doc, q));
    if (key === "$or") return (cond as Doc[]).some(q => matches(doc, q));
    if (key.startsWith("$")) throw new Error(`memory-aggregate: unsupported query operator ${key}`);
    const value = getPath(doc, key);
    if (isRecord(cond) && Object.keys(cond).some(k => k.startsWith("$"))) return Object.entries(cond).every(([op, arg]) => operatorMatches(value, op, arg, cond));
    return Array.isArray(value) && !Array.isArray(cond) ? value.some(v => compareValues(v, cond) === 0) : compareValues(value, cond) === 0;
  });
}

/* Expressions. */

function pair(args: unknown, doc: Doc): [unknown, unknown] {
  if (!Array.isArray(args) || args.length !== 2) throw new Error("memory-aggregate: expected two arguments");
  return [evaluate(args[0], doc), evaluate(args[1], doc)];
}

function cond(args: unknown, doc: Doc): unknown {
  const [test, then, otherwise] = Array.isArray(args) ? args : [(args as Doc).if, (args as Doc).then, (args as Doc).else];
  return truthy(evaluate(test, doc)) ? evaluate(then, doc) : evaluate(otherwise, doc);
}

function divide(args: unknown, doc: Doc): number | null {
  const [a, b] = pair(args, doc);
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (typeof a !== "number" || typeof b !== "number" || b === 0) throw new Error("memory-aggregate: $divide needs numbers and a non-zero divisor");
  return a / b;
}

function size(args: unknown, doc: Doc): number {
  const value = evaluate(Array.isArray(args) ? args[0] : args, doc);
  if (!Array.isArray(value)) throw new Error("memory-aggregate: $size needs an array");
  return value.length;
}

const COMPARISONS: Readonly<Record<string, (c: number) => boolean>> = { $eq: c => c === 0, $ne: c => c !== 0, $gt: c => c > 0, $gte: c => c >= 0, $lt: c => c < 0, $lte: c => c <= 0 };

function operator(op: string, args: unknown, doc: Doc): unknown {
  const comparison = COMPARISONS[op];
  if (comparison !== undefined) {
    const [a, b] = pair(args, doc);
    return comparison(compareValues(a, b));
  }
  switch (op) {
    case "$cond": return cond(args, doc);
    case "$divide": return divide(args, doc);
    case "$size": return size(args, doc);
    case "$ifNull": {
      const [a, b] = pair(args, doc);
      return a === null || a === undefined ? b : a;
    }
    case "$isNumber": return typeof evaluate(Array.isArray(args) ? args[0] : args, doc) === "number";
    case "$and": return (args as unknown[]).every(a => truthy(evaluate(a, doc)));
    case "$or": return (args as unknown[]).some(a => truthy(evaluate(a, doc)));
    case "$not": return !truthy(evaluate(Array.isArray(args) ? args[0] : args, doc));
    case "$literal": return args;
    default: throw new Error(`memory-aggregate: unsupported expression operator ${op}`);
  }
}

export function evaluate(expr: unknown, doc: Doc): unknown {
  if (typeof expr === "string" && expr.startsWith("$")) {
    if (expr.startsWith("$$")) throw new Error("memory-aggregate: variables are not supported");
    return getPath(doc, expr.slice(1));
  }
  if (Array.isArray(expr)) return expr.map(e => evaluate(e, doc));
  if (!isRecord(expr)) return expr;
  const keys = Object.keys(expr);
  if (keys.length === 1 && keys[0].startsWith("$")) return operator(keys[0], expr[keys[0]], doc);
  return Object.fromEntries(keys.map(k => [k, evaluate(expr[k], doc)]));
}

/* Accumulators. */

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function accumulate(op: string, arg: unknown, docs: readonly Doc[]): unknown {
  const input = op === "$median" ? (arg as Doc).input : arg;
  const values = docs.map(d => evaluate(input, d));
  const numbers = values.filter((v): v is number => typeof v === "number");
  const present = values.filter(v => v !== null && v !== undefined);
  switch (op) {
    case "$sum": return numbers.reduce((s, v) => s + v, 0);
    case "$avg": return numbers.length === 0 ? null : numbers.reduce((s, v) => s + v, 0) / numbers.length;
    case "$min": return present.length === 0 ? null : present.reduce((m, v) => (compareValues(v, m) < 0 ? v : m));
    case "$max": return present.length === 0 ? null : present.reduce((m, v) => (compareValues(v, m) > 0 ? v : m));
    case "$first": return values[0] ?? null;
    case "$push": return values;
    case "$addToSet": return values.filter((v, i) => values.findIndex(w => compareValues(v, w) === 0) === i);
    case "$median": return median(numbers);
    default: throw new Error(`memory-aggregate: unsupported accumulator ${op}`);
  }
}

function group(docs: readonly Doc[], spec: Doc): Doc[] {
  const groups = new Map<string, { key: unknown; docs: Doc[] }>();
  for (const doc of docs) {
    const key = evaluate(spec._id, doc) ?? null;
    const id = JSON.stringify(key);
    const entry = groups.get(id) ?? { key, docs: [] };
    entry.docs.push(doc);
    groups.set(id, entry);
  }
  return [...groups.values()].map(({ key, docs: members }) => {
    const out: Doc = { _id: key };
    for (const [field, acc] of Object.entries(spec)) {
      if (field === "_id") continue;
      const [op, arg] = Object.entries(acc as Doc)[0];
      out[field] = accumulate(op, arg, members);
    }
    return out;
  });
}

const isFlag = (v: unknown): v is 0 | 1 | boolean => v === 0 || v === 1 || typeof v === "boolean";

export function project(doc: Doc, spec: Doc): Doc {
  const out: Doc = {};
  if (doc._id !== undefined && (spec._id === undefined || truthy(spec._id))) out._id = doc._id;
  for (const [key, value] of Object.entries(spec)) {
    if (key === "_id" && isFlag(value)) continue;
    if (value === 1 || value === true) {
      const included = getPath(doc, key);
      if (included !== undefined) setPath(out, key, structuredClone(included));
    } else if (value === 0 || value === false) {
      throw new Error("memory-aggregate: only _id may be excluded");
    } else {
      setPath(out, key, evaluate(value, doc));
    }
  }
  return out;
}

function sortDocs(docs: readonly Doc[], spec: Doc): Doc[] {
  const keys = Object.entries(spec) as [string, number][];
  return [...docs].sort((a, b) => {
    for (const [key, direction] of keys) {
      const c = compareValues(getPath(a, key), getPath(b, key));
      if (c !== 0) return direction < 0 ? -c : c;
    }
    return 0;
  });
}

function unwind(docs: readonly Doc[], spec: unknown): Doc[] {
  if (typeof spec !== "string" || !spec.startsWith("$")) throw new Error("memory-aggregate: $unwind takes a field path");
  const path = spec.slice(1);
  return docs.flatMap(doc => {
    const value = getPath(doc, path);
    if (!Array.isArray(value)) return value === undefined || value === null ? [] : [doc];
    return value.map(item => {
      const copy = structuredClone(doc);
      setPath(copy, path, item);
      return copy;
    });
  });
}

function applyStage(docs: Doc[], stage: Stage): Doc[] {
  const [name, spec] = Object.entries(stage)[0];
  switch (name) {
    case "$match": return docs.filter(d => matches(d, spec as Doc));
    case "$group": return group(docs, spec as Doc);
    case "$project": return docs.map(d => project(d, spec as Doc));
    case "$sort": return sortDocs(docs, spec as Doc);
    case "$limit": return docs.slice(0, spec as number);
    case "$skip": return docs.slice(spec as number);
    case "$unwind": return unwind(docs, spec);
    case "$facet": return [Object.fromEntries(Object.entries(spec as Doc).map(([k, sub]) => [k, runPipeline(docs, sub as Stage[])]))];
    default: throw new Error(`memory-aggregate: unsupported stage ${name}`);
  }
}

export function runPipeline(docs: readonly Doc[], pipeline: readonly Stage[]): Doc[] {
  return pipeline.reduce<Doc[]>((current, stage) => applyStage(current, stage), docs.map(d => structuredClone(d)));
}
