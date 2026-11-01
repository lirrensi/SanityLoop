// ============================================================================
// tests/extras/subagents.test.ts — @sanityloop/subagents: THE STUPID TOOL.
// ============================================================================
// A sub-agent is an Agent nobody ran yet. agentAsTool(builder) per call:
// invoke builder → fresh pristine agent (FULL ritual: installs, filters) →
// run → land → collect final assistant text → terminate → { answer }.
//
// Proven here: freshness per call, ritual carried, loud refusals
// (non-Agent / same-instance), timeout path over a parked sub, and the whole
// thing working INSIDE a real parent loop as a plain tool.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, EVENTS } from "@sanityloop/core";
import { agentAsTool, createSubAgents, fork, runOnce, runUntilSettled, sideCall, textMessage, collectFinalAnswer } from "@sanityloop/subagents";
import {
    StubModel,
    assistantTurn,
    callTo,
    makeAgent,
    seedUserMessage,
    toolCallTurn,
} from "@sanityloop/test-kit/core";
import { awaitLanded, sleep, waitUntil } from "@sanityloop/test-kit";

function buildSub(script: Array<() => ReturnType<typeof assistantTurn>>, decorate?: (a: Agent) => void): {
    toolFactory: () => Agent;
    created: Agent[];
} {
    const created: Agent[] = [];
    return {
        created,
        toolFactory: () => {
            const a = new Agent({ model: new StubModel(script.slice()) });
            decorate?.(a);
            created.push(a);
            return a;
        },
    };
}

test("one-off: fresh build → run → collect final → terminate", async () => {
    const { toolFactory, created } = buildSub([() => assistantTurn("the final word")]);
    const tool = agentAsTool({ name: "researcher", description: "digs things up", agent: toolFactory });

    const res = await tool.execute({ prompt: "find me the truth" }, {} as never);
    assert.equal(res.error, undefined);
    assert.equal(res.answer, "the final word");
    assert.equal(created.length, 1);
    assert.equal(created[0].loopState, "terminated", "heart stopped after the one call");
    assert.ok(
        (res.stored as { subId: string }).subId === created[0].id,
        "stored carries the sub's identity",
    );
});

test("fresh brain per call: no history bleed between invocations", async () => {
    // each builder invocation gets ITS OWN one-turn script — like real life
    let n = 0;
    const created: Agent[] = [];
    const tool = agentAsTool({
        name: "critic",
        description: "tears drafts apart",
        agent: () => {
            n++;
            const a = new Agent({
                model: new StubModel([() => assistantTurn(n === 1 ? "first answer" : "second answer")]),
            });
            created.push(a);
            return a;
        },
    });

    const r1 = await tool.execute({ prompt: "call one" }, {} as never);
    const r2 = await tool.execute({ prompt: "call two" }, {} as never);

    assert.equal(r1.answer, "first answer");
    assert.equal(r2.answer, "second answer");
    assert.notEqual(created[0], created[1], "two distinct instances");
    assert.equal(created[0].loopState, "terminated");
    assert.equal(created[1].loopState, "terminated");
    assert.equal(created[1].messages.length, 2, "only its own user+assistant — zero bleed");
});

test("the ritual carries: installs and filters declared in the builder RUN inside the sub", async () => {
    const { toolFactory, created } = buildSub([() => assistantTurn("ok")], (a) => {
        // EXACTLY like decorating the boss — plugins/hooks/filters, everything.
        a.addFilter({
            event: EVENTS.turnStart,
            id: "test/ritual-mark",
            priority: 0,
            fn: async (agent) => {
                agent.setState("ritualMarked", true);
            },
        });
        a.addDeclaredCapability({ id: "test/cap", description: "declared inside the builder" });
    });
    const tool = agentAsTool({ name: "marked", description: "proves the ritual", agent: toolFactory });

    const res = await tool.execute({ prompt: "go" }, {} as never);
    assert.equal(res.error, undefined);
    assert.equal(created[0].state["ritualMarked"], true, "filter fired inside the sub");
    assert.ok(
        created[0].getDeclaredCapability("test/cap"),
        "declared registries carried too",
    );
});

test("loud refusals: non-Agent return and same-instance reuse both error honestly", async () => {
    const bad = agentAsTool({
        name: "bad",
        description: "returns garbage",
        agent: (() => ({}) as never) as never,
    });
    const badRes = await bad.execute({ prompt: "x" }, {} as never);
    assert.equal(badRes.error, true);
    assert.match(badRes.answer!, /instead of an Agent instance/);

    let shared: Agent | undefined;
    const sneaky = agentAsTool({
        name: "sneaky",
        description: "reuses its instance",
        agent: () => (shared ??= new Agent({ model: new StubModel([() => assistantTurn("only once")]) })),
    });
    const first = await sneaky.execute({ prompt: "a" }, {} as never);
    assert.equal(first.error, undefined, "first call is fine");
    const second = await sneaky.execute({ prompt: "b" }, {} as never);
    assert.equal(second.error, true);
    assert.match(second.answer!, /SAME agent instance/, "reuse refused loudly, no silent history bleed");
});

test("timeout GRACEFUL (shorthand number): parked sub escalates stop→abort, gets reaped, reported", async () => {
    const created: Agent[] = [];
    const tool = agentAsTool({
        name: "sleepy",
        description: "parks forever",
        timeout: 200, // bare number = graceful, graceMs default 2000
        agent: () => {
            const a = new Agent({ model: new StubModel([() => assistantTurn("never reached")]) });
            a.addFilter({
                event: EVENTS.beforeProviderRequest,
                id: "test/park-forever",
                priority: 0,
                fn: async (agent) => {
                    agent.park({ type: "test/forever" }); // BREAKPOINT #1 wall — parks the worker
                },
            });
            created.push(a);
            return a;
        },
    });

    const res = await tool.execute({ prompt: "wake me inside" }, {} as never);
    assert.equal(res.error, true, "parked sub produces nothing — even graceful returns an error");
    assert.match(res.answer!, /timed out after 200ms \(graceful\)/);
    assert.equal(created[0].loopState, "terminated", "even the parked corpse gets reaped");
});

test("timeout HARD: oblivion at the deadline — fast, pure error, no leftovers", async () => {
    const created: Agent[] = [];
    const tool = agentAsTool({
        name: "obliviator",
        description: "parks forever too",
        timeout: { ms: 150, mode: "hard" },
        agent: () => {
            const a = new Agent({ model: new StubModel([() => assistantTurn("never reached")]) });
            a.addFilter({
                event: EVENTS.beforeProviderRequest,
                id: "test/park-forever",
                priority: 0,
                fn: async (agent) => {
                    agent.park({ type: "test/forever" });
                },
            });
            created.push(a);
            return a;
        },
    });

    const res = await tool.execute({ prompt: "vanish" }, {} as never);
    assert.equal(res.error, true);
    assert.match(res.answer!, /timed out after 150ms \(hard\)/);
    assert.equal((res.stored as { timeoutMode?: string }).timeoutMode, "hard");
    assert.equal(created[0].loopState, "terminated");
});

test("timeout GRACEFUL harvest: a sub that already answered once gets its crumb delivered", async () => {
    const created: Agent[] = [];
    const tool = agentAsTool({
        name: "almost_done",
        description: "answers turn one, then parks on turn two",
        timeout: { ms: 300, mode: "graceful", graceMs: 100 },
        agent: () => {
            const a = new Agent({
                model: new StubModel([
                    () => assistantTurn("partial gold"), // turn ONE completes
                    () => assistantTurn("never reached"), // turn TWO never gets there
                ]),
            });
            // after the landing of turn one, inject MORE work → a second turn starts…
            a.addFilter({
                event: EVENTS.stop,
                id: "test/one-more-turn",
                priority: 0,
                fn: async (agent) => {
                    if (!agent.hasWork && agent.messages.length < 5) {
                        agent.messages.push({
                            id: `user-${crypto.randomUUID().slice(0, 8)}`,
                            enabled: true,
                            type: "user",
                            committedAt: Date.now(),
                            content: [{ type: "text", content: "again!" }],
                        });
                    }
                },
            });
            // …and that second turn parks at the provider wall forever.
            a.addFilter({
                event: EVENTS.beforeProviderRequest,
                id: "test/park-turn-two",
                priority: 0,
                fn: async (agent) => {
                    if (agent.messages.length >= 3) agent.park({ type: "test/forever" });
                },
            });
            created.push(a);
            return a;
        },
    });

    const res = await tool.execute({ prompt: "start" }, {} as never);
    assert.equal(res.error, undefined, "graceful harvest delivers the last completed answer");
    assert.equal(res.answer, "partial gold");
    const stored = res.stored as { timedOut?: boolean; timeoutMode?: string };
    assert.equal(stored.timedOut, true, "the crumb is flagged as a timeout survivor");
    assert.equal(stored.timeoutMode, "graceful");
    assert.equal(created[0].loopState, "terminated");
});

test("END-TO-END: the sub tool works inside a REAL parent loop as a plain tool", async () => {
    const subTool = agentAsTool({
        name: "researcher",
        description: "answers research questions",
        agent: () => new Agent({ model: new StubModel([() => assistantTurn("42, obviously")]) }),
    });

    const { agent: parent } = makeAgent({
        script: [
            () => toolCallTurn([callTo("researcher", { prompt: "meaning of life?" })]),
            () => assistantTurn("parent done"),
        ],
        tools: [subTool],
    });
seedUserMessage(parent, "consult the researcher then finish");

    void parent.run(); // pre-seeded — run() sees the message as owed work immediately
    await awaitLanded(parent);

    const toolResult = parent.messages.find((m) => m.type === "toolResult") as
        | { content: { answer?: string; error?: boolean } }
        | undefined;
    assert.ok(toolResult, "parent committed a tool result");
    assert.equal(toolResult.content.error, undefined);
    assert.equal(toolResult.content.answer, "42, obviously", "the sub's final flowed into the parent");
});

// ============================================================================
// MODE 2 — THE AGENT-MANAGER: persistent sub-agents + spawn/await/steer/list.
// ============================================================================

test("manager: sync spawn returns the reply AND the sub STAYS ALIVE", async () => {
    const mgr = createSubAgents({
        subs: [
            {
                id: "worker",
                description: "does things",
                build: () => new Agent({ model: new StubModel([() => assistantTurn("one done")]) }),
            },
        ],
    });
    const res = await mgr.tools["spawn"].execute({ sub: "worker", text: "job one" }, {} as never);
    assert.equal(res.error, undefined);
    assert.equal(res.answer, "one done");
    const inst = mgr.instances().find((i) => i.id === "worker-1");
    assert.ok(inst, "instance registered");
    assert.equal(inst.state, "idle", "alive, not terminated — persistence doctrine");
});

test("manager: steer continues the SAME brain; await collects; transcripts accumulate", async () => {
    const mgr = createSubAgents({
        subs: [
            {
                id: "chatty",
                description: "remembers",
                build: () =>
                    new Agent({
                        model: new StubModel([
                            () => assistantTurn("hello v1"),
                            () => assistantTurn("hello v2"),
                        ]),
                    }),
            },
        ],
    });
    const first = await mgr.tools["spawn"].execute({ sub: "chatty", text: "one" }, {} as never);
    assert.equal(first.answer, "hello v1");
    const steerRes = await mgr.tools["steer"].execute({ id: "chatty-1", text: "two" }, {} as never);
    assert.match(steerRes.answer!, /kickstart|inserted|live/);
const awaited = await mgr.tools["await"].execute({ id: "chatty-1" }, {} as never);
    assert.match(awaited.answer!, /hello v2/, "same instance, continued brain");
    const inst = mgr.instances()[0];
    assert.equal(inst.state, "idle");
});

test("manager: background spawn + concurrency queue + await-all", async () => {
    const slowTool = {
        name: "slow",
        description: "takes time",
        inputSchema: { type: "object" },
        executionMode: "sequential",
        execute: async () => {
            await sleep(120);
            return { answer: "slow done" };
        },
    };
    const mgr = createSubAgents({
        concurrency: 1,
        subs: [
            {
                id: "slug",
                description: "slow worker",
                build: () =>
                    new Agent({
                        model: new StubModel([
                            () => toolCallTurn([callTo("slow", {})]),
                            () => assistantTurn("A finished"),
                        ]),
                        tools: [slowTool],
                    }),
            },
            {
                id: "fast",
                description: "quick worker",
                build: () => new Agent({ model: new StubModel([() => assistantTurn("B finished")]) }),
            },
        ],
    });
    const r1 = await mgr.tools["spawn"].execute({ sub: "slug", text: "a", background: true }, {} as never);
    assert.match(r1.answer!, /Started slug-1/);
    const r2 = await mgr.tools["spawn"].execute({ sub: "fast", text: "b", background: true }, {} as never);
    assert.match(r2.answer!, /Queued fast-1/, "concurrency 1 → second background spawn is queued");
    const all = await mgr.tools["await"].execute({}, {} as never);
    assert.equal(all.error, undefined);
    assert.match(all.answer!, /A finished/);
    assert.match(all.answer!, /B finished/);
});

test("manager: ESCALATE — child gate proxies onto parent as subagents/pending, answered via subagents/answer", async () => {
    const parent = new Agent({ model: new StubModel([]) });
    const mgr = createSubAgents({
        onPending: "escalate",
        answerBuilders: {
            "test/gate": (item, raw) => ({
                type: "gate-answer",
                ref: item.id!,
                approved: (raw as { approved?: boolean }).approved,
            }),
        },
        subs: [
            {
                id: "gated",
                description: "needs approval",
build: () => {
                    const a = new Agent({ model: new StubModel([() => assistantTurn("post-gate gold")]) });
                    let resolved = false; // real gates latch via preResolve — mirror the discipline
                    a.addFilter({
                        event: EVENTS.beforeProviderRequest,
                        id: "test/gate-park",
                        priority: 0,
                        fn: async (ag) => {
                            if (resolved) return;
                            if (!ag.pendingAwaits.some((w) => w.id === "gate-1")) {
                                ag.pendingAwaits.push({ type: "test/gate", id: "gate-1", schema: null });
                            }
                        },
                    });
                    a.addFilter({
                        event: EVENTS.inputReceived,
                        id: "test/gate-resolve",
                        priority: 100,
                        fn: async (ag) => {
                            const input = ag.currentInput as { type?: string; ref?: string };
                            if (input?.type !== "gate-answer" || input.ref !== "gate-1") return;
                            resolved = true;
                            const idx = ag.pendingAwaits.findIndex((w) => w.id === "gate-1");
                            if (idx !== -1) ag.pendingAwaits.splice(idx, 1);
                        },
                    });
                    return a;
                },
            },
        ],
    });
    parent.install(mgr);
    void parent.run({ startState: "idle" });

    await mgr.tools["spawn"].execute({ sub: "gated", text: "dangerous thing", background: true }, {} as never);
    await waitUntil(() => parent.pendingAwaits.some((w) => w.type === "subagents/pending"), {
        what: "child gate proxied onto parent",
    });
    const proxy = parent.pendingAwaits.find((w) => w.type === "subagents/pending")!;
    assert.match(proxy.id, /^sub:gated-1:/, "proxy id routes home");
    assert.notEqual(proxy.type, "test/gate", "THE LAW: native type never crosses the border");

    parent.input({ type: "subagents/answer", id: proxy.id, approved: true });
    await waitUntil(() => parent.pendingAwaits.length === 0, {
        what: "proxy released after the answer flowed down",
    });
    const collected = await mgr.tools["await"].execute({ id: "gated-1" }, {} as never);
    assert.match(collected.answer!, /post-gate gold/);
});

test("manager: AUTO — the decide fn answers silently, parent never touched", async () => {
    const parent = new Agent({ model: new StubModel([]) });
    const mgr = createSubAgents({
        onPending: async (_subId, item) => ({
            type: "gate-answer",
            ref: item.id!,
            approved: true,
        }),
        subs: [
            {
                id: "gated",
                description: "auto-approved",
build: () => {
                    const a = new Agent({ model: new StubModel([() => assistantTurn("auto gold")]) });
                    let resolved = false;
                    a.addFilter({
                        event: EVENTS.beforeProviderRequest,
                        id: "test/gate-park",
                        priority: 0,
                        fn: async (ag) => {
                            if (resolved) return;
                            if (!ag.pendingAwaits.some((w) => w.id === "gate-2")) {
                                ag.pendingAwaits.push({ type: "test/gate", id: "gate-2", schema: null });
                            }
                        },
                    });
                    a.addFilter({
                        event: EVENTS.inputReceived,
                        id: "test/gate-resolve",
                        priority: 100,
                        fn: async (ag) => {
                            const input = ag.currentInput as { type?: string; ref?: string };
                            if (input?.type !== "gate-answer" || input.ref !== "gate-2") return;
                            resolved = true;
                            const idx = ag.pendingAwaits.findIndex((w) => w.id === "gate-2");
                            if (idx !== -1) ag.pendingAwaits.splice(idx, 1);
                        },
                    });
                    return a;
                },
            },
        ],
    });
    parent.install(mgr);
    void parent.run({ startState: "idle" });

    await mgr.tools["spawn"].execute({ sub: "gated", text: "x", background: true }, {} as never);
    await waitUntil(() => {
        const i = mgr.instances().find((x) => x.id === "gated-1");
        return i !== undefined && i.state === "idle";
    }, { what: "auto-decided sub to land idle" });
    assert.equal(parent.pendingAwaits.length, 0, "parent was never blocked — nobody saw anything");
    const collected = await mgr.tools["await"].execute({ id: "gated-1" }, {} as never);
    assert.match(collected.answer!, /auto gold/);
});

test("manager: steer stop freezes, terminate kills, double-intent refuses", async () => {
    const mgr = createSubAgents({
        subs: [
            {
                id: "target",
                description: "receives commands",
                build: () => new Agent({ model: new StubModel([() => assistantTurn("x")]) }),
            },
        ],
    });
    await mgr.tools["spawn"].execute({ sub: "target", text: "go" }, {} as never);
    assert.equal(mgr.instances()[0].state, "idle");

    const stopRes = await mgr.tools["steer"].execute({ id: "target-1", stop: true }, {} as never);
    assert.match(stopRes.answer!, /stopped gently/);

    const bothRes = await mgr.tools["steer"].execute(
        { id: "target-1", text: "hi", stop: true },
        {} as never,
    );
    assert.equal(bothRes.error, true);
    assert.match(bothRes.answer!, /exactly one intent/);

    const killRes = await mgr.tools["steer"].execute({ id: "target-1", terminate: true }, {} as never);
    assert.match(killRes.answer!, /terminated/);
    assert.equal(mgr.instances()[0].state, "terminated");
});

test("manager: list paints the family portrait with snippets", async () => {
    const mgr = createSubAgents({
        subs: [
            {
                id: "a",
                description: "alpha",
                build: () => new Agent({ model: new StubModel([() => assistantTurn("alpha reply")]) }),
            },
            {
                id: "b",
                description: "beta",
                build: () => new Agent({ model: new StubModel([() => assistantTurn("beta reply")]) }),
            },
        ],
    });
    await mgr.tools["spawn"].execute({ sub: "a", text: "go" }, {} as never);
    await mgr.tools["spawn"].execute({ sub: "b", text: "go", background: true }, {} as never);
    const list = await mgr.tools["list"].execute({}, {} as never);
    assert.match(list.answer!, /a-1/);
    assert.match(list.answer!, /b-1/);
    assert.match(list.answer!, /alpha reply/);
    assert.match(list.answer!, /\[idle\]/);
});

test("manager: mode dial — sync has no background param & no await/steer; async is always-background", async () => {
    const buildKind = () => new Agent({ model: new StubModel([]) });
    const syncMgr = createSubAgents({ mode: "sync", subs: [{ id: "s", build: buildKind }] });
    assert.equal(
        (syncMgr.tools["spawn"].inputSchema as { properties?: Record<string, unknown> }).properties
            ?.background,
        undefined,
        "sync spawn has no background option",
    );
    assert.equal(syncMgr.tools["await"], undefined, "sync mode: no await tool");
    assert.equal(syncMgr.tools["steer"], undefined, "sync mode: no steer tool");
    assert.ok(syncMgr.tools["list"], "sync mode: list exists");

    const asyncMgr = createSubAgents({ mode: "async", subs: [{ id: "s", build: buildKind }] });
    assert.ok(asyncMgr.tools["await"], "async mode: await exists");
    assert.ok(asyncMgr.tools["steer"], "async mode: steer exists");
    assert.equal(
        (asyncMgr.tools["spawn"].inputSchema as { properties?: Record<string, unknown> }).properties
            ?.background,
        undefined,
        "async spawn is always-background — no param either",
    );

    const bothMgr = createSubAgents({ mode: "both", subs: [{ id: "s", build: buildKind }] });
    assert.ok(
        (bothMgr.tools["spawn"].inputSchema as { properties?: Record<string, unknown> }).properties
            ?.background,
        "both mode: spawn carries background",
    );
});

test("manager: ORCHESTRATE — ask surfaces to the host, top loop NOT blocked, respond() routes the answer down", async () => {
    const parent = new Agent({ model: new StubModel([]) });
    const asks: Array<{ id: string; subId: string; kind: string }> = [];
    const mgr = createSubAgents({
        onPending: "orchestrate",
        onAsk: (ask) => {
            asks.push({ id: ask.id, subId: ask.subId, kind: ask.kind });
        },
        subs: [
            {
                id: "gated",
                description: "needs approval",
                build: () => {
                    const a = new Agent({ model: new StubModel([() => assistantTurn("orchestrated gold")]) });
                    let resolved = false;
                    a.addFilter({
                        event: EVENTS.beforeProviderRequest,
                        id: "test/gate-park",
                        priority: 0,
                        fn: async (ag) => {
                            if (resolved) return;
                            if (!ag.pendingAwaits.some((w) => w.id === "gate-3")) {
                                ag.pendingAwaits.push({ type: "test/gate", id: "gate-3", schema: null });
                            }
                        },
                    });
                    a.addFilter({
                        event: EVENTS.inputReceived,
                        id: "test/gate-resolve",
                        priority: 100,
                        fn: async (ag) => {
                            const input = ag.currentInput as { type?: string; ref?: string };
                            if (input?.type !== "gate-answer" || input.ref !== "gate-3") return;
                            resolved = true;
                            const idx = ag.pendingAwaits.findIndex((w) => w.id === "gate-3");
                            if (idx !== -1) ag.pendingAwaits.splice(idx, 1);
                        },
                    });
                    return a;
                },
            },
        ],
    });
    parent.install(mgr);
    void parent.run({ startState: "idle" });

    await mgr.tools["spawn"].execute({ sub: "gated", text: "x", background: true }, {} as never);
    await waitUntil(() => asks.length > 0, { what: "ask surfaced to orchestrator" });
    assert.equal(asks[0].subId, "gated-1");
    assert.equal(asks[0].kind, "gated");
    assert.equal(parent.pendingAwaits.length, 0, "ORCHESTRATE does NOT block the top loop");

    const ok = mgr.respond(asks[0].id, { type: "gate-answer", ref: "gate-3", approved: true });
    assert.equal(ok, true, "respond delivered");
    await waitUntil(() => {
        const i = mgr.instances().find((x) => x.id === "gated-1");
        return i !== undefined && i.state === "idle";
    }, { what: "sub resumed after orchestrated answer" });
    const collected = await mgr.tools["await"].execute({ id: "gated-1" }, {} as never);
    assert.match(collected.answer!, /orchestrated gold/);

    assert.equal(mgr.respond(asks[0].id, { type: "gate-answer", ref: "gate-3" }), false, "stale ask refuses");
});

// ---------------------------------------------------------------------------
// FORK — parallel sessions that return (e87e4b8, previously untested)
// ---------------------------------------------------------------------------

test("fork: copies history+state by value, tools by ref, nothing shared mutable", () => {
    const parent = new Agent({ model: new StubModel([]), agentId: "parent" });
    parent.messages.push(
        { id: "u1", enabled: true, type: "user", content: [{ type: "text", content: "work" }] } as never,
        { id: "a1", enabled: true, type: "assistant", content: [{ type: "text", content: "done" }] } as never,
    );
    parent.setState("k", { nested: [1, 2] });
    const child = fork(parent);
    assert.equal(child.agentId, "parent-fork");
    assert.deepEqual(child.messages, parent.messages, "whole history carried");
    assert.ok(child.messages[0] !== parent.messages[0], "messages deep-copied, not aliased");
    assert.deepEqual(child.state.k, { nested: [1, 2] });
    child.setState("k", { nested: [9] });
    assert.deepEqual(parent.state.k, { nested: [1, 2] }, "child writes never leak back");
    assert.equal(child.model, parent.model, "same model (prefix cache intact)");
    // slice + append + blank
    const sliced = fork(parent, { messages: { from: -1 }, append: [textMessage("user", "task")] });
    assert.deepEqual(sliced.messages.map((m) => m.id), ["a1", sliced.messages[1].id]);
    assert.equal(sliced.messages[1].type, "user");
    assert.equal(fork(parent, { messages: [] }).messages.length, 0, "blank child on demand");
    // bad builder refuses loudly
    assert.throws(() => fork(parent, { agent: () => "nope" as never }), /instead of an Agent/);
});

test("runOnce: exactly one provider call, then terminated — tools unexecuted", async () => {
    const parent = new Agent({ model: new StubModel([]), agentId: "p1" });
    const child = fork(parent, {
        messages: [],
        append: [textMessage("user", "extract")],
        agent: () => new Agent({ model: new StubModel([() => assistantTurn("JSON HERE"), () => assistantTurn("SECOND")]), agentId: "c1" }),
    });
    const res = await runOnce(child, { name: "t1" });
    assert.equal(res.error, false);
    assert.equal(res.answer, "JSON HERE", "first call's text collected");
    assert.equal(res.timedOut, false);
    assert.equal(child.loopState, "terminated", "child always terminated");
    assert.ok(!child.messages.some((m) => JSON.stringify(m.content).includes("SECOND")), "second call never ran");
});

test("runUntilSettled: full loop lands, stats ride along, child terminated", async () => {
    const echo = { name: "echo", description: "e", inputSchema: { type: "object" }, execute: async () => ({ answer: "echoed" }) } as never;
    const parent = new Agent({ model: new StubModel([]), agentId: "p2" });
    const sub = new Agent({
        model: new StubModel([() => toolCallTurn([callTo("echo", {})]), () => assistantTurn("all done")]),
        tools: [echo],
        agentId: "c2",
    });
    sub.messages.push(textMessage("user", "go"));
    const res = await runUntilSettled(sub, { name: "t2" });
    assert.equal(res.error, false);
    assert.equal(res.answer, "all done");
    assert.equal(sub.loopState, "terminated");
    assert.ok(res.stats.totalTokens > 0, "child stats accumulated for the ledger");
    assert.equal(parent.messages.length, 0, "parent untouched");
});

test("sideCall: JSON extraction with schema wall — strict/warn/fallback", async () => {
    const mkParent = (reply: string) => {
        const p = new Agent({ model: new StubModel([() => assistantTurn(reply)]), agentId: "px" });
        p.messages.push(textMessage("user", "context"));
        return p;
    };
    const schema = { type: "object", properties: { n: { type: "number" } }, required: ["n"] } as never;
    // happy path
    const ok = await sideCall<{ n: number }>(mkParent('{"n": 42}'), { schema });
    assert.equal(ok.error, false);
    assert.deepEqual(ok.object, { n: 42 });
    assert.equal(ok.usedFallbackValue, false);
    // bad JSON, strict → error
    const bad = await sideCall(mkParent("not json"), { schema });
    assert.equal(bad.error, true);
    assert.match(bad.errorMessage!, /not valid JSON/);
    // bad JSON, warn → error:false + raw text
    const warned = await sideCall(mkParent("not json"), { schema, onError: "warn" });
    assert.equal(warned.error, false);
    assert.equal(warned.text, "not json");
    assert.match(warned.errorMessage!, /not valid JSON/);
    // schema violation, fallback → fallback value stands in
    const fb = await sideCall<{ n: number }>(mkParent('{"n": "nan"}'), { schema, onError: "fallback", fallbackValue: { n: -1 } });
    assert.equal(fb.error, false);
    assert.equal(fb.usedFallbackValue, true);
    assert.deepEqual(fb.object, { n: -1 });
});

test("collectFinalAnswer: last assistant text wins; none → undefined", () => {
    const msgs = [
        textMessage("user", "q"),
        textMessage("assistant", "first"),
        textMessage("assistant", "  second  "),
    ];
    assert.equal(collectFinalAnswer(msgs), "second");
    assert.equal(collectFinalAnswer([textMessage("user", "q")]), undefined);
    assert.equal(collectFinalAnswer([]), undefined);
});

// ---------------------------------------------------------------------------
// DEATH — a dead child reports, never hangs (reconcile watches abort/error/term)
// ---------------------------------------------------------------------------

test("manager: abort mid-flight resolves the blocking wait with the reason + frees the slot", async () => {
    const mgr = createSubAgents({
        concurrency: 1,
        subs: [
            {
                id: "w",
                build: () => new Agent({ model: new StubModel([() => assistantTurn("w1")]) }),
            },
        ],
    });
    const r1 = await mgr.tools["spawn"].execute({ sub: "w", text: "a", background: true }, {} as never);
    assert.match(r1.answer!, /Started w-1/);
    mgr.get("w-1")!.abort("test kill");
    const out = await mgr.tools["await"].execute({ id: "w-1" }, {} as never);
    assert.equal(out.error, true);
    assert.match(out.answer!, /test kill/);
    assert.equal(mgr.get("w-1")!.loopState, "aborted");
    // the slot is free — the next background spawn starts, not queues
    const r2 = await mgr.tools["spawn"].execute({ sub: "w", text: "b", background: true }, {} as never);
    assert.match(r2.answer!, /Started w-2/);
});

test("manager: terminate while queued never starts a corpse — pump skips it", async () => {
    const slowTool = {
        name: "slow",
        description: "takes time",
        inputSchema: { type: "object" },
        executionMode: "sequential",
        execute: async () => {
            await sleep(120);
            return { answer: "slow done" };
        },
    };
    const mgr = createSubAgents({
        concurrency: 1,
        subs: [
            {
                id: "slug",
                build: () =>
                    new Agent({
                        model: new StubModel([() => toolCallTurn([callTo("slow", {})]), () => assistantTurn("A finished")]),
                        tools: [slowTool as never],
                    }),
            },
            {
                id: "fast",
                build: () => new Agent({ model: new StubModel([() => assistantTurn("B finished")]) }),
            },
        ],
    });
    await mgr.tools["spawn"].execute({ sub: "slug", text: "a", background: true }, {} as never);
    const q = await mgr.tools["spawn"].execute({ sub: "fast", text: "b", background: true }, {} as never);
    assert.match(q.answer!, /Queued fast-1/);
    const kill = await mgr.tools["steer"].execute({ id: "fast-1", terminate: true }, {} as never);
    assert.match(kill.answer!, /terminated/);
    const all = await mgr.tools["await"].execute({}, {} as never);
    assert.match(all.answer!, /A finished/);
    assert.doesNotMatch(all.answer!, /B finished/, "the queued corpse never ran");
});

// ---------------------------------------------------------------------------
// BUILDER CONTEXT + HOST API — per-child expression
// ---------------------------------------------------------------------------

test("manager: builder receives {id, kind, depth}; get() exposes the live child", async () => {
    const seen: Array<{ id: string; kind: string; depth: number }> = [];
    const mgr = createSubAgents({
        subs: [
            {
                id: "ctx",
                build: (ctx) => {
                    seen.push({ id: ctx!.id, kind: ctx!.kind, depth: ctx!.depth });
                    return new Agent({ model: new StubModel([() => assistantTurn("hi")]) });
                },
            },
        ],
    });
    await mgr.tools["spawn"].execute({ sub: "ctx", text: "go" }, {} as never);
    assert.deepEqual(seen, [{ id: "ctx-1", kind: "ctx", depth: 1 }]);
    const child = mgr.get("ctx-1");
    assert.ok(child instanceof Agent, "host holds the live ref");
    assert.equal(mgr.get("nope"), undefined);
});

test("manager: onSpawn/onDone fire once per birth/landing", async () => {
    const events: string[] = [];
    const mgr = createSubAgents({
        onSpawn: (s) => events.push(`spawn:${s.id}:${s.depth}`),
        onDone: (d) => events.push(`done:${d.id}:${d.ok}`),
        subs: [
            {
                id: "ev",
                build: () => new Agent({ model: new StubModel([() => assistantTurn("done")]) }),
            },
        ],
    });
    await mgr.tools["spawn"].execute({ sub: "ev", text: "go" }, {} as never);
    assert.deepEqual(events, ["spawn:ev-1:1", "done:ev-1:true"]);
});

test("manager: maxDepth refuses deeper spawns before the builder runs", async () => {
    let builds = 0;
    const mk = (depth?: number) =>
        createSubAgents({
            maxDepth: 1,
            depth,
            subs: [
                {
                    id: "d",
                    build: () => {
                        builds++;
                        return new Agent({ model: new StubModel([() => assistantTurn("x")]) });
                    },
                },
            ],
        });
    const top = mk();
    const okRes = await top.tools["spawn"].execute({ sub: "d", text: "go" }, {} as never);
    assert.equal(okRes.error, undefined, "depth 1 within maxDepth 1");
    assert.equal(builds, 1);
    const nested = mk(1);
    const noRes = await nested.tools["spawn"].execute({ sub: "d", text: "go" }, {} as never);
    assert.equal(noRes.error, true);
    assert.match(noRes.answer!, /nesting bound/);
    assert.equal(builds, 1, "builder never ran for the refused spawn");
});

// ---------------------------------------------------------------------------
// READ — pull-peek into a live or finished instance
// ---------------------------------------------------------------------------

test("manager: read returns transcript tail + status; list shows parked gates", async () => {
    const parent = new Agent({ model: new StubModel([]) });
    const mgr = createSubAgents({
        onPending: "escalate",
        answerBuilders: { "test/gate": (item) => ({ type: "gate-answer", ref: item.id! }) as never },
        subs: [
            {
                id: "chatter",
                build: () => new Agent({ model: new StubModel([() => assistantTurn("the secret")]) }),
            },
            {
                id: "gated",
                build: () => {
                    const a = new Agent({ model: new StubModel([() => assistantTurn("post-gate gold")]) });
                    a.addFilter({
                        event: EVENTS.beforeProviderRequest,
                        id: "test/gate-park",
                        priority: 0,
                        fn: async (ag) => {
                            if (!ag.pendingAwaits.some((w) => w.id === "gate-9")) {
                                ag.pendingAwaits.push({ type: "test/gate", id: "gate-9", schema: null } as never);
                            }
                        },
                    });
                    a.addFilter({
                        event: EVENTS.inputReceived,
                        id: "test/gate-resolve",
                        priority: 100,
                        fn: async (ag) => {
                            const input = ag.currentInput as { type?: string; ref?: string };
                            if (input?.type !== "gate-answer" || input.ref !== "gate-9") return;
                            const idx = ag.pendingAwaits.findIndex((w) => w.id === "gate-9");
                            if (idx !== -1) ag.pendingAwaits.splice(idx, 1);
                        },
                    });
                    return a;
                },
            },
        ],
    });
    parent.install(mgr);
    void parent.run({ startState: "idle" });
    await mgr.tools["spawn"].execute({ sub: "chatter", text: "tell me" }, {} as never);
    const read = await mgr.tools["read"].execute({ id: "chatter-1", tail: 5 }, {} as never);
    assert.match(read.answer!, /the secret/);
    assert.match(read.answer!, /state: idle/);
    const bad = await mgr.tools["read"].execute({ id: "nope" }, {} as never);
    assert.equal(bad.error, true);
    // parked gate surfaces in read + list
    await mgr.tools["spawn"].execute({ sub: "gated", text: "dangerous", background: true }, {} as never);
    await waitUntil(() => parent.pendingAwaits.some((w) => w.type === "subagents/pending"), {
        what: "proxy escalated onto the parent",
    });
    const parked = await mgr.tools["read"].execute({ id: "gated-1" }, {} as never);
    assert.match(parked.answer!, /parked: test\/gate/);
    const list = await mgr.tools["list"].execute({}, {} as never);
    assert.match(list.answer!, /parked: test\/gate/);
});

// ---------------------------------------------------------------------------
// SIBLING_SEND — child↔child mail
// ---------------------------------------------------------------------------

test("manager: sibling_send delivers labeled mail; broadcast skips the dead", async () => {
    const mgr = createSubAgents({
        subs: [
            {
                id: "a",
                build: () => new Agent({ model: new StubModel([() => assistantTurn("a-ok")]) }),
            },
            {
                id: "b",
                build: () =>
                    new Agent({
                        // two turns: the spawn reply + the sibling-mail reply (mail kickstarts the idle loop)
                        model: new StubModel([() => assistantTurn("b-ok"), () => assistantTurn("b-got-mail")]),
                    }),
            },
            {
                id: "c",
                build: () => new Agent({ model: new StubModel([() => assistantTurn("c-ok")]) }),
            },
        ],
    });
    await mgr.tools["spawn"].execute({ sub: "a", text: "go" }, {} as never);
    await mgr.tools["spawn"].execute({ sub: "b", text: "go" }, {} as never);
    await mgr.tools["spawn"].execute({ sub: "c", text: "go" }, {} as never);
    const sender = mgr.get("a-1")!;
    const mail = sender.tools.find((t) => t.name === "sibling_send")!;
    assert.ok(mail, "every child carries the sibling door");
    const one = await mail.execute({ to: "b-1", text: "hello sib" }, sender as never);
    assert.equal(one.error, undefined);
    assert.match(JSON.stringify(mgr.get("b-1")!.messages.at(-1)!.content), /from a-1/);
    // mail kickstarted b's loop — let its reply land before counting it live again
    await mgr.tools["await"].execute({ id: "b-1" }, {} as never);
    const self = await mail.execute({ to: "a-1", text: "me" }, sender as never);
    assert.equal(self.error, true, "self-send refuses");
    const ghost = await mail.execute({ to: "ghost-9", text: "boo" }, sender as never);
    assert.equal(ghost.error, true, "unknown sibling refuses");
    await mgr.tools["steer"].execute({ id: "c-1", terminate: true }, {} as never);
    const cast = await mail.execute({ to: "*", text: "all hands" }, sender as never);
    assert.equal((cast.stored as { count: number }).count, 1, "broadcast skips self + the dead");
    assert.match(JSON.stringify(mgr.get("b-1")!.messages.at(-1)!.content), /all hands/);
});

// ---------------------------------------------------------------------------
// RESTART — rebirth under the same id
// ---------------------------------------------------------------------------

test("manager: restart rebirths an ended instance — same id, fresh brain", async () => {
    let builds = 0;
    const mgr = createSubAgents({
        subs: [
            {
                id: "phoenix",
                build: () => {
                    builds++;
                    const n = builds;
                    return new Agent({ model: new StubModel([() => assistantTurn(`life ${n}`)]) });
                },
            },
        ],
    });
    const first = await mgr.tools["spawn"].execute({ sub: "phoenix", text: "live" }, {} as never);
    assert.equal(first.answer, "life 1");
    const old = mgr.get("phoenix-1")!;
    const re = await mgr.tools["restart"].execute({ id: "phoenix-1", text: "live again" }, {} as never);
    assert.equal(re.error, undefined);
    assert.equal(re.answer, "life 2");
    assert.equal((re.stored as { id: string }).id, "phoenix-1", "same handle");
    assert.equal(old.loopState, "terminated", "old brain terminated");
    assert.notEqual(mgr.get("phoenix-1"), old, "new brain under the same id");
    assert.equal(mgr.get("phoenix-1")!.messages.length, 2, "fresh history: user + assistant");
});

test("manager: restart refuses a live instance; revives an errored one", async () => {
    const slowTool = {
        name: "slow",
        description: "takes time",
        inputSchema: { type: "object" },
        executionMode: "sequential",
        execute: async () => {
            await sleep(150);
            return { answer: "slow done" };
        },
    };
    const mgr = createSubAgents({
        subs: [
            {
                id: "busy",
                build: () =>
                    new Agent({
                        model: new StubModel([
                            () => toolCallTurn([callTo("slow", {})]),
                            () => assistantTurn("busy done"),
                            () => assistantTurn("reborn done"),
                        ]),
                        tools: [slowTool as never],
                    }),
            },
            {
                id: "doomed",
                build: () => new Agent({ model: new StubModel([() => assistantTurn("doomed done")]) }),
            },
        ],
    });
    await mgr.tools["spawn"].execute({ sub: "busy", text: "work", background: true }, {} as never);
    await waitUntil(() => mgr.get("busy-1")!.loopState === "running", { what: "child reaches running" });
    const live = await mgr.tools["restart"].execute({ id: "busy-1", text: "nope" }, {} as never);
    assert.equal(live.error, true);
    assert.match(live.answer!, /still live/);
    await mgr.tools["await"].execute({ id: "busy-1" }, {} as never);
    // errored instance: abort it, then restart revives it under the same id
    await mgr.tools["spawn"].execute({ sub: "doomed", text: "go", background: true }, {} as never);
    mgr.get("doomed-1")!.abort("doom");
    const dead = await mgr.tools["await"].execute({ id: "doomed-1" }, {} as never);
    assert.equal(dead.error, true);
    assert.match((await mgr.tools["list"].execute({}, {} as never)).answer!, /error: doom/);
    const revive = await mgr.tools["restart"].execute({ id: "doomed-1", text: "again" }, {} as never);
    assert.equal(revive.error, undefined);
    assert.equal(revive.answer, "doomed done");
});

// ---------------------------------------------------------------------------
// BIRTH-HOOK SAFETY + EVERY-LANDING onDone
// ---------------------------------------------------------------------------

test("manager: throwing onSpawn leaves no unstartable instance — sub_await never hangs", async () => {
    const mgr = createSubAgents({
        onSpawn: () => { throw new Error("storage exploded"); },
        subs: [
            {
                id: "fragile",
                build: () => new Agent({ model: new StubModel([() => assistantTurn("x")]) }),
            },
        ],
    });
    const r = await mgr.tools["spawn"].execute({ sub: "fragile", text: "go", background: true }, {} as never);
    assert.equal(r.error, true);
    assert.match(r.answer!, /storage exploded/);
    assert.equal(mgr.instances().length, 0, "no corpse left behind");
    const all = await mgr.tools["await"].execute({}, {} as never);
    assert.match(all.answer!, /nothing is running/, "await-all resolves, never hangs");
});

test("manager: onDone fires on mail-woken landings with no send — exactly once each", async () => {
    const dones: Array<{ id: string; ok: boolean }> = [];
    const mgr = createSubAgents({
        onDone: (d) => dones.push({ id: d.id, ok: d.ok }),
        subs: [
            {
                id: "ear",
                build: () => new Agent({ model: new StubModel([
                    () => assistantTurn("first"),
                    () => assistantTurn("second"),
                ]) }),
            },
            {
                id: "mouth",
                build: () => new Agent({ model: new StubModel([() => assistantTurn("mail sent")]) }),
            },
        ],
    });
    await mgr.tools["spawn"].execute({ sub: "ear", text: "listen" }, {} as never);
    assert.deepEqual(dones, [{ id: "ear-1", ok: true }], "the send-backed landing fires");
    // mail wakes the idle child with NO send outstanding — its next landing still notifies
    mgr.get("mouth-1") ?? (await mgr.tools["spawn"].execute({ sub: "mouth", text: "wake" }, {} as never));
    dones.length = 0;
    await mgr.get("mouth-1")!.tools.find((t) => t.name === "sibling_send")!.execute!({ to: "ear-1", text: "ping" }, {} as never);
    await waitUntil(() => dones.length > 0, { what: "mail-woken landing notifies" });
    assert.deepEqual(dones, [{ id: "ear-1", ok: true }], "exactly once for the mail-woken landing");
});

test("manager: onDone fires exactly once on death (2-3 death beats, one notice)", async () => {
    const dones: Array<{ id: string; ok: boolean; error?: string }> = [];
    const mgr = createSubAgents({
        onDone: (d) => dones.push({ id: d.id, ok: d.ok, error: d.error }),
        subs: [
            {
                id: "doomed",
                build: () => new Agent({ model: new StubModel([() => assistantTurn("never")]) }),
            },
        ],
    });
    await mgr.tools["spawn"].execute({ sub: "doomed", text: "go", background: true }, {} as never);
    mgr.get("doomed-1")!.abort("test kill");
    await sleep(50); // let the abort+beforeAbort microtask reconciles all land
    assert.equal(dones.length, 1, `one notice across all death beats, got ${JSON.stringify(dones)}`);
    assert.equal(dones[0]!.ok, false);
    assert.match(dones[0]!.error!, /test kill/);
});
