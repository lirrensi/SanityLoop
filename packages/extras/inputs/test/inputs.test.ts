// ============================================================================
// tests/extras/inputs.test.ts — @sanityloop/inputs: the default input vocabulary.
// ============================================================================
// The core is TYPE-BLIND: this extra assigns meaning to input_abort/stop/
// steer/followup (+clear/reset). A bare custom-typed input must do NOTHING
// visible — the type-blindness regression guard.
//
// SIGNALS ARE JUST SIGNALS: an input never starts a loop. Every sync input
// below runs under the eternal heartbeat (agent.run()), which the tests start
// explicitly. Type-blindness is proven through the ASYNC lane, which stays
// orthogonal to the heartbeat entirely.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, EVENTS } from "@sanityloop/core";
import type { Input, Tool, TurnResult } from "@sanityloop/core";
import { createDefaultInputs, InputTypes } from "@sanityloop/inputs";
import { StubModel, assistantTurn, callTo, toolCallTurn } from "@sanityloop/test-kit/core";
import { awaitAwaiting, awaitIdle, sleep, waitUntil } from "@sanityloop/test-kit";
import { withDriver } from "@sanityloop/test-kit/core";

function inputAgent(script: Array<() => TurnResult>) {
    const model = new StubModel(script);
    const agent = new Agent({ model, agentId: "inputs-test" });
    agent.install(createDefaultInputs());
    return { agent, model };
}

function seed(agent: Agent, text = "go"): void {
    agent.messages.push({
        id: `seed-${Math.random().toString(36).slice(2, 8)}`,
        enabled: true,
        type: "user",
        committedAt: Date.now(),
        content: [{ type: "text", content: text }],
    });
}

test("the default vocabulary constants are exact", () => {
    assert.equal(InputTypes.abort, "input_abort");
    assert.equal(InputTypes.stop, "input_stop");
    assert.equal(InputTypes.steer, "input_steer");
    assert.equal(InputTypes.followup, "input_followup");
    assert.equal(InputTypes.clear, "request_clear");
    assert.equal(InputTypes.reset, "request_reset");
});

test("install registers the capability + declared inputs", () => {
    const { agent } = inputAgent([]);
    assert.ok(agent.getDeclaredCapability("inputs"));
    assert.match(agent.getDeclaredCapability("inputs")!.description, /abort\/stop\/steer\/followup/);
    assert.ok(agent.getDeclaredInput("clear-request"));
    assert.ok(agent.getDeclaredInput("reset-request"));
});

test("REGRESSION GUARD: followup becomes a USER MESSAGE and starts a turn", async () => {
    const { agent } = inputAgent([() => assistantTurn("the answer")]);
    agent.run({ startState: "idle" }); // born-landed — signals need a ticking driver to be noticed
    agent.input({ type: "input_followup", text: "hello cutie" });
    await awaitIdle(agent);

    const user = agent.messages.find((m) => m.type === "user");
    assert.ok(user, "a user message landed in history");
    assert.deepEqual(user!.content, [{ type: "text", content: "hello cutie" }]);
    const assistant = agent.messages.at(-1)!;
    assert.equal(assistant.type, "assistant");
    assert.equal(agent.loopState, "idle");

    // store:false opts out of history. Pre-seed owed work FIRST — a store:false
    // followup creates no message (and a zero-work signal just sits — the law).
    const { agent: a2 } = inputAgent([() => assistantTurn("x")]);
    seed(a2, "real work");
    a2.run({ startState: "idle" });
    a2.input({ type: "input_followup", text: "ghost", store: false });
    await awaitIdle(a2);
    assert.equal(
        a2.messages.some((m) => m.type === "user" && JSON.stringify(m.content)?.includes("ghost")),
        false,
        "store:false → no history entry for the followup",
    );
    assert.equal(a2.messages.filter((m) => m.type === "user").length, 1, "only the seeded message");
});

test("steer mid-turn is QUEUED in state.inputSteer and inserted after the tool batch", async () => {
    const { agent } = inputAgent([
        () => toolCallTurn([callTo("slow", {})]),
        () => assistantTurn("post-steer answer"),
    ]);
    const slowTool: Tool = {
        name: "slow",
        description: "d",
        inputSchema: { type: "object" },
        execute: async () => ({ answer: "ran" }),
    };
    agent.tools.push(slowTool);

    // park mid-gates so the turn stays IN FLIGHT while we steer
    agent.addFilter({
        event: EVENTS.beforeTool, id: "t/park", priority: 0,
        fn: async (a) => void a.pendingAwaits.push({ type: "t/ask", id: "c1" }),
    });
    agent.addFilter({
        event: EVENTS.inputReceived, id: "t/resolve", priority: 0,
        fn: async (a) => {
            if (a.currentInput?.type === "t/answer") {
                const i = a.pendingAwaits.findIndex((w) => w.id === "c1");
                if (i !== -1) a.pendingAwaits.splice(i, 1);
            }
        },
    });

    await withDriver(agent, async () => {
        seed(agent);
        agent.input({ type: "__test_kick__" });
        await awaitAwaiting(agent, { what: "parked on the gate ask" });
        assert.equal((agent.currentAction as { phase?: string })?.phase, "toolExec");

        // STEER while parked — processed mid-turn (inTurn true) → queued in
        // state.inputSteer. The answer arrives LATER (a realistic REPL beat):
        // under the endless driver this is fully deterministic.
        const before = agent.messages.length;
        agent.input({ type: "input_steer", text: "do it differently" } as Input);
        await sleep(30);
        assert.deepEqual(
            ((agent.state.inputSteer as Input[] | undefined) ?? []).map((i) => i.text),
            ["do it differently"],
            "steer queued in state while parked mid-turn",
        );
        assert.equal(agent.messages.length, before, "no immediate insertion");
        agent.input({ type: "t/answer" });
        await waitUntil(() => agent.loopState === "idle" && !agent.hasWork, { what: "steered turn to land" });
        void before;
    });

    // The steer went through the state queue: exactly ONE steer became a REAL
    // user message, inserted at the cycleEnd seam AFTER the tool results.
    // Final shape: [seed(user), toolCall, toolResult, steer(user), assistant]
    assert.equal(agent.messages.length, 5);
    const types = agent.messages.map((m) => m.type);
    const steerIdx = types.lastIndexOf("user");
    assert.ok(steerIdx > types.indexOf("toolResult"), "steer inserted AFTER the tool results");
    assert.deepEqual(
        (agent.messages[steerIdx]!.content as Array<{ content?: string }>)[0]?.content,
        "do it differently",
    );
    assert.deepEqual(
        (agent.state.inputSteer as unknown[] | undefined) ?? [],
        [],
        "queue drained",
    );
    assert.equal(agent.messages.at(-1)!.type, "assistant");
});

test("abort holds everything immediately and lands terminal", async () => {
    const { agent } = inputAgent([
        () => toolCallTurn([callTo("x", {})]),
        () => assistantTurn("never"),
    ]);
    agent.tools.push({
        name: "x", description: "d", inputSchema: { type: "object" },
        execute: async () => ({ answer: "ran" }),
    });
    agent.addFilter({
        event: EVENTS.beforeTool, id: "t/park2", priority: 0,
        fn: async (a) => void a.pendingAwaits.push({ type: "t/ask", id: "c9" }),
    });
    seed(agent);
    agent.run({ startState: "idle" }); // eternal heartbeat
    agent.input({ type: "__test_kick__" });
    await awaitAwaiting(agent);

    agent.input({ type: "input_abort" });
    await waitUntil(() => agent.loopState === "aborted", { what: "aborted terminal state" });
    assert.equal(agent.abortController.signal.aborted, true);
});

test("TYPE-BLINDNESS GUARD: bare custom-typed input does NOTHING visible", async () => {
    const { agent } = inputAgent([]);
    let processed = 0;
    agent.addFilter({
        event: EVENTS.inputProcessed, id: "t/watch", priority: 0,
        fn: async () => void processed++,
    });

    const messagesBefore = JSON.stringify(agent.messages.map((m) => m.id));
    const stateBefore = JSON.stringify(agent.state);
    agent.input({ type: "some/custom_thing", payload: { weird: true }, async: true });

    await waitUntil(() => processed === 1, { what: "async input to be processed" });
    await sleep(20);

    assert.equal(JSON.stringify(agent.messages.map((m) => m.id)), messagesBefore, "no message added");
    assert.equal(JSON.stringify(agent.state), stateBefore, "no state touched");
    assert.equal(agent.loopState, "idle", "loop never woke");
    assert.equal(agent.hasWork, false, "nothing owed");
});

test("stop mid-turn lets the current step finish then lands gracefully", async () => {
    const { agent } = inputAgent([
        () => toolCallTurn([callTo("x", {})]),
        () => assistantTurn("final words"),
    ]);
    agent.tools.push({
        name: "x", description: "d", inputSchema: { type: "object" },
        execute: async () => ({ answer: "ran" }),
    });
    // stop at the provider wall of cycle 2 — deterministic mid-turn stop
    let walls = 0;
    agent.addFilter({
        event: EVENTS.beforeProviderRequest, id: "t/stopper", priority: 0,
        fn: async (a) => {
            walls++;
            if (walls === 2) a.stop();
        },
    });

    await withDriver(agent, async () => {
        seed(agent);
        agent.input({ type: "__test_kick__" });
        await waitUntil(() => agent.loopState === "idle" && !agent.hasWork, { what: "stopped turn to land" });

        assert.equal(agent.loopState, "idle");
        assert.equal(agent.stopRequested, false, "halt flags reset at the landing");
        assert.ok(agent.messages.some((m) => m.type === "assistant"), "the final answer still committed");
    });
});
