// Path translation table: relative passthrough, cwd-prefix rewrite,
// outside-absolute rejection, containerCwd override.
import { test } from "node:test";
import assert from "node:assert/strict";
import { translatePath } from "../tools.ts";

const HOST = process.platform === "win32" ? "C:\\proj" : "/proj";

test("relative paths pass through untouched", () => {
  assert.deepEqual(translatePath("a/b.txt", HOST, "/workspace"), { ok: true, containerPath: "a/b.txt" });
  assert.deepEqual(translatePath("./a.txt", HOST, "/workspace"), { ok: true, containerPath: "./a.txt" });
});

test("host-cwd-prefixed absolutes rewrite to containerCwd", () => {
  const p = process.platform === "win32" ? "C:\\proj\\sub\\f.txt" : "/proj/sub/f.txt";
  assert.deepEqual(translatePath(p, HOST, "/workspace"), { ok: true, containerPath: "/workspace/sub/f.txt" });
});

test("host cwd itself maps to containerCwd root", () => {
  assert.deepEqual(translatePath(HOST, HOST, "/workspace"), { ok: true, containerPath: "/workspace" });
});

test("absolutes outside host cwd are rejected", () => {
  const outside = process.platform === "win32" ? "C:\\other\\f.txt" : "/other/f.txt";
  const r = translatePath(outside, HOST, "/workspace");
  assert.equal(r.ok, false);
});

test("containerCwd override is honored", () => {
  const p = process.platform === "win32" ? "C:\\proj\\f.txt" : "/proj/f.txt";
  assert.deepEqual(translatePath(p, HOST, "/custom"), { ok: true, containerPath: "/custom/f.txt" });
});

test("sibling prefix (/proj2) does not match /proj", () => {
  const sib = process.platform === "win32" ? "C:\\proj2\\f.txt" : "/proj2/f.txt";
  assert.equal(translatePath(sib, HOST, "/workspace").ok, false);
});

test("container-side absolutes under containerCwd pass through", () => {
  assert.deepEqual(translatePath("/workspace/notes.txt", HOST, "/workspace"), { ok: true, containerPath: "/workspace/notes.txt" });
  assert.deepEqual(translatePath("/workspace", HOST, "/workspace"), { ok: true, containerPath: "/workspace" });
});

test("extra container roots (e.g. /docs) pass through; unknown roots rejected", () => {
  assert.deepEqual(translatePath("/docs/guide.md", HOST, "/workspace", ["/docs"]), { ok: true, containerPath: "/docs/guide.md" });
  assert.equal(translatePath("/docs/guide.md", HOST, "/workspace").ok, false);
});

test("container sibling prefix (/workspace2) does not match /workspace", () => {
  assert.equal(translatePath("/workspace2/f.txt", HOST, "/workspace").ok, false);
});
