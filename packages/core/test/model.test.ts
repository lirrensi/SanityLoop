// ============================================================================
// tests/core/model.test.ts — the ModelContract / SimpleModel subclassing story.
// ============================================================================
// The stub pattern (templates/simple-agent.ts) IS the contract: extend
// SimpleModel, override callNextTurn, return { message, stats, stopReason }.
// Stats land FLAT in state.stats — exact keys, summed by recordStats.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    Agent,
    SimpleModel,
    normalizeForAlternation,
} from "@sanityloop/core";
import type { GodObject, Message, MessageStats, TurnResult } from "@sanityloop/core";
import { makeAgent, seedUserMessage, kick } from "@sanityloop/test-kit/core";
import { assistantTurn, flatStats } from "@sanityloop/test-kit/core";
import { awaitIdle } from "@sanityloop/test-kit";

test("SimpleModel constructor defaults are sane", () => {
    const m = new SimpleModel({ modelId: "m1" });
    assert.equal(m.api, "chat_completions");
    assert.equal(m.modelId, "m1");
    assert.equal(m.stream, true);
    assert.equal(typeof m.normalizeMessages, "function");
    // the seam exists and is overridable
    const out = m.prepareMessages([
        { id: "s", enabled: true, type: "system", content: [{ type: "text", content: "sys" }] },
        { id: "u1", enabled: true, type: "user", content: [{ type: "text", content: "hi" }] },
        { id: "u2", enabled: false, type: "user", content: [{ type: "text", content: "hidden" }] },
    ]) as Array<{ role: string; content: string }>;
    assert.deepEqual(out, [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
    ], "disabled messages drop; simple types map to roles");
});

test("normalizeForAlternation: orphan results dropped, dangling toolCall dropped, trailing assistant popped, same-role collapsed", () => {
    const msg = (id: string, type: Message["type"], extra: Record<string, unknown> = {}): Message =>
        ({ id, enabled: true, type, content: [], ...extra }) as Message;

    // orphaned toolResult (no preceding toolCall) → dropped
    let out = normalizeForAlternation([msg("u1", "user"), msg("r1", "toolResult", { toolCallId: "nope" })]);
    assert.deepEqual(out.map((m) => m.id), ["u1"]);

    // consecutive same-role user messages collapse (earlier dropped)
    out = normalizeForAlternation([msg("u1", "user"), msg("u2", "user")]);
    assert.deepEqual(out.map((m) => m.id), ["u2"]);

    // list must NOT end with an assistant or a dangling toolCall
    out = normalizeForAlternation([msg("u1", "user"), msg("a1", "assistant")]);
    assert.deepEqual(out.map((m) => m.id), ["u1"]);

    // toolCall kept only with its MATCHING result immediately after
    out = normalizeForAlternation([
        msg("c1", "toolCall", { content: { answer: "", stored: [{ id: "call-9", type: "function", name: "x", parameters: {} }] } }),
        msg("r-ok", "toolResult", { toolCallId: "call-9" }),
        msg("r-orphan", "toolResult", { toolCallId: "call-404" }),
    ]);
    assert.deepEqual(out.map((m) => m.id), ["c1", "r-ok"]);
});

test("callNextTurn receives THE whole agent (identity, not a copy)", async () => {
    const { agent, model } = makeAgent({ script: [() => assistantTurn("hey")] });
    seedUserMessage(agent, "go");
    kick(agent);
    await awaitIdle(agent);
    assert.equal(model.calls.length, 1);
    assert.ok(model.calls[0] === (agent as unknown as GodObject), "the context IS the god object");
});

test("FLAT MessageStats lands in state.stats UNCHANGED in shape — exact flat keys", async () => {
    const stats: Partial<MessageStats> = {
        input: 111, output: 22, cacheRead: 3, cacheWrite: 4, totalTokens: 140,
        cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
    };
    const { agent } = makeAgent({ script: [() => assistantTurn("one", stats)] });
    seedUserMessage(agent, "go");
    kick(agent);
    await awaitIdle(agent);

    // EXACT flat key set — no nesting beyond cost, no surprise fields.
    // NOTE: addStats() sums numeric open-index fields too, so the provider
    // `timestamp` stamped onto every per-call stat ends up (summed) here.
    // That is CURRENT CORE BEHAVIOR; pinned so a change is deliberate.
    assert.deepEqual(
        Object.keys(agent.stats).sort(),
        ["cacheRead", "cacheWrite", "cost", "input", "output", "timestamp", "totalTokens"],
    );
    assert.ok(typeof agent.stats.timestamp === "number", "summed provider timestamp rides along");
    assert.equal(agent.stats.input, 111);
    assert.equal(agent.stats.output, 22);
    assert.equal(agent.stats.cacheRead, 3);
    assert.equal(agent.stats.cacheWrite, 4);
    assert.equal(agent.stats.totalTokens, 140);
    assert.deepEqual(agent.stats.cost, {
        input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033,
    });
    // the per-call stamp also landed on the message itself, provider-timestamped
    const last = agent.messages.at(-1)!;
    assert.ok(last.stats);
    assert.equal(last.stats!.input, 111);
    assert.ok(typeof last.committedAt === "number", "agent stamps commit time at BREAKPOINT #1");
});

test("stats ACCUMULATE across turns (recordStats recomputes totals from all messages)", async () => {
    const s1: Partial<MessageStats> = { input: 10, output: 5, totalTokens: 15 };
    const s2: Partial<MessageStats> = { input: 20, output: 7, totalTokens: 27 };
    const { agent } = makeAgent({
        script: [() => assistantTurn("first", s1), () => assistantTurn("second", s2)],
    });
    seedUserMessage(agent, "one");
    kick(agent);
    await awaitIdle(agent);
    seedUserMessage(agent, "two");
    kick(agent);
    await awaitIdle(agent);

    assert.equal(agent.messages.length, 4); // u, a, u, a
    assert.equal(agent.stats.input, 30);
    assert.equal(agent.stats.output, 12);
    assert.equal(agent.stats.totalTokens, 42);
});

test("contextUsage appears ONLY when maxContext is set (derived ratio)", async () => {
    const model = new SimpleModel({ modelId: "m", stream: false, maxContext: 1000 });
    model.callNextTurn = async (_ctx: GodObject): Promise<TurnResult> => ({
        message: { id: "a", enabled: true, type: "assistant", content: [{ type: "text", content: "x" }] },
        stats: flatStats({ input: 100, output: 10, totalTokens: 110 }),
        stopReason: "stop",
    });
    const agent = new Agent({ model, agentId: "ctx-test" });
    seedUserMessage(agent, "go");
    kick(agent);
    await awaitIdle(agent);
    assert.equal(agent.stats.contextUsage, 0.1); // latest input / maxContext, capped at 1
});
