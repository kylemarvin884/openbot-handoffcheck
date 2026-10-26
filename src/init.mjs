import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { usageError } from "./errors.mjs";
import { changedPaths, lastCommitPaths } from "./git.mjs";
import { MAX_HANDOFF_FILE_BYTES, SNIPPET_LIMIT, hashText, readTextFile, shortHash, splitLines } from "./handoff.mjs";

export const ANCHOR_PATTERN = /\b(TODO|FIXME|XXX|HACK)\b/;
export const MAX_ANCHORS = 20;

export const cleanPath = (value) => value.replace(/\\/g, "/").replace(/^\.\//, "").trim();

/** `path:line` — the path may contain a colon on Windows, so split on the last one. */
export function parseAnchorSpec(spec) {
  const text = String(spec ?? "").trim();
  const split = text.lastIndexOf(":");
  if (split <= 0) throw usageError(`--anchor 需要 path:line 形式，收到：${text}`);
  const rawPath = cleanPath(text.slice(0, split));
  const rawLine = text.slice(split + 1).trim();
  if (rawPath === "") throw usageError(`--anchor 的 path 为空：${text}`);
  if (!/^\d+$/.test(rawLine) || Number(rawLine) < 1) {
    throw usageError(`--anchor 的行号必须是 >= 1 的整数：${text}`);
  }
  return { path: rawPath, line: Number(rawLine) };
}

/** Files to fingerprint: explicit list, else pending changes, else the last
 *  commit's files. Anything unreadable or binary is skipped with a warning. */
export function pickFiles({ explicit = [], root, warn = () => {} }) {
  let candidates;
  if (explicit.length > 0) {
    candidates = explicit;
  } else {
    candidates = changedPaths(root);
    if (candidates.length === 0) candidates = lastCommitPaths(root);
    if (candidates.length === 0) {
      warn("没有改动、也没有上一次提交的文件可记录：HANDOFF 的 Files 表是空的。用 --files 指定。");
    }
  }

  const unique = [...new Set(candidates.map(cleanPath).filter((entry) => entry !== ""))].sort();
  const picked = [];
  for (const relative of unique) {
    if (relative.startsWith(".git/")) continue;
    const absolute = path.resolve(root, relative);
    let stat = null;
    try {
      stat = statSync(absolute);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile()) {
      warn(`跳过 ${relative}：不是文件`);
      continue;
    }
    if (stat.size > MAX_HANDOFF_FILE_BYTES) {
      warn(`跳过 ${relative}：超过 ${MAX_HANDOFF_FILE_BYTES / 1024 / 1024} MB`);
      continue;
    }
    const { text, reason } = readTextFile(absolute);
    if (text === null) {
      warn(`跳过 ${relative}：${reason}`);
      continue;
    }
    picked.push({ path: relative, sha256: hashText(text), note: "", text });
  }
  return picked;
}

/** Anchors recorded by default: TODO-style markers inside the fingerprinted files. */
export function scanAnchors(files, { limit = MAX_ANCHORS } = {}) {
  const anchors = [];
  for (const file of files) {
    const lines = splitLines(file.text);
    for (let index = 0; index < lines.length; index += 1) {
      if (!ANCHOR_PATTERN.test(lines[index])) continue;
      const snippet = lines[index].trim().slice(0, SNIPPET_LIMIT);
      if (snippet === "") continue;
      anchors.push({ path: file.path, line: index + 1, snippet });
      if (anchors.length >= limit) return anchors;
    }
  }
  return anchors;
}

export function anchorsFromSpecs(specs, { root }) {
  return specs.map((spec) => {
    const { path: relative, line } = parseAnchorSpec(spec);
    const { text } = readTextFile(path.resolve(root, relative));
    if (text === null) throw usageError(`--anchor 指向的文件读不到：${relative}`);
    const lines = splitLines(text);
    const atLine = lines[line - 1];
    if (atLine === undefined) {
      throw usageError(`--anchor ${relative}:${line} 超出范围（文件只有 ${lines.length} 行）`);
    }
    const snippet = atLine.trim().slice(0, SNIPPET_LIMIT);
    if (snippet === "") throw usageError(`--anchor ${relative}:${line} 是空行，没有可记录的文本`);
    return { path: relative, line, snippet };
  });
}

/** Default command set: whatever the repo already uses as its test command. */
export function defaultCommands(root) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    if (manifest && manifest.scripts && typeof manifest.scripts.test === "string") {
      return [{ command: "npm test", expectExit: 0 }];
    }
  } catch {
    // No package.json, or it is not JSON: no default command.
  }
  return [];
}

export function describeFiles(files) {
  return files.map(({ text, ...rest }) => rest);
}

export function headShort(commit) {
  return shortHash(commit);
}
