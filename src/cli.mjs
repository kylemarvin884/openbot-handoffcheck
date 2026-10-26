#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  checkAnchors,
  checkBranch,
  checkCommands,
  checkCommit,
  checkFiles,
  pendingCommandsItem,
  scanSecrets,
  summarize,
} from "./checks.mjs";
import { EXIT, HandoffcheckError, ioError, repoError, usageError } from "./errors.mjs";
import {
  commitExists,
  countBetween,
  git,
  isAncestor,
  openRepo,
  resolveCommit,
} from "./git.mjs";
import { buildHandoff, parseHandoff, readTextFile } from "./handoff.mjs";
import { anchorsFromSpecs, cleanPath, defaultCommands, describeFiles, pickFiles, scanAnchors } from "./init.mjs";
import { formatJson, formatText } from "./report.mjs";
import { makeExecutor } from "./run.mjs";

const HELP = `handoffcheck — 接手前先确认交接文档还成立

Usage:
  handoffcheck init [options]                 从当前仓库状态写一份 HANDOFF.md
  handoffcheck check [HANDOFF.md] [options]   校验交接是否过期
  handoffcheck help

init 选项:
  --files <a,b>        要记录 hash 的文件，逗号分隔或重复给；默认取改动过的文件
  --anchor <path:line> 记录一个锚点，可重复；默认扫 TODO / FIXME / XXX / HACK
  --command <cmd>      记录一条命令，expect_exit 记为 0，可重复；默认 npm test
  --out <file>         输出路径，默认 HANDOFF.md
  --author <name>      作者，默认取 git config user.name
  --note <text>        写进 ## State 的自由文本（不校验）
  --next <text>        写进 ## Next 的自由文本（不校验）
  --root <dir>         在哪个仓库里生成，默认当前目录
  --force              覆盖已存在的 HANDOFF.md

check 选项:
  --run                真的执行 Commands 表里声明的命令并核对退出码
  --strict             警告也算失败（CI 门禁用）
  --timeout <秒>       --run 的单条命令超时，默认 120
  --root <dir>         在哪个仓库里检查，默认当前目录
  --json               stdout 输出纯 JSON

Exit codes:
  0  全部成立
  1  有过期项；或 --strict 下有警告
  2  用法 / 格式错误：不是 git 仓库、表头缺列、行号不是整数

check 不联网、不调用模型、不改仓库。--run 会执行交接里写的命令，只对自己写的交接用。
`;

function parsePositiveInt(raw, flag, { max }) {
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) {
    throw usageError(`${flag} 需要一个正整数，收到：${raw}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw usageError(`${flag} 必须在 1 到 ${max} 之间，收到：${raw}`);
  }
  return value;
}

function printError(error, jsonMode) {
  const known = error instanceof HandoffcheckError;
  const code = known ? error.code : "E_INTERNAL";
  const message = known ? error.message : `未预期错误：${error instanceof Error ? error.message : String(error)}`;
  if (jsonMode) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code, message } }, null, 2)}\n`);
  } else {
    process.stderr.write(`handoffcheck: ${message}\n`);
  }
  return known ? error.exitCode : EXIT.STALE;
}

function runInit(values) {
  const root = path.resolve(values.root ?? process.cwd());
  const repo = openRepo(root);
  if (!repo.head) {
    throw repoError("仓库还没有提交：先 git commit，再写交接（交接必须记录 commit）。");
  }

  const outName = values.out ?? "HANDOFF.md";
  const outPath = path.resolve(root, outName);
  if (existsSync(outPath) && !values.force) {
    throw usageError(`${outName} 已存在；确认要覆盖加 --force`);
  }

  const warnings = [];
  const explicitFiles = (values.files ?? [])
    .flatMap((entry) => String(entry).split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  const files = pickFiles({ explicit: explicitFiles, root, warn: (message) => warnings.push(message) });
  const outRelative = cleanPath(path.relative(root, outPath));
  const recorded = files.filter((file) => {
    if (file.path === outRelative) {
      warnings.push(`跳过 ${file.path}：交接文档不记录自己（hash 每次重写都会变）`);
      return false;
    }
    return true;
  });
  const anchors = values.anchor?.length
    ? anchorsFromSpecs(values.anchor, { root })
    : scanAnchors(recorded);
  const commands = values.command?.length
    ? values.command
        .map((command) => String(command).trim())
        .filter((command) => command !== "")
        .map((command) => ({ command, expectExit: 0 }))
    : defaultCommands(root);

  const gitAuthor = git(["config", "user.name"], root).stdout;
  const author = values.author ?? (gitAuthor === "" ? null : gitAuthor);

  const model = {
    repo: path.basename(repo.root),
    branch: repo.branch,
    commit: repo.head.slice(0, 12),
    created: new Date().toISOString(),
    author,
    files: describeFiles(recorded),
    anchors,
    commands,
    state: values.note ?? "",
    next: values.next ?? "",
  };

  let text;
  try {
    text = buildHandoff(model);
  } catch (error) {
    throw ioError(`生成交接失败：${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    writeFileSync(outPath, text, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : "E_IO";
    throw ioError(`写不进 ${outPath}（${code}）`);
  }

  return {
    ok: true,
    out: outName,
    path: outPath,
    repo: model.repo,
    branch: model.branch,
    commit: model.commit,
    created: model.created,
    author,
    files: model.files,
    anchors: model.anchors,
    commands: model.commands,
    warnings,
  };
}

function runCheck(values, positionals) {
  const root = path.resolve(values.root ?? process.cwd());
  const repo = openRepo(root);

  const outName = positionals[0] ?? "HANDOFF.md";
  const absolute = path.resolve(root, outName);
  const { text, reason } = readTextFile(absolute);
  if (text === null) throw ioError(`读不到交接文件 ${outName}：${reason}`);

  const handoff = parseHandoff(text, { file: path.basename(absolute) });
  const read = (relative) => readTextFile(path.resolve(repo.root, relative));

  const items = [
    checkCommit(handoff, {
      repo,
      commitExists: (sha) => commitExists(sha, repo.root),
      resolveCommit: (sha) => resolveCommit(sha, repo.root),
      isAncestor: (sha, ref) => isAncestor(sha, ref, repo.root),
      countBetween: (from, to) => countBetween(from, to, repo.root),
    }),
    checkBranch(handoff, { repo }),
    ...checkFiles(handoff.files, { read }),
    ...checkAnchors(handoff.anchors, { read }),
  ];

  if (values.run) {
    const timeoutSeconds = values.timeout === undefined ? 120 : parsePositiveInt(values.timeout, "--timeout", { max: 3600 });
    items.push(
      ...checkCommands(handoff.commands, {
        execute: makeExecutor({ cwd: repo.root, timeoutSeconds }),
      }),
    );
  } else {
    const pending = pendingCommandsItem(handoff.commands);
    if (pending) items.push(pending);
  }

  items.push(...scanSecrets(text, { file: path.basename(absolute) }));

  const summary = summarize(items);
  const strict = Boolean(values.strict);
  const failed = summary.stale > 0 || (strict && summary.warn > 0);

  return {
    ok: !failed,
    exitCode: failed ? EXIT.STALE : EXIT.OK,
    strict,
    file: outName,
    handoff,
    repo,
    summary,
    items,
  };
}

export function main(argv = process.argv.slice(2)) {
  const jsonMode = argv.includes("--json");
  try {
    let parsed;
    try {
      parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
          files: { type: "string", multiple: true },
          anchor: { type: "string", multiple: true },
          command: { type: "string", multiple: true },
          out: { type: "string" },
          author: { type: "string" },
          note: { type: "string" },
          next: { type: "string" },
          root: { type: "string" },
          timeout: { type: "string" },
          force: { type: "boolean" },
          run: { type: "boolean" },
          strict: { type: "boolean" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw usageError(`参数错误：${detail}\n运行 handoffcheck --help 查看用法。`);
    }

    const { values, positionals } = parsed;
    if (values.help || positionals.length === 0) {
      process.stdout.write(HELP);
      return EXIT.OK;
    }

    const command = positionals[0];
    if (command === "help") {
      process.stdout.write(HELP);
      return EXIT.OK;
    }
    if (!["init", "check"].includes(command)) {
      throw usageError(`未知命令：${command}`);
    }
    if (positionals.length > 2) {
      throw usageError(`多余的参数：${positionals.slice(2).join(" ")}`);
    }

    if (command === "init") {
      if (positionals.length > 1) throw usageError(`init 不接受位置参数：${positionals[1]}`);
      const result = runInit(values);
      if (values.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return EXIT.OK;
      }
      const out = [];
      out.push(`${result.out} 已写入`);
      out.push(
        `  repo ${result.repo} · branch ${result.branch ?? "?"} · commit ${result.commit}`,
      );
      out.push(`  files ${result.files.length} · anchors ${result.anchors.length} · commands ${result.commands.length}`);
      if (result.warnings.length > 0) {
        for (const warning of result.warnings) out.push(`  ⚠ ${warning}`);
      }
      out.push(`  下一步：handoffcheck check ${result.out}`);
      process.stdout.write(`${out.join("\n")}\n`);
      return EXIT.OK;
    }

    const result = runCheck(values, positionals.slice(1));
    if (values.json) {
      process.stdout.write(formatJson(result));
    } else {
      process.stdout.write(formatText(result));
    }
    return result.exitCode;
  } catch (error) {
    return printError(error, jsonMode);
  }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exitCode = main();
