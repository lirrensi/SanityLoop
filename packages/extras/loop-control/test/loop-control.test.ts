// ============================================================================
// tests/extras/loop-control.test.ts — the optional guardrails (new guards).
// ============================================================================
// maxSteps and maxConsecutiveTools are closure-counted at toolEnd/cycleEnd and
// act with a committed wrap-up (never a silent crash). Proven through real turns
// under the eternal heartbeat (withDriver).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loopControl } from "@sanityloop/loop-control";
import { Agent, Tool } from "@sanityloop/core";
import type { TurnResult } from "@sanityloop/core";
import { StubModel, assistantTurn, callTo, toolCallTurn } from "@sanityloop/test-kit/core";
import { withDriver } from "@sanityloop/test-kit/core";
import { awaitLanded } from "@sanityloop/test-kit";

function makeAgent(script: Array<() => TurnResult>, opts: Parameters<typeof loopControl>[0]) {
    const executed: string[] = [];
    const tool = Tool.define({
        name: "dummy",
        description: "d",
        inputSchema: { type: "object" },
        async execute(p) {
            executed.push(String((p as { tag?: string }).tag));
            return { answer: "ran" };
        },
    });
    const model = new StubModel(script);
    const agent = new Agent({ model, tools: [tool], agentId: "loop-control-test" });
    agent.install(loopControl(opts));
    const seedAndKick = () => {
        agent.messages.push({
            id: `u-${Math.random().toString(36).slice(2, 8)}`,
            enabled: true,
            type: "user",
            committedAt: Date.now(),
            content: [{ type: "text", content: "go" }],
        });
        agent.input({ type: "__test_kick__" });
    };
    return { agent, executed, seedAndKick };
}

function userTexts(agent: Agent): string[] {
    return agent.messages
        .filter((m) => m.type === "user")
        .map((m) => (m.content as { content: string }[])[0]?.content ?? "");
}

test("maxSteps: stops at the step cap (provider round-trips + committed tools)", async () => {
    const { agent, executed, seedAndKick } = makeAgent(
        [
            () => toolCallTurn([callTo("dummy", { tag: "a" }, "s-1")]),
            () => toolCallTurn([callTo("dummy", { tag: "b" }, "s-2")]),
            () => toolCallTurn([callTo("dummy", { tag: "c" }, "s-3")]),
            () => assistantTurn("done"),
        ],
        { maxSteps: { enabled: true, cap: 5 } },
    );
    let landedLoopState: string | undefined;
    await withDriver(agent, async () => {
        seedAndKick();
        await awaitLanded(agent);
        landedLoopState = agent.loopState;
    });
    // steps: toolEnd(a)=1 + cycleEnd=2 | toolEnd(b)=3 + cycleEnd=4 | toolEnd(c)=5 → cap hit.
    // The budget message interrupts the tool chain; a cooperative model concludes.
    assert.deepEqual(executed, ["a", "b", "c"], "stopped after the third tool, before any more");
    assert.equal(landedLoopState, "idle", "landed cleanly — no crash");
    const last = agent.messages.at(-1);
    assert.equal(last?.type, "assistant", "the model concluded after the budget stop");
    const texts = userTexts(agent);
    assert.ok(texts.some((t) => t.includes("Step budget exhausted")), "final message pushed");
});

test("maxConsecutiveTools: nudges after N tools without an answer, then recovers on the answer", async () => {
    const { agent, executed, seedAndKick } = makeAgent(
        [
            () => toolCallTurn([callTo("dummy", { tag: "a" }, "c-1")]),
            () => toolCallTurn([callTo("dummy", { tag: "b" }, "c-2")]),
            () => toolCallTurn([callTo("dummy", { tag: "c" }, "c-3")]),
            () => assistantTurn("done"),
        ],
        { maxConsecutiveTools: { enabled: true, cap: 2, reaction: "nudge" } },
    );
    await withDriver(agent, async () => {
        seedAndKick();
        await awaitLanded(agent);
    });
    assert.deepEqual(executed, ["a", "b", "c"], "nudge keeps going, does not kill the run");
    const last = agent.messages.at(-1);
    assert.equal(last?.type, "assistant", "run completed normally with a final answer");
    const texts = userTexts(agent);
    assert.equal(
        texts.filter((t) => t.includes("consecutive tool calls")).length,
        1,
        "exactly one nudge pushed (cap=2 hit once, reset on the next tool)",
    );
});

test("maxConsecutiveTools reaction=stop: warns + interrupts the tool chain, model concludes", async () => {
    const { agent, executed, seedAndKick } = makeAgent(
        [
            () => toolCallTurn([callTo("dummy", { tag: "a" }, "d-1")]),
            () => toolCallTurn([callTo("dummy", { tag: "b" }, "d-2")]),
            () => assistantTurn("done"),
        ],
        { maxConsecutiveTools: { enabled: true, cap: 2, reaction: "stop" } },
    );
    await withDriver(agent, async () => {
        seedAndKick();
        await awaitLanded(agent);
    });
    assert.deepEqual(executed, ["a", "b"], "the tool chain stopped at the cap — no third tool");
    const last = agent.messages.at(-1);
    assert.equal(last?.type, "assistant", "a cooperative model concludes after the stop");
    const texts = userTexts(agent);
    assert.ok(texts.some((t) => t.includes("consecutive tool calls")), "stop message pushed");
});

test("maxSteps abort=true HARD-stops: the turn dies (aborted), no silent resume", async () => {
    const { agent, executed, seedAndKick } = makeAgent(
        [
            () => toolCallTurn([callTo("dummy", { tag: "a" }, "z-1")]),
            () => toolCallTurn([callTo("dummy", { tag: "b" }, "z-2")]),
            () => toolCallTurn([callTo("dummy", { tag: "c" }, "z-3")]),
            () => assistantTurn("done"),
        ],
        { maxSteps: { enabled: true, cap: 4, abort: true, finalMessage: "[budget] HARD STOP" } },
    );
    await withDriver(agent, async () => {
        seedAndKick();
        // steps: toolEnd(a)=1 + cycleEnd=2 | toolEnd(b)=3 + cycleEnd=4 → abort at b's cycleEnd
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
            if (agent.loopState === "aborted") break;
            await new Promise((r) => setTimeout(r, 50));
        }
        assert.equal(agent.loopState, "aborted", "hard stop — turn died, no resume past the cap");
    });
    assert.deepEqual(executed, ["a", "b"], "aborted after the second tool — never reached c");
});