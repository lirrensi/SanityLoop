// ============================================================================
// tests/core/terminate.test.ts — THE OFF SWITCH: run() finally resolving.
// ============================================================================
// terminate() is the ONE sanctioned break of THE LAW: both clocks exit,
// run() resolves, loopState lands "terminated", and the corpse stays
// inspectable (state is truth — nothing is wiped). abort() by contrast is
// terminal-but-still-ticking; the contrast IS the point, so it is tested.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, EVENTS } from "@sanityloop/core";
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
