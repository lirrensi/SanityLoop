// ============================================================================
// tests/extras/permission.test.ts — @sanityloop/permission over the core park.
// ============================================================================
// REGRESSION GUARDS inside: classicResolve "once"/"session" are SILENT
// approvals — the resolver must NOT preResolve an approved call, so the
// parked batch actually EXECUTES the tool. Only denials preResolve.
//
// All park→answer→resume scenarios run under the ETERNAL heartbeat
// (agent.run()) via withDriver(). Signals never start loops; the heartbeat
// ticks forever and notices every queued signal next tick — park→answer→resume
// is deterministic BY CONSTRUCTION (no driver death-decisions exist anymore).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    createPermissions,
    askAll,
    denyAll,
    allowAll,
    fsPathGate,
    bashGate,
    classicResolve,
    recordDenial,
    matchEntry,
    globMatch,
    canonicalizeCommand,
    isCompoundCommand,
    PERMISSION_AWAIT,
    PERMISSION_ANSWER,
    CLASSIC_CHOICES,
} from "@sanityloop/permission";
import type { DenialRecord, PermissionConfig } from "@sanityloop/permission";
import { Agent, Tool } from "@sanityloop/core";
import type { GodObject, ToolResultMessage, TurnResult } from "@sanityloop/core";
import { StubModel, assistantTurn, callTo, toolCallTurn } from "@sanityloop/test-kit/core";
import { awaitAwaiting, awaitLanded } from "@sanityloop/test-kit";
import { makeTempDir } from "@sanityloop/test-kit";
import { withDriver } from "@sanityloop/test-kit/core";

interface Spy {
    executes: number;
    params: unknown;
}

function makePermAgent(script: Array<() => TurnResult>, opts: { cwd?: string } = {}) {
    const spy: Spy = { executes: 0, params: undefined };
    const tool = Tool.define({
        name: "dummy",
        description: "the gated tool",
        inputSchema: {
            type: "object",
            properties: { path: { type: "string" }, text: { type: "string" } },
        },
        async execute(params) {
            spy.executes++;
            spy.params = params;
            return { answer: "ran", stored: { n: 1 } };
        },
    });
    const model = new StubModel(script);
    const agent = new Agent({ model, cwd: opts.cwd, tools: [tool], agentId: "perm-test" });
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
    return { agent, spy, seedAndKick };
}

function lastToolResult(agent: Agent): ToolResultMessage {
    const last = [...agent.messages].reverse().find((m) => m.type === "toolResult");
    assert.ok(last, "no toolResult committed");
    return last as unknown as ToolResultMessage;
}

const answerOnce = (agent: Agent, ref: string | undefined, body: unknown) =>
    agent.input({ type: PERMISSION_ANSWER, ref, answer: body });

const singleCallScript = (): Array<() => TurnResult> => [
    () => toolCallTurn([callTo("dummy", {}, "call-77")]),
    () => assistantTurn("done"),
];

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

test("gates fire on beforeTool — the spy sees every call", async () => {
    const gated: string[] = [];
    const config: PermissionConfig = {
        tools: {
            "*": { gate: allowAll },
            dummy: { gate: (_a, _r, call) => void gated.push(call.name) },
        },
    };
    const { agent, seedAndKick } = makePermAgent(singleCallScript());
    agent.install(createPermissions(config));

    await withDriver(agent, async () => {
        seedAndKick();
        await awaitLanded(agent);
    });
    assert.deepEqual(gated, ["dummy"]);
});

test("allowAll gate = silence = the tool just runs (no parking)", async () => {
    const { agent, spy, seedAndKick } = makePermAgent(singleCallScript());
    agent.install(createPermissions({ defaults: { gate: allowAll } }));
    await withDriver(agent, async () => {
        seedAndKick();
        await awaitLanded(agent);
    });
    assert.equal(spy.executes, 1);
    assert.equal(agent.pendingAwaits.length, 0);
});

test("askAll parks awaiting: PendingAwait recorded with rendezvous id + schema", async () => {
    const { agent, spy, seedAndKick } = makePermAgent(singleCallScript());
    agent.install(createPermissions({ defaults: { gate: askAll } }));
    await withDriver(agent, async () => {
        seedAndKick();
        await awaitAwaiting(agent);
        assert.equal(spy.executes, 0, "nothing executes while asked");
        assert.equal(agent.pendingAwaits.length, 1);
        const aw = agent.pendingAwaits[0];
        assert.equal(aw.type, PERMISSION_AWAIT);
        assert.equal(aw.id, "call-77");
        const schema = aw.schema as { tool?: string; options?: string[] };
        assert.equal(schema.tool, "dummy");
        assert.deepEqual(schema.options, ["yes", "no"]);
    });
});

// ---------------------------------------------------------------------------
// THE REGRESSION GUARDS — approvals must never stand between an approved
// call and its execution.
// ---------------------------------------------------------------------------

test("GUARD: classicResolve 'once' is a SILENT approval — the tool ACTUALLY EXECUTES", async () => {
    const { agent, spy, seedAndKick } = makePermAgent(singleCallScript());
    agent.install(createPermissions({ defaults: { gate: askAll, resolve: classicResolve } }));

    await withDriver(agent, async () => {
        seedAndKick();
        await awaitAwaiting(agent);
        assert.equal(spy.executes, 0);
        answerOnce(agent, "call-77", { choice: "once" });
        await awaitLanded(agent);
    });

    assert.equal(spy.executes, 1, "an APPROVED call must execute FOR REAL");
    const result = lastToolResult(agent);
    assert.equal(result.content!.error, undefined, "no error flag injected into approval");
    assert.equal(result.content!.answer, "ran", "the REAL tool answer reaches the model");
});

test("defaultResolve turns the raw answer INTO the tool result (documented contract)", async () => {
    // NOT a silent approval — defaultResolve preResolves deliberately:
    // "the raw answer becomes the tool result; the model reads it and acts."
    const { agent, spy, seedAndKick } = makePermAgent(singleCallScript());
    agent.install(createPermissions({ defaults: { gate: askAll } }));
    await withDriver(agent, async () => {
        seedAndKick();
        await awaitAwaiting(agent);
        answerOnce(agent, "call-77", "yes do it");
        await awaitLanded(agent);
    });
    assert.equal(spy.executes, 0, "execution skipped — the answer IS the result");
    const result = lastToolResult(agent);
    assert.equal(result.content!.error, undefined, "no error flag — an answer, not a denial");
    assert.match(result.content!.answer!, /The user answered: yes do it/);
});

test("'session' remembers an approval AND executes; the SAME path next turn skips the ask", async (t) => {
    const base = await makeTempDir(t);
    const outside = await makeTempDir(t, "sanityloop-session-out-");
    const target = `${outside}/file.txt`;

    // fsPathGate READS approvals — so "session" has real teeth for turn 2
    const model = new StubModel([
        () => toolCallTurn([callTo("dummy", { path: target }, "s-1")]),
        () => assistantTurn("t1 done"),
        () => toolCallTurn([callTo("dummy", { path: target }, "s-2")]),
        () => assistantTurn("t2 done"),
    ]);
    const executed: string[] = [];
    const agent = new Agent({
        model,
        cwd: base,
        tools: [Tool.define({
            name: "dummy", description: "d", inputSchema: { type: "object" },
            async execute(p) { executed.push(String((p as { path?: string }).path)); return { answer: "ran" }; },
        })],
        agentId: "classic-session",
    });
    agent.install(createPermissions({
        rules: { paths: { mode: "workspace" } },
        tools: { dummy: { gate: fsPathGate } },
        defaults: { resolve: classicResolve },
    }));

    // deterministic ask counter: runs AFTER fsPathGate (priority 100) — an ask
    // for THIS call is visible in pendingAwaits by then
    let asks = 0;
    agent.addFilter({
        event: "beforeTool", id: "test/count-asks", priority: 200,
        fn: async (a, e) => {
            const id = (e?.call as { id?: string })?.id;
            if (id && a.pendingAwaits.some((w) => w.type === PERMISSION_AWAIT && w.id === id)) asks++;
        },
    });

    const seedAndKick = () => {
        agent.messages.push({
            id: `u-${Math.random().toString(36).slice(2, 8)}`,
            enabled: true, type: "user", committedAt: Date.now(),
            content: [{ type: "text", content: "go" }],
        });
        agent.input({ type: "__test_kick__" });
    };

    await withDriver(agent, async () => {
        // TURN 1 — asks (outside workspace)
        seedAndKick();
        await awaitAwaiting(agent);
        answerOnce(agent, "s-1", { choice: "session" });
        await awaitLanded(agent);

        // TURN 2 — the session approval covers tool+folder: NO ask
        seedAndKick();
        await awaitLanded(agent);
    });

    assert.deepEqual(executed, [target, target], "both turns executed for real");
    const st = agent.state.permission as { approvals?: Array<{ tool?: string; path?: string }> };
    assert.equal(st.approvals?.length, 1, "exactly one session approval remembered");
    assert.equal(st.approvals?.[0]?.tool, "dummy");
    assert.equal(asks, 1, "exactly ONE ask across both turns");
});

test("'no' denies WITHOUT executing; audit ledger records it", async () => {
    const { agent, spy, seedAndKick } = makePermAgent(singleCallScript());
    agent.install(createPermissions({ defaults: { gate: askAll, resolve: classicResolve } }));
    await withDriver(agent, async () => {
        seedAndKick();
        await awaitAwaiting(agent);
        answerOnce(agent, "call-77", { choice: "no" });
        await awaitLanded(agent);
    });

    assert.equal(spy.executes, 0, "denied calls never execute");
    const result = lastToolResult(agent);
    assert.equal(result.content!.error, true);
    assert.match(result.content!.answer!, /declined/);
    const st = agent.state.permission as { audit?: DenialRecord[] };
    assert.equal(st.audit?.length, 1);
    assert.equal(st.audit?.[0]?.reason, "the human declined");
    assert.equal(st.audit?.[0]?.tool, "dummy");
});

test("'no_explain' carries the human's reason into result + ledger", async () => {
    const { agent, spy, seedAndKick } = makePermAgent(singleCallScript());
    agent.install(createPermissions({ defaults: { gate: askAll, resolve: classicResolve } }));
    await withDriver(agent, async () => {
        seedAndKick();
        await awaitAwaiting(agent);
        answerOnce(agent, "call-77", { choice: "no_explain", reason: "it is a trap" });
        await awaitLanded(agent);
    });

    assert.equal(spy.executes, 0);
    const result = lastToolResult(agent);
    assert.match(result.content!.answer!, /declined: it is a trap/);
    const st = agent.state.permission as { audit?: DenialRecord[] };
    assert.match(st.audit?.[0]?.reason ?? "", /it is a trap/);
});

test("denyAll blocks everything: preResolved refusal AT the wall, no execution, audited", async () => {
    const { agent, spy, seedAndKick } = makePermAgent(singleCallScript());
    agent.install(createPermissions({ defaults: { gate: denyAll } }));
    await withDriver(agent, async () => {
        seedAndKick();
        await awaitLanded(agent); // NO parking — refusal resolves at the wall
    });
    assert.equal(spy.executes, 0);
    const result = lastToolResult(agent);
    assert.equal(result.content!.error, true);
    assert.match(result.content!.answer!, /not permitted by policy/);
    const st = agent.state.permission as { audit?: DenialRecord[] };
    assert.equal(st.audit?.length, 1);
});

test("audit ledger caps at 500 entries (AUDIT_CAP runaway guard)", () => {
    const fakeAgent = { state: {}, emit: () => {} } as unknown as GodObject;
    for (let i = 0; i < 505; i++) {
        recordDenial(fakeAgent, { id: `c${i}`, type: "function", name: "t", parameters: {} }, `reason ${i}`);
    }
    const st = (fakeAgent.state as { permission: { audit: DenialRecord[] } }).permission;
    assert.equal(st.audit.length, 500);
    assert.equal(st.audit[0].reason, "reason 5", "oldest dropped");
    assert.equal(st.audit.at(-1)?.reason, "reason 504", "newest kept");
});

// ---------------------------------------------------------------------------
// fsPathGate — the shipped strategy
// ---------------------------------------------------------------------------

test("fsPathGate: blacklisted paths denied WITHOUT executing (blacklist beats all)", async (t) => {
    const base = await makeTempDir(t);
    const { agent, spy, seedAndKick } = makePermAgent([
        () => toolCallTurn([callTo("dummy", { path: `${base}/evil/.env` }, "p-1")]),
        () => assistantTurn("ok"),
    ], { cwd: base });
    agent.install(createPermissions({
        rules: { paths: { blacklist: ["**/.env"] } },
        tools: { dummy: { gate: fsPathGate } },
    }));
    await withDriver(agent, async () => {
        seedAndKick();
        await awaitLanded(agent);
    });

    assert.equal(spy.executes, 0, "blacklisted call never ran");
    assert.equal(agent.pendingAwaits.length, 0, "no ask either — straight refusal");
    const result = lastToolResult(agent);
    assert.equal(result.content!.error, true);
    assert.match(result.content!.answer!, /blacklisted/);
});

test("fsPathGate workspace mode: inside cwd passes silently, outside cwd asks", async (t) => {
    const base = await makeTempDir(t);
    const outside = await makeTempDir(t, "sanityloop-outside-");
    const executed: string[] = [];
    const model = new StubModel([
        () => toolCallTurn([
            callTo("dummy", { path: `${base}/inside.txt` }, "in-1"),
            callTo("dummy", { path: `${outside}/outside.txt` }, "out-1"),
        ]),
        () => assistantTurn("ok"),
    ]);
    const agent = new Agent({
        model,
        cwd: base,
        tools: [Tool.define({
            name: "dummy", description: "d", inputSchema: { type: "object" },
            async execute(p) { executed.push(String((p as { path?: string }).path)); return { answer: "x" }; },
        })],
        agentId: "fsgate-workspace",
    });
    agent.install(createPermissions({
        rules: { paths: { mode: "workspace" } },
        tools: { dummy: { gate: fsPathGate } },
        defaults: { resolve: classicResolve },
    }));
    const seedAndKick = () => {
        agent.messages.push({
            id: `u-${Math.random().toString(36).slice(2, 8)}`,
            enabled: true, type: "user", committedAt: Date.now(),
            content: [{ type: "text", content: "go" }],
        });
        agent.input({ type: "__test_kick__" });
    };

    await withDriver(agent, async () => {
        seedAndKick();
        await awaitAwaiting(agent, { what: "fsPathGate to ask about the outside path" });

        // the ask covers ONLY the outside path
        const schema = agent.pendingAwaits[0].schema as { detail?: { paths: string[] } };
        assert.equal(schema.detail.paths.length, 1);
        assert.ok(schema.detail.paths[0].endsWith("outside.txt"));

        answerOnce(agent, "out-1", { choice: "once" });
        await awaitLanded(agent);
    });
    const norm = (p: string) => p.replace(/\\/g, "/");
    assert.deepEqual(
        executed.map(norm),
        [`${base}/inside.txt`, `${outside}/outside.txt`].map(norm),
        "whole batch executed after approval",
    );
});

test("fsPathGate: no path params → silence = allow (not a path tool)", async (t) => {
    const base = await makeTempDir(t);
    const { agent, spy, seedAndKick } = makePermAgent([
        () => toolCallTurn([callTo("dummy", { text: "no paths here" }, "np-1")]),
        () => assistantTurn("ok"),
    ], { cwd: base });
    agent.install(createPermissions({
        rules: { paths: { mode: "workspace" } },
        tools: { dummy: { gate: fsPathGate } },
    }));
    await withDriver(agent, async () => {
        seedAndKick();
        await awaitLanded(agent);
    });
    assert.equal(spy.executes, 1);
    assert.equal(agent.pendingAwaits.length, 0);
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("matchEntry: LAST matching pattern wins (broad first, specific after)", () => {
    const tools = {
        "*": { gate: allowAll },
        "github__*": { gate: denyAll },
        "github__push": { gate: null },
    };
    assert.equal(matchEntry(tools, "anything"), tools["*"]);
    assert.equal(matchEntry(tools, "github__gist"), tools["github__*"]);
    assert.equal(matchEntry(tools, "github__push"), tools["github__push"]);
    assert.equal(matchEntry(undefined, "x"), undefined);
});

test("globMatch semantics: * one segment, ** anything, ? one char, case-insensitive, backslashes normalized", () => {
    assert.equal(globMatch("**/.env", "C:/work/deep/.env"), true);
    assert.equal(globMatch("*.ts", "folder/a.ts"), false, "* does NOT cross /");
    assert.equal(globMatch("**/*.ts", "a/b/c.ts"), true);
    assert.equal(globMatch("a?c", "ABC"), true);
    assert.equal(globMatch("a?c", "ABBC"), false);
    assert.equal(globMatch("C:/x/**", "C:\\x\\y\\z"), true);
});

test("CLASSIC_CHOICES vocabulary is stable", () => {
    assert.deepEqual([...CLASSIC_CHOICES], ["once", "session", "no", "no_explain"]);
});

// ---------------------------------------------------------------------------
// bashGate — canonical commands + compound-command safety
// ---------------------------------------------------------------------------

function makeBashAgent(script: Array<() => TurnResult>, opts: { rules?: Record<string, unknown> } = {}) {
    const executed: string[] = [];
    const tool = Tool.define({
        name: "bash",
        description: "shell",
        inputSchema: {
            type: "object",
            properties: { command: { type: "string" }, workdir: { type: "string" } },
            required: ["command"],
        },
        async execute(params) {
            executed.push(String((params as { command?: string }).command));
            return { answer: "ran" };
        },
    });
    const model = new StubModel(script);
    const agent = new Agent({ model, tools: [tool], agentId: "bash-gate-test" });
    agent.install(createPermissions({
        rules: opts.rules ?? {},
        tools: { bash: { gate: bashGate } },
        defaults: { resolve: classicResolve },
    }));
    const seedAndKick = () => {
        agent.messages.push({
            id: `u-${Math.random().toString(36).slice(2, 8)}`,
            enabled: true, type: "user", committedAt: Date.now(),
            content: [{ type: "text", content: "go" }],
        });
        agent.input({ type: "__test_kick__" });
    };
    return { agent, executed, seedAndKick };
}

test("canonicalizeCommand: whitespace + quotes collapse to one form", () => {
    assert.equal(canonicalizeCommand("  git  status "), "git status");
    assert.equal(canonicalizeCommand('"git status"'), "git status");
    assert.equal(canonicalizeCommand("npm   run  check"), "npm run check");
});

test("isCompoundCommand: chains and substitutions detected; plain commands safe", () => {
    assert.equal(isCompoundCommand("git status"), false);
    assert.equal(isCompoundCommand("npm run check -- --filter x"), false);
    assert.equal(isCompoundCommand("git; rm -rf /"), true);
    assert.equal(isCompoundCommand("git status && make deploy"), true);
    assert.equal(isCompoundCommand("cat a | grep x"), true);
    assert.equal(isCompoundCommand("echo `id`"), true);
    assert.equal(isCompoundCommand("echo $(whoami)"), true);
});

test("bashGate: blacklisted command denied WITHOUT executing", async () => {
    const { agent, executed, seedAndKick } = makeBashAgent([
        () => toolCallTurn([callTo("bash", { command: "rm -rf /tmp/x" }, "b-1")]),
        () => assistantTurn("ok"),
    ], { rules: { commands: { blacklist: ["rm -rf **"] } } });
    await withDriver(agent, async () => {
        seedAndKick();
        await awaitLanded(agent);
    });
    assert.equal(executed.length, 0);
    const result = lastToolResult(agent);
    assert.equal(result.content!.error, true);
    assert.match(result.content!.answer!, /blacklisted/);
});

test("bashGate: a `git *` approval NEVER covers a compound command — it asks", async () => {
    const { agent, executed, seedAndKick } = makeBashAgent([
        () => toolCallTurn([callTo("bash", { command: "git; rm -rf /" }, "c-1")]),
        () => assistantTurn("ok"),
    ]);
    // the broad approval exists — and MUST NOT silently cover the compound
    (agent.state as Record<string, unknown>).permission = {
        approvals: [{ tool: "bash", cmd: "git *", createdAt: Date.now() }],
    };
    await withDriver(agent, async () => {
        seedAndKick();
        await awaitAwaiting(agent, { what: "compound command must ask" });
        assert.equal(executed.length, 0, "compound command did NOT run on a wildcard approval");
        assert.equal(agent.pendingAwaits.length, 1);
        const schema = agent.pendingAwaits[0].schema as { title?: string; detail?: { command?: string } };
        assert.match(schema.title ?? "", /compound command/i);
        assert.equal(schema.detail?.command, "git; rm -rf /");
    });
});

test("bashGate: simple command + matching session approval passes silently; canonical form matches", async () => {
    const { agent, executed, seedAndKick } = makeBashAgent([
        () => toolCallTurn([callTo("bash", { command: "git   status" }, "s-1")]),
        () => assistantTurn("ok"),
    ]);
    // approval stored under the CANONICAL form — the raw `git   status` matches it
    (agent.state as Record<string, unknown>).permission = {
        approvals: [{ tool: "bash", cmd: "git status", createdAt: Date.now() }],
    };
    await withDriver(agent, async () => {
        seedAndKick();
        await awaitLanded(agent);
    });
    assert.deepEqual(executed, ["git   status"], "approved simple command executes for real");
    assert.equal(agent.pendingAwaits.length, 0, "no ask");
});

test("bashGate: compound command with an EXACT canonical approval passes silently", async () => {
    const { agent, executed, seedAndKick } = makeBashAgent([
        () => toolCallTurn([callTo("bash", { command: "git status && git log -1" }, "x-1")]),
        () => assistantTurn("ok"),
    ]);
    (agent.state as Record<string, unknown>).permission = {
        approvals: [{ tool: "bash", cmd: "git status && git log -1", createdAt: Date.now() }],
    };
    await withDriver(agent, async () => {
        seedAndKick();
        await awaitLanded(agent);
    });
    assert.deepEqual(executed, ["git status && git log -1"], "exact compound approval passes");
});

test("classicResolve 'session' on a command tool remembers the CANONICAL command", async () => {
    const { agent, executed, seedAndKick } = makeBashAgent([
        () => toolCallTurn([callTo("bash", { command: "npm run check && echo done" }, "n-1")]),
        () => assistantTurn("t1 done"),
        () => toolCallTurn([callTo("bash", { command: "npm   run  check && echo done" }, "n-2")]),
        () => assistantTurn("t2 done"),
    ]);
    // deterministic ask counter: runs AFTER bashGate (priority 100)
    let asks = 0;
    agent.addFilter({
        event: "beforeTool", id: "test/count-asks", priority: 200,
        fn: async (a, e) => {
            const id = (e?.call as { id?: string })?.id;
            if (id && a.pendingAwaits.some((w) => w.type === PERMISSION_AWAIT && w.id === id)) asks++;
        },
    });
    await withDriver(agent, async () => {
        // TURN 1 — compound command, no exact approval → asks; answer "session"
        seedAndKick();
        await awaitAwaiting(agent, { what: "compound command asks first" });
        assert.equal(agent.pendingAwaits.length, 1);
        const ref = agent.pendingAwaits[0].id;
        agent.input({ type: PERMISSION_ANSWER, ref, answer: { choice: "session" } });
        await awaitLanded(agent);

        // TURN 2 — same command, messier spacing: canonical approval covers it
        seedAndKick();
        await awaitLanded(agent);
    });
    assert.deepEqual(
        executed,
        ["npm run check && echo done", "npm   run  check && echo done"],
        "both turns ran",
    );
    assert.equal(asks, 1, "only the FIRST turn asked — canonical approval covered the messy spacing");
    const st = agent.state.permission as { approvals?: Array<{ tool?: string; cmd?: string }> };
    assert.equal(st.approvals?.[0]?.cmd, "npm run check && echo done", "approval stored canonical");
    assert.equal(st.approvals?.length, 1, "only one approval — spacing didn't duplicate it");
});
