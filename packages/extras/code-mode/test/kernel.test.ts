import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { Tool } from "@sanityloop/core";
import { makeAgent } from "@sanityloop/test-kit/core";
import { createCodeMode } from "../index.ts";

// Live-kernel integration: spawns real python3/node children. Skips cleanly
// when python3 is missing (js tests still run).
const agents: Array<{ uninstall: (id: string) => void }> = [];
after(() => {
    for (const a of agents.splice(0)) {
        try { a.uninstall("code-mode"); } catch { /* already gone */ }
    }
});

function rig(id: string) {
    const { agent } = makeAgent({ script: [], agentId: id });
    agent.install(createCodeMode());
    agent.addTool(Tool.define({
        name: "echo",
        description: "Echo.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        execute: async (p) => ({ answer: `echo:${(p as { text: string }).text}` }),
    }));
    agents.push(agent);
    const code = agent.tools.find((t) => t.name === "code")!;
    const text = (a: unknown): string => typeof a === "string" ? a : JSON.stringify(a);
    const run = (params: unknown) => Promise.resolve(code.execute(params, agent as never)).then((r) => ({ ...r, text: text(r.answer) }));
    return { agent, run };
}

async function hasPython(): Promise<boolean> {
    try {
        const { execFile } = await import("node:child_process");
        await new Promise<void>((resolve, reject) => {
            execFile("python3", ["--version"], (err) => err ? reject(err) : resolve());
        });
        return true;
    } catch {
        return false;
    }
}

describe("code tool (live kernels)", () => {
    it("py: basics + state + trailing expr", async () => {
        if (!await hasPython()) return;
        const { run } = rig("code-py");
        const r1 = await run({ language: "py", code: "x = 1\nprint('hi')\nx + 1" });
        assert.match(r1.text, /hi/);
        assert.match(r1.text, /=> 2/);
        const r2 = await run({ language: "py", code: "x + 10" });
        assert.match(r2.text, /=> 11/);
    });

    it("py: top-level await + bridge call + enriched invalid_arguments", async () => {
        if (!await hasPython()) return;
        const { run } = rig("code-py2");
        const r1 = await run({ language: "py", code: "import asyncio\nawait asyncio.sleep(0.01)\n'ready'" });
        assert.equal(r1.error, undefined);
        const r2 = await run({ language: "py", code: "out = await tools.echo(text='yo')\nout" });
        assert.equal(r2.error, undefined);
        assert.match(r2.text, /echo:yo/);
        const r3 = await run({ language: "py", code: "await tools.echo()" });
        assert.match(r3.text, /Invalid arguments for echo/);
        assert.match(r3.text, /Signature: echo\(text\)/);
    });

    it("py: timeout kills the kernel, stale vars are gone", async () => {
        if (!await hasPython()) return;
        const { run } = rig("code-py3");
        await run({ language: "py", code: "zzz = 1" });
        const t0 = Date.now();
        const r = await run({ language: "py", code: "import time\ntime.sleep(30)", timeout: 2 });
        assert.equal(r.error, true);
        assert.match(r.text, /kernel restarted \(timeout\)/);
        assert.ok(Date.now() - t0 < 25_000, "kill ladder took too long");
        const r2 = await run({ language: "py", code: "zzz" });
        assert.match(r2.text, /NameError/);
    });

    it("js: basics + TS + state", async () => {
        const { run } = rig("code-js");
        const r1 = await run({ language: "js", code: "const a = 2\nconsole.log('hi')\na * 3" });
        assert.match(r1.text, /hi/);
        assert.match(r1.text, /=> 6/);
        const r2 = await run({ language: "js", code: "const n: number = 41; n + 1" });
        assert.match(r2.text, /=> 42/);
    });

    it("js: bridge call needs explicit return in TLA cells", async () => {
        const { run } = rig("code-js2");
        const r = await run({ language: "js", code: "const r = await tools.echo({ text: 'hey' }); return r;" });
        assert.equal(r.error, undefined);
        assert.match(r.text, /echo:hey/);
    });

    it("js: sync loop is killed by the host (state gone, honest notice)", async () => {
        const { run } = rig("code-js3");
        await run({ language: "js", code: "var keep = 1;" });
        const r = await run({ language: "js", code: "while (true) {}", timeout: 2 });
        assert.equal(r.error, true);
        assert.match(r.text, /kernel restarted \(timeout\)/);
        const r2 = await run({ language: "js", code: "typeof keep" });
        assert.match(r2.text, /undefined/);
    });

    it("reset clears state with a notice", async () => {
        const { run } = rig("code-js4");
        await run({ language: "js", code: "var q = 1;" });
        const r = await run({ language: "js", code: "typeof q", reset: true });
        assert.match(r.text, /undefined/);
        assert.match(r.text, /kernel restarted \(reset\)/);
    });

    it("%magics are rejected host-side without touching the kernel", async () => {
        const { run } = rig("code-magic");
        for (const [cell, marker] of [["%bun add x", "%bun"], ["%pip install x", "%pip"], ["%wat", "unknown magic"]] as const) {
            const r = await run({ language: "js", code: cell });
            assert.equal(r.error, true, cell);
            assert.match(r.text, new RegExp(marker.replace("%", "%")), cell);
        }
    });

    it("invalid params fail before any kernel work", async () => {
        const { run } = rig("code-params");
        const r1 = await run({ language: "rb", code: "1" });
        assert.equal(r1.error, true);
        const r2 = await run({ language: "js", code: "1", timeout: "60" });
        assert.equal(r2.error, true);
    });
});
