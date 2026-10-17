// LIVE container proof (needs SL_DOCKER=1): build the ref image, start a real
// container (workspace rw, docs ro), run all four tools through the wall.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cliExec } from "../exec.ts";
import { createSandboxedTools } from "../tools.ts";

const IMAGE = "sl-sandbox-tools-ref:test";
const here = dirname(fileURLToPath(import.meta.url));
const PKG = join(here, "..");
const REF = join(PKG, "Dockerfile.sandbox.ref");
const REPO_ROOT = join(PKG, "..", "..", "..");

function sh(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 240_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(" ")} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

const agent = (cwd: string) => ({ cwd });

test("LIVE sandboxed tools through the wall (needs SL_DOCKER=1)", {
  skip: process.env.SL_DOCKER !== "1",
  timeout: 300_000,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "sl-sbx-live-"));
  const ws = join(root, "ws");
  const docs = join(root, "docs");
  mkdirSync(ws, { recursive: true });
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "guide.md"), "# guide\n");
  const ctr = `sl-sbx-live-${Date.now()}`;

  // build context is the repo root (SDK ships in-package)
  await sh("docker", ["build", "-f", REF, "-t", IMAGE, REPO_ROOT]);
  await sh("docker", [
    "run", "-d", "--name", ctr,
    "-v", `${ws}:/workspace`,
    "-v", `${docs}:/docs:ro`,
    "--user", "root",
    IMAGE, "sleep", "infinity",
  ]);
  t.after(async () => {
    await sh("docker", ["rm", "-f", ctr]).catch(() => undefined);
  });

  const tools = createSandboxedTools({ container: ctr, exec: cliExec(), containerCwd: "/workspace" });

  // write + read round-trip
  const w = await tools.write.execute({ path: "hello.txt", content: "hello\nworld\n" }, agent(ws) as never);
  assert.equal((w as { error?: boolean }).error, undefined, JSON.stringify(w));
  const r = await tools.read.execute({ path: "hello.txt" }, agent(ws) as never);
  assert.ok((r as { answer: string }).answer.includes("1:hello"), JSON.stringify(r));

  // edit round-trip
  const e = await tools.edit.execute({ path: "hello.txt", old_string: "world", new_string: "wall" }, agent(ws) as never);
  assert.equal((e as { error?: boolean }).error, undefined, JSON.stringify(e));

  // bash stdout + exit code through the wall
  const b = await tools.bash.execute({ command: "echo hi && pwd" }, agent(ws) as never);
  assert.ok((b as { answer: string }).answer.includes("hi"), JSON.stringify(b));
  assert.equal((b as { stored: { exitCode: number } }).stored.exitCode, 0);
  const bfail = await tools.bash.execute({ command: "exit 3" }, agent(ws) as never);
  assert.equal((bfail as { error: boolean }).error, true);

  // read-only docs enforcement (container-side EROFS/R/O)
  const dw = await tools.write.execute({ path: "/docs/evil.txt", content: "x" }, agent(ws) as never);
  // /docs is outside agent cwd → rejected pre-exec OR fails in-container; either is a tool error
  assert.equal((dw as { error: boolean }).error, true);

  // outside-absolute rejected pre-exec
  const out = await tools.read.execute({ path: "/etc/passwd" }, agent(ws) as never);
  assert.equal((out as { error: boolean }).error, true);
  assert.ok((out as { answer: string }).answer.includes("outside the agent working directory"));

  // SDK version check passed implicitly (no "container exec failed" in answers above)
});
