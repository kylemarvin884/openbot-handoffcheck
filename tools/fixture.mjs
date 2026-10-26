import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function gitAvailable() {
  const result = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
  return result.status === 0;
}

export function runGit(dir, args) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败：${(result.stderr ?? "").trim()}`);
  }
  return result;
}

/** Throwaway git repo with a committer already configured. `t` is the node:test
 *  context, used to register cleanup. */
export function makeRepo(t, { files = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "handoffcheck-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  runGit(dir, ["init", "-b", "main"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  runGit(dir, ["config", "user.name", "test-agent"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);

  const write = (relative, content) => {
    const absolute = path.join(dir, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  };

  for (const [relative, content] of Object.entries(files)) write(relative, content);

  return {
    dir,
    write,
    commit(message = "chore: fixture") {
      runGit(dir, ["add", "-A"]);
      runGit(dir, ["commit", "-m", message]);
      return runGit(dir, ["rev-parse", "HEAD"]).stdout.trim();
    },
  };
}
