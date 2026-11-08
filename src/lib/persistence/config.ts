/**
 * Atlas connection settings, read on the server only.
 *
 * MONGODB_URI (a mongodb:// or mongodb+srv:// connection string with the database user's credentials) and
 * MONGODB_DB (default "flyfirefighter") come only from the environment: .env.local for `next dev` and the
 * scripts, never the browser. The URI is never returned, logged or put into an error message; replies name
 * the variable, not its value. Without MONGODB_URI, persistence is "not configured" and every /api/runs
 * route says so; the rest of the app is unaffected.
 */

export const DEFAULT_DB_NAME = "flyfirefighter";
const DB_NAME_PATTERN = /^[A-Za-z0-9_-]{1,63}$/;

export type PersistenceConfig =
  | { readonly configured: true; readonly uri: string; readonly dbName: string }
  | { readonly configured: false; readonly reason: string };

/** Reads MONGODB_URI and MONGODB_DB; accepts process.env directly. */
export type PersistenceEnv = { readonly [name: string]: string | undefined };

export const NOT_CONFIGURED_MESSAGE = "Atlas persistence is not configured: set MONGODB_URI (and optionally MONGODB_DB) in .env.local and restart the server. See docs/persistence.md.";

/** Validate the settings without echoing them. A malformed value reads as not configured, with the variable named. */
export function readPersistenceConfig(env: PersistenceEnv): PersistenceConfig {
  const uri = (env.MONGODB_URI ?? "").trim();
  if (uri === "") return { configured: false, reason: NOT_CONFIGURED_MESSAGE };
  if (!/^mongodb(\+srv)?:\/\/[^\s]+$/.test(uri)) return { configured: false, reason: "MONGODB_URI is set but is not a mongodb:// or mongodb+srv:// connection string; persistence is off." };
  const dbName = (env.MONGODB_DB ?? "").trim() || DEFAULT_DB_NAME;
  if (!DB_NAME_PATTERN.test(dbName)) return { configured: false, reason: "MONGODB_DB must be 1–63 letters, digits, '_' or '-'; persistence is off." };
  return { configured: true, uri, dbName };
}

/** Remove anything that looks like a connection string or credentials from text that might reach a reply or log. */
export function redactSecrets(text: string): string {
  return text
    .replace(/mongodb(\+srv)?:\/\/[^\s"'<>]*/gi, "mongodb://[redacted]")
    .replace(/\b[^\s:@/]+:[^\s:@/]+@/g, "[redacted]@");
}

/**
 * The only form in which a driver failure leaves the server: the error class name (e.g.
 * MongoServerSelectionError) and a fixed sentence. Driver messages can contain host names, so they are dropped.
 */
export function publicErrorMessage(error: unknown): string {
  const name = error instanceof Error && /^[A-Za-z]{1,64}$/.test(error.name) ? error.name : "Error";
  return `The Atlas request failed (${name}). Check the cluster, the network access list and the credentials in .env.local.`;
}
