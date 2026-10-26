import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { schemaError } from "./errors.mjs";

export const SCHEMA = "handoffcheck/v1";
export const HASH_LENGTH = 12;
export const SNIPPET_LIMIT = 120;
export const MAX_HANDOFF_FILE_BYTES = 2 * 1024 * 1024;

const REQUIRED_META = ["schema", "repo", "commit"];
const SECTIONS = [
  { key: "files", heading: "Files", columns: ["path", "sha256"] },
  { key: "anchors", heading: "Anchors", columns: ["path", "line", "snippet"] },
  { key: "commands", heading: "Commands", columns: ["command", "expect_exit"] },
];

export const normalizeNewlines = (text) => text.replace(/\r\n?/g, "\n");
export const normalizeSpace = (text) => text.replace(/\s+/g, " ").trim();
export const shortHash = (sha) => String(sha ?? "").slice(0, HASH_LENGTH);

/** Split into logical lines. A trailing newline does not create an extra line,
 *  so "one line\n" is 1 line and anchors cannot point past the real content. */
export function splitLines(text) {
  const lines = normalizeNewlines(text).split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** sha256 of the file content, normalised to LF so that a Windows and a macOS
 *  checkout of the same commit produce the same hash. */
export function hashText(text) {
  return createHash("sha256").update(normalizeNewlines(text), "utf8").digest("hex").slice(0, HASH_LENGTH);
}

/** Read a text file; null when missing, unreadable, or larger than the cap.
 *  Returns a reason instead of throwing so checks can report it as stale. */
export function readTextFile(absolutePath) {
  try {
    const buffer = readFileSync(absolutePath);
    if (buffer.byteLength > MAX_HANDOFF_FILE_BYTES) {
      return { text: null, reason: `文件超过 ${MAX_HANDOFF_FILE_BYTES / 1024 / 1024} MB，跳过` };
    }
    if (buffer.includes(0)) return { text: null, reason: "看起来是二进制文件，跳过" };
    return { text: normalizeNewlines(buffer.toString("utf8")), reason: null };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : "E_IO";
    return { text: null, reason: `读不到（${code}）` };
  }
}

/* ------------------------------------------------------------------ parsing */

function stripCodeSpan(cell) {
  const trimmed = cell.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("`") && trimmed.endsWith("`")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function splitRow(line) {
  const cells = [];
  let current = "";
  let inCode = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\\" && (line[index + 1] === "|" || line[index + 1] === "\\")) {
      current += line[index + 1];
      index += 1;
      continue;
    }
    if (char === "`") inCode = !inCode;
    if (char === "|" && !inCode) {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  if (cells.length > 0 && cells[0].trim() === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === "") cells.pop();
  return cells.map(stripCodeSpan);
}

const isSeparatorRow = (cells) => cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));

function parseFence(lines, file) {
  const openIndex = lines.findIndex((line) => /^```handoff\s*$/i.test(line.trim()));
  if (openIndex === -1) {
    throw schemaError(
      `${file}: 找不到 \`\`\`handoff 元信息块。用 handoffcheck init 生成模板，或按 README 的格式手写。`,
    );
  }
  const meta = {};
  for (let index = openIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^```\s*$/.test(line.trim())) return meta;
    if (line.trim() === "") continue;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!match) {
      throw schemaError(`${file}: 元信息块第 ${index + 1} 行不是 \`key: value\` 格式：${line.trim()}`);
    }
    meta[match[1].toLowerCase()] = match[2].trim();
  }
  throw schemaError(`${file}: \`\`\`handoff 元信息块没有闭合`);
}

function collectSections(lines) {
  const sections = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^##\s+(.+?)\s*$/.exec(lines[index]);
    if (!heading) continue;
    const key = heading[1]
      .toLowerCase()
      .replace(/[`*_]/g, "")
      .trim();
    const rows = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor].trim();
      if (line.startsWith("|")) rows.push(line);
      else if (line === "") {
        if (rows.length === 0) continue;
        break;
      } else break;
    }
    sections.set(key, rows);
  }
  return sections;
}

function findSectionRows(sections, wanted) {
  const candidates = [wanted.toLowerCase()];
  for (const [key, rows] of sections) {
    if (candidates.includes(key)) return rows;
  }
  return null;
}

function parseTable(rows, { heading, columns, file }) {
  if (!rows) {
    throw schemaError(`${file}: 缺少 \`## ${heading}\` 章节（没有锚点时保留空表，不要删章节）`);
  }
  const table = rows.filter((line, index) => !(index === 1 && isSeparatorRow(splitRow(line))));
  if (table.length === 0) return [];
  const header = splitRow(table[0]).map((cell) =>
    cell.toLowerCase().replace(/[\s-]+/g, "_"),
  );
  const missing = columns.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    throw schemaError(
      `${file}: \`## ${heading}\` 表头缺列 ${missing.join(", ")}；需要 ${columns.join(" / ")}`,
    );
  }
  const body = table.slice(1);
  return body.map((line, offset) => {
    const cells = splitRow(line);
    if (cells.length !== header.length) {
      throw schemaError(
        `${file}: \`## ${heading}\` 第 ${offset + 1} 行列数不对（表头 ${header.length} 列，这一行 ${cells.length} 列）：${line}`,
      );
    }
    const row = {};
    header.forEach((column, index) => {
      row[column] = cells[index];
    });
    return { row, rowNumber: offset + 1 };
  });
}

const cleanPath = (value) => value.replace(/\\/g, "/").replace(/^\.\//, "").trim();

function parseFiles(entries, file) {
  return entries.map(({ row, rowNumber }) => {
    const relative = cleanPath(row.path ?? "");
    if (relative === "") throw schemaError(`${file}: Files 第 ${rowNumber} 行 path 为空`);
    const rawHash = (row.sha256 ?? "").replace(/^sha256:/i, "").trim().toLowerCase();
    if (!/^[0-9a-f]{7,64}$/.test(rawHash)) {
      throw schemaError(`${file}: Files 第 ${rowNumber} 行的 sha256 不是十六进制 hash：${row.sha256}`);
    }
    return { path: relative, sha256: rawHash, note: row.note ?? "" };
  });
}

function parseAnchors(entries, file) {
  return entries.map(({ row, rowNumber }) => {
    const relative = cleanPath(row.path ?? "");
    if (relative === "") throw schemaError(`${file}: Anchors 第 ${rowNumber} 行 path 为空`);
    const rawLine = (row.line ?? "").trim();
    if (!/^\d+$/.test(rawLine) || Number(rawLine) < 1) {
      throw schemaError(`${file}: Anchors 第 ${rowNumber} 行的 line 必须是 >= 1 的整数：${rawLine || "(空)"}`);
    }
    const snippet = (row.snippet ?? "").trim();
    if (snippet === "") throw schemaError(`${file}: Anchors 第 ${rowNumber} 行 snippet 为空`);
    return { path: relative, line: Number(rawLine), snippet };
  });
}

function parseCommands(entries, file) {
  return entries.map(({ row, rowNumber }) => {
    const command = (row.command ?? "").trim();
    if (command === "") throw schemaError(`${file}: Commands 第 ${rowNumber} 行 command 为空`);
    const rawExpect = (row.expect_exit ?? "").trim();
    if (rawExpect === "" || /^skip$/i.test(rawExpect)) return { command, expectExit: "skip" };
    if (!/^-?\d+$/.test(rawExpect)) {
      throw schemaError(
        `${file}: Commands 第 ${rowNumber} 行的 expect_exit 必须是整数或 skip：${rawExpect}`,
      );
    }
    return { command, expectExit: Number(rawExpect) };
  });
}

/** Parse a HANDOFF.md. Throws E_SCHEMA (exit 2) on anything it cannot read
 *  unambiguously: a typo must never silently disable a check. */
export function parseHandoff(text, { file = "HANDOFF.md" } = {}) {
  const source = normalizeNewlines(text);
  const lines = source.split("\n");
  const meta = parseFence(lines, file);

  const missingMeta = REQUIRED_META.filter((key) => !meta[key]);
  if (missingMeta.length > 0) {
    throw schemaError(`${file}: 元信息块缺字段 ${missingMeta.join(", ")}`);
  }
  if (meta.schema !== SCHEMA) {
    throw schemaError(`${file}: 不支持的 schema ${meta.schema}（本版本只认 ${SCHEMA}）`);
  }

  const sections = collectSections(lines);
  const tables = new Map();
  for (const section of SECTIONS) {
    tables.set(section.key, parseTable(findSectionRows(sections, section.heading), { ...section, file }));
  }

  return {
    schema: meta.schema,
    repo: meta.repo,
    branch: meta.branch ?? null,
    commit: meta.commit,
    created: meta.created ?? null,
    author: meta.author ?? null,
    files: parseFiles(tables.get("files"), file),
    anchors: parseAnchors(tables.get("anchors"), file),
    commands: parseCommands(tables.get("commands"), file),
    source,
  };
}

/* -------------------------------------------------------------- serialising */

function escapeCell(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function renderTable(header, rows) {
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
  ];
  for (const row of rows) lines.push(`| ${row.map(escapeCell).join(" | ")} |`);
  return lines;
}

/** Build the canonical HANDOFF.md. Everything `check` reads is machine-written;
 *  prose sections are for the next agent. */
export function buildHandoff(model) {
  const lines = [];
  lines.push("# HANDOFF", "");
  lines.push("> 由 `handoffcheck init` 生成。接手前先跑 `handoffcheck check HANDOFF.md`。");
  lines.push("> 三张表是唯一被校验的部分；改完代码记得 `init --force` 重写。", "");
  lines.push("```handoff");
  lines.push(`schema: ${SCHEMA}`);
  lines.push(`repo: ${model.repo}`);
  if (model.branch) lines.push(`branch: ${model.branch}`);
  lines.push(`commit: ${model.commit}`);
  lines.push(`created: ${model.created}`);
  if (model.author) lines.push(`author: ${model.author}`);
  lines.push("```", "");

  lines.push("## Files", "");
  lines.push(...renderTable(["path", "sha256", "note"], model.files.map((file) => [file.path, file.sha256, file.note ?? ""])), "");
  lines.push("## Anchors", "");
  lines.push(...renderTable(["path", "line", "snippet"], model.anchors.map((anchor) => [anchor.path, anchor.line, anchor.snippet])), "");
  lines.push("## Commands", "");
  lines.push(...renderTable(["command", "expect_exit"], model.commands.map((command) => [command.command, command.expectExit])), "");
  lines.push("## State", "");
  lines.push(model.state?.trim() || "（写下接手人需要的上下文。这一段不校验，check 不会读它。）", "");
  if (model.next) {
    lines.push("## Next", "");
    lines.push(model.next.trim(), "");
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}
