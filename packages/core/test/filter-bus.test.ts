// ============================================================================
// tests/core/filter-bus.test.ts — the WordPress-style awaited bus.
// ============================================================================
// Covers: registration, priority order (lower first), async chains AWAITED
// end-to-end, duplicate-id rejection across ALL events, throw = skip +
// handlerError {error, filterId, event} + queue survives, child dispatch
// semantics, disable/enable/remove lifecycles, and SEALED-PHASE DEFERRAL
// (toolUpdate / toolListChanged held mid-batch → drained at the seam).

import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, EVENTS } from "@sanityloop/core";
import type { Tool } from "@sanityloop/core";
import { assistantTurn, callTo, flatStats, toolCallTurn, StubModel } from "@sanityloop/test-kit/core";
import { awaitIdle, sleep } from "@sanityloop/test-kit";
import { seedUserMessage, kick } from "@sanityloop/test-kit/core";

function busAgent() {
    const model = new StubModel([]); // never called in pure-bus tests
    return new Agent({ model, agentId: "bus-test" });
}

// ---------------------------------------------------------------------------
// Registration + ordering
// ---------------------------------------------------------------------------

test("filters register into the registry and run by priority (lower first)", async () => {
    const agent = busAgent();
    const order: string[] = [];
    agent.addFilter({ event: "t/ord", id: "b", priority: 10, fn: async () => void order.push("b") });
    agent.addFilter({ event: "t/ord", id: "a", priority: -5, fn: async () => void order.push("a") });
    agent.addFilter({ event: "t/ord", id: "c", priority: 0, fn: async () => void order.push("c") });

    // registry chain sorted by priority regardless of insertion order
    const chain = agent.bus.registrySnapshot().get("t/ord")!.map((f) => f.id);
    assert.deepEqual(chain, ["a", "c", "b"]);

    await agent.bus.runFromRegistry("t/ord");
    assert.deepEqual(order, ["a", "c", "b"]);
});

test("async chains are AWAITED end-to-end — a slow filter delays its successors", async () => {
    const agent = busAgent();
    const order: string[] = [];
    let slowDone = false;
    agent.addFilter({
        event: "t/slow", id: "slow", priority: 0,
        fn: async () => {
            await sleep(40);
            order.push("slow");
            slowDone = true;
        },
    });
    agent.addFilter({
        event: "t/slow", id: "after-slow", priority: 1,
        fn: async () => {
            order.push("after");
            assert.ok(slowDone, "successor must not start before the slow filter settles");
        },
    });
    await agent.bus.runFromRegistry("t/slow");
    assert.deepEqual(order, ["slow", "after"]);
});

test("duplicate filter id is rejected ACROSS events (ids unique everywhere)", () => {
    const agent = busAgent();
    agent.addFilter({ event: "t/x1", id: "dup", priority: 0, fn: async () => {} });
    assert.throws(
        () => agent.addFilter({ event: "t/x2", id: "dup", priority: 0, fn: async () => {} }),
        /already registered/,
    );
    // same event too
    assert.throws(
        () => agent.addFilter({ event: "t/x1", id: "dup", priority: 5, fn: async () => {} }),
        /already registered/,
    );
});

// ---------------------------------------------------------------------------
// Throw isolation + handlerError
// ---------------------------------------------------------------------------

test("a throwing filter is skipped, fires handlerError {error, filterId, event}, queue survives", async () => {
    const agent = busAgent();
    const caught: unknown[] = [];
    const ran: string[] = [];
    agent.addFilter({
        event: EVENTS.handlerError, id: "catch",
        fn: async (_a, e) => {
            if (e?.event === "t/boom") caught.push({ filterId: e.filterId, error: e.error });
        },
    });
    agent.addFilter({
        event: "t/boom", id: "thrower", priority: 0,
        fn: async () => {
            throw new Error("kaboom-42");
        },
    });
    agent.addFilter({ event: "t/boom", id: "survivor", priority: 1, fn: async () => void ran.push("yes") });

    await agent.bus.runFromRegistry("t/boom"); // NEVER rejects
    await sleep(20); // handlerError rides a floating registry dispatch — give it a beat

    assert.equal(caught.length, 1);
    assert.equal((caught[0] as { filterId: string }).filterId, "thrower");
    assert.ok((caught[0] as { error: Error }).error instanceof Error);
    assert.equal((caught[0] as { error: Error }).error.message, "kaboom-42");
    assert.deepEqual(ran, ["yes"], "the next sibling still runs after a thrower");
});

test("remove / disable / enable — three lifetimes, three behaviors", async () => {
    const agent = busAgent();
    const hits: string[] = [];
    agent.addFilter({ event: "t/life", id: "f1", priority: 0, fn: async () => void hits.push("f1") });

    assert.equal(agent.disableFilter("t/life", "f1"), true);
    await agent.bus.runFromRegistry("t/life"); // disabled → skipped even on the registry lane
    assert.deepEqual(hits, []);

    assert.equal(agent.enableFilter("t/life", "f1"), true);
    await agent.bus.runFromRegistry("t/life");
    assert.deepEqual(hits, ["f1"]);

    assert.equal(agent.removeFilter("t/life", "f1"), true);
    assert.equal(agent.removeFilter("t/life", "f1"), false); // gone from the record
    assert.equal(agent.filters.length, 0);
    assert.equal(agent.bus.has("t/life"), false);
});

// ---------------------------------------------------------------------------
// Child dispatch (events fired inside a filter)
// ---------------------------------------------------------------------------

test("an event fired inside a filter reaches its listeners inline (child dispatch)", async () => {
    const agent = busAgent();
    const order: string[] = [];
    agent.addFilter({
        event: "t/parent", id: "p1", priority: 0,
        fn: async (a) => {
            order.push("p1-start");
            a.emit("t/child", {});
            order.push("p1-end");
        },
    });
    agent.addFilter({
        event: "t/child", id: "c1", priority: 0,
        fn: async () => void order.push("CHILD"),
    });
    await agent.bus.runFromRegistry("t/parent");
    // The child's synchronous prefix runs INSIDE p1's body (emit → registry
    // dispatch starts immediately) — depth-first-flavored nesting.
    assert.deepEqual(order, ["p1-start", "CHILD", "p1-end"]);
});

test("CURRENT SEMANTICS: an ASYNC child does NOT block the next sibling (doc says it should)", async () => {
    // docs/architecture/core.md claims children are fully drained before the
    // next sibling. The bus has the machinery (spawned queue) but nothing ever
    // populates it, so an awaiting child races the sibling. This test PINS the
    // real behavior — if core ever implements true depth-first draining, this
    // assertion flips, and that is a headline, not a failure.
    const agent = busAgent();
    const order: string[] = [];
    agent.addFilter({
        event: "t/p2", id: "p2", priority: 0,
        fn: async (a) => {
            a.emit("t/c2", {});
            order.push("sibling-after-emit");
        },
    });
    agent.addFilter({
        event: "t/p2", id: "p3", priority: 1,
        fn: async () => {
            await sleep(10);
            order.push("next-sibling");
        },
    });
    agent.addFilter({
        event: "t/c2", id: "c2", priority: 0,
        fn: async () => {
            await sleep(30); // slower than everything
            order.push("async-child-done");
        },
    });
    await agent.bus.runFromRegistry("t/p2");
    await sleep(60); // let the floating child finish
    assert.equal(order.indexOf("async-child-done"), order.length - 1, "child eventually completes");
    assert.ok(
        order.indexOf("next-sibling") < order.indexOf("async-child-done"),
        `sibling overtook the awaiting child: [${order.join(", ")}]`,
    );
});

// ---------------------------------------------------------------------------
// Sealed-phase deferral — THE LANE (behavioral; the whitelist is private)
// ---------------------------------------------------------------------------

test("SEALED LANE: toolUpdate fired DURING the tool batch defers to the seam", async () => {
    const marks: string[] = [];
    const tool: Tool = {
        name: "mutator",
        description: "updates itself mid-run",
        inputSchema: { type: "object" },
        async execute(_params, agent) {
            agent.updateTool("mutator", { description: "updated MID-BATCH" });
            return { answer: "ran" };
        },
    };
    const model = new StubModel([
        () => toolCallTurn([callTo("mutator", {})]),
        () => assistantTurn("landed"),
    ]);
    const agent = new Agent({ model, tools: [tool], agentId: "lane-test" });

    let batchDone = false;
    agent.addFilter({
        event: EVENTS.toolUpdate, id: "watch-update", priority: 0,
        fn: async () => marks.push(batchDone ? "delivered-after-seam" : "delivered-mid-batch"),
    });
    agent.addFilter({
        event: EVENTS.cycleEnd, id: "mark-seam", priority: -1000, // runs BEFORE other cycleEnd work
        fn: async () => void (batchDone = true),
    });

    seedUserMessage(agent, "go");
    kick(agent);
    await awaitIdle(agent);

    assert.deepEqual(marks, ["delivered-after-seam"],
        "toolUpdate fired while sealed must be HELD, then delivered after toolResults commit");
    assert.equal(tool.description, "updated MID-BATCH", "the definition change itself applied immediately");
});

test("SEALED LANE: toolListChanged (addTool mid-batch) defers too", async () => {
    const marks: string[] = [];
    const tool: Tool = {
        name: "spawner",
        description: "adds a tool mid-run",
        inputSchema: { type: "object" },
        async execute(_params, agent) {
            agent.addTool({
                name: "spawned",
                description: "born during the batch",
                inputSchema: { type: "object" },
                execute: async () => ({ answer: "unused" }),
            });
            return { answer: "ran" };
        },
    };
    const model = new StubModel([
        () => toolCallTurn([callTo("spawner", {})]),
        () => assistantTurn("landed"),
    ]);
    const agent = new Agent({ model, tools: [tool], agentId: "lane-test-2" });

    let batchDone = false;
    agent.addFilter({
        event: EVENTS.toolListChanged, id: "watch-list", priority: 0,
        fn: async () => marks.push(batchDone ? "after-seam" : "mid-batch"),
    });
    agent.addFilter({
        event: EVENTS.cycleEnd, id: "mark-seam", priority: -1000,
        fn: async () => void (batchDone = true),
    });

    seedUserMessage(agent, "go");
    kick(agent);
    await awaitIdle(agent);

    assert.deepEqual(marks, ["after-seam"]);
    assert.ok(agent.tools.some((t) => t.name === "spawned"));
});

test("outside the batch the SAME events deliver immediately (no lane when unsealed)", async () => {
    const marks: string[] = [];
    const model = new StubModel([]);
    const agent = new Agent({ model, agentId: "unsealed" });
    agent.addFilter({
        event: EVENTS.toolUpdate, id: "watch-update", priority: 0,
        fn: async () => void marks.push("update"),
    });
    agent.addFilter({
        event: EVENTS.toolListChanged, id: "watch-list", priority: 0,
        fn: async () => void marks.push("list"),
    });
    // addTool fires toolListChanged immediately; updateTool fires toolUpdate immediately
    agent.addTool({ name: "plain", description: "d", inputSchema: { type: "object" }, execute: async () => ({ answer: "x" }) });
    agent.updateTool("plain", { description: "d2" });
    assert.deepEqual(marks, ["list", "update"]);
});

// ---------------------------------------------------------------------------
// Cycle queues vs registry — two dispatch paths
// ---------------------------------------------------------------------------

test("cycle queues rebuild fresh each cycle minus disabled filters (beginCycle/endCycle)", async () => {
    const agent = busAgent();
    const hits: number[] = [];
    agent.addFilter({ event: "t/cyc", id: "cf", priority: 0, fn: async () => void hits.push(1) });

    // no cycle open → bus.run uses EMPTY cycle queues (registry untouched)
    await agent.bus.run("t/cyc");
    assert.deepEqual(hits, [], "cycle lane is silent with no open cycle");

    agent.bus.beginCycle();
    await agent.bus.run("t/cyc");
    assert.equal(hits.length, 1, "cycle lane runs after beginCycle");

    agent.disableFilter("t/cyc", "cf");
    agent.bus.beginCycle(); // rebuilt WITHOUT disabled
    await agent.bus.run("t/cyc");
    assert.equal(hits.length, 1, "disabled filters stay out of rebuilt queues");

    agent.bus.endCycle();
    assert.equal(agent.bus.queueFor("t/cyc").length, 0, "endCycle clears the queues");
});
