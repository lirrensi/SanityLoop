// ============================================================================
// tests/core/pending.test.ts — PendingAwait / PendingQuestion primitives.
// ============================================================================
// Awaits are THE park: push → the worker stops at its next wall (loopState
// awaiting), position saved; remove → supervisor relaunches. Questions are
// the async twin — never gate anything.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, EVENTS } from "@sanityloop/core";
import type { Tool } from "@sanityloop/core";
import { StubModel } from "@sanityloop/test-kit/core";
import { assistantTurn, callTo, toolCallTurn } from "@sanityloop/test-kit/core";
import { awaitAwaiting, awaitIdle, awaitLanded, sleep, waitUntil } from "@sanityloop/test-kit";
import { seedUserMessage, withDriver } from "@sanityloop/test-kit/core";

function newAgent(script: Array<() => ReturnType<typeof assistantTurn>> = []) {
    return new Agent({ model: new StubModel(script), agentId: "pending-test" });
}

// ---------------------------------------------------------------------------
// Park primitive
// ---------------------------------------------------------------------------

test("park() pushes a pure-JSON PendingAwait onto the shared array", () => {
    const agent = newAgent();
    const item = { type: "permission/ask", id: "call-1", schema: { tool: "x" }, createdAt: 123 };
    agent.park(item);
    assert.equal(agent.pendingAwaits.length, 1);
    assert.deepEqual(agent.pendingAwaits[0], item);
    // pure JSON — survives a round-trip (taped + restored)
    const cloned = JSON.parse(JSON.stringify(agent.pendingAwaits[0]));
    assert.deepEqual(cloned, item);
});

test("a pending await makes hasWork true even while idle (the loop reads hunger from state)", () => {
    const agent = newAgent();
    assert.equal(agent.hasWork, false);
    agent.pendingAwaits.push({ type: "loop-control/doom", id: "d1" });
    assert.equal(agent.hasWork, true);
});

test("PARK END-TO-END: a beforeTool gate that parks → loopState awaiting at BREAKPOINT #2, position saved", async () => {
    let executed = false;
    const tool: Tool = {
        name: "guarded",
        description: "needs permission",
        inputSchema: { type: "object" },
        async execute() {
            executed = true;
            return { answer: "ran" };
        },
    };
    const agent = newAgent([() => toolCallTurn([callTo("guarded", {}, "call-7")]), () => assistantTurn("after")]);
    agent.tools.push(tool);
    // gate parks an ask mid-GATING phase
    agent.addFilter({
        event: EVENTS.beforeTool, id: "test/gate", priority: 0,
        fn: async (a) => void a.pendingAwaits.push({ type: "test/ask", id: "call-7" }),
    });
    // the matching resolver — whoever creates an await owns resolving it
    agent.addFilter({
        event: EVENTS.inputReceived, id: "test/resolver", priority: 0,
        fn: async (a) => {
            const input = a.currentInput;
            if (input?.type === "test/answer") {
                const i = a.pendingAwaits.findIndex((w) => w.id === input.ref);
                if (i !== -1) a.pendingAwaits.splice(i, 1);
            }
        },
    });

    // THE LAW: run() needs messages — seed before the driver starts it.
    seedUserMessage(agent, "go");
    // Endless driver for the whole scenario — deterministic park AND resume.
    await withDriver(agent, async () => {
        agent.input({ type: "__test_kick__" });
        await awaitAwaiting(agent);

        assert.equal(executed, false, "nothing behind the wall runs while parked");
        assert.deepEqual(
            agent.pendingAwaits.map((x) => x.id),
            ["call-7"],
        );
        assert.ok(agent.currentAction !== undefined, "worker position saved for resume");
        assert.equal((agent.currentAction as { phase?: string })?.phase, "toolExec");

        // RESUME: the answer removes the await → worker relaunches → tool executes → lands
        agent.input({ type: "test/answer", ref: "call-7" });
        await awaitLanded(agent);
    });

    assert.equal(executed, true);
    assert.equal(agent.pendingAwaits.length, 0);
    assert.equal(agent.currentAction, undefined, "position cleared after resume");
});

// ---------------------------------------------------------------------------
// PendingQuestion — the async twin, never gates
// ---------------------------------------------------------------------------

test("questions are inert state: adding one does NOT create work or block anything", () => {
    const agent = newAgent();
    agent.addPendingQuestion({ type: "ask-question/question", id: "q1", schema: {} });
    assert.equal(agent.pendingQuestions.length, 1);
    assert.equal(agent.hasWork, false, "questions never gate");
    assert.equal(agent.loopState, "idle");
});

test("question flow resolves via input ref: filter matches by id, removes, acts on the answer", async () => {
    const agent = newAgent();
    agent.addPendingQuestion({ type: "ask-question/question", id: "q1" });

    let answered: unknown;
    agent.addFilter({
        event: EVENTS.inputReceived, id: "test/q-resolver", priority: 0,
        fn: async (a) => {
            const input = a.currentInput;
            if (input?.type === "ask-question/answer" && input.ref === "q1") {
                a.removePendingQuestion("q1");
                answered = input.answer;
            }
        },
    });

    // ASYNC lane: fire-and-forget, no driver needed, fully deterministic
    agent.input({ type: "ask-question/answer", ref: "q1", answer: "blue", async: true });
    await waitUntil(() => answered !== undefined, { what: "question to be answered" });

    assert.equal(answered, "blue");
    assert.deepEqual(agent.pendingQuestions, []);
    assert.equal(agent.loopState, "idle", "the loop never noticed any of this");
});

test("removePendingQuestion with an unknown id is a silent no-op", () => {
    const agent = newAgent();
    agent.addPendingQuestion({ type: "q", id: "real" });
    agent.removePendingQuestion("ghost");
    assert.equal(agent.pendingQuestions.length, 1);
});
