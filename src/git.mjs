import { spawnSync } from "node:child_process";
import { repoError } from "./errors.mjs";

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
const MAX_BUFFER = 8 * 1024 * 1024;

/** Run git and return its exit status plus trimmed output. Never throws on a
 *  non-zero status: callers decide what a failure means. */
export function git(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: MAX_BUFFER,
    env: ENV,
  });
  if (result.error) throw repoError(`无法执行 git：${result.error.message}`);
  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? "").replace(/\r\n/g, "\n").trim(),
    stderr: (result.stderr ?? "").replace(/\r\n/g, "\n").trim(),
  };
}

/** Open the work tree that contains `cwd`. Throws E_NOREPO when git is not usable
 *  or the directory is not inside a repository. */
export function openRepo(cwd) {
  const top = git(["rev-parse", "--show-toplevel"], cwd);
  if (top.status !== 0 || top.stdout === "") {
    throw repoError(`不是一个 git 仓库：${cwd}\n先 git init，或在仓库目录里运行。`);
  }
  const root = top.stdout;
  const head = git(["rev-parse", "HEAD"], root);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], root);
  return {
    root,
    head: head.status === 0 && head.stdout !== "" ? head.stdout : null,
    branch: branch.status === 0 && branch.stdout !== "" ? branch.stdout : null,
  };
}

export function commitExists(sha, cwd) {
  return git(["cat-file", "-e", `${sha}^{commit}`], cwd).status === 0;
}

export function resolveCommit(sha, cwd) {
  const result = git(["rev-parse", `${sha}^{commit}`], cwd);
  return result.status === 0 ? result.stdout : null;
}

export function isAncestor(sha, ref, cwd) {
  return git(["merge-base", "--is-ancestor", sha, ref], cwd).status === 0;
}

/** Number of commits between `from` (exclusive) and `to` (inclusive), or null. */
export function countBetween(from, to, cwd) {
  const result = git(["rev-list", "--count", `${from}..${to}`], cwd);
  const count = Number(result.stdout);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function splitPaths(stdout) {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Paths with pending changes: tracked diff against HEAD plus untracked files.
 *  Falls back to every tracked path in a repo that has no commit yet. */
export function changedPaths(cwd) {
  const tracked = git(["-c", "core.quotepath=false", "diff", "--name-only", "HEAD"], cwd);
  const untracked = git(["-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard"], cwd);
  const all = git(["-c", "core.quotepath=false", "ls-files"], cwd);
  const base = tracked.status === 0 ? splitPaths(tracked.stdout) : splitPaths(all.stdout);
  const paths = new Set([...base, ...splitPaths(untracked.stdout)]);
  return [...paths].sort();
}

/** Paths touched by the last commit. */
export function lastCommitPaths(cwd) {
  const result = git(
    ["-c", "core.quotepath=false", "show", "--name-only", "--pretty=format:", "HEAD"],
    cwd,
  );
  return result.status === 0 ? splitPaths(result.stdout) : [];
}
