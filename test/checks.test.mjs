import assert from "node:assert/strict";
import test from "node:test";
import {
  checkAnchors,
  checkBranch,
  checkCommands,
  checkCommit,
  checkFiles,
  pendingCommandsItem,
  scanSecrets,
  summarize,
} from "../src/checks.mjs";
import { hashText } from "../src/handoff.mjs";

const readerFor = (files) => (relative) =>
  relative in files
    ? { text: files[relative], reason: null }
    : { text: null, reason: "读不到（ENOENT）" };

test("checkFiles: unchanged content is ok", () => {
  const files = { "src/a.mjs": "export const a = 1;\n" };
  const items = checkFiles([{ path: "src/a.mjs", sha256: hashText(files["src/a.mjs"]) }], {
    read: readerFor(files),
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].status, "ok");
  assert.match(items[0].detail, /未变/);
});

test("checkFiles: changed content is stale and shows both hashes", () => {
  const items = checkFiles([{ path: "src/a.mjs", sha256: "aaaaaaaaaaaa" }], {
    read: readerFor({ "src/a.mjs": "export const a = 2;\n" }),
  });
  assert.equal(items[0].status, "stale");
  assert.match(items[0].detail, /aaaaaaaaaaaa → [0-9a-f]{12}/);
});

test("checkFiles: a deleted file is stale, never silently ok", () => {
  const items = checkFiles([{ path: "src/gone.mjs", sha256: "aaaaaaaaaaaa" }], { read: readerFor({}) });
  assert.equal(items[0].status, "stale");
  assert.match(items[0].detail, /ENOENT/);
});

test("checkAnchors: the recorded line still holds the snippet", () => {
  const files = { "src/a.mjs": "line1\n// TODO: retry on 409\nline3\n" };
  const items = checkAnchors([{ path: "src/a.mjs", line: 2, snippet: "// TODO: retry on 409" }], {
    read: readerFor(files),
  });
  assert.equal(items[0].status, "ok");
});

test("checkAnchors: indentation drift is not a failure", () => {
  const files = { "src/a.mjs": "line1\n        // TODO: retry on 409\n" };
  const items = checkAnchors([{ path: "src/a.mjs", line: 2, snippet: "// TODO: retry on 409" }], {
    read: readerFor(files),
  });
  assert.equal(items[0].status, "ok");
});

test("checkAnchors: a snippet that moved is a warning with the new line", () => {
  const files = { "src/a.mjs": "line1\nline2\nline3\n// TODO: retry on 409\n" };
  const items = checkAnchors([{ path: "src/a.mjs", line: 2, snippet: "// TODO: retry on 409" }], {
    read: readerFor(files),
  });
  assert.equal(items[0].status, "warn");
  assert.match(items[0].detail, /第 4 行/);
});

test("checkAnchors: a vanished snippet is stale", () => {
  const files = { "src/a.mjs": "export function refund() {}\nexport const b = 1;\n" };
  const items = checkAnchors([{ path: "src/a.mjs", line: 2, snippet: "// TODO: retry on 409" }], {
    read: readerFor(files),
  });
  assert.equal(items[0].status, "stale");
  assert.match(items[0].detail, /已经没有/);
});

test("checkAnchors: a line past the end of the file is stale", () => {
  const files = { "src/a.mjs": "only one line\n" };
  const items = checkAnchors([{ path: "src/a.mjs", line: 12, snippet: "// TODO" }], {
    read: readerFor(files),
  });
  assert.equal(items[0].status, "stale");
  assert.match(items[0].detail, /文件现在 1 行/);
});

test("scanSecrets finds keys, masks them, and keeps the line number", () => {
  const token = "sk-abcdefghijklmnopqrstuvwxyz012345";
  const text = ["# HANDOFF", "", "OPENAI_API_KEY=" + token, "", "普通文字不算。", ""].join("\n");
  const items = scanSecrets(text, { file: "HANDOFF.md" });
  assert.equal(items.length, 1);
  assert.equal(items[0].status, "warn");
  assert.equal(items[0].subject, "HANDOFF.md:3");
  assert.ok(!items[0].detail.includes(token), "完整密钥不能出现在输出里");
  assert.match(items[0].detail, /•|…/);
});

test("scanSecrets flags a private key header and a GitHub token", () => {
  const text = ["-----BEGIN RSA PRIVATE KEY-----", "ghp_" + "a".repeat(36)].join("\n");
  const items = scanSecrets(text);
  assert.equal(items.length, 2);
  assert.match(items[0].detail, /私钥/);
  assert.match(items[1].detail, /GitHub/);
});

test("checkCommit: an unknown commit is stale", () => {
  const items = checkCommit(
    { commit: "deadbeef" },
    {
      repo: { head: "f".repeat(40), branch: "main" },
      commitExists: () => false,
      resolveCommit: () => null,
      isAncestor: () => false,
      countBetween: () => 0,
    },
  );
  assert.equal(items.status, "stale");
  assert.match(items.detail, /找不到/);
});

test("checkCommit: a commit that is not an ancestor is stale", () => {
  const items = checkCommit(
    { commit: "aaaaaaaaaaaa" },
    {
      repo: { head: "f".repeat(40), branch: "main" },
      commitExists: () => true,
      resolveCommit: () => "a".repeat(40),
      isAncestor: () => false,
      countBetween: () => null,
    },
  );
  assert.equal(items.status, "stale");
  assert.match(items.detail, /历史被改写/);
});

test("checkCommit: being behind is a warning with the commit count", () => {
  const items = checkCommit(
    { commit: "aaaaaaaaaaaa" },
    {
      repo: { head: "f".repeat(40), branch: "main" },
      commitExists: () => true,
      resolveCommit: () => "a".repeat(40),
      isAncestor: () => true,
      countBetween: () => 3,
    },
  );
  assert.equal(items.status, "warn");
  assert.match(items.detail, /落后 3 个提交/);
});

test("checkCommit: the exact HEAD is ok", () => {
  const head = "a".repeat(40);
  const items = checkCommit(
    { commit: "aaaaaaaaaaaa" },
    {
      repo: { head, branch: "main" },
      commitExists: () => true,
      resolveCommit: () => head,
      isAncestor: () => true,
      countBetween: () => 0,
    },
  );
  assert.equal(items.status, "ok");
});

test("checkBranch: mismatch and detached HEAD are warnings", () => {
  assert.equal(checkBranch({ branch: "main" }, { repo: { branch: "feat" } }).status, "warn");
  assert.equal(checkBranch({ branch: "main" }, { repo: { branch: null } }).status, "warn");
  assert.equal(checkBranch({ branch: "main" }, { repo: { branch: "main" } }).status, "ok");
  assert.equal(checkBranch({ branch: null }, { repo: { branch: "main" } }).status, "info");
});

test("checkCommands: a matching exit code is ok, a mismatch is stale", () => {
  const ok = checkCommands([{ command: "npm test", expectExit: 0 }], {
    execute: () => ({ status: 0, timedOut: false, output: "" }),
  });
  assert.equal(ok[0].status, "ok");

  const bad = checkCommands([{ command: "npm test", expectExit: 0 }], {
    execute: () => ({ status: 1, timedOut: false, output: "1 failing" }),
  });
  assert.equal(bad[0].status, "stale");
  assert.match(bad[0].detail, /exit 1/);
  assert.match(bad[0].detail, /1 failing/);
});

test("checkCommands: a timeout is stale, a skip is not executed", () => {
  let called = 0;
  const items = checkCommands(
    [
      { command: "sleep 999", expectExit: 0 },
      { command: "npm run deploy", expectExit: "skip" },
    ],
    {
      execute: () => {
        called += 1;
        return { status: null, timedOut: true, timeoutSeconds: 1, output: "" };
      },
    },
  );
  assert.equal(called, 1);
  assert.equal(items[0].status, "stale");
  assert.match(items[0].detail, /超时/);
  assert.equal(items[1].status, "info");
});

test("pendingCommandsItem only counts runnable commands", () => {
  assert.equal(pendingCommandsItem([]), null);
  assert.equal(pendingCommandsItem([{ command: "a", expectExit: "skip" }]), null);
  const item = pendingCommandsItem([
    { command: "a", expectExit: 0 },
    { command: "b", expectExit: "skip" },
  ]);
  assert.equal(item.status, "info");
  assert.match(item.subject, /1 条/);
});

test("summarize counts each status", () => {
  const summary = summarize([
    { status: "ok" },
    { status: "ok" },
    { status: "warn" },
    { status: "stale" },
    { status: "info" },
  ]);
  assert.deepEqual(summary, { ok: 2, warn: 1, stale: 1, info: 1, total: 5 });
});
