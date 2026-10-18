// ============================================================================
// packages/test-kit/test/nightmare.test.ts — the generic stability suite.
// ============================================================================
// The loop against the provider you absolutely hate. Every test scripts a
// NightmareModel, drives a REAL Agent through kick + bounded waits, and proves
// the run lands, commits, or dies LOUDLY — never hangs, never half-commits,
// never corrupts history. These are the behaviors a chaos provider must pin:
// retry survival, stream-death recovery, garbage containment, hostile
// tool-call handling, and abort-during-chaos.
//
// Rule: NightmareModel defaults to stream:false + 5/20ms backoffs, so every
// test here is FAST and deterministic (no Math.random in the model — jitter
// lives in core's retry loop and only affects sleep length, never outcome).

import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, EVENTS, Tool } from "@sanityloop/core";
import {
    NightmareModel,
    kick,
    seedUserMessage,
} from "@sanityloop/test-kit/core";
import type { NightmareAttempt } from "@sanityloop/test-kit/core";
import { awaitLanded, sleep, waitUntil } from "@sanityloop/test-kit";

/** Drive one user turn through the nightmare; return when landed or terminal. */
async function drive(agent: Agent, text = "go"): Promise<void> {
    seedUserMessage(agent, text);
    kick(agent);
    // born-landed idle matches instantly — wait for the provider call FIRST,
    // then for the settle. attempts>=1 fires on every path (land or throw).
    const model = agent.model as unknown as { attempts?: number };
    if (typeof model.attempts === "number") {
        await waitUntil(() => (model.attempts as number) >= 1, { what: "provider call to start", timeoutMs: 15000 });
    }
    await waitUntil(
        () => agent.loopState === "idle" || agent.loopState === "aborted" || agent.loopState === "errored",
        { what: "turn to settle", timeoutMs: 15000 },
    );
}

function errors(agent: Agent): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    agent.addFilter({
        event: EVENTS.error,
        id: "test/error-tap",
        priority: 0,
        fn: async (_a, raw) => {
            out.push({ ...(raw as Record<string, unknown>) });
        },
    });
    return out;
}

// ---------------------------------------------------------------------------
// 1. retry survival — transport hell, then the town at the end
// ---------------------------------------------------------------------------

test("stability: reset + 500 + 429, then clean — the turn lands, attempts counted", async () => {
    const script: NightmareAttempt[] = [
        { transport: "reset" },
        { http: { status: 500 } },
        { http: { status: 429 } },
        { text: "finally through" },
    ];
    const model = new NightmareModel(script, { retries: 5 });
    const agent = new Agent({ model, agentId: "nm-retry" });
    await drive(agent);

    assert.equal(agent.loopState, "idle", "landed idle after 3 failures");
    assert.equal(model.attempts, 4, "every scripted attempt consumed exactly once");
    assert.equal(model.remaining, 0);
    const last = agent.messages.at(-1)!;
    assert.equal(last.type, "assistant");
    assert.deepEqual(last.content, [{ type: "text", content: "finally through" }]);
    assert.equal(agent.stats.input, 10, "usage from the clean completion recorded");
});

test("stability: retry exhaustion dies LOUD — error event carries attempts + elapsedMs", async () => {
    const model = new NightmareModel(
        [{ http: { status: 503 } }, { http: { status: 503 } }, { http: { status: 503 } }],
        { retries: 3 },
    );
    const agent = new Agent({ model, agentId: "nm-exhaust" });
    const seen = errors(agent);
    await drive(agent);

    assert.equal(agent.loopState, "errored", "terminal, not hanging");
    assert.equal(model.attempts, 3, "cap respected — no fourth attempt");
    assert.equal(seen.length, 1, "exactly one error event");
    assert.equal(seen[0].source, "provider");
    assert.equal(seen[0].status, 503);
    assert.equal(seen[0].attempts, 3, "attempts stamped on the throw");
    assert.ok(typeof seen[0].elapsedMs === "number", "elapsedMs stamped on the throw");
    assert.ok(!agent.messages.some((m) => m.type === "assistant"), "no phantom reply committed");
});

test("stability: 401 is permanent — throws on the FIRST attempt, no retry", async () => {
    const model = new NightmareModel([{ http: { status: 401, body: '{"error":"bad key"}' } }], { retries: 5 });
    const agent = new Agent({ model, agentId: "nm-401" });
    const seen = errors(agent);
    await drive(agent);

    assert.equal(agent.loopState, "errored");
    assert.equal(model.attempts, 1, "4xx never retried");
    assert.equal(seen[0].status, 401);
});

test("stability: onRetry veto stops the loop — the ORIGINAL error throws", async () => {
    const hooks: number[] = [];
    const model = new NightmareModel(
        [{ http: { status: 500 } }, { http: { status: 500 } }, { text: "never reached" }],
        {
            retries: 5,
            onRetry: ({ attempt }) => {
                hooks.push(attempt);
                return false; // veto after the first failure
            },
        },
    );
    const agent = new Agent({ model, agentId: "nm-veto" });
    const seen = errors(agent);
    await drive(agent);

    assert.deepEqual(hooks, [1], "hook ran once, before any sleep");
    assert.equal(model.attempts, 1, "veto prevented attempt 2");
    assert.equal(seen[0].status, 500, "original error, not the veto");
});

// ---------------------------------------------------------------------------
// 2. garbage containment — malformed bodies never corrupt history
// ---------------------------------------------------------------------------

test("stability: garbage/empty/choiceless bodies — terminal errors, history clean", async () => {
    for (const body of ["garbage", "empty", "no-choice"] as const) {
        const model = new NightmareModel([{ body }], { retries: 1 });
        const agent = new Agent({ model, agentId: `nm-${body}` });
        const seen = errors(agent);
        await drive(agent, `probe ${body}`);

        if (body === "garbage") {
            // res.json() throws SyntaxError — non-retryable, terminal
            assert.equal(agent.loopState, "errored", `${body}: terminal`);
            assert.equal(seen.length, 1, `${body}: one error event`);
        } else {
            // {} / {choices:[]} → no choice → empty assistant COMMITS (core's
            // silent-empty path: stopReason 'stop', no error). Pinned so a
            // change is deliberate — see RetryPath finding #1/#3.
            assert.equal(agent.loopState, "idle", `${body}: lands idle`);
            const last = agent.messages.at(-1)!;
            assert.equal(last.type, "assistant");
            assert.deepEqual(last.content, [{ type: "text", content: "" }], `${body}: empty commit pinned`);
        }
        // history shape invariant: user, then exactly one provider message
        const types = agent.messages.map((m) => m.type);
        assert.deepEqual(types, ["user", body === "garbage" ? "user" : "assistant"].slice(0, body === "garbage" ? 1 : 2),
            `${body}: no half-commit, no duplication`);
        await agent.terminate();
    }
});

test("stability: null-content + missing-finish commit degraded, never crash", async () => {
    for (const body of ["null-content", "missing-finish"] as const) {
        const model = new NightmareModel([{ body, text: "degraded" }], { retries: 1 });
        const agent = new Agent({ model, agentId: `nm-${body}` });
        await drive(agent);
        assert.equal(agent.loopState, "idle", `${body}: lands`);
        const last = agent.messages.at(-1)!;
        assert.equal(last.type, "assistant", `${body}: assistant committed`);
        await agent.terminate();
    }
});

// ---------------------------------------------------------------------------
// 3. hostile tool calls — the loop contains every one
// ---------------------------------------------------------------------------

function echoAgent(script: NightmareAttempt[], agentId: string): { agent: Agent; model: NightmareModel } {
    const model = new NightmareModel(script, { retries: 1 });
    const echo = Tool.define({
        name: "echo",
        description: "echo",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
        async execute(p: unknown) {
            return { answer: `echo:${(p as { text?: string }).text ?? ""}` };
        },
    });
    const agent = new Agent({ model, tools: [echo], agentId });
    return { agent, model };
}

test("stability: unknown tool call → error-as-result, turn completes", async () => {
    const { agent, model } = echoAgent(
        [{ toolCalls: "unknown-tool", finish: "tool_calls" }, { text: "recovered" }],
        "nm-unknown-tool",
    );
    await drive(agent);
    await awaitLanded(agent);

    const results = agent.messages.filter((m) => m.type === "toolResult");
    assert.equal(results.length, 1, "exactly one result committed");
    const face = results[0].content as { answer: string; error?: boolean };
    assert.equal(face.error, true);
    assert.match(face.answer, /unknown tool/i, "the loop names the problem");
    assert.equal(model.requests[0].body !== undefined, true, "tools rode the wire request");
    assert.equal(agent.loopState, "idle");
});

test("stability: bad-json tool args → preResolved parse error, model self-corrects", async () => {
    const { agent } = echoAgent(
        [{ toolCalls: "bad-json", finish: "tool_calls" }, { text: "second try" }],
        "nm-bad-json",
    );
    await drive(agent);
    await awaitLanded(agent);

    const results = agent.messages.filter((m) => m.type === "toolResult");
    assert.equal(results.length, 1);
    const face = results[0].content as { answer: string };
    assert.match(face.answer, /failed to parse/i, "parse error reaches the model as a result");
    assert.equal(agent.loopState, "idle", "loop survives malformed args");
});

test("stability: no-id / dup-id / empty-name calls never break pairing", async () => {
    for (const toolCalls of ["no-id", "dup-id", "empty-name"] as const) {
        const { agent } = echoAgent(
            [{ toolCalls, finish: "tool_calls" }, { text: "after" }],
            `nm-${toolCalls}`,
        );
        await drive(agent);
        await awaitLanded(agent);
        // every call got exactly one result — the every-call-gets-an-answer insurance
        const calls = agent.messages.filter((m) => m.type === "toolCall").length;
        const results = agent.messages.filter((m) => m.type === "toolResult").length;
        assert.ok(results >= calls && calls >= 1, `${toolCalls}: ${calls} calls → ${results} results, none lost`);
        assert.equal(agent.loopState, "idle", `${toolCalls}: loop survives`);
        await agent.terminate();
    }
});

// ---------------------------------------------------------------------------
// 4. stream hell — deaths, garbage, and lies on the wire
// ---------------------------------------------------------------------------

test("stability: mid-stream cut retries and re-emits — the turn lands", async () => {
    const model = new NightmareModel([{ stream: "cut" }, { text: "clean after cut" }], {
        stream: true,
        retries: 3,
    });
    const agent = new Agent({ model, agentId: "nm-cut" });
    const deltas: string[] = [];
    agent.streamSink = { emit: (e: { type: string; delta?: string }) => {
        if (e.type === "textDelta" && e.delta) deltas.push(e.delta);
    } };
    await drive(agent);

    assert.equal(agent.loopState, "idle");
    assert.equal(model.attempts, 2, "the cut attempt retried");
    const last = agent.messages.at(-1)!;
    assert.deepEqual(last.content, [{ type: "text", content: "clean after cut" }], "no partial text from the dead stream committed");
});

test("stability: garbage chunk + missing [DONE] still assemble", async () => {
    for (const stream of ["garbage-chunk", "no-done", "done-hang"] as const) {
        const model = new NightmareModel([{ stream, text: "assembled" }], { stream: true, retries: 1 });
        const agent = new Agent({ model, agentId: `nm-${stream}` });
        await drive(agent);
        assert.equal(agent.loopState, "idle", `${stream}: lands`);
        const last = agent.messages.at(-1)!;
        assert.equal(last.type, "assistant", `${stream}: assistant committed`);
        assert.match(
            (last.content as Array<{ content: string }>)[0].content,
            /assembled|tail/,
            `${stream}: assembled text present`,
        );
        await agent.terminate();
    }
});

test("stability: empty stream commits empty assistant (pinned silent path)", async () => {
    const model = new NightmareModel([{ stream: "empty-stream" }], { stream: true, retries: 1 });
    const agent = new Agent({ model, agentId: "nm-empty-stream" });
    await drive(agent);
    assert.equal(agent.loopState, "idle");
    assert.deepEqual(agent.messages.at(-1)!.content, [{ type: "text", content: "" }]);
});

// ---------------------------------------------------------------------------
// 5. abort during chaos — the kill signal wins every race
// ---------------------------------------------------------------------------

test("stability: abort during backoff ends the wait with the ORIGINAL error", async () => {
    const model = new NightmareModel([{ http: { status: 500 } }, { text: "never" }], {
        retries: 5,
        retryDelayMs: 60_000, // the sleep must NOT run out
        retryMaxDelayMs: 60_000,
    });
    const agent = new Agent({ model, agentId: "nm-abort-backoff" });
    const seen = errors(agent);
    seedUserMessage(agent, "go");
    kick(agent);
    await waitUntil(() => model.attempts >= 1, { what: "first attempt to fail" });
    agent.abort("test-abort");
    await waitUntil(() => agent.loopState === "aborted" || agent.loopState === "errored", {
        what: "abort to land",
        timeoutMs: 5000,
    });
    // abort() wins the race: providerStep sees isTerminal OR fail() no-ops on
    // the already-aborted heart. Either way: settled fast, attempt 2 never ran.
    assert.equal(model.attempts, 1, "no second attempt after abort");
    assert.ok(seen.length <= 1, "at most one error event");
});

test("stability: abort mid-hung-fetch releases the call, loop settles", async () => {
    const model = new NightmareModel([{ transport: "timeout" }, { text: "never" }], { retries: 3 });
    const agent = new Agent({ model, agentId: "nm-abort-hang" });
    seedUserMessage(agent, "go");
    kick(agent);
    await waitUntil(() => model.attempts >= 1, { what: "hung fetch to start" });
    await sleep(50); // let the hang settle in
    agent.abort("test-abort");
    await waitUntil(() => agent.loopState === "aborted" || agent.loopState === "errored", {
        what: "abort to land",
        timeoutMs: 5000,
    });
    assert.deepEqual(model.abortedAttempts, [1], "the hung attempt observed the abort");
    assert.equal(model.attempts, 1, "abort is never retried");
});

// ---------------------------------------------------------------------------
// 6. finish reasons — stopReasons config; unclean reasons RETRY, then throw loud
// ---------------------------------------------------------------------------

test("stability: length retries, then lands when the provider recovers", async () => {
    const model = new NightmareModel(
        [{ finish: "length", text: "truncated" }, { finish: "length", text: "truncated" }, { text: "full reply" }],
        { retries: 5 },
    );
    const agent = new Agent({ model, agentId: "nm-length-retry" });
    await drive(agent);
    assert.equal(agent.loopState, "idle", "a truncated reply never kills the loop");
    assert.equal(model.attempts, 3, "two length-retries, then the clean landing");
    assert.deepEqual(agent.messages.at(-1)!.content, [{ type: "text", content: "full reply" }]);
});

test("stability: length exhaustion throws LOUD — reason + truncated + attempts stamped", async () => {
    const model = new NightmareModel(
        [{ finish: "length" }, { finish: "length" }, { finish: "length" }],
        { retries: 3 },
    );
    const agent = new Agent({ model, agentId: "nm-length-exhaust" });
    const seen = errors(agent);
    await drive(agent);
    assert.equal(agent.loopState, "errored", "terminal after exhaustion, not silent");
    assert.equal(model.attempts, 3, "all attempts spent on length");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].reason, "length", "reason forwarded");
    assert.equal(seen[0].truncated, true, "truncated forwarded");
    assert.equal(seen[0].attempts, 3, "attempts stamped");
    assert.ok(!agent.messages.some((m) => m.type === "assistant"), "no truncated text committed");
});

test("stability: content_filter retries like length (same candidate class)", async () => {
    const model = new NightmareModel([{ finish: "content_filter" }, { text: "cleaned up" }], { retries: 3 });
    const agent = new Agent({ model, agentId: "nm-filter-retry" });
    await drive(agent);
    assert.equal(agent.loopState, "idle");
    assert.equal(model.attempts, 2);
    assert.deepEqual(agent.messages.at(-1)!.content, [{ type: "text", content: "cleaned up" }]);
});

test("stability: stopReasons override — provider vocabularies land clean", async () => {
    // Anthropic end_turn / Google STOP land when configured ...
    for (const [finish, reasons] of [["end_turn", ["stop", "end_turn"]], ["STOP", ["STOP"]]] as const) {
        const model = new NightmareModel([{ finish, text: "landed" }], { retries: 1, stopReasons: [...reasons] });
        const agent = new Agent({ model, agentId: `nm-sr-${finish}` });
        await drive(agent);
        assert.equal(agent.loopState, "idle", `${finish} lands with stopReasons=[${reasons}]`);
        assert.equal(model.attempts, 1, "no retry for a clean reason");
        assert.equal(agent.messages.at(-1)!.stats?.stopReason, finish, "reason preserved on stats");
        await agent.terminate();
    }
    // ... and the DEFAULT set still retries them (only "stop" is clean)
    const model = new NightmareModel([{ finish: "end_turn", text: "x" }], { retries: 1 });
    const agent = new Agent({ model, agentId: "nm-sr-default" });
    const seen = errors(agent);
    await drive(agent);
    assert.equal(agent.loopState, "errored", "unlisted reason retries, then throws with retries:1");
    assert.equal(seen[0].reason, "end_turn");
});

test("stability: tool calls bypass the reason check (work is work)", async () => {
    const { agent, model } = echoAgent(
        [{ toolCalls: "unknown-tool", finish: "length" }, { text: "recovered" }],
        "nm-tool-bypass",
    );
    await drive(agent);
    await awaitLanded(agent);
    // the length-tagged tool_call was NOT retried — it executed (unknown-tool error-as-result)
    const results = agent.messages.filter((m) => m.type === "toolResult");
    assert.equal(results.length, 1, "tool call executed despite length reason");
    assert.equal(model.attempts >= 2, true, "attempts spent on turns, not on reason-retries");
    assert.equal(agent.loopState, "idle");
});
