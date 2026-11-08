/**
 * Minimal runtime schemas for untrusted boundary input: worker messages, planner output and imported
 * files. Unknown object members are rejected, so a proposer cannot smuggle in a risk class, an approval
 * or a guard override.
 */
import type { ProposalInput } from "./actions.ts";
import { PROPOSERS } from "./actions.ts";

export type Schema =
  | { readonly type: "number"; readonly min?: number; readonly max?: number; readonly integer?: boolean; readonly exclusiveMin?: boolean }
  | { readonly type: "string"; readonly minLength?: number; readonly maxLength: number }
  | { readonly type: "boolean" }
  | { readonly type: "literal"; readonly values: readonly (string | number | boolean | null)[] }
  | { readonly type: "vec3"; readonly maxAbs?: number }
  | { readonly type: "array"; readonly items: Schema; readonly minItems?: number; readonly maxItems: number }
  | { readonly type: "object"; readonly fields: { readonly [key: string]: Schema }; readonly optional?: readonly string[] }
  | { readonly type: "nullable"; readonly inner: Schema }
  | { readonly type: "tagged"; readonly tag: string; readonly variants: { readonly [tag: string]: Schema } };

export type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly string[] };

/** Returns every violation of `schema` by `value`; empty when valid. */
export function validate(schema: Schema, value: unknown, path = "$"): string[] {
  const errors: string[] = [];
  check(schema, value, path, errors);
  return errors;
}

export function parseWith<T>(schema: Schema, value: unknown): ParseResult<T> {
  const errors = validate(schema, value);
  return errors.length === 0 ? { ok: true, value: value as T } : { ok: false, errors };
}

function check(schema: Schema, value: unknown, path: string, errors: string[]): void {
  switch (schema.type) {
    case "number":
      return checkNumber(schema, value, path, errors);
    case "string":
      return checkString(schema, value, path, errors);
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${path}: expected boolean`);
      return;
    case "literal":
      if (!schema.values.some(allowed => allowed === value)) errors.push(`${path}: expected one of ${JSON.stringify(schema.values)}`);
      return;
    case "vec3":
      return checkVec3(schema.maxAbs ?? 1e4, value, path, errors);
    case "array":
      return checkArray(schema, value, path, errors);
    case "object":
      return checkObject(schema, value, path, errors);
    case "nullable":
      if (value !== null) check(schema.inner, value, path, errors);
      return;
    case "tagged":
      return checkTagged(schema, value, path, errors);
  }
}

function checkNumber(schema: Extract<Schema, { type: "number" }>, value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(`${path}: expected a finite number`);
    return;
  }
  if (schema.integer && !Number.isSafeInteger(value)) errors.push(`${path}: expected an integer`);
  if (schema.min !== undefined && (schema.exclusiveMin ? value <= schema.min : value < schema.min)) errors.push(`${path}: below minimum ${schema.min}`);
  if (schema.max !== undefined && value > schema.max) errors.push(`${path}: above maximum ${schema.max}`);
}

function checkString(schema: Extract<Schema, { type: "string" }>, value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string") {
    errors.push(`${path}: expected string`);
    return;
  }
  if (value.length < (schema.minLength ?? 0)) errors.push(`${path}: shorter than ${schema.minLength}`);
  if (value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function checkVec3(maxAbs: number, value: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${path}: expected {x, y, z}`);
    return;
  }
  const keys = Object.keys(value);
  if (keys.length !== 3 || !["x", "y", "z"].every(key => keys.includes(key))) {
    errors.push(`${path}: expected exactly x, y, z`);
    return;
  }
  for (const key of ["x", "y", "z"]) {
    const component = value[key];
    if (typeof component !== "number" || !Number.isFinite(component) || Math.abs(component) > maxAbs) errors.push(`${path}.${key}: expected a finite number within ±${maxAbs}`);
  }
}

function checkArray(schema: Extract<Schema, { type: "array" }>, value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${path}: expected array`);
    return;
  }
  if (value.length < (schema.minItems ?? 0) || value.length > schema.maxItems) errors.push(`${path}: expected ${schema.minItems ?? 0}..${schema.maxItems} items`);
  value.slice(0, schema.maxItems).forEach((item, index) => check(schema.items, item, `${path}[${index}]`, errors));
}

function checkObject(schema: Extract<Schema, { type: "object" }>, value: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${path}: expected object`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(schema.fields, key)) errors.push(`${path}.${key}: unknown field`);
  }
  for (const [key, fieldSchema] of Object.entries(schema.fields)) {
    if (value[key] === undefined) {
      if (!schema.optional?.includes(key)) errors.push(`${path}.${key}: required`);
    } else {
      check(fieldSchema, value[key], `${path}.${key}`, errors);
    }
  }
}

function checkTagged(schema: Extract<Schema, { type: "tagged" }>, value: unknown, path: string, errors: string[]): void {
  const tag = isPlainObject(value) ? value[schema.tag] : undefined;
  if (typeof tag !== "string" || !Object.hasOwn(schema.variants, tag)) {
    errors.push(`${path}.${schema.tag}: expected one of ${JSON.stringify(Object.keys(schema.variants))}`);
    return;
  }
  check(schema.variants[tag], value, path, errors);
}

/* Schema builders. */

export const num = (min?: number, max?: number): Schema => ({ type: "number", min, max });
export const positive = (max?: number): Schema => ({ type: "number", min: 0, exclusiveMin: true, max });
export const int = (min = 0, max = Number.MAX_SAFE_INTEGER): Schema => ({ type: "number", integer: true, min, max });
export const str = (maxLength = 64, minLength = 1): Schema => ({ type: "string", maxLength, minLength });
export const lit = (...values: readonly (string | number | boolean | null)[]): Schema => ({ type: "literal", values });
export const vec3Schema: Schema = { type: "vec3" };
export const arr = (items: Schema, maxItems: number, minItems = 0): Schema => ({ type: "array", items, maxItems, minItems });
export const obj = (fields: { readonly [key: string]: Schema }, optional?: readonly string[]): Schema => ({ type: "object", fields, optional });

const durationTicks = int(1, 60_000);

export const actionSpecSchema: Schema = {
  type: "tagged",
  tag: "kind",
  variants: {
    move: obj({ kind: lit("move"), goal: vec3Schema, maxSpeedMps: positive(20) }),
    scan: obj({ kind: lit("scan"), lookAt: vec3Schema, durationTicks }),
    hold: obj({ kind: lit("hold"), durationTicks }),
    return: obj({ kind: lit("return"), routeId: str() }),
    land: obj({ kind: lit("land"), site: vec3Schema }),
    speak: obj({ kind: lit("speak"), templateId: str() }),
    guide: obj({ kind: lit("guide"), trackId: str(), routeId: str(), templateIds: arr(str(), 8, 1), maxDurationTicks: durationTicks }),
    breach_opening: obj({ kind: lit("breach_opening"), openingId: str(), standoff: vec3Schema, strikePoint: vec3Schema }),
    spray: obj({ kind: lit("spray"), standoff: vec3Schema, aimPoint: vec3Schema, flowLps: positive(5), durationTicks }),
    release_payload: obj({ kind: lit("release_payload"), payloadId: str(), releasePoint: vec3Schema }),
  },
};

export const proposalInputSchema: Schema = obj({
  runId: str(),
  aircraftId: str(),
  proposer: lit(...PROPOSERS),
  action: actionSpecSchema,
  rationale: str(600),
  citedEvidence: arr(str(), 32),
  basis: obj({ evidenceRevision: int(), mapRevision: int(), profileRevision: int(), envelopeRevision: int(), policyRevision: int() }),
  createdTick: int(),
  expiresTick: int(),
});

export function parseProposalInput(value: unknown): ParseResult<ProposalInput> {
  return parseWith<ProposalInput>(proposalInputSchema, value);
}
