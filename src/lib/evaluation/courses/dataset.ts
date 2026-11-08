/**
 * Readout dataset shards (git-ignored, datasets/generated/readout-v1/<part>/): one little-endian float32
 * matrix per run (`<runId>.f32`, row-major) plus a part manifest (`manifest.json`) with the column names,
 * per-run row counts, split, course, driver and the SHA-256 of every shard. Columns: the readout inputs
 * (READOUT_INPUT_NAMES), then the truth teacher's labels (teacher_forward, teacher_yaw), then
 * driven_by_teacher (1/0), tick and the teacher's true gap (diagnostic only; never a model input).
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { READOUT_INPUT_NAMES } from "../../navigation/reflex/trained-readout.ts";
import type { Sample } from "./runner.ts";

export const DATASET_COLUMNS: readonly string[] = [...READOUT_INPUT_NAMES, "teacher_forward", "teacher_yaw", "driven_by_teacher", "tick", "teacher_gap"];

export interface ShardEntry {
  readonly runId: string;
  readonly courseId: string;
  readonly split: string;
  readonly driver: string;
  readonly rows: number;
  readonly file: string;
  readonly sha256: string;
  readonly endReason: string;
  readonly collisions: number;
}

export class ShardBuffer {
  private readonly rows: number[][] = [];

  add(sample: Sample): void {
    this.rows.push([...sample.inputs, sample.teacher.forwardMps, sample.teacher.yawRateRadps, sample.drivenBy === "teacher" ? 1 : 0, sample.tick, sample.teacher.gapM]);
  }

  get length(): number {
    return this.rows.length;
  }

  write(dir: string, runId: string): { file: string; sha256: string; rows: number } {
    mkdirSync(dir, { recursive: true });
    const width = DATASET_COLUMNS.length;
    const data = new Float32Array(this.rows.length * width);
    this.rows.forEach((row, i) => data.set(row, i * width));
    const bytes = Buffer.from(data.buffer);
    const file = `${runId.replace(/[^A-Za-z0-9_.-]/g, "_")}.f32`;
    writeFileSync(join(dir, file), bytes);
    return { file, sha256: createHash("sha256").update(bytes).digest("hex"), rows: this.rows.length };
  }
}

export function writeManifest(dir: string, manifest: { readonly part: string; readonly created: string; readonly columns: readonly string[]; readonly shards: readonly ShardEntry[]; readonly [key: string]: unknown }): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}
