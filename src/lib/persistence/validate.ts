/**
 * Size limits and strict validation of uploaded bundles before anything reaches Atlas.
 *
 * The save body is exactly {files: {"results.json", "events.jsonl", "replay.jsonl"?}} with string values;
 * unknown members are rejected. Each file has its own byte limit (a ten-minute run's replay is about 15 MB).
 * Every event line must be a well-formed MissionEvent of this run: gap-free seq from 1, non-decreasing
 * ticks, a known source, bounded strings, plain JSON data and no field names MongoDB reserves ("$…", NUL).
 */
import type { EventSource, MissionEvent } from "../contracts/events.ts";
import { Buffer } from "node:buffer";
import { isTick } from "../contracts/clock.ts";

export function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export const MAX_SAVE_BODY_BYTES = 64 * 1024 * 1024;
export const MAX_FILE_BYTES = { "results.json": 1024 * 1024, "events.jsonl": 24 * 1024 * 1024, "replay.jsonl": 48 * 1024 * 1024 } as const;
export const MAX_EVENTS = 200_000;
export const MAX_REASON_LENGTH = 4000;
const MAX_DATA_DEPTH = 32;
const KIND_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;
const EVENT_KEYS = new Set(["seq", "runId", "tick", "source", "kind", "subject", "ruleIds", "reason", "data"]);
const SOURCE_SET: Readonly<Record<EventSource, true>> = {
  commander: true, harness: true, planner: true, decisions_gateway: true, intake: true, evidence: true,
  sensor: true, motion: true, simulator: true, evaluator: true, operator: true, system: true,
};

export type FileName = keyof typeof MAX_FILE_BYTES;
export type UploadFiles = { readonly "results.json": string; readonly "events.jsonl": string; readonly "replay.jsonl"?: string };

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The POST /api/runs body: strict shape and per-file byte limits. */
export function parseSaveBody(value: unknown): { readonly ok: true; readonly files: UploadFiles } | { readonly ok: false; readonly tooLarge: boolean; readonly errors: readonly string[] } {
  if (!isPlainObject(value)) return { ok: false, tooLarge: false, errors: ["$: expected {files: {...}}"] };
  const extra = Object.keys(value).filter(key => key !== "files");
  if (extra.length > 0) return { ok: false, tooLarge: false, errors: extra.map(key => `$.${key}: unknown field`) };
  const files = value.files;
  if (!isPlainObject(files)) return { ok: false, tooLarge: false, errors: ["$.files: expected an object of file texts"] };
  const errors: string[] = [];
  let tooLarge = false;
  for (const name of Object.keys(files)) {
    if (!Object.hasOwn(MAX_FILE_BYTES, name)) errors.push(`$.files.${name}: not a bundle file`);
  }
  for (const [name, limit] of Object.entries(MAX_FILE_BYTES)) {
    const text = files[name];
    if (text === undefined) {
      if (name !== "replay.jsonl") errors.push(`$.files.${name}: required`);
    } else if (typeof text !== "string") {
      errors.push(`$.files.${name}: expected the file text`);
    } else if (utf8Length(text) > limit) {
      tooLarge = true;
      errors.push(`$.files.${name}: larger than ${limit / 1024 / 1024} MB`);
    }
  }
  return errors.length === 0 ? { ok: true, files: files as UploadFiles } : { ok: false, tooLarge, errors };
}

function shapeProblem(e: Record<string, unknown>, expectedSeq: number, runId: string): string | null {
  const extra = Object.keys(e).find(key => !EVENT_KEYS.has(key));
  if (extra !== undefined) return `unknown field "${extra}"`;
  if (e.seq !== expectedSeq) return `seq ${String(e.seq)} where ${expectedSeq} was expected (the log must be gap-free from 1)`;
  if (e.runId !== runId) return "belongs to another run";
  if (!isTick(e.tick)) return "tick is not a non-negative integer";
  if (typeof e.source !== "string" || !Object.hasOwn(SOURCE_SET, e.source)) return "source is not a known event source";
  if (typeof e.kind !== "string" || e.kind.length > 120 || !KIND_PATTERN.test(e.kind)) return "kind is not a dotted event type";
  return null;
}

function contentProblem(e: Record<string, unknown>): string | null {
  if (e.subject !== null && !(typeof e.subject === "string" && e.subject.length <= 512)) return "subject must be null or a string of at most 512 characters";
  if (!Array.isArray(e.ruleIds) || e.ruleIds.length > 64 || !e.ruleIds.every(id => typeof id === "string" && id.length <= 128)) return "ruleIds must be at most 64 short strings";
  if (typeof e.reason !== "string" || e.reason.length > MAX_REASON_LENGTH) return `reason must be a string of at most ${MAX_REASON_LENGTH} characters`;
  if (!isPlainObject(e.data)) return "data must be an object";
  return unsafeJson(e.data, 0);
}

/** Plain, finite JSON with field names MongoDB accepts; null when fine. */
export function unsafeJson(value: unknown, depth: number): string | null {
  if (depth > MAX_DATA_DEPTH) return "data is nested too deeply";
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? null : "data holds a non-finite number";
  if (Array.isArray(value)) {
    for (const item of value) {
      const problem = unsafeJson(item, depth + 1);
      if (problem !== null) return problem;
    }
    return null;
  }
  if (!isPlainObject(value)) return "data holds a non-JSON value";
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith("$") || key.includes("\0")) return `data field name "${key.slice(0, 40)}" is reserved by MongoDB`;
    const problem = unsafeJson(item, depth + 1);
    if (problem !== null) return problem;
  }
  return null;
}

/** Every problem with the parsed event lines (capped at 20 so a bad file yields a readable reply). */
export function eventProblems(events: readonly unknown[], runId: string): string[] {
  const problems: string[] = [];
  if (events.length > MAX_EVENTS) return [`events.jsonl has ${events.length} events; at most ${MAX_EVENTS} are accepted`];
  let lastTick = 0;
  events.forEach((e, index) => {
    if (problems.length >= 20) return;
    const problem = isPlainObject(e) ? shapeProblem(e, index + 1, runId) ?? contentProblem(e) : "not an object";
    if (problem !== null) {
      problems.push(`events.jsonl event ${index + 1}: ${problem}`);
      return;
    }
    const tick = (e as unknown as MissionEvent).tick;
    if (tick < lastTick) problems.push(`events.jsonl event ${index + 1}: tick ${tick} goes back in time (after ${lastTick})`);
    lastTick = Math.max(lastTick, tick);
  });
  return problems;
}
