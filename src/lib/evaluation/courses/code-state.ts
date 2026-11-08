/**
 * Code state stamped into every dataset manifest and result bundle: the git commit plus a SHA-256 over the
 * uncommitted changes (tracked diffs and untracked files) in the source trees a course run executes, so two
 * bundles are comparable only when their code states match.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export const RUN_SOURCE_PATHS = ["src/lib/simulation", "src/lib/mission", "src/lib/harness", "src/lib/navigation", "src/lib/evaluation", "src/lib/contracts", "services/flyvis/flyvis_service"] as const;

export interface CodeState {
  readonly commit: string;
  readonly dirtyFiles: readonly string[];
  /** SHA-256 over the paths and contents of uncommitted files in RUN_SOURCE_PATHS; null when clean. */
  readonly uncommittedSha256: string | null;
  /** Same, restricted to src/lib/simulation (the coordinator's comparison key). */
  readonly simulationUncommittedSha256: string | null;
}

const git = (args: readonly string[]): string => execFileSync("git", [...args], { encoding: "utf8" }).trim();

function digest(files: readonly string[]): string | null {
  if (files.length === 0) return null;
  const h = createHash("sha256");
  for (const file of [...files].sort()) {
    h.update(`${file}\n`);
    h.update(existsSync(file) ? readFileSync(file) : "<deleted>");
  }
  return h.digest("hex");
}

export function codeState(): CodeState {
  const commit = git(["rev-parse", "HEAD"]);
  const status = git(["status", "--porcelain", "--untracked-files=all", "--", ...RUN_SOURCE_PATHS]);
  const dirtyFiles = status.split("\n").filter(line => line.length > 3).map(line => line.slice(3).split(" -> ").pop() as string).filter(f => !f.includes("__pycache__"));
  return { commit, dirtyFiles, uncommittedSha256: digest(dirtyFiles), simulationUncommittedSha256: digest(dirtyFiles.filter(f => f.startsWith("src/lib/simulation/"))) };
}
