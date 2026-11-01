// ============================================================================
// packages/core/test/call-tool.test.ts — GodObject.callTool, the universal seam.
// ============================================================================
// callTool runs ONE tool through the full wall from anywhere: gate →
// park-wait → preResolved → resolve → schema → toolStart → execute →
// (afterTool?) → (commit?) → toolEnd. Never throws, never touches messages
// unless commit:true. The loop lane (executeOne) delegates to the same body.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, EVENTS, MAX_CALLTOOL_DEPTH, Tool } from "@sanityloop/core";
import type { GodObject, Tool as ToolType } from "@sanityloop/core";
import { StubModel, assistantTurn, callTo, toolCallTurn } from "@sanityloop/test-kit/core";
import { awaitIdle } from "@sanityloop/test-kit";
import { seedUserMessage, kick } from "@sanityloop/test-kit/core";

function echoTool(): ToolType {
    return Tool.define({
        name: "echo",
        description: "Echo.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        execute: async (p) => ({ answer: `echo:${(p as { text: string }).text}` }),
    });
}

function bareAgent(tools: ToolType[] = [echoTool()]): Agent {
    return new Agent({ model: new StubModel([]), tools, agentId: "calltool-test" });
}

// ---------------------------------------------------------------------------
// the wall, end to end
// ---------------------------------------------------------------------------

test("callTool runs the full wall and returns {call, result}", async () => {
    const agent = bareAgent();
    const seen: string[] = [];
    for (const ev of [EVENTS.beforeTool, EVENTS.toolStart, EVENTS.toolEnd] as const) {
        agent.addFilter({ event: ev, id: `t/${ev}`, priority: 0, fn: async () => { seen.push(ev); } });
    }
    const outcome = await agent.callTool("echo", { text: "hi" }, { via: "test" });
    assert.equal(outcome.result.answer, "echo:hi");
    assert.equal(outcome.result.error, undefined);
    assert.equal(outcome.call.name, "echo");
    assert.deepEqual(outcome.call.parameters, { text: "hi" });
    assert.deepEqual(seen, [EVENTS.beforeTool, EVENTS.toolStart, EVENTS.toolEnd]);
    assert.equal(outcome.gated, false);
    assert.equal(agent.messages.length, 0, "no commit by default");
});

test("callTool carries via/depth on every event payload", async () => {
    const agent = bareAgent();
    const got: Array<{ via?: unknown; depth?: unknown }> = [];
    for (const ev of [EVENTS.beforeTool, EVENTS.toolStart, EVENTS.toolEnd] as const) {
        agent.addFilter({ event: ev, id: `t/${ev}`, priority: 0, fn: async (_a, p) => { got.push({ via: p?.via, depth: p?.depth }); } });
    }
    await agent.callTool("echo", { text: "hi" }, { via: "code", depth: 1 });
    assert.equal(got.length, 3);
    for (const g of got) assert.deepEqual(g, { via: "code", depth: 1 });
});

test("callTool defaults via to direct and depth to 0", async () => {
    const agent = bareAgent();
    let seen: unknown;
    agent.addFilter({ event: EVENTS.toolStart, id: "t/s", fn: async (_a, p) => { seen = { via: p?.via, depth: p?.depth }; } });
    await agent.callTool("echo", { text: "hi" });
    assert.deepEqual(seen, { via: "direct", depth: 0 });
});

test("callTool refuses past MAX_CALLTOOL_DEPTH without executing", async () => {
    let executed = 0;
    const agent = bareAgent([Tool.define({
        name: "echo",
        description: "Echo.",
        inputSchema: { type: "object", properties: {} },
        execute: async () => { executed++; return { answer: "ran" }; },
    })]);
    const outcome = await agent.callTool("echo", {}, { depth: MAX_CALLTOOL_DEPTH + 1 });
    assert.equal(outcome.result.error, true);
    assert.equal(outcome.result.errorMessage, "recursion_blocked");
    assert.equal(executed, 0);
});

test("callTool normalizes non-object params to {}", async () => {
    const agent = bareAgent();
    const outcome = await agent.callTool("echo", "nope" as unknown as Record<string, unknown>);
    // {} fails the required-text schema → invalid_arguments, not a crash
    assert.equal(outcome.result.errorMessage, "invalid_arguments");
});

// ---------------------------------------------------------------------------
// resolve + schema
// ---------------------------------------------------------------------------

test("callTool: unknown and disabled tools get coded errors", async () => {
    const agent = bareAgent();
    agent.addTool(Tool.define({
        name: "off", description: "Off.", inputSchema: { type: "object", properties: {} },
        disabled: true, execute: async () => ({ answer: "ran" }),
    }));
    const ghost = await agent.callTool("nope", {});
    assert.equal(ghost.result.answer, "Unknown tool: nope");
    assert.equal(ghost.result.errorMessage, "unknown_tool");
    const off = await agent.callTool("off", {});
    assert.match(String(off.result.answer), /currently disabled: off/);
    assert.equal(off.result.errorMessage, "tool_disabled");
});

test("callTool: hidden tools stay callable", async () => {
    const agent = bareAgent([Tool.define({
        name: "hid", description: "Hid.", inputSchema: { type: "object", properties: {} },
        hidden: true, execute: async () => ({ answer: "ran-hidden" }),
    })]);
    const outcome = await agent.callTool("hid", {});
    assert.equal(outcome.result.answer, "ran-hidden");
});

test("callTool enforces the schema wall (custom validate replaces it)", async () => {
    const agent = bareAgent();
    const bad = await agent.callTool("echo", {});
    assert.equal(bad.result.errorMessage, "invalid_arguments");
    assert.match(String(bad.result.answer), /Invalid arguments for echo/);
    assert.deepEqual((bad.result.stored as { errors: string[] }).errors.length > 0, true);
    agent.addTool(Tool.define({
        name: "custom", description: "C.", inputSchema: { type: "object", properties: {} },
        validate: () => ["always wrong"], execute: async () => ({ answer: "ran" }),
    }));
    const custom = await agent.callTool("custom", {});
    assert.match(String(custom.result.answer), /always wrong/);
});

test("callTool validate:false skips the wall (caller pre-validated)", async () => {
    const agent = bareAgent();
    const outcome = await agent.callTool("echo", {}, { validate: false });
    // text missing → template renders undefined, but the tool RAN
    assert.equal(outcome.result.answer, "echo:undefined");
});

// ---------------------------------------------------------------------------
// gates + parks
// ---------------------------------------------------------------------------

test("callTool runs gates outside a cycle (registry lane)", async () => {
    const agent = bareAgent();
    let gated = false;
    agent.addFilter({ event: EVENTS.beforeTool, id: "t/g", fn: async () => { gated = true; } });
    await agent.callTool("echo", { text: "hi" }); // no cycle in flight
    assert.equal(gated, true);
});

test("callTool gate:false skips the chain (explicit escape hatch)", async () => {
    const agent = bareAgent();
    let gated = false;
    agent.addFilter({ event: EVENTS.beforeTool, id: "t/g", fn: async () => { gated = true; } });
    const outcome = await agent.callTool("echo", { text: "hi" }, { gate: false });
    assert.equal(gated, false);
    assert.equal(outcome.result.answer, "echo:hi");
});

test("callTool honors gate denials without executing", async () => {
    const agent = bareAgent();
    let executed = 0;
    agent.tools.find((t) => t.name === "echo")!.execute = async () => { executed++; return { answer: "ran" }; };
    agent.addFilter({
        event: EVENTS.beforeTool,
        id: "t/deny",
        priority: 0,
        fn: async (_a, p) => {
            const call = (p as { call?: { preResolved?: unknown } }).call;
            if (call) call.preResolved = { answer: "denied", error: true, errorMessage: "denied" };
        },
    });
    const outcome = await agent.callTool("echo", { text: "hi" });
    assert.equal(outcome.result.answer, "denied");
    assert.equal(executed, 0);
});

test("callTool waits for parked gates and reports gated/waitedMs", async () => {
    const agent = bareAgent();
    agent.addFilter({
        event: EVENTS.beforeTool,
        id: "t/park",
        priority: 0,
        fn: async (a, p) => {
            const call = (p as { call?: { id?: string } }).call;
            a.pendingAwaits.push({ type: "test/ask", id: call?.id });
        },
    });
    const pending = agent.callTool("echo", { text: "hi" });
    while (agent.pendingAwaits.length === 0) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 30)); // measurable park time
    agent.pendingAwaits.splice(0, agent.pendingAwaits.length);
    const outcome = await pending;
    assert.equal(outcome.result.answer, "echo:hi");
    assert.equal(outcome.gated, true);
    assert.ok(outcome.waitedMs >= 20, `waitedMs=${outcome.waitedMs}`);
});

test("callTool preResolved injects a verdict and skips execute", async () => {
    let executed = 0;
    const agent = bareAgent([Tool.define({
        name: "echo", description: "E.", inputSchema: { type: "object", properties: {} },
        execute: async () => { executed++; return { answer: "ran" }; },
    })]);
    const outcome = await agent.callTool("echo", {}, { preResolved: { answer: "cached!", stored: { hit: true } } });
    assert.equal(outcome.result.answer, "cached!");
    assert.deepEqual(outcome.result.stored, { hit: true });
    assert.equal(executed, 0);
});

// ---------------------------------------------------------------------------
// events / afterTool / commit
// ---------------------------------------------------------------------------

test("callTool events:false silences toolStart/toolEnd", async () => {
    const agent = bareAgent();
    const seen: string[] = [];
    for (const ev of [EVENTS.toolStart, EVENTS.toolEnd] as const) {
        agent.addFilter({ event: ev, id: `t/${ev}`, priority: 0, fn: async () => { seen.push(ev); } });
    }
    await agent.callTool("echo", { text: "hi" }, { events: false });
    assert.deepEqual(seen, []);
});

test("callTool skips afterTool by default, runs it on opt-in", async () => {
    const agent = bareAgent();
    let runs = 0;
    agent.addFilter({
        event: EVENTS.afterTool,
        id: "t/patch",
        priority: 0,
        fn: async (_a, p) => {
            runs++;
            ((p as { result?: { answer?: unknown } }).result as { answer: string }).answer = "patched!";
        },
    });
    const plain = await agent.callTool("echo", { text: "hi" });
    assert.equal(plain.result.answer, "echo:hi");
    assert.equal(runs, 0);
    const patched = await agent.callTool("echo", { text: "hi" }, { afterTool: true });
    assert.equal(patched.result.answer, "patched!");
    assert.equal(runs, 1);
});

test("callTool commit:true pushes a PAIRED enabled:false call+result and repoints", async () => {
    const agent = bareAgent();
    const outcome = await agent.callTool("echo", { text: "hi" }, { commit: true });
    assert.equal(agent.messages.length, 2);
    const [callMsg, resultMsg] = agent.messages;
    assert.equal(callMsg!.type, "toolCall");
    assert.equal(callMsg!.enabled, false);
    assert.equal(resultMsg!.type, "toolResult");
    assert.equal(resultMsg!.enabled, false);
    const stored = (callMsg!.content as { stored: Array<{ id: string }> }).stored;
    assert.equal(stored[0]!.id, outcome.call.id);
    assert.equal((resultMsg as unknown as { toolCallId: string }).toolCallId, outcome.call.id);
    assert.equal(agent.currentTurn?.id, resultMsg!.id);
});

// ---------------------------------------------------------------------------
// timeout / signal / errors
// ---------------------------------------------------------------------------

test("callTool timeoutMs returns a timeout result; the tool is orphaned, late toolEnd still fires", async () => {
    const agent = bareAgent([Tool.define({
        name: "slow", description: "S.", inputSchema: { type: "object", properties: {} },
        execute: async () => {
            await new Promise((r) => setTimeout(r, 50));
            return { answer: "late" };
        },
    })]);
    const ends: string[] = [];
    agent.addFilter({ event: EVENTS.toolEnd, id: "t/e", fn: async () => { ends.push("toolEnd"); } });
    const outcome = await agent.callTool("slow", {}, { timeoutMs: 10 });
    assert.equal(outcome.result.errorMessage, "timeout");
    assert.match(String(outcome.result.answer), /timed out after 10ms/);
    await new Promise((r) => setTimeout(r, 80)); // let the orphan settle
    assert.deepEqual(ends, ["toolEnd"], "late toolEnd fires exactly once");
});

test("callTool signal does NOT orphan execute: the tool runs to settle, result delivered", async () => {
    // Tools have no cancel channel — aborting mid-execute cannot stop the
    // tool, so callTool delivers its real result instead of lying orphaned.
    const agent = bareAgent([Tool.define({
        name: "slow", description: "S.", inputSchema: { type: "object", properties: {} },
        execute: async () => {
            await new Promise((r) => setTimeout(r, 40));
            return { answer: "late" };
        },
    })]);
    const controller = new AbortController();
    const pending = agent.callTool("slow", {}, { signal: controller.signal });
    controller.abort();
    const outcome = await pending;
    assert.equal(outcome.result.answer, "late");
    assert.equal(outcome.result.error, undefined);
});

test("callTool signal releases a parked gate wait", async () => {
    const agent = bareAgent();
    agent.addFilter({
        event: EVENTS.beforeTool,
        id: "t/park",
        priority: 0,
        fn: async (a, p) => {
            const call = (p as { call?: { id?: string } }).call;
            a.pendingAwaits.push({ type: "test/ask", id: call?.id });
        },
    });
    const controller = new AbortController();
    const pending = agent.callTool("echo", { text: "hi" }, { signal: controller.signal });
    while (agent.pendingAwaits.length === 0) await new Promise((r) => setImmediate(r));
    controller.abort();
    const outcome = await pending;
    assert.equal(outcome.result.errorMessage, "aborted");
    assert.equal(outcome.gated, true);
});

test("callTool never throws: throwing tools become error results", async () => {
    const agent = bareAgent([Tool.define({
        name: "boom", description: "B.", inputSchema: { type: "object", properties: {} },
        execute: async () => { throw new Error("kaput"); },
    })]);
    const outcome = await agent.callTool("boom", {});
    assert.equal(outcome.result.error, true);
    assert.match(String(outcome.result.answer), /Tool boom failed: kaput/);
    assert.ok((outcome.result.stored as { trace?: string }).trace);
});

test("callTool normalizes null results into error results", async () => {
    const agent = bareAgent([Tool.define({
        name: "nil", description: "N.", inputSchema: { type: "object", properties: {} },
        execute: async () => null as unknown as { answer: string },
    })]);
    const outcome = await agent.callTool("nil", {});
    assert.equal(outcome.result.error, true);
});

// ---------------------------------------------------------------------------
// activeCall rendezvous
// ---------------------------------------------------------------------------

test("activeCall exposes the in-flight record during execute, deleted after", async () => {
    let seenDuring: unknown;
    const agent = bareAgent([Tool.define({
        name: "probe", description: "P.", inputSchema: { type: "object", properties: {} },
        execute: async (_p, a) => {
            seenDuring = a.activeCall("fixed-id");
            return { answer: "ok" };
        },
    })]);
    await agent.callTool("probe", {}, { id: "fixed-id" });
    assert.equal((seenDuring as { name?: string } | undefined)?.name, "probe");
    assert.equal(agent.activeCall("fixed-id"), undefined, "deleted on settle");
});

// ---------------------------------------------------------------------------
// the loop lane still works (executeOne delegates)
// ---------------------------------------------------------------------------

test("loop lane unchanged: model batch gates → executes → commits with toolEnd", async () => {
    const model = new StubModel([
        () => toolCallTurn([callTo("echo", { text: "hi" }, "call-1")]),
        () => assistantTurn("done"),
    ]);
    const agent = new Agent({ model, tools: [echoTool()], agentId: "loop-lane" });
    const seen: string[] = [];
    for (const ev of [EVENTS.beforeTool, EVENTS.afterTool, EVENTS.toolStart, EVENTS.toolEnd] as const) {
        agent.addFilter({ event: ev, id: `t/${ev}`, priority: 0, fn: async () => { seen.push(ev); } });
    }
    seedUserMessage(agent, "go");
    kick(agent);
    await awaitIdle(agent);
    assert.deepEqual(seen, [EVENTS.beforeTool, EVENTS.toolStart, EVENTS.afterTool, EVENTS.toolEnd]);
    const result = [...agent.messages].reverse().find((m) => m.type === "toolResult");
    assert.ok(result);
    assert.equal((result.content as { answer: string }).answer, "echo:hi");
});
