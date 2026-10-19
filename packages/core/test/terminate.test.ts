// ============================================================================
// tests/core/terminate.test.ts — THE OFF SWITCH: run() finally resolving.
// ============================================================================
// terminate() is the ONE sanctioned break of THE LAW: both clocks exit,
// run() resolves, loopState lands "terminated", and the corpse stays
// inspectable (state is truth — nothing is wiped). abort() by contrast is
// terminal-but-still-ticking; the contrast IS the point, so it is tested.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, EVENTS, emptySessionStats } from "@sanityloop/core";
import type { Tool } from "@sanityloop/core";
import { makeAgent, seedUserMessage } from "@sanityloop/test-kit/core";
import { assistantTurn, callTo, toolCallTurn } from "@sanityloop/test-kit/core";
import { sleep, waitUntil } from "@sanityloop/test-kit";

/** Count lifecycle announcements — the abort family vs agentEnd. */
function counter(agent: Agent, event: string): { n(): number } {
    let hits = 0;
    agent.addFilter({
        event,
        id: `test/count-${event}-${crypto.randomUUID().slice(0, 4)}`,
        priority: 0,
        fn: async () => {
            hits++;
        },
    });
    return { n: () => hits };
}

// ---------------------------------------------------------------------------
// The promise settles
// ---------------------------------------------------------------------------

test("run() resolves after terminate() — the promise finally settles", async () => {
    const { agent } = makeAgent({ script: [() => assistantTurn("done")] });
    seedUserMessage(agent, "hi");
    const ends = counter(agent, EVENTS.agentEnd);
    const aborts = counter(agent, EVENTS.abort);
    let resolved = 0;
    const runP = agent.run().then(() => {
        resolved++;
    });
    await waitUntil(() => agent.loopState === "idle" && !agent.hasWork, {
        what: "turn to land idle",
    });
    assert.equal(resolved, 0, "run() still pending before the off switch");
    await agent.terminate();
    await runP;
    assert.equal(resolved, 1, "run() resolved exactly once");
    assert.equal(agent.loopState, "terminated");
    // agentEnd is dual-purpose: once at the graceful landing, once at teardown
    assert.ok(ends.n() >= 1, "teardown announced (agentEnd)");
    // terminate ALWAYS aborts first — the cleanup channel fires even for an
    // idle agent, so out-of-band children (background jobs) are never orphaned
    assert.equal(aborts.n(), 1, "terminate fires the abort family exactly once");
    assert.equal(agent.abortSignal.aborted, true, "the signal fired — subscribers saw it");
    assert.ok(
        agent.messages.length >= 2,
        "state preserved — the post-mortem stays inspectable",
    );
});

test("fire-and-forget terminate() still stops the heart", async () => {
    const { agent } = makeAgent({ script: [() => assistantTurn("x")] });
    seedUserMessage(agent, "hi"); // THE LAW: run() needs messages to start
    agent.run(); // never awaited — the fire-and-forget life
    void agent.terminate(); // nobody holds this promise
    await waitUntil(() => agent.loopState === "terminated", {
        what: "terminated state",
    });
    await sleep(60); // let a possibly mid-beat loop finish its last breath
    const frozen = agent.ticks;
    await sleep(60);
    assert.equal(agent.ticks, frozen, "zero ticks after termination — the heart stopped");
});

// ---------------------------------------------------------------------------
// THE LAW, amended: abort keeps ticking, terminate does not
// ---------------------------------------------------------------------------

test("abort() leaves the clock ticking; terminate() stops it", async () => {
    const { agent } = makeAgent({ script: [() => assistantTurn("x")] });
    seedUserMessage(agent, "hi");
    agent.run();
    await waitUntil(() => agent.loopState === "idle" && !agent.hasWork, {
        what: "turn to land idle",
    });

    agent.abort("test");
    await waitUntil(() => agent.loopState === "aborted", { what: "aborted" });
    const t1 = agent.ticks;
    await sleep(50);
    assert.ok(agent.ticks > t1, "aborted corpse still ticks — silent but alive");

    await agent.terminate();
    const t2 = agent.ticks;
    await sleep(50);
    assert.equal(agent.ticks, t2, "terminated corpse never ticks again");
});

// ---------------------------------------------------------------------------
// Mid-flight kill
// ---------------------------------------------------------------------------

test("terminate() mid-batch: in-flight tool commits its result, run() resolves", async () => {
    let toolStarted = false;
    const slowTool: Tool = {
        name: "slow",
        description: "takes its sweet time and ignores the abort signal",
        inputSchema: { type: "object" },
        executionMode: "sequential",
        execute: async () => {
            toolStarted = true; // we are INSIDE executeToolBatch now — not merely gating
            await sleep(150); // badly-behaved tool: cooperative cancellation ignored
            return { answer: "finally done" };
        },
    };
    const { agent } = makeAgent({
        script: [
            () => toolCallTurn([callTo("slow", {})]),
            () => assistantTurn("never reached"),
        ],
        tools: [slowTool],
    });
    seedUserMessage(agent, "go");
    const aborts = counter(agent, EVENTS.abort);
    const runP = agent.run();
    await waitUntil(() => toolStarted, {
        what: "slow tool to actually start executing",
    });
    await agent.terminate("mid-batch");
    await runP;
    assert.equal(agent.loopState, "terminated");
    assert.ok(aborts.n() >= 1, "in-flight work got the REAL abort family");
    const results = agent.messages.filter((m) => m.type === "toolResult");
    assert.equal(results.length, 1, "the tool result still committed — state is truth");
    assert.equal(
        agent.messages.filter((m) => m.type === "assistant").length,
        0,
        "no further turn ran after the off switch",
    );
});
// ---------------------------------------------------------------------------
// Abort-first: out-of-band children die on terminate, even when idle
// ---------------------------------------------------------------------------

test("terminate() on an idle agent still fires signal + abort family (no orphans)", async () => {
    const { agent } = makeAgent({ script: [() => assistantTurn("done")] });
    seedUserMessage(agent, "hi");
    const aborts = counter(agent, EVENTS.abort);
    const befores = counter(agent, EVENTS.beforeAbort);
    let signalFired = 0;
    agent.abortSignal.addEventListener("abort", () => signalFired++, { once: true });
    agent.run();
    await waitUntil(() => agent.loopState === "idle" && !agent.hasWork, {
        what: "turn to land idle",
    });
    await agent.terminate("owner cleanup");
    assert.equal(befores.n(), 1, "beforeAbort fired on idle terminate");
    assert.equal(aborts.n(), 1, "abort fired on idle terminate");
    assert.equal(signalFired, 1, "signal subscribers saw it");
    assert.equal(agent.loopState, "terminated");
});

// ---------------------------------------------------------------------------
// Idempotence + dead stays dead
// ---------------------------------------------------------------------------

test("terminate() is idempotent; a dead agent cannot be driven again", async () => {
    const { agent } = makeAgent({ script: [] });
    // the zero-message run() REJECTS by law — hold the promise so the
    // rejection is observed, not floating (a later test's settled-timer
    // activity would otherwise surface it as async-after-end noise).
    const runP = agent.run();
    runP.catch(() => {});
    await agent.terminate();
    await agent.terminate(); // second call resolves too, fires nothing new
    await agent.run(); // dead stays dead — immediate resolve, no new clocks
    assert.equal(agent.loopState, "terminated");
});

test("terminate() before run(): born dead — run() resolves immediately", async () => {
    const { agent } = makeAgent({ script: [() => assistantTurn("never")] });
    await agent.terminate("premature");
    assert.equal(agent.loopState, "terminated");
    await agent.run();
    assert.equal(agent.messages.length, 0, "no turn ever ran");
    assert.equal(agent.loopState, "terminated");
});

// ---------------------------------------------------------------------------
// settled() — the caller-SDK wait. Resolves, never polls, never throws.
// ---------------------------------------------------------------------------

test("settled() resolves idle when the turn lands (the worker pattern)", async () => {
    const { agent } = makeAgent({ script: [() => assistantTurn("done")] });
    seedUserMessage(agent, "hi");
    agent.run();
    const r = await agent.settled({ timeoutMs: 5000 });
    assert.deepEqual(r, { state: "idle", timedOut: false });
    assert.equal(agent.messages.at(-1)?.type, "assistant");
    await agent.terminate();
});

test("settled() resolves awaiting when the loop parks (a rest, not a hang)", async () => {
    const { agent } = makeAgent({ script: [() => assistantTurn("never")] });
    seedUserMessage(agent, "hi");
    agent.park({ type: "test/ask", id: "x1" });
    agent.run();
    const r = await agent.settled({ timeoutMs: 5000 });
    assert.deepEqual(r, { state: "awaiting", timedOut: false });
    await agent.terminate();
});

test("settled() timeout RESOLVES timedOut:true — never throws", async () => {
    const { agent } = makeAgent({ script: [() => assistantTurn("slow")] });
    seedUserMessage(agent, "hi");
    agent.run();
    const r = await agent.settled({ timeoutMs: 30, states: ["awaiting"] });
    assert.equal(r.timedOut, true, "deadline fired, promise resolved");
    assert.equal(typeof r.state, "string", "live state sampled at the deadline");
    await agent.terminate();
});

test("settled() states filter skips non-wanted rests", async () => {
    const { agent } = makeAgent({ script: [() => assistantTurn("ok")] });
    seedUserMessage(agent, "hi");
    agent.park({ type: "test/ask", id: "x1" });
    agent.run();
    // awaiting arrives first — the idle-only waiter must NOT resolve on it
    const p = agent.settled({ timeoutMs: 5000, states: ["idle"] });
    await sleep(80);
    agent.pendingAwaits.splice(0, 1); // answer the park → turn runs → lands idle
    const r = await p;
    assert.deepEqual(r, { state: "idle", timedOut: false });
    await agent.terminate();
});

test("settled() resolves the terminal state after abort()", async () => {
    const { agent } = makeAgent({ script: [() => assistantTurn("x")] });
    seedUserMessage(agent, "hi");
    agent.run();
    setTimeout(() => agent.abort("test"), 30);
    const r = await agent.settled({ timeoutMs: 5000 });
    assert.deepEqual(r, { state: "aborted", timedOut: false });
    await agent.terminate();
});

test("settled() on an un-run agent answers NOW from current state (no hang)", async () => {
    const { agent } = makeAgent({ script: [] });
    const t0 = Date.now();
    const r = await agent.settled({ timeoutMs: 5000 });
    assert.ok(Date.now() - t0 < 1000, "immediate answer — no heartbeat to wait on");
    assert.deepEqual(r, { state: "idle", timedOut: false });
});

test("settled() AFTER terminate() answers NOW with terminated (dead heart, no hang)", async () => {
    // REGRESSION: settled() registered a waiter no beat would ever notify —
    // the loops broke, terminate()'s sweep already ran. Hung forever.
    // Dead hearts answer NOW: terminated, not a timeout.
    const { agent } = makeAgent({ script: [() => assistantTurn("x")] });
    seedUserMessage(agent, "hi");
    const runP = agent.run();
    await waitUntil(() => agent.loopState === "idle" && !agent.hasWork, {
        what: "turn to land idle",
    });
    await agent.terminate();
    await runP;
    const t0 = Date.now();
    const r = await agent.settled(); // NO timeout — must not hang
    assert.ok(Date.now() - t0 < 1000, "immediate answer — the heart is dead");
    assert.deepEqual(r, { state: "terminated", timedOut: false });
    // states filter still applies: unwanted rest → timedOut, still NOW
    const r2 = await agent.settled({ states: ["idle"] });
    assert.deepEqual(r2, { state: "terminated", timedOut: true });
});

// ---------------------------------------------------------------------------
// destroy() — THE HUSK-MAKER: terminate() + strip
// ---------------------------------------------------------------------------

test("destroy() nulls the guts: messages/state/stats/filters/bus refs/lastResponse", async () => {
    const { agent } = makeAgent({ script: [() => assistantTurn("done")] });
    seedUserMessage(agent, "hi");
    agent.state.custom = { nested: true };
    agent.install({
        id: "test/stuff",
        install(a) {
            a.addFilter({ event: EVENTS.agentEnd, id: "test/stuff-end", priority: 0, fn: async () => {} });
        },
        uninstall(a) {
            a.removeFilter(EVENTS.agentEnd, "test/stuff-end");
        },
    });
    const runP = agent.run();
    await waitUntil(() => agent.loopState === "idle" && !agent.hasWork, {
        what: "turn to land idle",
    });
    assert.ok(agent.messages.length > 0, "precondition: corpse has messages");
    assert.ok(agent.filters.length > 0, "precondition: filters registered");
    await agent.destroy();
    await runP;
    assert.equal(agent.loopState, "terminated");
    assert.deepEqual(agent.messages, [], "messages nulled");
    assert.deepEqual(agent.state, {}, "state emptied");
    assert.deepEqual(agent.stats, emptySessionStats(), "stats zeroed to fresh shape");
    assert.deepEqual(agent.filters, [], "filters emptied");
    assert.equal(agent.bus.has(EVENTS.agentEnd), false, "bus registry stripped");
    assert.equal(agent.plugins.length, 0, "plugins uninstalled");
    assert.equal(agent.lastResponse, -1, "lastResponse reset");
    assert.equal(agent.pendingInputs.sync.length, 0, "no pending sync");
    assert.equal(agent.pendingAwaits.length, 0, "no pending awaits");
});

test("destroy() uninstalls plugins in REVERSE install order", async () => {
    const { agent } = makeAgent({ script: [] });
    const order: string[] = [];
    for (const id of ["p/a", "p/b", "p/c"]) {
        agent.install({
            id,
            install() {},
            uninstall() {
                order.push(id);
            },
        });
    }
    await agent.destroy();
    assert.deepEqual(order, ["p/c", "p/b", "p/a"], "reverse install order");
});

test("destroy() is idempotent; a second call returns the same settlement", async () => {
    const { agent } = makeAgent({ script: [() => assistantTurn("x")] });
    seedUserMessage(agent, "hi");
    const runP = agent.run();
    await waitUntil(() => agent.loopState === "idle" && !agent.hasWork, {
        what: "turn to land idle",
    });
    await agent.destroy();
    await agent.destroy("again");
    await agent.destroy();
    await runP;
    assert.equal(agent.loopState, "terminated");
    assert.deepEqual(agent.messages, [], "still a husk after repeat destroys");
});

test("run() after destroy() resolves immediately (dead stays dead)", async () => {
    const { agent } = makeAgent({ script: [() => assistantTurn("x")] });
    seedUserMessage(agent, "hi");
    await agent.destroy(); // born dead — never ran
    const t0 = Date.now();
    await agent.run();
    assert.ok(Date.now() - t0 < 1000, "immediate resolve — the husk never ticks");
    assert.equal(agent.ticks, 0, "zero ticks after destroy");
});

test("terminate() keeps the corpse: state stays inspectable (destroy contrast)", async () => {
    const { agent } = makeAgent({ script: [() => assistantTurn("done")] });
    seedUserMessage(agent, "hi");
    const runP = agent.run();
    await waitUntil(() => agent.loopState === "idle" && !agent.hasWork, {
        what: "turn to land idle",
    });
    await agent.terminate();
    await runP;
    assert.ok(agent.messages.length >= 2, "terminate preserves the post-mortem");
});

// ---------------------------------------------------------------------------
// Death events: beforeTerminate + beforeDestroy fire once, and only once
// ---------------------------------------------------------------------------

test("beforeTerminate fires ONCE, sync, inside terminate() after the abort channel", async () => {
    const { agent } = makeAgent({ script: [() => assistantTurn("x")] });
    seedUserMessage(agent, "hi");
    const seen: string[] = [];
    let abortSeenAt = -1;
    agent.addFilter({
        event: EVENTS.abort, id: "t/abort-spy", priority: 0,
        fn: async () => {
            abortSeenAt = seen.length;
        },
    });
    agent.addFilter({
        event: EVENTS.beforeTerminate, id: "t/bt-spy", priority: 0,
        fn: async () => {
            seen.push("beforeTerminate");
        },
    });
    agent.run();
    await waitUntil(() => agent.loopState === "idle" && !agent.hasWork, {
        what: "turn to land idle",
    });
    await agent.terminate("test-reason");
    assert.equal(seen.length, 1, "fires exactly once");
    assert.ok(abortSeenAt !== -1, "abort channel fired (abort event observed)");
    assert.equal(agent.loopState, "terminated");
    // second terminate is a no-op — no second firing
    await agent.terminate("test-reason");
    assert.equal(seen.length, 1, "idempotent terminate never re-fires");
});

test("beforeDestroy fires ONCE inside destroy() after terminate, before the strip", async () => {
    const { agent } = makeAgent({ script: [() => assistantTurn("x")] });
    seedUserMessage(agent, "hi");
    const order: string[] = [];
    agent.addFilter({
        event: EVENTS.beforeTerminate, id: "t/bt-order", priority: 0,
        fn: async () => void order.push("beforeTerminate"),
    });
    agent.addFilter({
        event: EVENTS.beforeDestroy, id: "t/bd-order", priority: 0,
        fn: async () => void order.push("beforeDestroy"),
    });
    const runP = agent.run();
    await waitUntil(() => agent.loopState === "idle" && !agent.hasWork, {
        what: "turn to land idle",
    });
    await agent.destroy();
    await runP;
    assert.deepEqual(order, ["beforeTerminate", "beforeDestroy"], "terminate first, destroy after");
    await agent.destroy();
    assert.deepEqual(order, ["beforeTerminate", "beforeDestroy"], "idempotent destroy never re-fires");
});

test("destroy() abort-channel first: terminate inside destroy fires beforeTerminate once", async () => {
    const { agent } = makeAgent({ script: [] });
    let bt = 0;
    let bd = 0;
    agent.addFilter({
        event: EVENTS.beforeTerminate, id: "t/bt-count", priority: 0,
        fn: async () => void bt++,
    });
    agent.addFilter({
        event: EVENTS.beforeDestroy, id: "t/bd-count", priority: 0,
        fn: async () => void bd++,
    });
    await agent.destroy("born-dead");
    assert.equal(bt, 1, "terminate half fires beforeTerminate exactly once");
    assert.equal(bd, 1, "destroy half fires beforeDestroy exactly once");
    assert.equal(agent.abortSignal.aborted, true, "abort channel fired even when idle");
});
