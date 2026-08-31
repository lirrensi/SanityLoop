// ============================================================================
// tests/core/events.test.ts - THE 39-event contract (ground truth: types.ts).
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENTS, Agent } from "@sanityloop/core";

const StubModel = () => ({
    api: "chat_completions",
    modelId: "stub",
    stream: false,
    callNextTurn: async () => {
        throw new Error("not called in this file");
    },
});

test("EVENTS registry has EXACTLY 39 events", () => {
    const keys = Object.keys(EVENTS);
    assert.equal(keys.length, 39, `expected 39 events, got ${keys.length}: ${keys.join(",")}`);
});

test("every EVENTS value is unique and self-named (value === key)", () => {
    const values = Object.values(EVENTS);
    assert.equal(new Set(values).size, 39, "event id strings must be unique");
    for (const [k, v] of Object.entries(EVENTS)) assert.equal(v, k, `EVENTS.${k} should equal its own name`);
});

test("spot-check: every documented event name exists", () => {
    const expected = [
        // loop lifecycle (15)
        "beforeAgentStart", "agentStart", "agentEnd", "agentSettled", "turnStart",
        "cycleEnd", "cycleDiscarded", "turnEnd", "beforeStop", "stop", "beforeAbort",
        "abort", "beforeRunEnd", "error", "handlerError",
        // input (2)
        "inputReceived", "inputProcessed",
        // messages (5)
        "beforeMessageAdd", "messageAdded", "messageUpdate", "messageRemoved", "fragmentUpdate",
        // tools (6)
        "beforeTool", "afterTool", "toolStart", "toolUpdate", "toolEnd", "toolListChanged",
        // output stream (6)
        "streamStarted", "textDelta", "textEnd", "thinkingDelta", "thinkingEnd", "toolcallDelta",
        // provider boundary (2)
        "beforeProviderRequest", "afterProviderResponse",
        // generic (3)
        "patched", "merged", "usage",
    ] as const;
    for (const name of expected) {
        assert.ok(name in EVENTS, `missing documented event: ${name}`);
        assert.equal(typeof EVENTS[name as keyof typeof EVENTS], "string");
    }
    assert.equal(expected.length, 39, "doc list itself must be complete");
});

test("the blocking walls exist: beforeTool / inputReceived / beforeAgentStart are declared events", () => {
    // The walls are where the worker/supervisor AWAIT the full filter chain —
    // beforeTool (per call), inputReceived (per sync input), beforeAgentStart
    // (turn assembly). They must exist and be pre-declared on a fresh agent.
    const agent = new Agent({ model: StubModel() as never });
    for (const wall of ["beforeTool", "inputReceived", "beforeAgentStart"]) {
        assert.ok(wall in EVENTS);
        assert.ok(
            agent.getDeclaredEvent(wall) !== undefined,
            `${wall} should be pre-declared`,
        );
    }
});

test("all 39 core events come PRE-DECLARED on a fresh agent (discovery without imports)", () => {
    const agent = new Agent({ model: StubModel() as never });
    const declared = agent.listDeclaredEvents().map((d) => d.id).sort();
    const builtins = Object.values(EVENTS).sort();
    assert.deepEqual(declared, builtins);
});

test("custom emit with publish lands in transient.currentEvent (live visibility)", () => {
    const agent = new Agent({ model: StubModel() as never });
    agent.emit("compaction/start", { reason: "manual" });
    const cur = agent.transient.currentEvent as { type?: string; reason?: string } | undefined;
    assert.equal(cur?.type, "compaction/start");
    assert.equal(cur?.reason, "manual");
});

test("emit with publish=false does NOT touch transient.currentEvent", () => {
    const agent = new Agent({ model: StubModel() as never });
    agent.emit("quiet/thing", {}, false);
    assert.notEqual((agent.transient.currentEvent as { type?: string } | undefined)?.type, "quiet/thing");
});
