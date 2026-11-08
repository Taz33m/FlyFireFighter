/**
 * Caller admission for /api/runs: the local-caller guard and token bucket of the Decisions gateway
 * (src/lib/navigation/planner/gateway.ts), copied here so persistence does not depend on planner code.
 *
 * - Host must be an allowed host (127.0.0.1:3200, localhost:3200 or an entry of PERSISTENCE_ALLOWED_HOSTS);
 *   an Origin header, when present, must be http(s) on one of those hosts; a browser's
 *   `Sec-Fetch-Site: cross-site` is refused as well. This closes DNS rebinding and cross-site pages reading
 *   or writing the run store. Anything else is 403 before the body is read or Atlas is contacted.
 * - A per-route token bucket bounds how often admitted callers reach Atlas; excess is 429.
 *
 * Residual risk, accepted for a single-machine demo (as for /api/decisions): this is not authentication. A
 * local process that can reach 127.0.0.1:3200 can send the right Host and no Origin.
 */

export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ["127.0.0.1:3200", "localhost:3200"];

const HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]{2,45}\])(?::[0-9]{1,5})?$/;

/** Default hosts plus a comma-separated list; malformed entries (schemes, paths, wildcards) are ignored, so a typo only narrows access. */
export function allowedHostsFromEnv(value: string | undefined): readonly string[] {
  const extra = (value ?? "").split(",").map(entry => entry.trim().toLowerCase()).filter(entry => HOST_PATTERN.test(entry));
  return [...new Set([...DEFAULT_ALLOWED_HOSTS, ...extra])];
}

export type CallerVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: "host" | "origin" | "cross_site" };

export function checkCaller(headers: Headers, allowedHosts: readonly string[]): CallerVerdict {
  const hosts = new Set(allowedHosts.map(host => host.toLowerCase()));
  const host = (headers.get("host") ?? "").trim().toLowerCase();
  if (!hosts.has(host)) return { ok: false, reason: "host" };
  if ((headers.get("sec-fetch-site") ?? "").trim().toLowerCase() === "cross-site") return { ok: false, reason: "cross_site" };
  const origin = headers.get("origin");
  if (origin === null) return { ok: true };
  const match = /^(https?):\/\/([^/?#@\s]+)$/.exec(origin.trim().toLowerCase());
  return match !== null && hosts.has(match[2]) ? { ok: true } : { ok: false, reason: "origin" };
}

export interface RateLimiter {
  take(): { readonly ok: true } | { readonly ok: false; readonly retryAfterMs: number };
}

/** `burst` tokens refilled continuously at `perMinute`; the clock is injectable for tests. */
export function tokenBucket(burst: number, perMinute: number, nowMs: () => number = () => performance.now()): RateLimiter {
  const refillPerMs = perMinute / 60_000;
  let tokens = burst;
  let last = nowMs();
  return {
    take() {
      const now = nowMs();
      tokens = Math.min(burst, tokens + Math.max(0, now - last) * refillPerMs);
      last = now;
      if (tokens >= 1) {
        tokens -= 1;
        return { ok: true };
      }
      return { ok: false, retryAfterMs: Math.ceil((1 - tokens) / refillPerMs) };
    },
  };
}

export type BoundedText = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: "too_large" | "unreadable" };

/** Read a body as strict UTF-8, stopping (and cancelling the stream) once it exceeds `maxBytes`. */
export async function readBoundedText(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<BoundedText> {
  if (body === null) return { ok: true, text: "" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const reader = body.getReader();
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(next.value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

export function declaredLength(headers: Headers): number {
  const value = Number(headers.get("content-length") ?? "0");
  return Number.isFinite(value) ? value : 0;
}
