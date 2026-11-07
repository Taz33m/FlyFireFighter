/**
 * Append-only mission event log.
 *
 * Every transition (report, observation, proposal, approval, execution, abort, outcome) is appended with
 * its source, simulation tick, rule decisions and a plain-language reason. Command, the evaluator and
 * replay all read the same log. Entries are frozen and JSON-serializable.
 */
import type { JsonValue } from "./canonical.ts";
import { canonicalJson } from "./canonical.ts";
import type { Tick } from "./clock.ts";
import type { RunId } from "./ids.ts";
import { deepFreeze } from "./ids.ts";

export type EventSource =
  | "commander"
  | "harness"
  | "planner"
  | "decisions_gateway"
  | "intake"
  | "evidence"
  | "sensor"
  | "motion"
  | "simulator"
  | "evaluator"
  | "operator"
  | "system";

export interface MissionEvent {
  /** 1-based, gap-free, monotonic within the run. */
  readonly seq: number;
  readonly runId: RunId;
  readonly tick: Tick;
  readonly source: EventSource;
  /** Dotted event type, e.g. "proposal.submitted", "approval.issued", "execution.stopped". */
  readonly kind: string;
  readonly subject: string | null;
  readonly ruleIds: readonly string[];
  readonly reason: string;
  readonly data: { readonly [key: string]: JsonValue };
}

export interface MissionEventInput {
  readonly tick: Tick;
  readonly source: EventSource;
  readonly kind: string;
  readonly reason: string;
  readonly subject?: string | null;
  readonly ruleIds?: readonly string[];
  readonly data?: { readonly [key: string]: JsonValue };
}

export class EventLog {
  readonly runId: RunId;
  private readonly items: MissionEvent[] = [];
  private lastTick = 0;

  constructor(runId: RunId) {
    this.runId = runId;
  }

  append(input: MissionEventInput): MissionEvent {
    if (!Number.isSafeInteger(input.tick) || input.tick < this.lastTick) {
      throw new RangeError(`Event tick ${input.tick} is not an integer at or after ${this.lastTick}`);
    }
    const data = input.data ?? {};
    // Throws for anything that is not plain, finite JSON, so the exported log always round-trips.
    canonicalJson(data);
    const event: MissionEvent = deepFreeze({
      seq: this.items.length + 1,
      runId: this.runId,
      tick: input.tick,
      source: input.source,
      kind: input.kind,
      subject: input.subject ?? null,
      ruleIds: [...(input.ruleIds ?? [])],
      reason: input.reason,
      data: structuredClone(data),
    });
    this.lastTick = input.tick;
    this.items.push(event);
    return event;
  }

  get length(): number {
    return this.items.length;
  }

  entries(): readonly MissionEvent[] {
    return this.items.slice();
  }

  /** Events with seq greater than `seq`. */
  since(seq: number): readonly MissionEvent[] {
    return this.items.slice(Math.max(0, seq));
  }

  /** events.jsonl: one canonical JSON object per line. */
  toJsonl(): string {
    return this.items.map(event => `${canonicalJson(event)}\n`).join("");
  }
}
