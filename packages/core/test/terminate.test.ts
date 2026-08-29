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
    assert.equal(aborts.n(), 0, "an idle agent dies QUIETLY — no fake abort events");
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
// Idempotence + dead stays dead
// ---------------------------------------------------------------------------

test("terminate() is idempotent; a dead agent cannot be driven again", async () => {
    const { agent } = makeAgent({ script: [] });
    agent.run();
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
