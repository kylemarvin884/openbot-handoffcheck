import assert from "node:assert/strict";
import test from "node:test";
import { SCHEMA, buildHandoff, hashText, normalizeSpace, parseHandoff, shortHash } from "../src/handoff.mjs";

const model = {
  repo: "demo",
  branch: "main",
  commit: "3d8f0b1a4c72",
  created: "2026-10-27T01:40:12.412Z",
  author: "demo-agent",
  files: [
    { path: "src/a.mjs", sha256: "5b81a9f0d3c2", note: "退款 | 重试" },
    { path: "src/b.mjs", sha256: "9c1d0b7e3a54", note: "" },
  ],
  anchors: [{ path: "src/a.mjs", line: 12, snippet: "// TODO: retry on 409" }],
  commands: [
    { command: "npm test", expectExit: 0 },
    { command: "node scripts/report.mjs", expectExit: "skip" },
  ],
  state: "退款主流程跑通；重试还在 TODO。",
};

const built = () => buildHandoff(model);

const schemaFailure = (fn) =>
  assert.throws(fn, (error) => {
    assert.equal(error.code, "E_SCHEMA");
    assert.equal(error.exitCode, 2);
    return true;
  });

test("buildHandoff then parseHandoff round-trips every checked field", () => {
  const parsed = parseHandoff(built(), { file: "HANDOFF.md" });
  assert.equal(parsed.schema, SCHEMA);
  assert.equal(parsed.repo, "demo");
  assert.equal(parsed.branch, "main");
  assert.equal(parsed.commit, "3d8f0b1a4c72");
  assert.equal(parsed.author, "demo-agent");
  assert.deepEqual(parsed.files, model.files);
  assert.deepEqual(parsed.anchors, model.anchors);
  assert.deepEqual(parsed.commands, model.commands);
});

test("a pipe inside a table cell survives the round trip", () => {
  const parsed = parseHandoff(built());
  assert.equal(parsed.files[0].note, "退款 | 重试");
});

test("backticks around cells are optional", () => {
  const source = [
    "# HANDOFF",
    "",
    "```handoff",
    "schema: handoffcheck/v1",
    "repo: demo",
    "commit: 3d8f0b1a4c72",
    "```",
    "",
    "## Files",
    "",
    "| path | sha256 |",
    "| --- | --- |",
    "| `src/a.mjs` | `5b81a9f0d3c2` |",
    "",
    "## Anchors",
    "",
    "| path | line | snippet |",
    "| --- | --- | --- |",
    "",
    "## Commands",
    "",
    "| command | expect_exit |",
    "| --- | --- |",
    "",
  ].join("\n");
  const parsed = parseHandoff(source);
  assert.equal(parsed.files[0].path, "src/a.mjs");
  assert.equal(parsed.files[0].sha256, "5b81a9f0d3c2");
  assert.deepEqual(parsed.anchors, []);
  assert.deepEqual(parsed.commands, []);
});

test("a missing handoff fence is a schema error, not a silent empty check", () => {
  schemaFailure(() => parseHandoff("# HANDOFF\n\n没有任何结构化内容。\n"));
});

test("a renamed section is rejected instead of quietly skipping anchors", () => {
  const text = built().replace("## Anchors", "## Anchor points");
  schemaFailure(() => parseHandoff(text));
});

test("a missing meta field is rejected", () => {
  const text = built().replace(/^commit: .*$/m, "");
  schemaFailure(() => parseHandoff(text));
});

test("an unknown schema version is rejected", () => {
  const text = built().replace(SCHEMA, "handoffcheck/v2");
  schemaFailure(() => parseHandoff(text));
});

test("a non-integer anchor line is rejected", () => {
  const text = built().replace("| src/a.mjs | 12 |", "| src/a.mjs | twelve |");
  schemaFailure(() => parseHandoff(text));
});

test("a table header missing a required column is rejected", () => {
  const text = built().replace("| path | sha256 | note |", "| path | hash | note |");
  schemaFailure(() => parseHandoff(text));
});

test("a row with the wrong number of cells is rejected", () => {
  const text = built().replace("| src/b.mjs | 9c1d0b7e3a54 |  |", "| src/b.mjs | 9c1d0b7e3a54 |");
  schemaFailure(() => parseHandoff(text));
});

test("a non-hex file hash is rejected", () => {
  const text = built().replace("9c1d0b7e3a54", "zzzzzzzzzzzz");
  schemaFailure(() => parseHandoff(text));
});

test("expect_exit accepts an integer, skip, or blank", () => {
  const text = built().replace("| node scripts/report.mjs | skip |", "| node scripts/report.mjs |  |");
  const parsed = parseHandoff(text);
  assert.equal(parsed.commands[1].expectExit, "skip");
  assert.equal(parsed.commands[0].expectExit, 0);
});

test("a negative or non-numeric expect_exit is rejected", () => {
  schemaFailure(() => parseHandoff(built().replace("| npm test | 0 |", "| npm test | sometimes |")));
});

test("hashText is a 12-char sha256 that ignores CRLF vs LF", () => {
  const lf = hashText("export const a = 1;\nexport const b = 2;\n");
  const crlf = hashText("export const a = 1;\r\nexport const b = 2;\r\n");
  assert.match(lf, /^[0-9a-f]{12}$/);
  assert.equal(lf, crlf);
  assert.notEqual(lf, hashText("export const a = 1;\n"));
});

test("normalizeSpace collapses whitespace so indentation drift is not a failure", () => {
  assert.equal(normalizeSpace("   // TODO:   retry\t on 409  "), "// TODO: retry on 409");
});

test("shortHash never returns more than 12 characters", () => {
  assert.equal(shortHash("0".repeat(40)).length, 12);
  assert.equal(shortHash(""), "");
});
