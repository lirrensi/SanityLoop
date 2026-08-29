// ============================================================================
// tests/core/tool.test.ts — Tool.define / Tool.factory / the result contract.
// ============================================================================
// The result contract lives in the CORE's normalization + execution path
// (agent.ts): valid results pass through; null / non-object / missing-string-
// answer are synthesized into error RESULTS — the loop never dies from a tool.
// Disabled tools never execute. All proven through real turns.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, Tool } from "@sanityloop/core";
import type { GodObject, Tool as ToolType, ToolResultMessage } from "@sanityloop/core";
import { assistantTurn, callTo, toolCallTurn, StubModel } from "@sanityloop/test-kit/core";
import { awaitIdle } from "@sanityloop/test-kit";
import { seedUserMessage, kick } from "@sanityloop/test-kit/core";

/** Build an agent that will call `tool` once then land with `final`. */
function turnFor(tool: ToolType, final = "done") {
    const model = new StubModel([
        () => toolCallTurn([callTo(tool.name, { text: "hi" }, "call-1")]),
        () => assistantTurn(final),
    ]);
    const agent = new Agent({ model, tools: [tool], agentId: "tool-test" });
    seedUserMessage(agent, "go");
    kick(agent);
    return { agent, model };
}

async function lastResultOf(agent: Agent): Promise<ToolResultMessage> {
    await awaitIdle(agent);
    const last = [...agent.messages].reverse().find((m) => m.type === "toolResult");
    assert.ok(last, "no toolResult message committed");
    return last as unknown as ToolResultMessage;
}

// ---------------------------------------------------------------------------
// Tool.define — metadata + factory param merging (pure, no loop)
// ---------------------------------------------------------------------------

test("Tool.define keeps every metadata block", () => {
    const t = Tool.define({
        name: "read_file",
        description: "reads a file",
        inputSchema: { type: "object", properties: { p: { type: "string" } }, required: ["p"] },
        outputSchema: { type: "object" },
        executionMode: "sequential",
        async execute() {
            return { answer: "" };
        },
    });
    assert.equal(t.name, "read_file");
    assert.equal(t.description, "reads a file");
    assert.equal(t.inputSchema.type, "object");
    assert.deepEqual(t.inputSchema.required, ["p"]);
    assert.equal(t.executionMode, "sequential");
    assert.equal(t.disabled, undefined, "enabled by default");
});

test("Tool.factory pre-locks params — execute sees locked + call params (call wins)", async () => {
    const seen: unknown[] = [];
    let gotAgent: unknown;
    const base = Tool.define({
        name: "echo",
        description: "e",
        inputSchema: { type: "object" },
        execute(params, agent) {
            seen.push(params);
            gotAgent = agent;
            return { answer: "ok" };
        },
    });
    const wrapped = Tool.factory({ tool: base, prefix: "!!! " });
    const fakeAgent = { messages: [] } as unknown as GodObject;
    const res = await wrapped.execute({ text: "hello", prefix: "OVERRIDDEN" }, fakeAgent);
    assert.deepEqual(seen[0], { prefix: "OVERRIDDEN", text: "hello" });
    assert.equal(gotAgent, fakeAgent, "execute receives the god object");
    assert.deepEqual(res, { answer: "ok" });
});

// ---------------------------------------------------------------------------
// Result contract through REAL turns
// ---------------------------------------------------------------------------

test("valid result passes through verbatim: answer to the model, stored untouched", async () => {
    let executed = 0;
    const tool = Tool.define({
        name: "good",
        description: "d",
        inputSchema: { type: "object" },
        async execute() {
            executed++;
            return { answer: "the model reads this", stored: { deep: [1, 2, { x: true }] } };
        },
    });
    const { agent } = turnFor(tool);
    const result = await lastResultOf(agent);
    assert.equal(executed, 1);
    assert.equal(result.toolCallId, "call-1");
    assert.equal(result.toolName, "good");
    assert.deepEqual(result.content, {
        answer: "the model reads this",
        stored: { deep: [1, 2, { x: true }] },
        error: undefined,
        errorMessage: undefined,
    });
});

test("tool returning null → synthesized ERROR result (never a hole, never a crash)", async () => {
    const tool = Tool.define({
        name: "nully",
        description: "d",
        inputSchema: { type: "object" },
        async execute() {
            return null as never;
        },
    });
    const { agent } = turnFor(tool);
    const result = await lastResultOf(agent);
    assert.equal(result.content!.error, true);
    assert.match(result.content!.answer, /returned null.*tool bug/s);
    assert.equal(result.content!.errorMessage, "tool returned no result object");
    assert.equal(agent.loopState, "idle", "the loop survived");
});

test("tool returning a raw STRING → synthesized error result", async () => {
    const tool = Tool.define({
        name: "stringy",
        description: "d",
        inputSchema: { type: "object" },
        async execute() {
            return "just a string" as never;
        },
    });
    const { agent } = turnFor(tool);
    const result = await lastResultOf(agent);
    assert.equal(result.content!.error, true);
    assert.match(result.content!.answer, /returned string/);
});

test("result without a string `answer` → synthesized error result", async () => {
    const tool = Tool.define({
        name: "answerless",
        description: "d",
        inputSchema: { type: "object" },
        async execute() {
            return { stored: { ok: true } } as never; // forgot the answer face
        },
    });
    const { agent } = turnFor(tool);
    const result = await lastResultOf(agent);
    assert.equal(result.content!.error, true);
    assert.match(result.content!.answer, /without a string "answer"/);
});

test("a THROWING tool becomes an error RESULT — the loop lands idle afterwards", async () => {
    const tool = Tool.define({
        name: "bomber",
        description: "d",
        inputSchema: { type: "object" },
        async execute() {
            throw new Error("disk on fire");
        },
    });
    const { agent } = turnFor(tool);
    const result = await lastResultOf(agent);
    assert.equal(result.content!.error, true);
    assert.match(result.content!.answer, /failed: disk on fire/);
    assert.match((result.content!.stored as { trace?: string }).trace ?? "", /Error: disk on fire/);
    assert.equal(agent.loopState, "idle", "error-as-result — never kills the turn");
});

test("DISABLED tool: gates may run but execute is skipped → synthetic disabled answer", async () => {
    let executed = 0;
    const tool = Tool.define({
        name: "switched-off",
        description: "off-switch demo",
        inputSchema: { type: "object" },
        disabled: true,
        async execute() {
            executed++;
            return { answer: "should never happen" };
        },
    });
    const gatedWith: string[] = [];
    const { agent, model } = turnFor(tool);
    // a beforeTool gate DOES see the disabled call (gating precedes the skip)
    agent.addFilter({
        event: "beforeTool", id: "test/gate-watch", priority: 0,
        fn: async (_a, e) => void gatedWith.push((e?.call as { name?: string })?.name ?? "?"),
    });
    const result = await lastResultOf(agent);
    assert.deepEqual(gatedWith, ["switched-off"], "the wall fired");
    assert.equal(executed, 0, "disabled tools never execute");
    assert.equal(result.content!.error, true);
    assert.match(result.content!.answer, /currently disabled: switched-off/);
    assert.ok(model.calls.length >= 2, "provider still owes + gets its answer");
});

test("UNKNOWN tool name → synthetic unknown-tool error result", async () => {
    const ghost = Tool.define({
        name: "ghost",
        description: "not registered",
        inputSchema: { type: "object" },
        async execute() {
            return { answer: "impossible" };
        },
    });
    const model = new StubModel([
        () => toolCallTurn([callTo("ghost", {})]),
        () => assistantTurn("ok"),
    ]);
    const agent = new Agent({ model, tools: [], agentId: "unknown-tool-test" }); // NOT installed
    seedUserMessage(agent, "go");
    kick(agent);
    const result = await lastResultOf(agent);
    assert.equal(result.content!.error, true);
    assert.equal(result.content!.answer, "Unknown tool: ghost");
});
