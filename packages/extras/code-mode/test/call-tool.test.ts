import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EVENTS, Tool } from "@sanityloop/core";
import { makeAgent } from "@sanityloop/test-kit/core";
import { createToolCaller } from "../call-tool.ts";

function echoTool() {
    return Tool.define({
        name: "echo",
        description: "Echo.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        execute: async (p) => ({ answer: `echo:${(p as { text: string }).text}` }),
    });
}

describe("createToolCaller (via:code preset)", () => {
    it("delegates to agent.callTool with via code and depth 1", async () => {
        const { agent } = makeAgent({ script: [] });
        agent.addTool(echoTool());
        const seen: Array<{ via?: unknown; depth?: unknown }> = [];
        agent.addFilter({
            event: EVENTS.toolStart,
            id: "t/start",
            priority: 0,
            fn: async (_a, p) => { seen.push({ via: p?.via, depth: p?.depth }); },
        });
        const caller = createToolCaller(agent);
        const { result } = await caller("echo", { text: "hi" });
        assert.equal(result.answer, "echo:hi");
        assert.deepEqual(seen, [{ via: "code", depth: 1 }]);
    });

    it("passes id and signal through to the seam", async () => {
        const { agent } = makeAgent({ script: [] });
        agent.addTool(echoTool());
        let seenId: unknown;
        agent.addFilter({
            event: EVENTS.beforeTool,
            id: "t/gate",
            priority: 0,
            fn: async (_a, p) => { seenId = (p as { call?: { id?: string } }).call?.id; },
        });
        const caller = createToolCaller(agent);
        const controller = new AbortController();
        const outcome = await caller("echo", { text: "hi" }, { id: "cell1_c3", signal: controller.signal });
        assert.equal(outcome.call.id, "cell1_c3");
        assert.equal(seenId, "cell1_c3");
    });

    it("recursion block: code, delegate, call_tool (+ custom) never reach the wall", async () => {
        const { agent } = makeAgent({ script: [] });
        agent.addTool(echoTool());
        let wallRuns = 0;
        agent.addFilter({ event: EVENTS.beforeTool, id: "t/g", priority: 0, fn: async () => { wallRuns++; } });
        const caller = createToolCaller(agent);
        for (const name of ["code", "delegate", "call_tool"]) {
            const { result } = await caller(name, {});
            assert.equal(result.error, true, name);
            assert.equal(result.errorMessage, "recursion_blocked", name);
        }
        const custom = await caller("echo", { text: "hi" }, { blocked: ["echo"] });
        assert.equal(custom.result.errorMessage, "recursion_blocked");
        assert.equal(wallRuns, 0, "blocked calls never touch the gate chain");
    });

    it("selfName override blocks that name instead of code", async () => {
        const { agent } = makeAgent({ script: [] });
        agent.addTool(echoTool());
        const caller = createToolCaller(agent);
        const { result } = await caller("run", {}, { selfName: "run" });
        assert.equal(result.errorMessage, "recursion_blocked");
    });

    it("schema failures from the seam surface with the host grammar", async () => {
        const { agent } = makeAgent({ script: [] });
        agent.addTool(echoTool());
        const caller = createToolCaller(agent);
        const { result } = await caller("echo", {});
        assert.equal(result.errorMessage, "invalid_arguments");
        assert.match(String(result.answer), /Invalid arguments for echo/);
    });
});
