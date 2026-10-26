#!/usr/bin/env node
// End-to-end demo: a real git repo, a real handoff, a real staleness check.
// Everything printed below is the CLI's own stdout — nothing is hand-written.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli.mjs");
const base = path.join(here, ".tmp");
const repo = path.join(base, "demo-repo");

function run(command, args, { cwd = repo, mustSucceed = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
  if (mustSucceed && result.status !== 0) {
    process.stderr.write(`${result.stdout ?? ""}${result.stderr ?? ""}\n`);
    throw new Error(`${command} ${args.join(" ")} 退出码 ${result.status}`);
  }
  return result;
}

const git = (...args) => run("git", args, { mustSucceed: true });
const cliRun = (...args) => run(process.execPath, [cli, ...args]);

function block(title, text) {
  process.stdout.write(`\n${"─".repeat(72)}\n${title}\n${"─".repeat(72)}\n`);
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

const failures = [];
function expect(label, actual, expected) {
  const pass = actual === expected;
  if (!pass) failures.push(`${label}: 期望 ${expected}，实际 ${actual}`);
  process.stdout.write(`\n[${pass ? "ok" : "FAIL"}] ${label} → exit ${actual}\n`);
}

// 1. A tiny repo with a real test suite.
rmSync(base, { recursive: true, force: true });
mkdirSync(path.join(repo, "src"), { recursive: true });
mkdirSync(path.join(repo, "test"), { recursive: true });

git("init", "-b", "main");
git("config", "user.email", "demo@example.com");
git("config", "user.name", "demo-agent");
git("config", "commit.gpgsign", "false");

writeFileSync(
  path.join(repo, "package.json"),
  `${JSON.stringify(
    { name: "demo-repo", private: true, type: "module", scripts: { test: "node --test" } },
    null,
    2,
  )}\n`,
  "utf8",
);
writeFileSync(
  path.join(repo, "test", "smoke.test.mjs"),
  [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { total } from "../src/api.mjs";',
    "",
    'test("total adds up", () => {',
    "  assert.equal(total(2, 3), 5);",
    "});",
    "",
  ].join("\n"),
  "utf8",
);
writeFileSync(
  path.join(repo, "src", "api.mjs"),
  ['export const total = (a, b) => a + b;', "", 'export const REFUND_ENDPOINT = "/api/refunds";', ""].join("\n"),
  "utf8",
);
const checkoutV1 = [
  "export function refund(order) {",
  "  // TODO: retry on 409",
  '  return { order: order.id, status: "pending" };',
  "}",
  "",
].join("\n");
writeFileSync(path.join(repo, "src", "checkout.mjs"), checkoutV1, "utf8");

git("add", "-A");
git("commit", "-m", "feat: pending refund flow");

// 2. Agent A writes the handoff.
const init = cliRun(
  "init",
  "--files",
  "src/checkout.mjs,src/api.mjs",
  "--anchor",
  "src/checkout.mjs:2",
  "--command",
  "npm test",
  "--note",
  "退款主流程跑通；409 重试还在 TODO。",
  "--next",
  "先补 409 重试和对应的测试，再动 api.mjs。",
);
expect("init 生成交接", init.status, 0);
block("HANDOFF.md（init 生成）", readFileSync(path.join(repo, "HANDOFF.md"), "utf8"));

const clean = cliRun("check", "HANDOFF.md");
block("刚写完就 check：应该全部成立", `${clean.stdout}${clean.stderr}`);
expect("干净状态下 check", clean.status, 0);

// 3. Agent B picks it up, implements the retry, and drops the TODO.
const checkoutV2 = [
  "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
  "",
  "export async function refund(order, attempt = 0) {",
  '  if (attempt > 2) return { order: order.id, status: "failed" };',
  "  await sleep(50 * (attempt + 1));",
  '  return { order: order.id, status: "pending", attempt };',
  "}",
  "",
].join("\n");
writeFileSync(path.join(repo, "src", "checkout.mjs"), checkoutV2, "utf8");
git("add", "-A");
git("commit", "-m", "fix: retry refund on conflict");

const stale = cliRun("check", "HANDOFF.md");
block("另一个 agent 改完代码后 check：应该过期", `${stale.stdout}${stale.stderr}`);
expect("代码变了之后 check", stale.status, 1);

// 4. Rewrite the handoff, then verify the declared command actually runs.
const rewrite = cliRun(
  "init",
  "--force",
  "--files",
  "src/checkout.mjs,src/api.mjs",
  "--anchor",
  "src/checkout.mjs:3",
  "--command",
  "npm test",
  "--note",
  "409 重试已实现，还没覆盖冲突分支的测试。",
);
expect("init --force 重写", rewrite.status, 0);

const withRun = cliRun("check", "HANDOFF.md", "--run");
block("重写后 check --run：命令也要对得上", `${withRun.stdout}${withRun.stderr}`);
expect("重写后 check --run", withRun.status, 0);

process.stdout.write("\n");
if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("demo 通过：交接过期会被 check 抓住，重写后恢复到 exit 0。\n");
  rmSync(base, { recursive: true, force: true });
}
