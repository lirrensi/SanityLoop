// ============================================================================
// tests/core/tool-validation.test.ts — the schema wall + the fixed aggregators.
// ============================================================================
// Three H-fixes proven here:
//   H1  addStats NEVER sums per-call telemetry (tps/latency/timing) — and the
//       agent overlays the LATEST call's values on the session totals.
//   H2  the observer proxy only wraps plain objects/arrays — Map/Set/class
//       instances with #private fields keep working raw.
//   H3  tool arguments are validated against inputSchema BEFORE execute —
//       a model that hallucinates bad args gets invalid_arguments, no crash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, Tool, addStats, emptyStats, validateToolArgs } from "@sanityloop/core";
import type { GodObject, Plugin } from "@sanityloop/core";
import { assistantTurn, callTo, toolCallTurn, StubModel } from "@sanityloop/test-kit/core";
import { awaitIdle } from "@sanityloop/test-kit";
import { seedUserMessage, kick } from "@sanityloop/test-kit/core";

// ---------------------------------------------------------------------------
// H3 — validateToolArgs (pure)
// ---------------------------------------------------------------------------

test("validateToolArgs: empty schema never blocks", () => {
    assert.deepEqual(validateToolArgs(undefined, {}), []);
    assert.deepEqual(validateToolArgs({ type: "object" }, {}), []);
    assert.deepEqual(validateToolArgs({}, { anything: true }), []);
});

test("validateToolArgs: required missing + wrong type + enum", () => {
    const schema = {
        type: "object",
        properties: {
            path: { type: "string" },
            mode: { type: "string", enum: ["open", "pending", "resolved"] },
            count: { type: "integer" },
        },
        required: ["path", "mode"],
    };
    assert.deepEqual(validateToolArgs(schema, { mode: "open", count: 3 }), [
        `missing required property "path"`,
    ]);
    assert.deepEqual(validateToolArgs(schema, { path: "a", mode: "bogus", count: 3 }), [
        `property "mode" must be one of "open", "pending", "resolved"`,
    ]);
    assert.deepEqual(validateToolArgs(schema, { path: "a", mode: "open", count: 1.5 }), [
        `property "count" must be integer`,
    ]);
    assert.deepEqual(validateToolArgs(schema, { path: "a", mode: "open", count: 2 }), []);
});

test("validateToolArgs: additionalProperties false rejects unknowns", () => {
    const schema = {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
    };
    assert.deepEqual(validateToolArgs(schema, { path: "a", sneaky: 1 }), [
        `unknown property "sneaky"`,
    ]);
    assert.deepEqual(validateToolArgs(schema, { path: "a" }), []);
});

test("validateToolArgs: numeric bounds + string lengths + array items", () => {
    const schema = {
        type: "object",
        properties: {
            n: { type: "number", minimum: 1, maximum: 10 },
            s: { type: "string", minLength: 2, maxLength: 4 },
            tags: { type: "array", items: { type: "string" } },
        },
    };
    assert.deepEqual(validateToolArgs(schema, { n: 0 }), [`property "n" is below minimum 1`]);
    assert.deepEqual(validateToolArgs(schema, { n: 11 }), [`property "n" is above maximum 10`]);
    assert.deepEqual(validateToolArgs(schema, { s: "x" }), [`property "s" is shorter than minLength 2`]);
    assert.deepEqual(validateToolArgs(schema, { tags: ["ok", 42] }), [
        `property "tags[1]" must be string`,
    ]);
    assert.deepEqual(validateToolArgs(schema, { n: 5, s: "ab", tags: ["a", "b"] }), []);
});

test("validateToolArgs: non-object params rejected", () => {
    assert.deepEqual(validateToolArgs({ type: "object" }, "nope"), [
        "arguments must be an object",
    ]);
});

// ---------------------------------------------------------------------------
// H3 — bad args through a REAL turn → invalid_arguments, execute never runs
// ---------------------------------------------------------------------------

test("model sends args that violate the schema → invalid_arguments error result", async () => {
    let executed = 0;
    const tool = Tool.define({
        name: "strict",
        description: "requires a string path",
        inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
        },
        async execute() {
            executed++;
            return { answer: "ok" };
        },
    });
    const model = new StubModel([
        () => toolCallTurn([callTo("strict", { nope: 1 }, "call-1")]), // wrong shape entirely
        () => assistantTurn("done"),
    ]);
    const agent = new Agent({ model, tools: [tool], agentId: "strict-test" });
    seedUserMessage(agent, "go");
    kick(agent);
    await awaitIdle(agent);

    const result = [...agent.messages].reverse().find((m) => m.type === "toolResult");
    assert.ok(result);
    assert.equal(executed, 0, "execute never ran for invalid args");
    assert.equal((result as { content: { error: boolean } }).content.error, true);
    assert.match((result as { content: { answer: string } }).content.answer, /Invalid arguments for strict/);
    assert.equal((result as { content: { errorMessage: string } }).content.errorMessage, "invalid_arguments");
});

test("model sends VALID args → schema wall stays quiet, tool runs", async () => {
    let executed = 0;
    const tool = Tool.define({
        name: "strict",
        description: "requires a string path",
        inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
        },
        async execute() {
            executed++;
            return { answer: "ok" };
        },
    });
    const model = new StubModel([
        () => toolCallTurn([callTo("strict", { path: "a.ts" }, "call-1")]),
        () => assistantTurn("done"),
    ]);
    const agent = new Agent({ model, tools: [tool], agentId: "strict-ok-test" });
    seedUserMessage(agent, "go");
    kick(agent);
    await awaitIdle(agent);
    assert.equal(executed, 1);
});

// ---------------------------------------------------------------------------
// H3b — custom `validate` REPLACES the default JSON-Schema wall
// ---------------------------------------------------------------------------

test("custom validate OVERRIDES the wall: loose schema + strict validator → blocked", async () => {
    let executed = 0;
    const tool = Tool.define({
        name: "custom-strict",
        description: "zod-style strictness",
        inputSchema: { type: "object" }, // the wall would let anything through
        validate(params) {
            const p = params as { n?: unknown };
            return typeof p?.n === "number" && p.n > 0 ? [] : [`property "n" must be a positive number`];
        },
        async execute() {
            executed++;
            return { answer: "ok" };
        },
    });
    const model = new StubModel([
        () => toolCallTurn([callTo("custom-strict", { n: -5 }, "call-1")]),
        () => assistantTurn("done"),
    ]);
    const agent = new Agent({ model, tools: [tool], agentId: "custom-strict-test" });
    seedUserMessage(agent, "go");
    kick(agent);
    await awaitIdle(agent);
    assert.equal(executed, 0);
    const result = [...agent.messages].reverse().find((m) => m.type === "toolResult");
    assert.equal((result as { content: { error: boolean } }).content.error, true);
    assert.match((result as { content: { answer: string } }).content.answer, /must be a positive number/);
});

test("custom validate OVERRIDES the wall: strict schema + lenient validator → runs", async () => {
    let executed = 0;
    const tool = Tool.define({
        name: "custom-lenient",
        description: "wants to be lenient despite a strict schema",
        inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
        },
        validate: () => [], // always passes — the wall is replaced, not added
        async execute() {
            executed++;
            return { answer: "ok" };
        },
    });
    const model = new StubModel([
        () => toolCallTurn([callTo("custom-lenient", { path: "a.ts", extra: 1 }, "call-1")]),
        () => assistantTurn("done"),
    ]);
    const agent = new Agent({ model, tools: [tool], agentId: "custom-lenient-test" });
    seedUserMessage(agent, "go");
    kick(agent);
    await awaitIdle(agent);
    assert.equal(executed, 1, "custom validate replaces the wall, so the strict schema never blocks");
});

// ---------------------------------------------------------------------------
// H1 — addStats never sums telemetry; recordStats overlays latest
// ---------------------------------------------------------------------------

test("addStats: per-call telemetry (tps/latency/timing) is NOT summed", () => {
    const totals = emptyStats();
    addStats(totals, {
        input: 10,
        output: 5,
        cacheRead: 1,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0.1, output: 0.05, cacheRead: 0, cacheWrite: 0, total: 0.15 },
        tps: 20,
        latencyMs: 100,
        ttftMs: 50,
    });
    addStats(totals, {
        input: 20,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 30,
        cost: { input: 0.2, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.3 },
        tps: 60,
        latencyMs: 300,
        ttftMs: 90,
    });
    assert.equal(totals.totalTokens, 45, "tokens still sum");
    assert.ok(Math.abs(totals.cost.total - 0.45) < 1e-9, "cost still sums");
    assert.equal(totals.tps, undefined, "tps must NOT sum");
    assert.equal(totals.latencyMs, undefined, "latency must NOT sum");
});

test("recordStats overlays the LATEST call's telemetry on the session totals", async () => {
    const model = new StubModel([
        () => assistantTurn("one", { input: 10, output: 5, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, tps: 20, latencyMs: 100 }),
        () => assistantTurn("two", { input: 20, output: 10, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, tps: 60, latencyMs: 300 }),
    ]);
    const agent = new Agent({ model, agentId: "stats-overlay-test" });
    seedUserMessage(agent, "go");
    kick(agent);
    await awaitIdle(agent); // turn one lands
    seedUserMessage(agent, "second");
    kick(agent);
    await awaitIdle(agent); // turn two lands

    assert.equal(agent.stats.totalTokens, 45, "tokens still sum across turns (15 + 30)");
    assert.equal(agent.stats.tps, 60, "latest tps wins, not a sum");
    assert.equal(agent.stats.latencyMs, 300, "latest latency wins, not a sum");
});

// ---------------------------------------------------------------------------
// H2 — observer only wraps plain objects/arrays; exotic types stay raw
// ---------------------------------------------------------------------------

test("state can hold Map/Set/class-with-private-fields without proxy breakage", async () => {
    const model = new StubModel([
        () => assistantTurn("ok"),
    ]);
    const agent = new Agent({ model, agentId: "proxy-exotic-test" });
    seedUserMessage(agent, "go");
    kick(agent);
    await awaitIdle(agent);

    class Secret {
        #key = "s3cret";
        getKey(): string {
            return this.#key;
        }
    }

    const map = new Map<string, number>([["a", 1]]);
    const set = new Set<string>(["x"]);
    const secret = new Secret();
    const date = new Date("2026-01-01T00:00:00Z");
    agent.setState("map", map);
    agent.setState("set", set);
    agent.setState("secret", secret);
    agent.setState("date", date);

    // The getters go through the observed container — exotics must come back RAW.
    assert.equal((agent.state.map as Map<string, number>).get("a"), 1, "Map methods work");
    assert.equal((agent.state.set as Set<string>).has("x"), true, "Set methods work");
    assert.equal((agent.state.secret as Secret).getKey(), "s3cret", "private fields work");
    assert.equal((agent.state.date as Date).getTime(), date.getTime(), "Date methods work");

    // Plain nested objects still observe + emit patched (the original behavior).
    const seen: unknown[] = [];
    agent.addFilter({
        event: "patched", id: "test/patched", priority: 0,
        fn: async (_a, e) => void seen.push((e as { change?: { path?: string } })?.change?.path),
    });
    agent.setState("plain", { deep: { n: 1 } });
    (agent.state.plain as { deep: { n: number } }).deep.n = 2;
    await new Promise((r) => setTimeout(r, 30)); // let the lane flush
    assert.ok(seen.some((p) => typeof p === "string" && p.includes("deep.n")), "plain nested writes still patch");
});

// ---------------------------------------------------------------------------
// Tool metadata now carries prompt contributions (pi-style)
// ---------------------------------------------------------------------------

test("Tool.define keeps promptSnippet + promptGuidelines", () => {
    const t = Tool.define({
        name: "read",
        description: "d",
        inputSchema: { type: "object" },
        promptSnippet: "Read file contents",
        promptGuidelines: ["Use read instead of cat."],
        async execute() {
            return { answer: "" } as never;
        },
    });
    assert.equal(t.promptSnippet, "Read file contents");
    assert.deepEqual(t.promptGuidelines, ["Use read instead of cat."]);
});

// ---------------------------------------------------------------------------
// #7 — hidden tools: the visibility axis (independent from disabled)
// ---------------------------------------------------------------------------

function visTool(name: string, opts: { disabled?: boolean; hidden?: boolean } = {}) {
    let executed = 0;
    const tool = Tool.define({
        name,
        description: "d",
        inputSchema: { type: "object" },
        disabled: opts.disabled,
        hidden: opts.hidden,
        async execute() {
            executed++;
            return { answer: `${name} ran` };
        },
    });
    return { tool, executed: () => executed };
}

test("visibleTools() excludes hidden tools but keeps visible + disabled ones", () => {
    const { tool: a } = visTool("a");                          // visible + enabled
    const { tool: b } = visTool("b", { disabled: true });      // visible + disabled
    const { tool: c } = visTool("c", { hidden: true });        // hidden + enabled
    const { tool: d } = visTool("d", { hidden: true, disabled: true }); // hidden + disabled
    const agent = new Agent({ model: new StubModel([]), tools: [a, b, c, d], agentId: "vis-test" });
    const names = agent.visibleTools().map((t) => t.name);
    assert.deepEqual(names, ["a", "b"], "hidden tools are NOT on the wire, visible ones are (even disabled)");
});

test("hideTool/showTool flip visibility and fire toolListChanged", () => {
    const { tool: a } = visTool("a");
    const agent = new Agent({ model: new StubModel([]), tools: [a], agentId: "hide-test" });
    const events: unknown[] = [];
    agent.addFilter({
        event: "toolListChanged", id: "test/list-changed", priority: 0,
        fn: async (_a, e) => void events.push(e),
    });
    assert.equal(agent.visibleTools().length, 1);
    assert.equal(agent.hideTool("a"), true);
    assert.deepEqual(agent.visibleTools().map((t) => t.name), [], "hidden after hideTool");
    assert.equal(events.length, 1);
    assert.equal((events[0] as { hidden?: string }).hidden, "a");
    assert.equal(agent.hideTool("a"), true, "idempotent — no event for already-hidden");
    assert.equal(events.length, 1);
    assert.equal(agent.showTool("a"), true);
    assert.deepEqual(agent.visibleTools().map((t) => t.name), ["a"], "back on the wire after showTool");
    assert.equal((events[1] as { shown?: string }).shown, "a");
});

test("a HIDDEN tool still executes when the model calls it by name", async () => {
    const { tool, executed } = visTool("secret", { hidden: true });
    const model = new StubModel([
        () => toolCallTurn([callTo("secret", {}, "h-1")]),
        () => assistantTurn("done"),
    ]);
    const agent = new Agent({ model, tools: [tool], agentId: "hidden-exec" });
    assert.deepEqual(agent.visibleTools().map((t) => t.name), [], "not on the wire");
    seedUserMessage(agent, "go");
    kick(agent);
    await awaitIdle(agent);
    assert.equal(executed(), 1, "hidden + enabled = callable, executes for real");
    const result = [...agent.messages].reverse().find((m) => m.type === "toolResult");
    assert.equal((result as { content: { answer: string } }).content.answer, "secret ran");
});

test("the 2x2 matrix: hidden+disabled is dormant (not callable), visible+disabled stays in context but skipped", async () => {
    const { tool: dorm, executed: dormRan } = visTool("dormant", { hidden: true, disabled: true });
    const model = new StubModel([
        () => toolCallTurn([callTo("dormant", {}, "d-1")]),
        () => assistantTurn("done"),
    ]);
    const agent = new Agent({ model, tools: [dorm], agentId: "matrix-test" });
    assert.deepEqual(agent.visibleTools().map((t) => t.name), [], "dormant is hidden");
    seedUserMessage(agent, "go");
    kick(agent);
    await awaitIdle(agent);
    assert.equal(dormRan(), 0, "hidden+disabled: execute is skipped — the disabled axis wins");
    const result = [...agent.messages].reverse().find((m) => m.type === "toolResult");
    assert.equal((result as { content: { error: boolean } }).content.error, true);
    assert.match((result as { content: { answer: string } }).content.answer, /currently disabled/);
});

test("updateTool can set hidden on the fly", () => {
    const { tool: a } = visTool("a");
    const agent = new Agent({ model: new StubModel([]), tools: [a], agentId: "update-hidden" });
    assert.equal(agent.visibleTools().length, 1);
    assert.equal(agent.updateTool("a", { hidden: true }), true);
    assert.deepEqual(agent.visibleTools().map((t) => t.name), []);
    assert.equal(agent.updateTool("a", { hidden: false }), true);
    assert.deepEqual(agent.visibleTools().map((t) => t.name), ["a"]);
});

// ---------------------------------------------------------------------------
// M5 — async install: awaitable, but sync plugins stay synchronous
// ---------------------------------------------------------------------------

test("install() keeps SYNC plugins synchronous (no await needed)", () => {
    const agent = new Agent({ model: new StubModel([]), agentId: "sync-install" });
    let registered = false;
    const plugin: Plugin = {
        id: "sync-plugin",
        install: () => {
            registered = true;
        },
        uninstall() {},
    };
    void agent.install(plugin);
    assert.equal(registered, true, "sync step ran synchronously");
    assert.ok(agent.plugins.some((x) => x.id === "sync-plugin"), "plugin tracked synchronously");
});

test("install() AWAITS async plugin steps — plugin tracked only after resolve", async () => {
    const agent = new Agent({ model: new StubModel([]), agentId: "async-install" });
    let registered = false;
    let settled = 0;
    const plugin: Plugin = {
        id: "async-plugin",
        install: async () => {
            await new Promise((r) => setTimeout(r, 20));
            settled++;
            registered = true;
        },
        uninstall() {},
    };
    const p = agent.install(plugin);
    assert.equal(settled, 0, "async step still running — not awaited yet");
    await p;
    assert.equal(settled, 1);
    assert.equal(registered, true, "registered after the async step resolved");
    assert.ok(agent.plugins.some((x) => x.id === "async-plugin"));
});

test("install() awaits a rejected async step — plugin NOT tracked (fail-fast)", async () => {
    const agent = new Agent({ model: new StubModel([]), agentId: "async-fail" });
    const plugin: Plugin = {
        id: "async-fail-plugin",
        install: async () => {
            await new Promise((r) => setTimeout(r, 5));
            throw new Error("server on fire");
        },
        uninstall() {},
    };
    await assert.rejects(agent.install(plugin), /server on fire/);
    assert.ok(!agent.plugins.some((x) => x.id === "async-fail-plugin"), "not tracked after failure");
});

// ---------------------------------------------------------------------------
// M2 — cycleDiscarded event (the spin-guard's signal)
// ---------------------------------------------------------------------------

test("cycleDiscarded fires when a filter vetoes a cycle (endCycle)", async () => {
    const model = new StubModel([
        () => assistantTurn("one"),
        () => assistantTurn("two"),
    ]);
    const agent = new Agent({ model, agentId: "discard-test" });
    const seen: string[] = [];
    agent.addFilter({
        event: "cycleDiscarded", id: "test/see", priority: 0,
        fn: async () => void seen.push("discarded"),
    });
    let vetoes = 0;
    agent.addFilter({
        event: "afterProviderResponse", id: "test/veto", priority: 0,
        fn: async (a) => {
            if (vetoes++ === 0) a.endCycle(); // veto ONCE, then let it commit
        },
    });
    seedUserMessage(agent, "go");
    kick(agent);
    await awaitIdle(agent);
    assert.deepEqual(seen, ["discarded"], "exactly one discarded cycle fired");
    assert.equal(agent.loopState, "idle");
});

// ---------------------------------------------------------------------------
// L1 — hasWork reflects wakeRequested
// ---------------------------------------------------------------------------

test("hasWork includes wakeRequested (a wake is work)", () => {
    const agent = new Agent({ model: new StubModel([]), agentId: "haswork-test" });
    assert.equal(agent.hasWork, false, "empty idle agent has no work");
    agent.wake();
    assert.equal(agent.hasWork, true, "wakeRequested is work — the machine is about to move");
});

// ---------------------------------------------------------------------------
// M6 — published events mutate transient in place (no full-object spread)
// ---------------------------------------------------------------------------

test("published events land as transient.currentEvent via an in-place set", async () => {
    const agent = new Agent({ model: new StubModel([() => assistantTurn("hi")]), agentId: "transient-test" });
    const paths: string[] = [];
    agent.addFilter({
        event: "patched", id: "test/patched", priority: 0,
        fn: async (_a, e) => {
            const p = (e as { change?: { path?: string } }).change?.path;
            if (p) paths.push(p);
        },
    });
    seedUserMessage(agent, "go");
    kick(agent);
    await awaitIdle(agent);
    assert.ok(
        paths.some((p) => p === "transient.currentEvent"),
        "in-place set on the proxied transient fires the same patched event",
    );
    // the transient still holds the last published event payload
    assert.ok(
        agent.transient.currentEvent && typeof (agent.transient.currentEvent as { type?: string }).type === "string",
        "transient keeps the last published event",
    );
});