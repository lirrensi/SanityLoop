// SDK protocol test: drive sdk/cli.js as a subprocess with piped JSON (no docker).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "sdk", "cli.cjs");

function call(req: unknown): Promise<{ code: number | null; doc: unknown }> {
  return new Promise((resolve, reject) => {
    const child = execFile("node", [CLI], (err, stdout) => {
      let doc: unknown = null;
      try {
        doc = JSON.parse(stdout);
      } catch {
        doc = { parseError: true, stdout };
      }
      resolve({ code: err ? (err as { code?: number | null }).code ?? 1 : 0, doc });
    });
    child.stdin?.write(JSON.stringify(req));
    child.stdin?.end();
    child.on("error", reject);
  });
}

test("sdk: version reports protocol version 1", async () => {
  const { code, doc } = await call({ protocol: 1, tool: "version", args: {} });
  assert.equal(code, 0);
  assert.equal((doc as { ok: boolean }).ok, true);
  assert.equal((doc as { result: { stored: { version: number } } }).result.stored.version, 1);
});

test("sdk: read/edit/write round-trip on a local dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-sdk-"));
  const f = join(dir, "a.txt");
  let r = await call({ protocol: 1, tool: "write", args: { path: f, content: "hello\nworld\n" } });
  assert.equal((r.doc as { ok: boolean }).ok, true);
  r = await call({ protocol: 1, tool: "read", args: { path: f } });
  const readDoc = r.doc as { ok: boolean; result: { answer: string } };
  assert.equal(readDoc.ok, true);
  assert.ok(readDoc.result.answer.includes("1:hello"), readDoc.result.answer);
  r = await call({ protocol: 1, tool: "edit", args: { path: f, old_string: "world", new_string: "there" } });
  assert.equal((r.doc as { ok: boolean }).ok, true);
  r = await call({ protocol: 1, tool: "read", args: { path: f } });
  assert.ok(((r.doc as { result: { answer: string } }).result.answer.includes("there")));
});

test("sdk: protocol mismatch returns {ok:false}", async () => {
  const { doc } = await call({ protocol: 999, tool: "read", args: { path: "x" } });
  assert.equal((doc as { ok: boolean }).ok, false);
});

test("sdk: unknown tool returns {ok:false}", async () => {
  const { doc } = await call({ protocol: 1, tool: "delete", args: {} });
  assert.equal((doc as { ok: boolean }).ok, false);
});

test("sdk: binary file is a tool error (ok:true, error:true)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-sdk-"));
  const f = join(dir, "b.bin");
  writeFileSync(f, Buffer.from([0x00, 0x01, 0x02]));
  const { doc } = await call({ protocol: 1, tool: "read", args: { path: f } });
  const d = doc as { ok: boolean; result: { error?: boolean } };
  assert.equal(d.ok, true);
  assert.equal(d.result.error, true);
});

test("sdk: offset out of range is a tool error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-sdk-"));
  const f = join(dir, "c.txt");
  writeFileSync(f, "one\ntwo\n");
  const { doc } = await call({ protocol: 1, tool: "read", args: { path: f, offset: 99 } });
  const d = doc as { ok: boolean; result: { error?: boolean } };
  assert.equal(d.ok, true);
  assert.equal(d.result.error, true);
});

test("sdk: edit multiple-match without flag errors; with flag replaces all", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-sdk-"));
  const f = join(dir, "d.txt");
  writeFileSync(f, "aa aa aa\n");
  let r = await call({ protocol: 1, tool: "edit", args: { path: f, old_string: "aa", new_string: "b" } });
  assert.equal((r.doc as { result: { error?: boolean } }).result.error, true);
  r = await call({ protocol: 1, tool: "edit", args: { path: f, old_string: "aa", new_string: "b", multiple: true } });
  assert.equal((r.doc as { ok: boolean }).ok, true);
  assert.equal((r.doc as { result: { stored: { replacements: number } } }).result.stored.replacements, 3);
});
