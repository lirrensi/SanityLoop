// ============================================================================
// test/quit-on-end.test.ts — terminate mode stands down while work is owed.
// ============================================================================
// The unified contract: BOTH exit and terminate lanes stand down while
// hasWork is true or a compaction rebuild is in flight; terminal states
// (aborted/errored/terminated) always quit immediately. Proven WITHOUT
// process.exit: terminate mode is spied by monkey-patching agent.terminate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, EVENTS } from "@sanityloop/core";
import { StubModel, assistantTurn } from "@sanityloop/test-kit/core";
import { createQuitOnEndPlugin } from "@sanityloop/quit-on-end";

function seed(agent: Agent, text = "go"): void {
    agent.messages.push({
        id: `seed-${Math.random().toString(36).slice(2, 8)}`,
        enabled: true,
        type: "user",
        committedAt: Date.now(),
        content: [{ type: "text", content: text }],
    });
}

async function fireAgentEnd(agent: Agent): Promise<void> {
    await agent.bus.runFromRegistry(EVENTS.agentEnd, { loopState: agent.loopState });
}

test("terminate mode stands down while work is owed", async () => {
    const agent = new Agent({ model: new StubModel([() => assistantTurn("done")]) });
    agent.install(createQuitOnEndPlugin({ mode: "terminate" }));
    let terminateCalls = 0;
    agent.terminate = ((..._args: unknown[]) => {
        terminateCalls += 1;
        return Promise.resolve();
    }) as typeof agent.terminate;
    seed(agent); // unanswered user message → hasWork true
    assert.equal(agent.hasWork, true, "seeded message must be owed work");
    await fireAgentEnd(agent);
    assert.equal(terminateCalls, 0, "terminate must stand down while hasWork");
});

test("terminate mode fires when workless", async () => {
    const agent = new Agent({ model: new StubModel([() => assistantTurn("done")]) });
    agent.install(createQuitOnEndPlugin({ mode: "terminate" }));
    let terminateCalls = 0;
    agent.terminate = ((..._args: unknown[]) => {
        terminateCalls += 1;
        return Promise.resolve();
    }) as typeof agent.terminate;
    assert.equal(agent.hasWork, false, "fresh agent must be workless");
    await fireAgentEnd(agent);
    assert.equal(terminateCalls, 1, "terminate must fire when workless");
});

test("terminate mode stands down during a compaction rebuild", async () => {
    const agent = new Agent({ model: new StubModel([() => assistantTurn("done")]) });
    agent.install(createQuitOnEndPlugin({ mode: "terminate" }));
    let terminateCalls = 0;
    agent.terminate = ((..._args: unknown[]) => {
        terminateCalls += 1;
        return Promise.resolve();
    }) as typeof agent.terminate;
    agent.state.compacting = true;
    await fireAgentEnd(agent);
    assert.equal(terminateCalls, 0, "terminate must stand down while compacting");
});

test("terminate mode still fires on terminal states even with work owed", async () => {
    const agent = new Agent({ model: new StubModel([() => assistantTurn("done")]) });
    agent.install(createQuitOnEndPlugin({ mode: "terminate" }));
    let terminateCalls = 0;
    agent.terminate = ((..._args: unknown[]) => {
        terminateCalls += 1;
        return Promise.resolve();
    }) as typeof agent.terminate;
    seed(agent);
    agent.loopState = "aborted";
    await fireAgentEnd(agent);
    assert.equal(terminateCalls, 1, "terminal states must terminate immediately");
});

test("canQuit veto stands down (terminate mode)", async () => {
    const agent = new Agent({ model: new StubModel([() => assistantTurn("done")]) });
    let consults = 0;
    agent.install(createQuitOnEndPlugin({
        mode: "terminate",
        canQuit: () => {
            consults += 1;
            return false;
        },
    }));
    let terminateCalls = 0;
    agent.terminate = ((..._args: unknown[]) => {
        terminateCalls += 1;
        return Promise.resolve();
    }) as typeof agent.terminate;
    assert.equal(agent.hasWork, false, "fresh agent must be workless");
    await fireAgentEnd(agent);
    assert.equal(consults, 1, "predicate must be consulted when built-ins pass");
    assert.equal(terminateCalls, 0, "veto must stand down");
});

test("canQuit allow quits (terminate mode)", async () => {
    const agent = new Agent({ model: new StubModel([() => assistantTurn("done")]) });
    agent.install(createQuitOnEndPlugin({ mode: "terminate", canQuit: () => true }));
    let terminateCalls = 0;
    agent.terminate = ((..._args: unknown[]) => {
        terminateCalls += 1;
        return Promise.resolve();
    }) as typeof agent.terminate;
    await fireAgentEnd(agent);
    assert.equal(terminateCalls, 1, "allow must quit");
});

test("canQuit NOT consulted when built-ins already stand down", async () => {
    const agent = new Agent({ model: new StubModel([() => assistantTurn("done")]) });
    let consults = 0;
    agent.install(createQuitOnEndPlugin({
        mode: "terminate",
        canQuit: () => {
            consults += 1;
            return true;
        },
    }));
    agent.terminate = (() => Promise.resolve()) as typeof agent.terminate;
    seed(agent); // hasWork true → built-in stands down first
    await fireAgentEnd(agent);
    assert.equal(consults, 0, "predicate must not run when built-ins already stand down");
});

test("canQuit NOT consulted on terminal states", async () => {
    const agent = new Agent({ model: new StubModel([() => assistantTurn("done")]) });
    let consults = 0;
    agent.install(createQuitOnEndPlugin({
        mode: "terminate",
        canQuit: () => {
            consults += 1;
            return false;
        },
    }));
    let terminateCalls = 0;
    agent.terminate = ((..._args: unknown[]) => {
        terminateCalls += 1;
        return Promise.resolve();
    }) as typeof agent.terminate;
    agent.loopState = "aborted";
    await fireAgentEnd(agent);
    assert.equal(consults, 0, "terminal path must bypass the predicate");
    assert.equal(terminateCalls, 1, "terminal states quit immediately");
});

test("throwing canQuit stands down (fail-closed)", async () => {
    const agent = new Agent({ model: new StubModel([() => assistantTurn("done")]) });
    agent.install(createQuitOnEndPlugin({
        mode: "terminate",
        canQuit: () => {
            throw new Error("predicate bug");
        },
    }));
    let terminateCalls = 0;
    agent.terminate = ((..._args: unknown[]) => {
        terminateCalls += 1;
        return Promise.resolve();
    }) as typeof agent.terminate;
    await fireAgentEnd(agent);
    assert.equal(terminateCalls, 0, "throw must stand down, never quit");
});
