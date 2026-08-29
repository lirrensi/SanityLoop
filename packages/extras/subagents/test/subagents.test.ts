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
import { agentAsTool, createSubAgents } from "@sanityloop/subagents";
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

    void parent.run();
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
    void parent.run();

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
    void parent.run();

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
    void parent.run();

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
