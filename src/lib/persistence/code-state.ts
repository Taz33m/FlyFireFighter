/**
 * The code state recorded with a saved run: the checked-out commit and branch, read from .git without
 * running git (the web server path), or from the git CLI with the dirty flag (the batch uploader). A missing
 * or unreadable repository yields nulls, never an error.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeState } from "./model.ts";

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
export const UNKNOWN_CODE_STATE: CodeState = { gitCommit: null, gitBranch: null, gitDirty: null, source: "unknown" };

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function packedRef(gitDir: string, ref: string): string | null {
  const packed = readText(join(gitDir, "packed-refs")) ?? "";
  const line = packed.split("\n").find(l => l.endsWith(` ${ref}`));
  const sha = line?.split(" ")[0] ?? "";
  return SHA.test(sha) ? sha : null;
}

/** HEAD's commit and branch from the files in `<root>/.git`. */
export function readGitHead(root: string): CodeState {
  const gitDir = join(root, ".git");
  const head = readText(join(gitDir, "HEAD"))?.trim() ?? "";
  if (SHA.test(head)) return { gitCommit: head, gitBranch: null, gitDirty: null, source: "git_head_file" };
  const match = /^ref: (refs\/heads\/([A-Za-z0-9._/-]{1,200}))$/.exec(head);
  if (match === null || match[1].includes("..")) return UNKNOWN_CODE_STATE;
  const loose = readText(join(gitDir, ...match[1].split("/")))?.trim() ?? "";
  const commit = SHA.test(loose) ? loose : packedRef(gitDir, match[1]);
  return commit === null ? UNKNOWN_CODE_STATE : { gitCommit: commit, gitBranch: match[2], gitDirty: null, source: "git_head_file" };
}

/** Commit, branch and dirty flag from the git CLI (used by the batch script). */
export function gitCodeState(root: string): CodeState {
  try {
    const run = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
    const commit = run(["rev-parse", "HEAD"]);
    const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
    const dirty = run(["status", "--porcelain", "--untracked-files=no"]) !== "";
    return { gitCommit: SHA.test(commit) ? commit : null, gitBranch: branch === "HEAD" ? null : branch, gitDirty: dirty, source: "git_cli" };
  } catch {
    return readGitHead(root);
  }
}
