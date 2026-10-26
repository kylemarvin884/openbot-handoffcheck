import { HASH_LENGTH, hashText, normalizeSpace, shortHash, splitLines } from "./handoff.mjs";

export const STATUS = Object.freeze({ OK: "ok", WARN: "warn", STALE: "stale", INFO: "info" });

const item = (kind, subject, status, detail = "") => ({ kind, subject, status, detail });

const SECRET_PATTERNS = [
  { name: "私钥", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "OpenAI key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/ },
  {
    name: "赋值的密钥",
    pattern: /\b(?:api[_-]?key|access[_-]?token|secret|password|passwd)\b\s*[:=]\s*["']?[A-Za-z0-9/+_-]{16,}/i,
  },
];

/** Never print a whole secret: keep a short prefix and mask the rest. */
function mask(value) {
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 6)}…${value.slice(-2)}`;
}

/** commit must exist, be an ancestor of HEAD, and (soft) not be far behind. */
export function checkCommit(handoff, { repo, commitExists, resolveCommit, isAncestor, countBetween }) {
  const declared = handoff.commit;
  if (!commitExists(declared)) {
    return item("commit", declared, STATUS.STALE, "git 里找不到这个 commit（可能被 rebase / squash / 删除）");
  }
  if (!repo.head) {
    return item("commit", declared, STATUS.WARN, "仓库还没有提交，无法判断是否过期");
  }
  const resolved = resolveCommit(declared);
  if (resolved !== null && resolved === repo.head) {
    return item("commit", declared, STATUS.OK, "就是当前 HEAD");
  }
  if (!isAncestor(declared, "HEAD")) {
    return item("commit", declared, STATUS.STALE, "不是 HEAD 的祖先：历史被改写过，交接里的结论可能失效");
  }
  const behind = countBetween(declared, "HEAD");
  if (behind === null) return item("commit", declared, STATUS.OK, "是 HEAD 的祖先");
  if (behind === 0) return item("commit", declared, STATUS.OK, "是 HEAD 的祖先");
  return item("commit", declared, STATUS.WARN, `是 HEAD 的祖先，但已落后 ${behind} 个提交`);
}

export function checkBranch(handoff, { repo }) {
  if (!handoff.branch) return item("branch", "(未声明)", STATUS.INFO, "HANDOFF 没写分支，跳过");
  if (repo.branch === null) return item("branch", handoff.branch, STATUS.WARN, "当前仓库处于 detached HEAD");
  if (repo.branch !== handoff.branch) {
    return item("branch", handoff.branch, STATUS.WARN, `当前在 ${repo.branch}`);
  }
  return item("branch", handoff.branch, STATUS.OK, `当前就在 ${repo.branch}`);
}

/** File hashes: any content change means the next agent must re-read the file. */
export function checkFiles(files, { read }) {
  return files.map((entry) => {
    const { text, reason } = read(entry.path);
    if (text === null) return item("file", entry.path, STATUS.STALE, reason ?? "读不到文件");
    const actual = hashText(text);
    const expected = entry.sha256.slice(0, HASH_LENGTH);
    if (actual === expected) {
      return item("file", entry.path, STATUS.OK, `${expected} 未变`);
    }
    return item("file", entry.path, STATUS.STALE, `hash 变了：${expected} → ${actual}`);
  });
}

/** Anchors: the line must still contain the recorded snippet. A snippet that
 *  merely moved is a warning; one that vanished is stale. */
export function checkAnchors(anchors, { read }) {
  return anchors.map((entry) => {
    const subject = `${entry.path}:${entry.line}`;
    const { text, reason } = read(entry.path);
    if (text === null) return item("anchor", subject, STATUS.STALE, reason ?? "读不到文件");

    const lines = splitLines(text);
    const wanted = normalizeSpace(entry.snippet);
    const atLine = lines[entry.line - 1];
    if (atLine !== undefined && normalizeSpace(atLine).includes(wanted)) {
      return item("anchor", subject, STATUS.OK, `仍在第 ${entry.line} 行`);
    }
    if (atLine === undefined) {
      return item(
        "anchor",
        subject,
        STATUS.STALE,
        `第 ${entry.line} 行已不存在（文件现在 ${lines.length} 行）`,
      );
    }
    const moved = lines.findIndex((line) => normalizeSpace(line).includes(wanted));
    if (moved !== -1) {
      return item("anchor", subject, STATUS.WARN, `文本移到了第 ${moved + 1} 行`);
    }
    return item("anchor", subject, STATUS.STALE, `这一行已经没有该文本：${entry.snippet}`);
  });
}

/** Scan the handoff itself: agents paste keys into status notes. */
export function scanSecrets(text, { file = "HANDOFF.md" } = {}) {
  const items = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    for (const { name, pattern } of SECRET_PATTERNS) {
      const match = pattern.exec(line);
      if (!match) continue;
      items.push(item("secret", `${file}:${index + 1}`, STATUS.WARN, `${name} ${mask(match[0])}`));
      break;
    }
  });
  return items;
}

/** Declared commands: only executed when the caller asks (--run). */
export function checkCommands(commands, { execute }) {
  if (commands.length === 0) return [];
  return commands.map((entry) => {
    if (entry.expectExit === "skip") {
      return item("command", entry.command, STATUS.INFO, "expect_exit 是 skip，不执行");
    }
    const result = execute(entry.command);
    if (result.timedOut) {
      return item("command", entry.command, STATUS.STALE, `超时（${result.timeoutSeconds}s）`);
    }
    if (result.status === entry.expectExit) {
      return item("command", entry.command, STATUS.OK, `exit ${result.status}，与声明一致`);
    }
    const tail = result.output ? `；最后一段输出：${result.output}` : "";
    return item(
      "command",
      entry.command,
      STATUS.STALE,
      `exit ${result.status === null ? "null" : result.status}，声明是 ${entry.expectExit}${tail}`,
    );
  });
}

export function pendingCommandsItem(commands) {
  const runnable = commands.filter((entry) => entry.expectExit !== "skip");
  if (runnable.length === 0) return null;
  return item(
    "command",
    `${runnable.length} 条声明`,
    STATUS.INFO,
    "未执行（加 --run 跑一遍，核对退出码）",
  );
}

export function summarize(items) {
  const summary = { ok: 0, warn: 0, stale: 0, info: 0, total: items.length };
  for (const entry of items) summary[entry.status] += 1;
  return summary;
}

export { shortHash };
