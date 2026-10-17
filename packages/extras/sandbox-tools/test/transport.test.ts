import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDockerExecArgs,
  buildDockerodeOptions,
  buildExecCreateOptions,
  cliExec,
} from "../exec.ts";
import { createSandboxedTools } from "../tools.ts";
import type { ExecResult, ExecTransport } from "../exec.ts";

test("buildDockerExecArgs: exec -i, workdir, env, container, argv — no shell", () => {
  const args = buildDockerExecArgs("myctr", ["node", "/opt/sdk/cli.cjs"], {
    cwd: "/workspace",
    env: { A: "b" },
    stdin: '{"x":1}',
  });
  assert.deepEqual(args, [
    "exec", "-i", "--workdir", "/workspace", "--env", "A=b", "myctr", "node", "/opt/sdk/cli.cjs",
  ]);
});

test("buildDockerodeOptions: socket/host/port/tls passthrough", () => {
  assert.deepEqual(buildDockerodeOptions({ socketPath: "/var/run/docker.sock" }), {
    socketPath: "/var/run/docker.sock",
  });
  const o = buildDockerodeOptions({ host: "tcp://h", port: 2376, protocol: "https" });
  assert.equal(o.host, "tcp://h");
  assert.equal(o.port, 2376);
  assert.equal(o.protocol, "https");
});

test("buildExecCreateOptions: AttachStdin, no Tty, WorkingDir + Env mapping", () => {
  const o = buildExecCreateOptions(["sh", "-lc", "echo hi"], { cwd: "/w", env: { K: "v" } });
  assert.equal(o.AttachStdin, true);
  assert.equal(o.Tty, false);
  assert.deepEqual(o.Cmd, ["sh", "-lc", "echo hi"]);
  assert.equal(o.WorkingDir, "/w");
  assert.deepEqual(o.Env, ["K=v"]);
});

test("cliExec: builds docker argv and pipes stdin (fake docker shim)", async () => {
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "sl-shim-"));
  const shim = join(dir, "docker");
  writeFileSync(
    shim,
    `#!/bin/sh\necho "ARGV:$@"\ncat > /dev/null\necho "STDIN_DONE"\n`,
  );
  chmodSync(shim, 0o755);
  const exec = cliExec({ dockerPath: shim });
  const res = await exec("c1", ["node", "x.js"], { stdin: '{"a":1}', cwd: "/w" });
  assert.equal(res.code, 0);
  assert.ok(res.stdout.includes("ARGV:exec -i --workdir /w c1 node x.js"), res.stdout);
  assert.ok(res.stdout.includes("STDIN_DONE"), res.stdout);
});

function scripted(responses: ExecResult[]): { exec: ExecTransport; seen: { container: string; argv: string[]; stdin?: string }[] } {
  const seen: { container: string; argv: string[]; stdin?: string }[] = [];
  let i = 0;
  const exec: ExecTransport = async (container, argv, opts) => {
    seen.push({ container, argv, stdin: typeof opts?.stdin === "string" ? opts.stdin : undefined });
    return responses[Math.min(i++, responses.length - 1)]!;
  };
  return { exec, seen };
}

const agent = (cwd: string) => ({ cwd });

test("tools: version check runs once, then SDK calls carry translated paths", async () => {
  const version = { code: 0, stdout: '{"ok":true,"result":{"answer":"sdk version 1","stored":{"version":1}}}', stderr: "" };
  const readRes = { code: 0, stdout: '{"ok":true,"result":{"answer":"1:hi","stored":{"path":"/workspace/f.txt","total":1}}}', stderr: "" };
  const { exec, seen } = scripted([version, readRes, readRes]);
  const tools = createSandboxedTools({ container: "c", exec });
  const r1 = await tools.read.execute({ path: "f.txt" }, agent("/proj") as never);
  assert.ok((r1 as { answer: string }).answer.includes("1:hi"));
  const r2 = await tools.read.execute({ path: "/proj/f.txt" }, agent("/proj") as never);
  assert.ok((r2 as { answer: string }).answer.includes("1:hi"));
  // 1 version + 2 reads = 3 calls; second read translated to container path
  assert.equal(seen.length, 3);
  const bodies = seen.map((s) => JSON.parse(s.stdin!));
  assert.equal(bodies[0].tool, "version");
  assert.equal(bodies[1].args.path, "f.txt");
  assert.equal(bodies[2].args.path, "/workspace/f.txt");
});

test("tools: outside-absolute rejected before crossing (no exec call)", async () => {
  const { exec, seen } = scripted([]);
  const tools = createSandboxedTools({ container: "c", exec });
  const r = await tools.read.execute({ path: "/etc/passwd" }, agent("/proj") as never);
  assert.equal((r as { error: boolean }).error, true);
  assert.equal(seen.length, 0);
});

test("tools: dead container becomes a tool error result, not a throw", async () => {
  const exec: ExecTransport = async () => {
    const { ExecError } = await import("../exec.ts");
    throw new ExecError("cliExec: docker exec failed: No such container");
  };
  const tools = createSandboxedTools({ container: "dead", exec });
  const r = await tools.read.execute({ path: "f.txt" }, agent("/proj") as never);
  assert.equal((r as { error: boolean }).error, true);
  assert.ok((r as { answer: string }).answer.includes("No such container"));
});

test("tools: version mismatch becomes a tool error result", async () => {
  const bad = { code: 0, stdout: '{"ok":true,"result":{"answer":"v","stored":{"version":999}}}', stderr: "" };
  const { exec } = scripted([bad]);
  const tools = createSandboxedTools({ container: "c", exec });
  const r = await tools.read.execute({ path: "f.txt" }, agent("/proj") as never);
  assert.equal((r as { error: boolean }).error, true);
  assert.ok((r as { answer: string }).answer.includes("version mismatch"));
});

test("tools: bash runs sh -lc with container cwd, reports exit code", async () => {
  const version = { code: 0, stdout: '{"ok":true,"result":{"answer":"v","stored":{"version":1}}}', stderr: "" };
  const bashRes = { code: 2, stdout: "oops\n", stderr: "bad\n" };
  const { exec, seen } = scripted([version, bashRes]);
  const tools = createSandboxedTools({ container: "c", exec });
  const r = await tools.bash.execute({ command: "exit 2" }, agent("/proj") as never);
  assert.equal((r as { error: boolean }).error, true);
  assert.ok((r as { answer: string }).answer.includes("code 2"));
  assert.deepEqual(seen[1]!.argv, ["sh", "-lc", "exit 2"]);
});

test("tools: default containerCwd is /workspace", async () => {
  const version = { code: 0, stdout: '{"ok":true,"result":{"answer":"v","stored":{"version":1}}}', stderr: "" };
  const bashRes = { code: 0, stdout: "ok", stderr: "" };
  const { exec } = scripted([version, bashRes]);
  const tools = createSandboxedTools({ container: "c", exec });
  const r = await tools.bash.execute({ command: "pwd" }, agent("/proj") as never);
  assert.equal((r as { stored: { cwd: string } }).stored.cwd, "/workspace");
});

test("tools: bash truncates the tail and spills full output to a host temp file", async () => {
  const version = { code: 0, stdout: '{"ok":true,"result":{"answer":"v","stored":{"version":1}}}', stderr: "" };
  const big = Array.from({ length: 50 }, (_, i) => `line-${i}`).join("\n");
  const bashRes = { code: 0, stdout: big, stderr: "" };
  const { exec } = scripted([version, bashRes]);
  const tools = createSandboxedTools({ container: "c", exec, maxLines: 5 });
  const r = await tools.bash.execute({ command: "seq 0 49" }, agent("/proj") as never);
  const rec = r as { answer: string; stored: { truncated: boolean; fullOutputPath?: string } };
  assert.equal(rec.stored.truncated, true);
  assert.ok(rec.answer.includes("line-49"), "tail kept");
  assert.ok(!rec.answer.includes("line-0\n"), "head dropped");
  assert.ok(rec.answer.includes("Full output:"), "spill pointer present");
  assert.ok(rec.stored.fullOutputPath, "spill path stored");
  const full = readFileSync(rec.stored.fullOutputPath!, "utf8");
  assert.ok(full.includes("line-0") && full.includes("line-49"), "spill holds the complete output");
});
