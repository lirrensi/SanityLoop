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

test("normalizeForAlternation: order absolute — same-type merges in place, tools pair by ID, unmatched excluded", () => {
    const msg = (id: string, type: Message["type"], extra: Record<string, unknown> = {}): Message =>
        ({ id, enabled: true, type, content: [], ...extra }) as Message;
    const text = (id: string, type: Message["type"], content: string, extra: Record<string, unknown> = {}): Message =>
        ({ id, enabled: true, type, content: [{ type: "text", content }], ...extra }) as Message;

    // RULE ONE — a lone mid-array system passes through as the ORIGINAL object, in place
    const midSys = text("s-mid", "system", "mid rules", { committedAt: 7 });
    let out = normalizeForAlternation([text("u1", "user", "hi"), midSys, text("u2", "user", "ho")]);
    assert.deepEqual(out.map((m) => m.id), ["u1", "s-mid", "u2"], "order preserved, nothing hoisted");
    assert.ok(out[1] === midSys, "lone system is the ORIGINAL object, untouched");

    // alternation via MERGE — consecutive same-type fold in place, first id wins, content appends
    out = normalizeForAlternation([text("u1", "user", "one"), text("u2", "user", "two")]);
    assert.deepEqual(out.map((m) => m.id), ["u1"], "merged, first keeps position + id");
    assert.deepEqual(out[0].content, [{ type: "text", content: "one\n\ntwo" }], "content appended, nothing dropped");

    // consecutive systems (compound + simple) merge into ONE head — no content lost
    out = normalizeForAlternation([
        { id: "system", enabled: true, type: "system-compound", content: [{ id: "a", content: "alpha" }, { id: "b", content: "beta" }] },
        text("s-cat", "system", "catalog"),
        text("s-pre", "system", "preload"),
        text("u1", "user", "go"),
    ]);
    assert.deepEqual(out.map((m) => m.id), ["system", "u1"], "head = merged systems, then user");
    assert.deepEqual(out[0].content, [{ type: "text", content: "alpha\nbeta\n\ncatalog\n\npreload" }], "all system text merged");

    // a trailing assistant STAYS — order is absolute, never popped
    out = normalizeForAlternation([text("u1", "user", "go"), text("a1", "assistant", "done")]);
    assert.deepEqual(out.map((m) => m.id), ["u1", "a1"], "trailing assistant preserved");

    // tools pair by ID — matched kept together, unmatched NOT included
    out = normalizeForAlternation([
        msg("c1", "toolCall", { content: { answer: "", stored: [{ id: "call-9", type: "function", name: "x", parameters: {} }] } }),
        msg("r-ok", "toolResult", { toolCallId: "call-9" }),
        msg("r-orphan", "toolResult", { toolCallId: "call-404" }),
    ]);
    assert.deepEqual(out.map((m) => m.id), ["c1", "r-ok"], "call + matching result kept, orphan result excluded");

    // dangling toolCall (no matching result) → NOT included
    out = normalizeForAlternation([
        msg("u1", "user"),
        msg("c-dangling", "toolCall", { content: { answer: "", stored: [{ id: "call-x", type: "function", name: "x", parameters: {} }] } }),
    ]);
    assert.deepEqual(out.map((m) => m.id), ["u1"], "dangling toolCall excluded");

    // orphaned toolResult (no preceding toolCall) → NOT included
    out = normalizeForAlternation([msg("u1", "user"), msg("r1", "toolResult", { toolCallId: "nope" })]);
    assert.deepEqual(out.map((m) => m.id), ["u1"], "orphan toolResult excluded");
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
