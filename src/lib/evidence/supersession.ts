/**
 * Observation supersession is reprocessing, never erasure.
 *
 * An observation may name one earlier observation it replaces: the same sensor's same frame (both with a
 * frame id), re-processed, captured no later than the replacement. The replacement's detections then stand
 * for that frame in place of the original's; the original stays in the record but can no longer support an
 * action or contribute detections. A link that does not meet these conditions is not a supersession: the
 * store rejects the observation, and belief consumers ignore such a link (both observations stand), so an
 * unrelated frame can never hide another frame's fire or person evidence.
 */
import type { ObservationId } from "../contracts/ids.ts";
import type { Observation } from "../contracts/observation.ts";

type Linkable = Pick<Observation, "id" | "sensorId" | "frameId" | "captureTick" | "supersedes">;

/** Why `replacement` cannot supersede `target` (undefined when the target is unknown), or null when it can. */
export function supersessionProblem(replacement: Linkable, target: Linkable | undefined): string | null {
  const targetId = replacement.supersedes;
  if (targetId === null) return null;
  const label = `Observation ${replacement.id} supersedes ${targetId}`;
  if (targetId === replacement.id) return `${label}: an observation cannot supersede itself.`;
  if (target === undefined) return `${label}, which is not a known observation.`;
  if (target.sensorId !== replacement.sensorId) return `${label}, which is from sensor ${target.sensorId}, not ${replacement.sensorId}.`;
  if (target.frameId === null || replacement.frameId === null) return `${label}, but supersession needs both frame ids to show they are the same frame.`;
  if (target.frameId !== replacement.frameId) return `${label}, which is frame ${target.frameId}, not ${replacement.frameId}.`;
  if (target.captureTick > replacement.captureTick) return `${label}, which was captured later (tick ${target.captureTick} > ${replacement.captureTick}).`;
  return null;
}

/**
 * Valid supersession links among `observations`: superseded id -> replacement id. Invalid links are ignored.
 * When several observations validly name the same target (the store accepts only the first), the smallest
 * replacement id wins, so the result does not depend on order.
 */
export function supersessions(observations: readonly Observation[]): Map<ObservationId, ObservationId> {
  const byId = new Map(observations.map(o => [o.id, o] as const));
  const links = new Map<ObservationId, ObservationId>();
  for (const o of observations) {
    if (o.supersedes === null || supersessionProblem(o, byId.get(o.supersedes)) !== null) continue;
    const current = links.get(o.supersedes);
    if (current === undefined || o.id < current) links.set(o.supersedes, o.id);
  }
  return links;
}
