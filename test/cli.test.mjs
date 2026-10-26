import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gitAvailable, makeRepo } from "../tools/fixture.mjs";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const skip = gitAvailable() ? false : "git 不可用";

const run = (args, cwd) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });

const BASE_FILES = {
  "src/a.mjs": "export const a = 1;\n// TODO: retry on 409\nexport const b = 2;\n",
  "scripts/ok.mjs": "process.exit(0);\n",
  "scripts/fail.mjs": "process.exit(3);\n",
};

function repoWithHandoff(t, { args = [], files = BASE_FILES, commitMessage = "feat: fixture" } = {}) {
  const repo = makeRepo(t, { files });
  repo.commit(commitMessage);
  const init = run(["init", ...args], repo.dir);
  assert.equal(init.status, 0, init.stderr);
  return repo;
}

test("help lists both commands and exits 0", () => {
  const child = run(["--help"], process.cwd());
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /handoffcheck init/);
  assert.match(child.stdout, /handoffcheck check/);
  assert.equal(child.stderr, "");
});

test("an unknown command is a usage error", { skip }, () => {
  const child = run(["verify"], process.cwd());
  assert.equal(child.status, 2);
  assert.equal(child.stdout, "");
  assert.match(child.stderr, /未知命令/);
});

test("init writes a handoff with the current commit and the TODO anchor", { skip }, (t) => {
  const repo = makeRepo(t, { files: BASE_FILES });
  const head = repo.commit("feat: fixture");

  const init = run(["init", "--command", "node scripts/ok.mjs"], repo.dir);
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /HANDOFF\.md 已写入/);

  const text = readFileSync(path.join(repo.dir, "HANDOFF.md"), "utf8");
  assert.match(text, /schema: handoffcheck\/v1/);
  assert.match(text, new RegExp(`commit: ${head.slice(0, 12)}`));
  assert.match(text, /\| src\/a\.mjs \| [0-9a-f]{12} \|/);
  assert.match(text, /\| src\/a\.mjs \| 2 \| \/\/ TODO: retry on 409 \|/);
  assert.match(text, /\| node scripts\/ok\.mjs \| 0 \|/);
});

test("check passes immediately after init", { skip }, (t) => {
  const repo = repoWithHandoff(t, { args: ["--command", "node scripts/ok.mjs"] });
  const child = run(["check"], repo.dir);
  assert.equal(child.status, 0, `${child.stdout}${child.stderr}`);
  assert.match(child.stdout, /0 stale/);
  assert.match(child.stdout, /exit 0/);
});

test("editing a recorded file makes the handoff stale", { skip }, (t) => {
  const repo = repoWithHandoff(t, { args: ["--command", "node scripts/ok.mjs"] });
  repo.write("src/a.mjs", "export const a = 99;\n// TODO: retry on 409\nexport const b = 2;\n");

  const child = run(["check"], repo.dir);
  assert.equal(child.status, 1);
  assert.match(child.stdout, /✗ 文件 src\/a\.mjs/);
  assert.match(child.stdout, /hash 变了/);
  assert.match(child.stdout, /先修掉 ✗ 再接手/);
});

test("a removed TODO anchor is stale with the current line count", { skip }, (t) => {
  const repo = repoWithHandoff(t, { args: ["--command", "node scripts/ok.mjs"] });
  repo.write("src/a.mjs", "export const a = 1;\nexport const b = 2;\n");
  repo.commit("fix: drop the todo");

  const child = run(["check"], repo.dir);
  assert.equal(child.status, 1);
  assert.match(child.stdout, /✗ 锚点 src\/a\.mjs:2/);
  assert.match(child.stdout, /已经没有/);
});

test("a moved TODO anchor is only a warning", { skip }, (t) => {
  const repo = repoWithHandoff(t, { args: ["--command", "node scripts/ok.mjs"] });
  repo.write("src/a.mjs", "// header\nexport const a = 1;\n// TODO: retry on 409\nexport const b = 2;\n");
  repo.commit("docs: add header");

  const child = run(["check", "HANDOFF.md", "--json"], repo.dir);
  const payload = JSON.parse(child.stdout);
  const anchor = payload.items.find((entry) => entry.kind === "anchor");
  assert.equal(anchor.status, "warn");
  assert.match(anchor.detail, /第 3 行/);
  assert.ok(payload.items.some((entry) => entry.kind === "file" && entry.status === "stale"));
});

test("--json is parseable and reports items plus a summary", { skip }, (t) => {
  const repo = repoWithHandoff(t, { args: ["--command", "node scripts/ok.mjs"] });
  repo.write("src/a.mjs", "export const a = 99;\n// TODO: retry on 409\nexport const b = 2;\n");

  const child = run(["check", "HANDOFF.md", "--json"], repo.dir);
  assert.equal(child.status, 1);
  const payload = JSON.parse(child.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.exitCode, 1);
  assert.equal(payload.handoff.schema, "handoffcheck/v1");
  assert.equal(payload.handoff.files, 3);
  assert.ok(payload.items.some((entry) => entry.status === "stale"));
  assert.equal(payload.summary.stale >= 1, true);
  assert.match(payload.repo.head, /^[0-9a-f]{40}$/);
});

test("a commit after the handoff is a warning, and --strict turns it into a failure", { skip }, (t) => {
  const repo = repoWithHandoff(t, { args: ["--command", "node scripts/ok.mjs"] });
  repo.write("docs/notes.md", "写点笔记，不动交接里记录的文件。\n");
  repo.commit("docs: notes");

  const relaxed = run(["check"], repo.dir);
  assert.equal(relaxed.status, 0, relaxed.stdout);
  assert.match(relaxed.stdout, /已落后 1 个提交/);

  const strict = run(["check", "--strict"], repo.dir);
  assert.equal(strict.status, 1);
  assert.match(strict.stdout, /--strict/);
});

test("--run verifies a declared command and catches a wrong exit code", { skip }, (t) => {
  const ok = repoWithHandoff(t, { args: ["--command", "node scripts/ok.mjs"] });
  const okRun = run(["check", "HANDOFF.md", "--run"], ok.dir);
  assert.equal(okRun.status, 0, `${okRun.stdout}${okRun.stderr}`);
  assert.match(okRun.stdout, /✓ 命令 node scripts\/ok\.mjs/);
  assert.match(okRun.stdout, /与声明一致/);

  const bad = repoWithHandoff(t, { args: ["--command", "node scripts/fail.mjs"] });
  const badRun = run(["check", "HANDOFF.md", "--run"], bad.dir);
  assert.equal(badRun.status, 1);
  assert.match(badRun.stdout, /✗ 命令 node scripts\/fail\.mjs/);
  assert.match(badRun.stdout, /声明是 0/);
});

test("commands are not executed without --run", { skip }, (t) => {
  const repo = repoWithHandoff(t, { args: ["--command", "node scripts/fail.mjs"] });
  const child = run(["check"], repo.dir);
  assert.equal(child.status, 0, child.stdout);
  assert.match(child.stdout, /未执行/);
  assert.doesNotMatch(child.stdout, /声明是 0/);
});

test("a secret pasted into the handoff is warned about and masked", { skip }, (t) => {
  const token = "sk-abcdefghijklmnopqrstuvwxyz012345";
  const repo = repoWithHandoff(t, { args: ["--command", "node scripts/ok.mjs", "--note", `key: ${token}`] });

  const child = run(["check"], repo.dir);
  assert.equal(child.status, 0, child.stdout);
  assert.match(child.stdout, /疑似密钥 HANDOFF\.md/);
  assert.ok(!child.stdout.includes(token), "完整密钥不能出现在报告里");

  const strict = run(["check", "--strict"], repo.dir);
  assert.equal(strict.status, 1);
});

test("init refuses to overwrite unless --force is given", { skip }, (t) => {
  const repo = repoWithHandoff(t, { args: ["--command", "node scripts/ok.mjs"] });
  const again = run(["init"], repo.dir);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /已存在/);

  const forced = run(["init", "--force", "--command", "node scripts/ok.mjs"], repo.dir);
  assert.equal(forced.status, 0, forced.stderr);
});

test("init --json reports what it recorded", { skip }, (t) => {
  const repo = makeRepo(t, { files: BASE_FILES });
  repo.commit();
  const child = run(["init", "--json", "--command", "node scripts/ok.mjs"], repo.dir);
  assert.equal(child.status, 0, child.stderr);
  const payload = JSON.parse(child.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.out, "HANDOFF.md");
  assert.equal(payload.files.length, 3);
  assert.equal(payload.anchors.length, 1);
  assert.equal(payload.commands[0].command, "node scripts/ok.mjs");
  assert.ok(existsSync(path.join(repo.dir, "HANDOFF.md")));
});

test("a missing handoff file exits 1 with a readable message", { skip }, (t) => {
  const repo = makeRepo(t, { files: BASE_FILES });
  repo.commit();
  const child = run(["check", "NOPE.md"], repo.dir);
  assert.equal(child.status, 1);
  assert.match(child.stderr, /读不到交接文件/);
});

test("a handoff with an unknown section name is a format error, not a pass", { skip }, (t) => {
  const repo = repoWithHandoff(t, { args: ["--command", "node scripts/ok.mjs"] });
  const text = readFileSync(path.join(repo.dir, "HANDOFF.md"), "utf8").replace("## Anchors", "## Todo");
  writeFileSync(path.join(repo.dir, "HANDOFF.md"), text, "utf8");

  const child = run(["check"], repo.dir);
  assert.equal(child.status, 2);
  assert.match(child.stderr, /缺少/);
});

test("check outside a git repository is a usage error", { skip }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "handoffcheck-nogit-"));
  try {
    const child = run(["check"], dir);
    assert.equal(child.status, 2);
    assert.match(child.stderr, /不是一个 git 仓库/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an anchor pointing outside the file range is rejected by init", { skip }, (t) => {
  const repo = makeRepo(t, { files: BASE_FILES });
  repo.commit();
  const child = run(["init", "--anchor", "src/a.mjs:99"], repo.dir);
  assert.equal(child.status, 2);
  assert.match(child.stderr, /超出范围/);
});

test("the handoff never records its own hash, so re-init stays checkable", { skip }, (t) => {
  const repo = makeRepo(t, { files: BASE_FILES });
  repo.commit();
  run(["init", "--command", "node scripts/ok.mjs"], repo.dir);
  repo.commit("docs: handoff");

  const again = run(["init", "--force", "--command", "node scripts/ok.mjs"], repo.dir);
  assert.equal(again.status, 0, again.stderr);

  const text = readFileSync(path.join(repo.dir, "HANDOFF.md"), "utf8");
  assert.doesNotMatch(text, /\| HANDOFF\.md \|/);

  const child = run(["check"], repo.dir);
  assert.equal(child.status, 0, `${child.stdout}${child.stderr}`);
  assert.match(child.stdout, /0 stale/);
});

test("default anchors come from TODO markers in the recorded files", { skip }, (t) => {
  const repo = makeRepo(t, {
    files: {
      "src/a.mjs": "// FIXME: 空指针\nexport const a = 1;\n",
      "src/b.mjs": "// HACK: 临时绕过\n",
      "src/c.mjs": "// 没有标记\n",
    },
  });
  repo.commit();
  const child = run(["init"], repo.dir);
  assert.equal(child.status, 0, child.stderr);
  const text = readFileSync(path.join(repo.dir, "HANDOFF.md"), "utf8");
  assert.match(text, /\| src\/a\.mjs \| 1 \| \/\/ FIXME: 空指针 \|/);
  assert.match(text, /\| src\/b\.mjs \| 1 \| \/\/ HACK: 临时绕过 \|/);
  assert.doesNotMatch(text, /src\/c\.mjs \| 1/);
});
