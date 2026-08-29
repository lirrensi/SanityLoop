// ============================================================================
// tests/core/agent-state.test.ts — the god object: fields, observer, hasWork.
// ============================================================================
// "State is truth": every write to the observed container emits a KeyChange →
// patched. merge() is the SILENT exception (one `merged`, zero patches).

import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, EVENTS, emptySessionStats } from "@sanityloop/core";
import type { KeyChange, Tool } from "@sanityloop/core";
import { StubModel } from "@sanityloop/test-kit/core";
import { assistantTurn, callTo, toolCallTurn } from "@sanityloop/test-kit/core";
import { makeAgent, seedUserMessage, kick, withDriver } from "@sanityloop/test-kit/core";
import { sleep, waitUntil, awaitIdle, awaitLanded } from "@sanityloop/test-kit";

function newAgent() {
    return new Agent({ model: new StubModel([]), agentId: "state-test" });
}

/** A patched collector. NOTE: patches only fire if someone listens (lazy gate). */
function collectPatches(agent: Agent): KeyChange[] {
    const seen: KeyChange[] = [];
    agent.addFilter({
        event: EVENTS.patched, id: "test/patch-collector", priority: 0,
        fn: async (_a, e) => {
            const change = e?.change as KeyChange | undefined;
            if (change) seen.push(change);
        },
    });
    return seen;
}

/**
 * The flush trick: async inputs ride a microtask sideband that ends with
 * flushPendingEvents() — a deterministic seam with NO loop driver involved.
 */
async function drainPatches(agent: Agent): Promise<void> {
    agent.input({ type: "__test_flush__", async: true });
    await sleep(25); // microtask sideband + registry dispatch
}

// ---------------------------------------------------------------------------
// God-object shape
// ---------------------------------------------------------------------------

test("god-object fields all exist on a fresh agent", () => {
    const agent = newAgent();
    assert.equal(typeof agent.id, "string");
    assert.ok(agent.id.length > 0, "fresh randomUUID id");
    assert.equal(agent.agentId, "state-test");
    assert.equal(typeof agent.cwd, "string");
    assert.ok(typeof agent.description === "string");
    assert.equal(typeof agent.activity, "string");
    assert.deepEqual(agent.messages, []);
    assert.ok(agent.stats);
    assert.deepEqual(agent.state, {});
    assert.equal(agent.loopState, "idle");
    assert.equal(typeof agent.runState, "string");
    assert.deepEqual(agent.pendingAwaits, []);
    assert.deepEqual(agent.pendingQuestions, []);
    assert.equal(agent.currentAction, undefined);
    assert.deepEqual(agent.tools, []);
    assert.equal(agent.lastResponse, -1);
});

test("constructor honors id / description / cwd / messages overrides", () => {
    const agent = new Agent({
        model: new StubModel([]),
        id: "fixed-id",
        agentId: "profile-x",
        description: "does things",
        cwd: "/tmp/wherever",
        messages: [{ id: "sys", enabled: true, type: "system-compound", content: [{ id: "b", content: "c" }] }],
    });
    assert.equal(agent.id, "fixed-id");
    assert.equal(agent.agentId, "profile-x");
    assert.equal(agent.description, "does things");
    assert.equal(agent.cwd, "/tmp/wherever");
    assert.equal(agent.messages.length, 1);
    assert.equal(agent.lastResponse, 0, "lastResponse initialized to last message index");
});

test("stats start as flat empty Stats (exact keys)", () => {
    const agent = newAgent();
    assert.deepEqual(agent.stats, emptySessionStats());
    assert.deepEqual(
        Object.keys(agent.stats).sort(),
        "cacheRead cacheWrite cost input output totalTokens".split(" ").sort(),
    );
});

// ---------------------------------------------------------------------------
// Observer — every write → patched {key}
// ---------------------------------------------------------------------------

test("ANY state write emits a patched KeyChange with top-level key + dotted path", async () => {
    const agent = newAgent();
    const changes = collectPatches(agent);

    agent.setState("foo", 42);
    await drainPatches(agent);

    const hit = changes.find((c) => c.path === "state.foo");
    assert.ok(hit, `expected state.foo in [${changes.map((c) => c.path).join(",")}]`);
    assert.deepEqual(hit, { key: "state", path: "state.foo", op: "set", value: 42 });
});

test("nested writes carry their full dotted path (observed at ANY depth)", async () => {
    const agent = newAgent();
    const changes = collectPatches(agent);

    agent.state.obj = { a: 1 };
    agent.state.obj.a = 2;
    await drainPatches(agent);

    assert.ok(changes.some((c) => c.path === "state.obj" && c.value !== undefined));
    const deep = changes.find((c) => c.path === "state.obj.a");
    assert.ok(deep, "deep mutation must be tracked");
    assert.equal(deep!.value, 2);
    assert.equal(deep!.key, "state");
});

test("loopState transitions emit patched too (the loop is observable)", async () => {
    const agent = newAgent();
    const changes = collectPatches(agent);
    agent.loopState = "awaiting";
    await drainPatches(agent);
    assert.ok(changes.some((c) => c.key === "loopState" && c.path === "loopState" && c.value === "awaiting"));
    agent.loopState = "idle"; // restore
});

test("message content mutations route to semantic events (messageUpdate)", async () => {
    const agent = newAgent();
    const updates: string[] = [];
    agent.addFilter({
        event: EVENTS.messageUpdate, id: "test/msg-update", priority: 0,
        fn: async (_a, e) => void updates.push((e?.turn as { id?: string } | undefined)?.id ?? "?"),
    });
    agent.messages.push({ id: "m1", enabled: true, type: "user", content: [{ type: "text", content: "hi" }] });
    (agent.messages[0].content as { content: string }[])[0].content = "edited";
    await drainPatches(agent);
    assert.deepEqual(updates, ["m1"]);
});

test("splice/pop/shift on messages fire messageRemoved with the ACTUALLY-removed ids", async () => {
    const agent = newAgent();
    const removed: string[] = [];
    agent.addFilter({
        event: EVENTS.messageRemoved, id: "test/msg-removed", priority: 0,
        fn: async (_a, e) => void removed.push((e?.turn as { id?: string } | undefined)?.id ?? "?"),
    });
    agent.messages.push(
        { id: "a", enabled: true, type: "user", content: [] },
        { id: "b", enabled: true, type: "user", content: [] },
        { id: "c", enabled: true, type: "user", content: [] },
    );
    await drainPatches(agent); // settle the adds
    removed.length = 0;
    agent.messages.splice(0, 1); // removes "a"
    await drainPatches(agent);
    assert.deepEqual(removed, ["a"]);
});

test("merge() writes SILENTLY — one merged event, ZERO patched for merged keys", async () => {
    const agent = newAgent();
    const changes = collectPatches(agent);
    let mergedFired = 0;
    agent.addFilter({ event: EVENTS.merged, id: "test/merged", priority: 0, fn: async () => void mergedFired++ });

    agent.merge((d) => {
        d.state.restoredKey = "hello";
        d.activity = "restored";
        return d;
    });

    assert.equal(mergedFired, 1);
    assert.equal(agent.state.restoredKey, "hello");
    // synchronous check: no patched queued by the merge itself
    const syncPatches = changes.length;
    assert.equal(syncPatches, 0, `merge must not produce patches synchronously (got ${syncPatches})`);
    await drainPatches(agent); // later flushes only carry UNRELATED churn (none here)
    assert.ok(!changes.some((c) => c.path.startsWith("state.restoredKey")), "merged keys never patch");
});

// ---------------------------------------------------------------------------
// Declared registries are NOT stored fields
// ---------------------------------------------------------------------------

test("SessionData has NO capabilities field — it's a declared registry, not stored data", () => {
    const agent = newAgent();
    assert.equal("capabilities" in agent, false, "no capabilities field on the god object");
    assert.equal(typeof agent.addDeclaredCapability, "function", "…but the registry API exists");
    assert.deepEqual(agent.listDeclaredCapabilities(), []);
});

// ---------------------------------------------------------------------------
// hasWork — owed response OR pending sync inputs OR pending awaits
// ---------------------------------------------------------------------------

test("hasWork is false on a fresh agent and true when a message owes an answer", () => {
    const agent = newAgent();
    assert.equal(agent.hasWork, false);
    agent.messages.push({ id: "u1", enabled: true, type: "user", content: [] }); // unanswered
    assert.equal(agent.hasWork, true, "unanswered message = owed response");
});

test("hasWork reflects pending awaits (an awaiting loop reads hungry — by design)", () => {
    const agent = newAgent();
    agent.park({ type: "test/ask", id: "x1" });
    assert.equal(agent.hasWork, true);
    agent.pendingAwaits.splice(0, 1);
    assert.equal(agent.hasWork, false);
});

test("hasWork sees queued SYNC inputs mid-drain (observable pending queue)", async () => {
    const { agent } = makeAgent({ script: [() => assistantTurn("ok")] });

    let observed: { len: number; hasWork: boolean } | undefined;
    agent.addFilter({
        event: EVENTS.inputReceived, id: "test/nested-input", priority: 0,
        fn: async (a) => {
            const input = a.currentInput;
            if (input?.type === "__test_kick__") {
                // a second sync input arrives while the first is mid-chain
                a.input({ type: "__bare_probe__" });
                observed = { len: a.pendingInputs.sync.length, hasWork: a.hasWork };
            }
        },
    });

    // the user message is pre-seeded → owed work exists REGARDLESS of the
    // inputs (the bare core is type-blind; a zero-work sync input would spin)
    seedUserMessage(agent, "outer");
    kick(agent);
    await waitUntil(() => observed !== undefined, { what: "nested input to be processed" });
    assert.equal(observed!.len, 1, "the bare probe sits in the sync queue during the outer chain");
    assert.equal(observed!.hasWork, true);
    await awaitIdle(agent);
});

test("THE LITERAL BLOCK FLAG: pending awaits pin the worker (blocked=true) until answered", async () => {
    let executes = 0;
    const { agent } = makeAgent({
        script: [() => toolCallTurn([callTo("x", {})]), () => assistantTurn("done")],
    });
    const tool: Tool = {
        name: "x", description: "d", inputSchema: { type: "object" },
        execute: async () => { executes++; return { answer: "ran" }; },
    };
    agent.tools.push(tool);
    agent.addFilter({
        event: EVENTS.beforeTool, id: "t/gate", priority: 0,
        fn: async (a) => void a.pendingAwaits.push({ type: "t/ask", id: "b1" }),
    });
    agent.addFilter({
        event: EVENTS.inputReceived, id: "t/clear", priority: 0,
        fn: async (a) => {
            if (a.currentInput?.type === "t/answer") {
                const i = a.pendingAwaits.findIndex((w) => w.id === "b1");
                if (i !== -1) a.pendingAwaits.splice(i, 1);
            }
        },
    });

    await withDriver(agent, async () => {
        seedUserMessage(agent, "go");
        agent.input({ type: "__test_kick__" });

        // the gate parks → loop 1 raises the literal flag, loop 2 freezes
        await waitUntil(() => agent.blocked === true, { what: "block flag raised by the gate ask" });
        assert.equal(agent.loopState, "awaiting", "derived loopState agrees with the flag");
        assert.equal(executes, 0, "worker frozen while blocked — nothing executes");

        // the answer clears the await → loop 1 drops the flag → loop 2 resumes
        agent.input({ type: "t/answer" });
        await waitUntil(() => agent.blocked === false, { what: "block flag dropped after the answer" });
        await awaitLanded(agent);
        assert.equal(executes, 1, "the tool ran the moment the flag dropped");
        assert.equal(agent.blocked, false);
        assert.equal(agent.loopState, "idle");
    });
});
