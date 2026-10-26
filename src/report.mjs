import { shortHash } from "./handoff.mjs";

const ICON = { ok: "✓", warn: "⚠", stale: "✗", info: "·" };

const LABEL = {
  commit: (subject) => `commit ${subject}`,
  branch: (subject) => `branch ${subject}`,
  file: (subject) => `文件 ${subject}`,
  anchor: (subject) => `锚点 ${subject}`,
  secret: (subject) => `疑似密钥 ${subject}`,
  command: (subject) => `命令 ${subject}`,
};

const label = (entry) => (LABEL[entry.kind] ?? ((subject) => subject))(entry.subject);

export function formatText(result) {
  const out = [];
  const handoff = result.handoff;

  out.push(`${result.file}   schema ${handoff.schema}`);
  out.push(
    `  repo ${handoff.repo} · branch ${handoff.branch ?? "?"} · commit ${shortHash(handoff.commit)} · created ${handoff.created ?? "?"}`,
  );
  if (result.repo.head) {
    out.push(`  HEAD ${shortHash(result.repo.head)}（${result.repo.branch ?? "detached"}）`);
  } else {
    out.push("  HEAD (仓库还没有提交)");
  }
  out.push("");

  for (const entry of result.items) {
    const detail = entry.detail ? `  ${entry.detail}` : "";
    out.push(`  ${ICON[entry.status]} ${label(entry)}${detail}`);
  }

  out.push("");
  const summary = result.summary;
  const parts = [`${summary.stale} stale`, `${summary.warn} warn`, `${summary.ok} ok`];
  if (summary.info > 0) parts.push(`${summary.info} info`);
  out.push(`  ${parts.join(" · ")}  →  exit ${result.exitCode}`);

  if (summary.stale > 0) {
    out.push("");
    out.push("  先修掉 ✗ 再接手，或重跑 handoffcheck init --force 重写交接。");
  } else if (result.strict && summary.warn > 0) {
    out.push("");
    out.push("  --strict：警告也算失败。确认这些警告可以接受就改成默认模式。");
  }

  return `${out.join("\n")}\n`;
}

export function formatJson(result) {
  const handoff = result.handoff;
  return `${JSON.stringify(
    {
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      strict: result.strict,
      file: result.file,
      handoff: {
        schema: handoff.schema,
        repo: handoff.repo,
        branch: handoff.branch,
        commit: handoff.commit,
        created: handoff.created,
        author: handoff.author,
        files: handoff.files.length,
        anchors: handoff.anchors.length,
        commands: handoff.commands.length,
      },
      repo: result.repo,
      summary: result.summary,
      items: result.items,
    },
    null,
    2,
  )}\n`;
}
