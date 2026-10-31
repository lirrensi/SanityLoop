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

test("retry: transient tool error recovers on the second attempt, attempts stamped", async () => {
    let n = 0;
    const flaky = Tool.define({
        name: "flaky",
        description: "fails once transiently, then works",
        inputSchema: { type: "object" },
        async execute() {
            n++;
            if (n === 1) return { answer: "boom", error: true, errorMessage: "timeout after 1ms" };
            return { answer: "recovered", stored: { n } };
        },
    });
    const model = new StubModel([
        () => toolCallTurn([callTo("flaky", {}, "r-1")]),
        () => assistantTurn("done"),
    ]);
    const agent = new Agent({ model, tools: [flaky], agentId: "retry-test" });
    agent.use(loopControl({ retry: { enabled: true, attempts: 3, backoff: { baseMs: 5 } } }));
    await withDriver(agent, async () => {
        agent.messages.push({
            id: "u-1", enabled: true, type: "user", committedAt: Date.now(),
            content: [{ type: "text", content: "go" }],
        });
        agent.input({ type: "__test_kick__" });
        await awaitLanded(agent);
    });
    assert.equal(n, 2, "executed twice: original + one retry");
    const result = [...agent.messages].reverse().find((m) => m.type === "toolResult");
    assert.ok(result, "a toolResult committed");
    const content = result!.content as { answer: string; error?: boolean; stored?: { attempts?: number } };
    assert.equal(content.answer, "recovered");
    assert.equal(content.error, undefined, "recovered result commits clean");
    assert.equal(content.stored?.attempts, 2, "attempts stamped in stored");
    const st = agent.state.loopControl as { lastAction?: string; attempts?: number } | undefined;
    assert.equal(st?.lastAction, "retry-recovered");
    assert.equal(st?.attempts, 2);
});

test("retry: permanent errors never retry (invalid_arguments + custom predicate)", async () => {
    let n = 0;
    const bad = Tool.define({
        name: "bad",
        description: "always fails permanently",
        inputSchema: { type: "object" },
        async execute() {
            n++;
            return { answer: "nope", error: true, errorMessage: "invalid_arguments" };
        },
    });
    const model = new StubModel([
        () => toolCallTurn([callTo("bad", {}, "p-1")]),
        () => assistantTurn("done"),
    ]);
    const agent = new Agent({ model, tools: [bad], agentId: "retry-perm" });
    agent.use(loopControl({ retry: { enabled: true, attempts: 3, backoff: { baseMs: 5 } } }));
    await withDriver(agent, async () => {
        agent.messages.push({
            id: "u-1", enabled: true, type: "user", committedAt: Date.now(),
            content: [{ type: "text", content: "go" }],
        });
        agent.input({ type: "__test_kick__" });
        await awaitLanded(agent);
    });
    assert.equal(n, 1, "permanent error: no retry, the model sees it");
});

test("retry: exhaustion commits the final error, fallback substitutes", async () => {
    let n = 0;
    const down = Tool.define({
        name: "down",
        description: "always 500s",
        inputSchema: { type: "object" },
        async execute() {
            n++;
            return { answer: "boom", error: true, errorMessage: "500 internal" };
        },
    });
    const model = new StubModel([
        () => toolCallTurn([callTo("down", {}, "e-1")]),
        () => assistantTurn("done"),
    ]);
    const agent = new Agent({ model, tools: [down], agentId: "retry-exhaust" });
    agent.use(loopControl({
        retry: {
            enabled: true, attempts: 2, backoff: { baseMs: 5 },
            fallback: ({ attempts }) => ({ answer: "upstream unavailable", errorMessage: `gave up after ${attempts}` }),
        },
    }));
    await withDriver(agent, async () => {
        agent.messages.push({
            id: "u-1", enabled: true, type: "user", committedAt: Date.now(),
            content: [{ type: "text", content: "go" }],
        });
        agent.input({ type: "__test_kick__" });
        await awaitLanded(agent);
    });
    assert.equal(n, 2, "two attempts, then fallback");
    const result = [...agent.messages].reverse().find((m) => m.type === "toolResult");
    const content = result!.content as { answer: string; error?: boolean; errorMessage?: string };
    assert.equal(content.answer, "upstream unavailable");
    assert.equal(content.errorMessage, "gave up after 2");
    const st = agent.state.loopControl as { lastAction?: string } | undefined;
    assert.equal(st?.lastAction, "retry-exhausted");
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

test("spinGuard: consecutive DISCARDED cycles trip the guard (stuck veto filter)", async () => {
    const { agent, seedAndKick } = makeAgent(
        [
            () => assistantTurn("1"),
            () => assistantTurn("2"),
            () => assistantTurn("3"),
            () => assistantTurn("4"),
        ],
        { spinGuard: { enabled: true, threshold: 3, abort: true, message: "[spin] cycles discarded without committing." } },
    );
    // a veto filter discards EVERY cycle — exactly the stuck-filter scenario.
    // gentle stop() can't win against a filter that vetoes forever, so the
    // guard's honest reaction is the hard abort.
    agent.addFilter({
        event: "afterProviderResponse", id: "test/veto", priority: 0,
        fn: async (a) => a.endCycle(),
    });
    await withDriver(agent, async () => {
        seedAndKick();
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
            if (agent.loopState === "aborted") break;
            await new Promise((r) => setTimeout(r, 50));
        }
        assert.equal(agent.loopState, "aborted", "hard stop — stuck filter frozen, no 100Hz spin");
    });
    const st = agent.state.loopControl as { lastAction?: string } | undefined;
    assert.equal(st?.lastAction, "spin-guard", "spin guard recorded");
});

test("maxTime: wall-clock breach stops before the next provider call", async () => {
    const model = new StubModel([
        () => toolCallTurn([callTo("dummy", { tag: "a" }, "t-1")]),
        () => toolCallTurn([callTo("dummy", { tag: "b" }, "t-2")]),
        () => assistantTurn("never"),
    ]);
    const tool = Tool.define({
        name: "dummy", description: "d", inputSchema: { type: "object" },
        async execute() {
            // GENUINE wall-clock: the governor reads Date.now() and the loop
            // beats on real 10ms ticks — fake timers cannot drive this.
            const { promise, resolve } = Promise.withResolvers<void>();
            setTimeout(resolve, 60); // burn the budget mid-turn
            await promise;
            return { answer: "ran" };
        },
    });
    const agent = new Agent({ model, tools: [tool], agentId: "max-time-test" });
    agent.install(loopControl({ maxTime: { enabled: true, capMs: 30 } }));
    await withDriver(agent, async () => {
        agent.messages.push({
            id: "u-1", enabled: true, type: "user", committedAt: Date.now(),
            content: [{ type: "text", content: "go" }],
        });
        agent.input({ type: "__test_kick__" });
        await awaitLanded(agent);
    });
    assert.equal(model.calls.length, 1, "second provider call never fired — the wall held");
    const texts = userTexts(agent);
    assert.ok(texts.some((t) => t.includes("Time budget exhausted")), "wrap-up message pushed");
    const st = agent.state.loopControl as { lastAction?: string } | undefined;
    assert.equal(st?.lastAction, "max-time");
});

test("maxCost: spend breach refuses the next provider call", async () => {
    const priceyCall = (id: string) => toolCallTurn([callTo("dummy", { tag: id }, id)], { cost: { total: 0.06 } });
    const model = new StubModel([
        () => priceyCall("c-1"),
        () => priceyCall("c-2"),
        () => assistantTurn("never"),
    ]);
    const tool = Tool.define({
        name: "dummy", description: "d", inputSchema: { type: "object" },
        async execute() { return { answer: "ran" }; },
    });
    const agent = new Agent({ model, tools: [tool], agentId: "max-cost-test" });
    agent.install(loopControl({ maxCost: { enabled: true, capUsd: 0.1 } }));
    await withDriver(agent, async () => {
        agent.messages.push({
            id: "u-1", enabled: true, type: "user", committedAt: Date.now(),
            content: [{ type: "text", content: "go" }],
        });
        agent.input({ type: "__test_kick__" });
        await awaitLanded(agent);
    });
    // 0 → call 1 (0.06) → call 2 (0.12) → wall: 0.12 >= 0.1, third call refused
    assert.equal(model.calls.length, 2, "third provider call never fired");
    assert.ok(agent.stats.cost.total >= 0.1, `spend recorded: ${agent.stats.cost.total}`);
    const st = agent.state.loopControl as { lastAction?: string } | undefined;
    assert.equal(st?.lastAction, "max-cost");
});

test("maxTokens: token breach stops before the next provider call", async () => {
    const heavyCall = (id: string) => toolCallTurn([callTo("dummy", { tag: id }, id)], { totalTokens: 600, input: 500, output: 100 });
    const model = new StubModel([
        () => heavyCall("k-1"),
        () => heavyCall("k-2"),
        () => assistantTurn("never"),
    ]);
    const tool = Tool.define({
        name: "dummy", description: "d", inputSchema: { type: "object" },
        async execute() { return { answer: "ran" }; },
    });
    const agent = new Agent({ model, tools: [tool], agentId: "max-tokens-test" });
    agent.install(loopControl({ maxTokens: { enabled: true, cap: 1000 } }));
    await withDriver(agent, async () => {
        agent.messages.push({
            id: "u-1", enabled: true, type: "user", committedAt: Date.now(),
            content: [{ type: "text", content: "go" }],
        });
        agent.input({ type: "__test_kick__" });
        await awaitLanded(agent);
    });
    // 0 → call 1 (600) → call 2 (1200) → wall: 1200 >= 1000, third call refused
    assert.equal(model.calls.length, 2, "third provider call never fired");
    assert.ok(agent.stats.totalTokens >= 1000, `tokens recorded: ${agent.stats.totalTokens}`);
    const st = agent.state.loopControl as { lastAction?: string } | undefined;
    assert.equal(st?.lastAction, "max-tokens");
});

test("governors: disabled by default, cap 0 = unlimited", async () => {
    const { agent, seedAndKick } = makeAgent(
        [() => assistantTurn("done")],
        { maxTime: { enabled: true, capMs: 0 }, maxCost: { enabled: true, capUsd: 0 }, maxTokens: { enabled: true, cap: 0 } },
    );
    let landedLoopState: string | undefined;
    await withDriver(agent, async () => {
        seedAndKick();
        await awaitLanded(agent);
        landedLoopState = agent.loopState;
    });
    assert.equal(landedLoopState, "idle", "zero caps never trip");
    assert.equal(agent.state.loopControl, undefined, "no governor action recorded");
});

test("circuitBreaker: opens after N consecutive errors, tool stops executing", async () => {
    let n = 0;
    const bad = Tool.define({
        name: "bad",
        description: "always fails",
        inputSchema: { type: "object" },
        async execute() {
            n++;
            return { answer: "boom", error: true, errorMessage: "500 down" };
        },
    });
    const model = new StubModel([
        () => toolCallTurn([callTo("bad", {}, "b-1")]),
        () => toolCallTurn([callTo("bad", {}, "b-2")]),
        () => toolCallTurn([callTo("bad", {}, "b-3")]),
        () => assistantTurn("done"),
    ]);
    const agent = new Agent({ model, tools: [bad], agentId: "breaker-test" });
    agent.install(loopControl({ circuitBreaker: { enabled: true, errors: 2, cooldownMs: 0 } }));
    await withDriver(agent, async () => {
        agent.messages.push({
            id: "u-1", enabled: true, type: "user", committedAt: Date.now(),
            content: [{ type: "text", content: "go" }],
        });
        agent.input({ type: "__test_kick__" });
        await awaitLanded(agent);
    });
    assert.equal(n, 2, "third call short-circuited — execute never ran");
    const results = agent.messages.filter((m) => m.type === "toolResult");
    assert.equal(results.length, 3);
    const third = (results[2].content as { answer: string }).answer;
    assert.match(third, /currently disabled/, "disabled answer committed, model informed");
    const st = agent.state.loopControl as { lastAction?: string; tool?: string } | undefined;
    assert.equal(st?.lastAction, "breaker-open");
    assert.equal(st?.tool, "bad");
});

test("circuitBreaker: success resets, tool left enabled", async () => {
    let n = 0;
    const flaky = Tool.define({
        name: "flaky",
        description: "fails twice, then works",
        inputSchema: { type: "object" },
        async execute() {
            n++;
            if (n <= 2) return { answer: "boom", error: true, errorMessage: "500 down" };
            return { answer: "recovered" };
        },
    });
    const model = new StubModel([
        () => toolCallTurn([callTo("flaky", {}, "f-1")]),
        () => toolCallTurn([callTo("flaky", {}, "f-2")]),
        () => toolCallTurn([callTo("flaky", {}, "f-3")]),
        () => assistantTurn("done"),
    ]);
    const agent = new Agent({ model, tools: [flaky], agentId: "breaker-heal" });
    // errors: 3 — never opens (third call succeeds, resetting at 2)
    agent.install(loopControl({ circuitBreaker: { enabled: true, errors: 3, cooldownMs: 30 } }));
    await withDriver(agent, async () => {
        agent.messages.push({
            id: "u-1", enabled: true, type: "user", committedAt: Date.now(),
            content: [{ type: "text", content: "go" }],
        });
        agent.input({ type: "__test_kick__" });
        await awaitLanded(agent);
    });
    assert.equal(n, 3, "all three executed — breaker never opened");
    const tool = agent.tools.find((t) => t.name === "flaky");
    assert.equal(tool?.disabled, undefined, "tool left enabled");
});

test("malformed: empty responses vetoed silently, nudge at the cap", async () => {
    const empty = (): TurnResult => ({
        message: { id: `e-${Math.random()}`, enabled: true, type: "assistant", content: [{ type: "text", content: "   " }] },
        stats: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
    });
    const model = new StubModel([empty, empty, empty, () => assistantTurn("finally")]);
    const agent = new Agent({ model, agentId: "malformed-test" });
    agent.install(loopControl({ malformed: { enabled: true, strikes: 2 } }));
    await withDriver(agent, async () => {
        agent.messages.push({
            id: "u-1", enabled: true, type: "user", committedAt: Date.now(),
            content: [{ type: "text", content: "go" }],
        });
        agent.input({ type: "__test_kick__" });
        await awaitLanded(agent);
    });
    assert.equal(model.calls.length, 4, "three empties vetoed, fourth committed");
    const assistants = agent.messages.filter((m) => m.type === "assistant");
    assert.equal(assistants.length, 1, "no empty commit pollutes the transcript");
    const texts = userTexts(agent);
    assert.ok(texts.some((t) => t.includes("empty")), "nudge pushed at the strike cap");
});