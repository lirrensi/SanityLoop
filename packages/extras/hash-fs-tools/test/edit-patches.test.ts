// packages/extras/hash-fs-tools/test/edit-patches.test.ts — no-op guard + leniency repairs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type ToolType } from "@sanityloop/core";
import { StubModel, assistantTurn } from "@sanityloop/test-kit/core";
import { createEditTools } from "../index.ts";
import { resEdit, stripReadRowPrefixes, rejectDiffContamination, type HEdit } from "../hashline/index.ts";

interface EditSuite {
  read: ToolType;
  replace: ToolType;
  undo: ToolType;
}

function setup(): { file: string; tools: EditSuite; agent: Agent } {
  const dir = mkdtempSync(join(tmpdir(), "hashline-patch-"));
  const file = join(dir, "a.txt");
  writeFileSync(file, "one\ntwo\nthree\n");
  const tools = createEditTools() as EditSuite; // in-memory store
  const agent = new Agent({ model: new StubModel([() => assistantTurn("x")]), agentId: "patch-test", cwd: dir });
  return { file, tools, agent };
}

async function readHashes(tools: EditSuite, agent: Agent, file: string): Promise<string[]> {
  const out = await tools.read.execute({ path: file }, agent) as { answer: string };
  // answer rows are `HASH│content` — first 3 chars before the separator
  return out.answer.split("\n").filter((l) => l.includes("│")).map((l) => l.slice(0, l.indexOf("│")));
}

function fakeEdit(lines: string[]): HEdit {
  return { content_lines: lines, hash_bounds: [{ hash: "aaa" }, { hash: "bbb" }] } as HEdit;
}

test("identical no-op escalates: soft → note → STOP at 3", async () => {
  const { file, tools, agent } = setup();
  const [h1, h2] = await readHashes(tools, agent, file);
  const payload = { path: file, remove_from: h1, remove_to: h2, replacement_text: "one\ntwo" };
  const first = await tools.replace.execute(payload, agent) as { answer: string };
  assert.match(first.answer, /Classification: noop/);
  assert.doesNotMatch(first.answer, /STOP/);
  const second = await tools.replace.execute(payload, agent) as { answer: string };
  assert.match(second.answer, /no-op'd 2 times in a row/);
  assert.doesNotMatch(second.answer, /STOP/);
  const third = await tools.replace.execute(payload, agent) as { answer: string };
  assert.match(third.answer, /STOP/);
  assert.match(third.answer, /Do NOT re-issue it/);
});

test("a real change resets the guard", async () => {
  const { file, tools, agent } = setup();
  const [h1, h2] = await readHashes(tools, agent, file);
  const noopPayload = { path: file, remove_from: h1, remove_to: h2, replacement_text: "one\ntwo" };
  await tools.replace.execute(noopPayload, agent);
  await tools.replace.execute(noopPayload, agent);
  // a real edit in between breaks the streak
  const changed = await tools.replace.execute({ path: file, remove_from: h1, remove_to: h1, replacement_text: "ONE" }, agent) as { answer: string };
  assert.doesNotMatch(changed.answer, /Classification: noop/);
  // same noop payload restarts at 1 (fresh anchors — ONE replaced one)
  const hashes = await readHashes(tools, agent, file);
  const again = await tools.replace.execute({ path: file, remove_from: hashes[1], remove_to: hashes[2], replacement_text: "two\nthree" }, agent) as { answer: string };
  assert.match(again.answer, /Classification: noop/);
  assert.doesNotMatch(again.answer, /STOP/);
  assert.doesNotMatch(again.answer, /2 times in a row/);
});

test("N: prefixes stripped when every line carries one", () => {
  const warnings: string[] = [];
  const stripped = stripReadRowPrefixes(fakeEdit(["1:one", "2:two", "", "4:four"]), warnings);
  assert.deepEqual(stripped.content_lines, ["one", "two", "", "four"]);
  assert.ok(warnings.some((w) => w.includes("[E_READ_ROW_PREFIX]")));
});

test("N: prefixes left alone on partial match (legit content)", () => {
  const warnings: string[] = [];
  const out = stripReadRowPrefixes(fakeEdit(["1:one", "plain line"]), warnings);
  assert.deepEqual(out.content_lines, ["1:one", "plain line"]);
  assert.equal(warnings.length, 0);
});

test("@@ hunk header rejects with E_DIFF_CONTAMINATION", () => {
  assert.throws(
    () => rejectDiffContamination(fakeEdit(["@@ -1,2 +1,2 @@", "-one", "+ONE"])),
    /E_DIFF_CONTAMINATION/,
  );
});

test("all -/+ rows reject with E_DIFF_CONTAMINATION; single-marker rows pass", () => {
  assert.throws(
    () => rejectDiffContamination(fakeEdit(["-one", "+ONE"])),
    /E_DIFF_CONTAMINATION/,
  );
  // single + row is a stripDiffPrefixes case, not contamination
  rejectDiffContamination(fakeEdit(["+ONE", "plain"]));
  rejectDiffContamination(fakeEdit(["normal", "text"]));
});

test("end-to-end: N: block pasted from read applies cleanly", async () => {
  const { file, tools, agent } = setup();
  const [h1] = await readHashes(tools, agent, file);
  const out = await tools.replace.execute({ path: file, remove_from: h1, remove_to: h1, replacement_text: "9:ONE" }, agent) as { answer: string };
  assert.match(out.answer, /\[E_READ_ROW_PREFIX\] Autocorrected/);
  assert.doesNotMatch(out.answer, /Classification: noop/);
});

test("end-to-end: diff payload errors with E_DIFF_CONTAMINATION", async () => {
  const { file, tools, agent } = setup();
  const [h1, h2] = await readHashes(tools, agent, file);
  await assert.rejects(
    async () => { await tools.replace.execute({ path: file, remove_from: h1, remove_to: h2, replacement_text: "@@ -1,2 +1,2 @@\n-one\n+ONE" }, agent); },
    /E_DIFF_CONTAMINATION/,
  );
});
