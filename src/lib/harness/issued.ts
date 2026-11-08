/**
 * Registry of harness-issued actuator batches.
 *
 * The simulator applies a batch only if the harness issued it in this process, so no planner, motion
 * controller, UI handler or test shortcut can actuate the aircraft directly. This guards against
 * accidental bypass inside one worker; it is not tamper-proof hardware control.
 */
import type { ActuatorBatch } from "../contracts/actions.ts";
import { deepFreeze } from "../contracts/ids.ts";

const issued = new WeakSet<object>();

/** Freeze and register a batch. Only the harness calls this. */
export function issueBatch(batch: ActuatorBatch): ActuatorBatch {
  const frozen = deepFreeze(batch);
  issued.add(frozen);
  return frozen;
}

export function isHarnessIssued(batch: unknown): batch is ActuatorBatch {
  return typeof batch === "object" && batch !== null && issued.has(batch);
}
