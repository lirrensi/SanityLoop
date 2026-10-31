// The patch tool: exact apply, honest mismatches, strict parse.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@sanityloop/core";
import { StubModel, assistantTurn } from "@sanityloop/test-kit/core";
import { createBasicTools, createPatchTool, createEditTool } from "../index.ts";

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "basic-patch-"));
  const agent = new Agent({ model: new StubModel([() => assistantTurn("x")]), agentId: "basic-patch-test", cwd: dir });
  return { dir, agent };
};

test("selector: default edit, opt-in patch — one slot, never both", () => {
  assert.equal(createBasicTools().edit.name, "edit");
  assert.equal(createBasicTools({}).edit.name, "edit");
  assert.equal(createBasicTools({ edit: "simple" }).edit.name, "edit");
  assert.equal(createBasicTools({ edit: "patch" }).edit.name, "patch");
  assert.deepEqual(Object.keys(createBasicTools({ edit: "patch" })).sort(), ["edit", "read", "write"]);
  assert.equal(createEditTool().name, "edit");
  assert.equal(createPatchTool().name, "patch");
});

test("patch: multi-hunk apply with headers", async () => {
  const { dir, agent } = setup();
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\nfour\n");
  const r = await createPatchTool().execute({
    path: "a.txt",
    patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n@@ -3,2 +3,2 @@\n three\n-four\n+FOUR\n",
  }, agent);
  assert.equal(r.error, undefined);
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "one\nTWO\nthree\nFOUR\n");
  assert.ok(r.stored !== null && typeof r.stored === "object" && "hunks" in r.stored);
  assert.equal(r.stored.hunks, 2);
});

test("patch: mismatch names the line, file untouched", async () => {
  const { dir, agent } = setup();
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  const r = await createPatchTool().execute(
    { path: "a.txt", patch: "@@ -1,2 +1,2 @@\n one\n-WRONG\n+X\n" }, agent);
  assert.equal(r.error, true);
  assert.equal(typeof r.answer, "string");
  assert.match(r.answer, /does not match at line 2/);
  assert.match(r.answer, /Re-read the file/);
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "one\ntwo\n");
});

test("patch: bare empty line counts as empty context", async () => {
  const { dir, agent } = setup();
  writeFileSync(join(dir, "a.txt"), "one\n\ntwo\n");
  // models strip the trailing space: " " arrives as "" — must still apply
  const r = await createPatchTool().execute(
    { path: "a.txt", patch: "@@ -1,3 +1,3 @@\n one\n\n-two\n+TWO\n" }, agent);
  assert.equal(r.error, undefined);
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "one\n\nTWO\n");
});

test("patch: overlapping hunks rejected", async () => {
  const { dir, agent } = setup();
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
  const r = await createPatchTool().execute(
    { path: "a.txt", patch: "@@ -1,2 +1,2 @@\n one\n-two\n+X\n@@ -2,2 +2,2 @@\n two\n-three\n+Y\n" }, agent);
  assert.equal(r.error, true);
  assert.equal(typeof r.answer, "string");
  assert.match(r.answer, /overlaps/);
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "one\ntwo\nthree\n");
});

test("patch: garbage and missing file are typed errors", async () => {
  const { dir, agent } = setup();
  writeFileSync(join(dir, "a.txt"), "one\n");
  const g = await createPatchTool().execute({ path: "a.txt", patch: "hello world" }, agent);
  assert.equal(g.error, true);
  assert.equal(typeof g.answer, "string");
  assert.match(g.answer, /unrecognized patch line 1/);
  const m = await createPatchTool().execute({ path: "nope.txt", patch: "@@ -1,1 +1,1 @@\n-a\n+b\n" }, agent);
  assert.equal(m.error, true);
  assert.equal(typeof m.answer, "string");
  assert.match(m.answer, /does not exist/);
});

test("patch: trailing-newline state preserved", async () => {
  const { dir, agent } = setup();
  writeFileSync(join(dir, "nonl.txt"), "x\ny");
  const r = await createPatchTool().execute(
    { path: "nonl.txt", patch: "@@ -1,2 +1,2 @@\n x\n-y\n+Y\n" }, agent);
  assert.equal(r.error, undefined);
  assert.equal(readFileSync(join(dir, "nonl.txt"), "utf8"), "x\nY");
});
