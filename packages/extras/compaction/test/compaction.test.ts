// packages/extras/compaction/test/compaction.test.ts — the unified explicit-pick extra.
// Pure engines (messageText/recentTail/rebuild/shake/prune/summarizer/handoff/remote-route)
// plus the plugin through REAL turns under the eternal heartbeat (withDriver).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, EVENTS, Tool } from "@sanityloop/core";
import type { Message, TurnResult } from "@sanityloop/core";
import {
    createCompaction,
    createSoftSummarizer,
    createHandoffRun,
    runRemoteSummary,
    shakeMessages,
    pruneMessages,
    findBlockRanges,
    estimateTokens,
    messageText,
    recentTail,
    rebuildWithSummary,
} from "@sanityloop/compaction";
import { requestCompactInput } from "@sanityloop/util";
import { StubModel, assistantTurn, withDriver } from "@sanityloop/test-kit/core";
import { awaitLanded, awaitIdle, waitUntil } from "@sanityloop/test-kit";

const text = (id: string, type: Message["type"], content: string): Message =>
    ({ id, enabled: true, type, content: [{ type: "text", content }] }) as Message;
const toolResult = (id: string, answer: string, extra: Record<string, unknown> = {}): Message =>
    ({ id, enabled: true, type: "toolResult", content: { answer, stored: {} }, ...extra }) as Message;

// ---------------------------------------------------------------------------
// messageText — what the summarizer sees
// ---------------------------------------------------------------------------

test("messageText: text blocks, typeless fragments, tool answers, nulls", () => {
    assert.equal(messageText(text("a", "user", "hi")), "hi");
    // typeless compound fragments { id, content } are text — dropping them
    // means summaries built from compound messages silently lose content
    assert.equal(
        messageText({ id: "s", enabled: true, type: "system-compound", content: [{ id: "f", content: "frag" }] } as Message),
        "frag",
    );
    assert.equal(messageText(toolResult("r", "the answer")), "the answer");
    // UNION: block answers flatten for the summarizer (text + descriptors)
    assert.equal(
        messageText(toolResult("rb", [{ type: "text", content: "shot:" }, { type: "image", data: "xx", mimeType: "image/png" }] as never)),
        "shot:\n[image omitted — text-only fallback]",
    );
    assert.equal(messageText({ id: "n", enabled: true, type: "toolResult", content: null } as Message), "");
    assert.equal(messageText(text("m", "user", "")), "");
});

// ---------------------------------------------------------------------------
// recentTail — alternation trims around the summary-as-user
// ---------------------------------------------------------------------------

test("recentTail: keep window, never starts user/toolResult, never ends assistant", () => {
    const snap: Message[] = [
        text("u1", "user", "one"),
        text("a1", "assistant", "two"),
        text("u2", "user", "three"),
        text("a2", "assistant", "four"),
        text("u3", "user", "five"),
    ];
    // keep 2 → window [a2, u3], no trims needed
    let tail = recentTail(snap, [], 2);
    assert.deepEqual(tail.map((m) => m.id), ["a2", "u3"]);
    // keep 3 → [u2, a2, u3] → leading user shifts → [a2, u3]
    tail = recentTail(snap, [], 3);
    assert.deepEqual(tail.map((m) => m.id), ["a2", "u3"]);
    // slice(0,4) = [u1,a1,u2,a2] → leading user shifts, trailing assistant pops
    tail = recentTail(snap.slice(0, 4), [], 4);
    assert.deepEqual(tail.map((m) => m.id), ["a1", "u2"]);
    // systems never in the tail; extra (mid-compaction arrivals) preserved
    const sys = text("sys", "system", "rules");
    tail = recentTail([sys, ...snap], [text("live", "user", "arrived mid-compact")], 1);
    assert.ok(tail.every((m) => m.type !== "system"), "no systems in tail");
    assert.equal(tail.at(-1)!.id, "live", "mid-compaction arrivals survive");
});

// ---------------------------------------------------------------------------
// rebuildWithSummary — the one splice dance
// ---------------------------------------------------------------------------

test("rebuildWithSummary: [systems + summary-as-user + tail], state stamped", () => {
    const agent = { messages: [] as Message[], state: {} as Record<string, unknown>, loopState: "idle", wake: () => {}, setState(k: string, v: unknown) { this.state[k] = v; } };
    const snapshot: Message[] = [
        text("sys", "system", "rules"),
        text("u1", "user", "old work"),
        text("a1", "assistant", "old reply"),
        text("u2", "user", "recent q"),
        text("a2", "assistant", "recent a"),
    ];
    agent.messages.push(...snapshot);
    rebuildWithSummary(agent, snapshot, "SUMMARY HERE", { keepRecent: 3, stateKey: "compaction", label: "soft" });
    // keep 3 → window [a1, u2, a2] → trailing a2 pops → [a1, u2] survives
    const ids = agent.messages.map((m) => m.id);
    assert.deepEqual(ids, ["sys", agent.messages[1].id, "a1", "u2"], "systems + summary + surviving tail");
    assert.equal(agent.messages[1].type, "user", "summary rides as USER");
    assert.match((agent.messages[1].content as Array<{ content: string }>)[0].content, /SUMMARY HERE/);
    assert.match((agent.messages[1].content as Array<{ content: string }>)[0].content, /soft/);
    assert.ok(!ids.includes("u1"), "old history gone");
    const rec = agent.state.compaction as Record<string, unknown>;
    assert.equal(rec.method, "soft");
    assert.equal(rec.summary, "SUMMARY HERE");
    assert.ok(typeof rec.at === "number");
});

// ---------------------------------------------------------------------------
// findBlockRanges + shake/prune — the sync in-place engines
// ---------------------------------------------------------------------------

test("findBlockRanges: fenced + top-level XML spans; unterminated yields nothing", () => {
    const text1 = "intro\n```js\nconst x = 1;\n```\noutro";
    const ranges = findBlockRanges(text1);
    assert.equal(ranges.length, 1);
    assert.equal(text1.slice(ranges[0].start, ranges[0].end), "```js\nconst x = 1;\n```");
    const xml = "head\n<result>\nbig blob\n</result>\ntail";
    const xr = findBlockRanges(xml);
    assert.equal(xr.length, 1);
    assert.equal(xml.slice(xr[0].start, xr[0].end), "<result>\nbig blob\n</result>");
    assert.deepEqual(findBlockRanges("```js\nnever closed"), [], "unterminated fence → no range");
    assert.deepEqual(findBlockRanges("<open>\nnever closed"), [], "unterminated tag → no range");
    // XML suppressed inside fences
    assert.equal(findBlockRanges("```\n<notxml>\n```").length, 1, "fence wins, tag inside ignored");
});

test("shakeNow: elides stale regions, protects the tail + skill reads, idempotent", () => {
    const big = `wall\n\`\`\`\n${"x".repeat(4000)}\n\`\`\`\ntail`;
    const msgs: Message[] = [
        toolResult("old", big, { toolName: "bash", toolCallId: "c1" }),
        toolResult("skill", big, { toolName: "skill", toolCallId: "c2" }),
        toolResult("new", "fresh small answer", { toolName: "bash", toolCallId: "c3" }),
    ];
    const out = shakeMessages(msgs, { protectTokens: 10, minSavings: 0, fenceMinTokens: 100 });
    assert.ok(out.regions >= 1, "old region elided");
    assert.ok(out.tokensSaved > 0);
    const oldAnswer = (msgs[0].content as { answer: string }).answer;
    assert.ok(oldAnswer.includes("elided"), `old answer elided, got: ${oldAnswer.slice(0, 80)}`);
    assert.equal((msgs[1].content as { answer: string }).answer, big, "skill reads never touched");
    assert.equal((msgs[2].content as { answer: string }).answer, "fresh small answer", "protected tail intact");
    // own placeholders are terminal: shake → shake harder (remainder blanks)
    // → third call is a TRUE no-op (regions 0, count honest, no double-count)
    const second = shakeMessages(msgs, { protectTokens: 10, minSavings: 0, fenceMinTokens: 100 });
    assert.ok(second.regions >= 1, "re-shake takes the remainder");
    const frozen = (msgs[0].content as { answer: string }).answer;
    assert.match(frozen, /^\[shaken — \d+ tokens of bash output elided\]$/, "full placeholder, count from the remainder");
    const third = shakeMessages(msgs, { protectTokens: 10, minSavings: 0, fenceMinTokens: 100 });
    assert.deepEqual(third, { regions: 0, tokensSaved: 0 }, "placeholder never re-shaken");
    assert.equal((msgs[0].content as { answer: string }).answer, frozen);
});

test("shakeNow: minSavings gate holds back small wins", () => {
    const msgs: Message[] = [toolResult("r", "small", { toolName: "bash", toolCallId: "c1" })];
    const out = shakeMessages(msgs, { protectTokens: 0, minSavings: 999_999 });
    assert.deepEqual(out, { regions: 0, tokensSaved: 0 });
    assert.equal((msgs[0].content as { answer: string }).answer, "small", "gated → untouched");
});

test("pruneNow: blanks stale results, protects tail + tools, undo restores", () => {
    const msgs: Message[] = [
        toolResult("old1", "ancient output one", { toolName: "bash", toolCallId: "c1" }),
        toolResult("old2", "ancient output two", { toolName: "bash", toolCallId: "c2" }),
        toolResult("new", "fresh", { toolName: "bash", toolCallId: "c3" }),
    ];
    const out = pruneMessages(msgs, { protectTokens: 2, minimumSavings: 0 });
    assert.equal(out.prunedCount, 2);
    assert.ok(out.tokensSaved > 0);
    for (const id of ["old1", "old2"]) {
        const m = msgs.find((x) => x.id === id)!;
        assert.match((m.content as { answer: string }).answer, /pruned/, `${id} blanked`);
    }
    assert.equal((msgs[2].content as { answer: string }).answer, "fresh", "tail survives");
    out.undo();
    assert.equal((msgs[0].content as { answer: string }).answer, "ancient output one", "undo restores");
    assert.equal((msgs[1].content as { answer: string }).answer, "ancient output two");
});

test("pruneNow: block answers blank to a single text block; undo restores blocks", () => {
    const blocks = [{ type: "text", content: "big wall of text here" }, { type: "image", data: "xx", mimeType: "image/png" }];
    const msgs: Message[] = [toolResult("b", blocks as never, { toolName: "shot", toolCallId: "c9" })];
    const out = pruneMessages(msgs, { protectTokens: 0, minimumSavings: 0 });
    assert.equal(out.prunedCount, 1, "block answers are eligible for pruning");
    const face = msgs[0].content as { answer: unknown };
    assert.ok(Array.isArray(face.answer), "union shape survives — still an array, not a raw string");
    assert.deepEqual(face.answer, [{ type: "text", content: "[pruned — output blanked to reclaim context]" }]);
    out.undo();
    assert.deepEqual((msgs[0].content as { answer: unknown }).answer, blocks, "undo restores the original blocks");
});
test("pruneNow: protected tools survive; catastrophic null-content skipped", () => {
    const msgs: Message[] = [
        toolResult("skill", "skill text", { toolName: "skill", toolCallId: "c1" }),
        { id: "dead", enabled: true, type: "toolResult", content: null } as Message,
        toolResult("victim", "big victim output here", { toolName: "bash", toolCallId: "c2" }),
    ];
    const out = pruneMessages(msgs, { protectTokens: 0, minimumSavings: 0 });
    assert.equal(out.prunedCount, 1);
    assert.equal((msgs[0].content as { answer: string }).answer, "skill text");
    assert.equal(msgs[1].content, null);
});

// ---------------------------------------------------------------------------
// createSoftSummarizer — clamp, chaining, override
// ---------------------------------------------------------------------------

test("soft summarizer: summarize-override wins; previousSummary chains into the prompt", async () => {
    let seen: Message[] = [];
    const fake = {
        model: {
            async callNextTurn(ctx: { messages: Message[] }) {
                seen = ctx.messages;
                return { message: text("s", "assistant", "the summary") };
            },
        },
    };
    // override path — model never called
    const over = createSoftSummarizer(fake, { summarize: async (msgs) => `n=${msgs.length}` });
    assert.equal(await over([text("u", "user", "x")]), "n=1");
    // built-in path — flat system+user, previous summary chained
    const sum = createSoftSummarizer(fake, { previousSummary: "OLD", focus: "SHINY", maxWords: 10 });
    assert.equal(await sum([text("u", "user", "work happened")]), "the summary");
    assert.equal(seen.length, 2);
    assert.equal(seen[0].type, "system");
    const instr = (seen[0].content as Array<{ content: string }>)[0].content;
    assert.match(instr, /OLD/, "previous summary chained");
    assert.match(instr, /SHINY/, "focus appended");
    assert.match(instr, /10 words/);
    assert.equal(seen[1].type, "user");
    // maxOutputTokens restored after the call (side-channel must not leak the cap)
    assert.equal((fake.model as { maxOutputTokens?: unknown }).maxOutputTokens, undefined);
});

test("soft summarizer: input clamped newest-first to ~500 tokens; empty → marker", async () => {
    let seenUser = "";
    const fake = {
        model: {
            async callNextTurn(ctx: { messages: Message[] }) {
                seenUser = (ctx.messages[1].content as Array<{ content: string }>)[0].content;
                return { message: text("s", "assistant", "   ") }; // whitespace-only → marker
            },
        },
    };
    const msgs: Message[] = [];
    for (let i = 0; i < 20; i++) msgs.push(text(`u${i}`, "user", `message number ${i} ` + "pad ".repeat(50)));
    const sum = createSoftSummarizer(fake, {});
    assert.equal(await sum(msgs), "(empty summary)", "empty reply → marker, never blank");
    assert.ok(seenUser.length / 4 <= 600, `clamped, got ~${Math.ceil(seenUser.length / 4)} tokens`);
    assert.match(seenUser, /message number 19/, "newest kept");
    assert.ok(!seenUser.includes("message number 0"), "oldest dropped");
});

// ---------------------------------------------------------------------------
// createHandoffRun — two-phase lifecycle
// ---------------------------------------------------------------------------

test("handoff run: start injects request + wakes; reset clears", () => {
    const run = createHandoffRun({ instruction: "WRITE IT" });
    assert.equal(run.pending(), false);
    let woke = 0;
    const agent = { messages: [text("u", "user", "work")], wake: () => { woke++; } };
    run.start(agent);
    assert.equal(run.pending(), true);
    assert.equal(woke, 1);
    assert.equal(run.snapshot().length, 1, "snapshot = pre-request history");
    assert.equal(agent.messages.length, 2);
    assert.equal(agent.messages[1].id, run.requestId());
    assert.match((agent.messages[1].content as Array<{ content: string }>)[0].content, /WRITE IT/);
    run.reset();
    assert.equal(run.pending(), false);
    assert.equal(run.requestId(), "");
});

// ---------------------------------------------------------------------------
// runRemoteSummary — gated route, no real network
// ---------------------------------------------------------------------------

test("runRemoteSummary: picks the available compactor; mismatch throws (history intact)", async () => {
    const okCompactor = {
        id: "fake",
        available: () => true,
        compact: async () => ({ summary: "REMOTE SUMMARY", preserveData: { k: 1 } }),
    };
    const out = await runRemoteSummary({ provider: "x", model: "y" }, [text("u", "user", "work")], {
        compactors: [okCompactor],
        focus: "F",
    });
    assert.equal(out.summary, "REMOTE SUMMARY");
    assert.equal(out.compactorId, "fake");
    assert.deepEqual(out.preserveData, { k: 1 });
    // no available route → throws; the PLUGIN records + keeps history (tested below)
    await assert.rejects(
        runRemoteSummary({ provider: "x", model: "y" }, [], {
            compactors: [{ id: "nope", available: () => false, compact: async () => ({ summary: "" }) }],
        }),
        /no compactor available/,
    );
});

// ---------------------------------------------------------------------------
// The plugin through REAL turns
// ---------------------------------------------------------------------------

function scriptedAgent(script: Array<() => TurnResult>, opts: Parameters<typeof createCompaction>[0] = {}) {
    const model = new StubModel(script);
    const agent = new Agent({ model, agentId: "compaction-test" });
    const handle = createCompaction({ method: "soft", ...opts });
    agent.use(handle.plugin);
    return { agent, handle };
}

function seed(agent: Agent, n: number): void {
    for (let i = 0; i < n; i++) {
        agent.messages.push(text(`u${i}`, "user", `question ${i}`));
        agent.messages.push(text(`a${i}`, "assistant", `answer ${i}`));
    }
}

test("plugin/soft: on-demand request_compact rebuilds history at the landing", async () => {
    const { agent } = scriptedAgent([() => assistantTurn("still here")], {
        soft: { summarize: async () => "COMPACTED SUMMARY" },
        keepRecent: 2,
    });
    seed(agent, 6); // 12 messages of old work
    const before = agent.messages.length;
    await withDriver(agent, async () => {
        agent.input({ type: requestCompactInput, reason: "test" });
        await waitUntil(() => (agent.state.compaction as { summary?: string } | undefined)?.summary === "COMPACTED SUMMARY", {
            what: "soft compaction to rebuild",
            timeoutMs: 10000,
        });
        await awaitLanded(agent);
    });
    assert.ok(agent.messages.length < before, `shrunk: ${before} → ${agent.messages.length}`);
    const summary = agent.messages.find((m) => m.id.startsWith("summary-soft-"));
    assert.ok(summary, "summary message present");
    assert.match((summary!.content as Array<{ content: string }>)[0].content, /COMPACTED SUMMARY/);
    assert.equal(summary!.type, "user");
    // rebuild wakes the loop → the owed summary gets its live reply AFTER the splice
    const last = agent.messages.at(-1)!;
    assert.equal(last.type, "assistant");
    assert.match((last.content as Array<{ content: string }>)[0].content, /still here/);
    await agent.terminate();
});

test("plugin/soft: threshold watcher fires stop → compact → wake (no manual input)", async () => {
    // afterProviderResponse fires BEFORE recordStats commits, so the watcher
    // reads the PREVIOUS turn's usage (one turn of lag, by core design).
    // Two turns: turn 1 stamps usage, turn 2's event trips the watcher.
    const model = new StubModel([() => assistantTurn("one"), () => assistantTurn("two")]);
    (model as unknown as { maxContext?: number }).maxContext = 1000;
    const agent = new Agent({ model, agentId: "compaction-watcher" });
    agent.use(createCompaction({ method: "soft", threshold: 0.0001, soft: { summarize: async () => "AUTO" }, keepRecent: 1 }).plugin);
    seed(agent, 3);
    agent.messages.push(text("u-live", "user", "go"));
    await withDriver(agent, async () => {
        agent.input({ type: "__test_kick__" });
        await waitUntil(() => agent.stats.contextUsage !== undefined, { what: "turn 1 to stamp usage", timeoutMs: 15000 });
        agent.messages.push(text("u-live-2", "user", "again"));
        agent.input({ type: "__test_kick__" });
        await waitUntil(() => (agent.state.compaction as { summary?: string } | undefined)?.summary === "AUTO", {
            what: "threshold compaction to fire",
            timeoutMs: 15000,
        });
        await awaitIdle(agent);
    });
    assert.ok(agent.messages.some((m) => m.id.startsWith("summary-soft-")), "watcher compacted");
    await agent.terminate();
});

test("plugin/shake: threshold watcher elides inline — no rebuild, no stop", async () => {
    // same one-turn usage lag as soft (see above) — two turns trip the watcher
    const model = new StubModel([() => assistantTurn("one"), () => assistantTurn("two")]);
    (model as unknown as { maxContext?: number }).maxContext = 1000;
    const agent = new Agent({ model, agentId: "compaction-shake" });
    const big = `data\n\`\`\`\n${"z".repeat(6000)}\n\`\`\``;
    agent.use(
        createCompaction({ method: "shake", threshold: 0.0001, shake: { protectTokens: 0, minSavings: 0, fenceMinTokens: 100 } }).plugin,
    );
    agent.messages.push(toolResult("old", big, { toolName: "bash", toolCallId: "c1" }));
    agent.messages.push(text("u-live", "user", "go"));
    await withDriver(agent, async () => {
        agent.input({ type: "__test_kick__" });
        await waitUntil(() => agent.stats.contextUsage !== undefined, { what: "turn 1 to stamp usage", timeoutMs: 15000 });
        agent.messages.push(text("u-live-2", "user", "again"));
        agent.input({ type: "__test_kick__" });
        await waitUntil(() => (agent.state.compaction as { method?: string } | undefined)?.method === "shake", {
            what: "shake watcher to stamp state",
            timeoutMs: 15000,
        });
        await awaitIdle(agent);
    });
    const ans = (agent.messages.find((m) => m.id === "old")!.content as { answer: string }).answer;
    assert.ok(ans.includes("elided"), "stale region elided inline");
    await agent.terminate();
});

test("plugin/remote: unavailable route keeps history INTACT + records the error", async () => {
    const { agent } = scriptedAgent([() => assistantTurn("reply")], {
        method: "remote",
        remote: { compactors: [{ id: "never", available: () => false, compact: async () => ({ summary: "?" }) }] },
        keepRecent: 2,
    });
    seed(agent, 4);
    const before = agent.messages.map((m) => m.id);
    await withDriver(agent, async () => {
        agent.input({ type: requestCompactInput });
        await waitUntil(() => (agent.state.compaction as { error?: string } | undefined)?.error !== undefined, {
            what: "remote failure to record",
            timeoutMs: 10000,
        });
        await awaitLanded(agent);
    });
    const after = agent.messages.map((m) => m.id);
    assert.ok(before.every((id) => after.includes(id)), "every pre-compaction message preserved — no silent fallback");
    assert.match(String((agent.state.compaction as { error: string }).error), /no compactor available/);
    await agent.terminate();
});

test("plugin/handoff: catcher rebuilds from the in-loop reply at turnEnd", async () => {
    const handoffTool = Tool.define({
        name: "write",
        description: "w",
        inputSchema: { type: "object" },
        async execute() {
            return { answer: "written" };
        },
    });
    const model = new StubModel([() => assistantTurn("THEME: test handover\nQUICK: it worked\nWALK: x\nFINAL: done")]);
    const agent = new Agent({ model, tools: [handoffTool], agentId: "compaction-handoff" });
    agent.use(createCompaction({ method: "handoff", keepRecent: 1 }).plugin);
    seed(agent, 4);
    const before = agent.messages.length;
    await withDriver(agent, async () => {
        agent.input({ type: requestCompactInput });
        await waitUntil(() => (agent.state.compaction as { method?: string } | undefined)?.method === "handoff", {
            what: "handoff catcher to rebuild",
            timeoutMs: 15000,
        });
        await awaitLanded(agent);
    });
    assert.ok(agent.messages.length < before, `rebuilt: ${before} → ${agent.messages.length}`);
    const summary = agent.messages.find((m) => m.id.startsWith("summary-handoff-"));
    assert.ok(summary, "handover summary present");
    assert.match((summary!.content as Array<{ content: string }>)[0].content, /THEME: test handover/);
    await agent.terminate();
});

test("plugin: shrink_context tool — shake/prune/compact modes", async () => {
    const { agent } = scriptedAgent([() => assistantTurn("reply")], {
        exposeTool: true,
        shake: { protectTokens: 0, minSavings: 0, fenceMinTokens: 100 },
        prune: { protectTokens: 0, minimumSavings: 0 },
        soft: { summarize: async () => "TOOLED" },
        keepRecent: 1,
    });
    const tool = agent.tools.find((t) => t.name === "shrink_context");
    assert.ok(tool, "shrink_context exposed");
    const big = `x\n\`\`\`\n${"q".repeat(5000)}\n\`\`\``;
    agent.messages.push(toolResult("r1", big, { toolName: "bash", toolCallId: "c1" }));
    agent.messages.push(toolResult("r2", big, { toolName: "bash", toolCallId: "c2" }));
    const exec = tool!.execute as (p: unknown) => { answer: string; stored: unknown };
    const shakeOut = exec({ mode: "shake" });
    assert.match(shakeOut.answer, /shook \d+ region/);
    const pruneOut = exec({ mode: "prune" });
    assert.match(pruneOut.answer, /pruned \d+ result/);
    // compact mode schedules at the landing (no loop running → runs now)
    await withDriver(agent, async () => {
        const compactOut = exec({ mode: "compact" });
        assert.match(compactOut.answer, /scheduled/);
        await waitUntil(() => (agent.state.compaction as { summary?: string } | undefined)?.summary === "TOOLED", {
            what: "tool-scheduled compaction",
            timeoutMs: 10000,
        });
        await awaitLanded(agent);
    });
    assert.ok(exec({} as never).answer.includes("mode required"), "missing mode → honest error");
    await agent.terminate();
});

test("plugin: install/uninstall cleans filters + capability; handle safe unbound", async () => {
    const handle = createCompaction({ method: "prune" });
    assert.equal(handle.method, "prune");
    assert.deepEqual(handle.shakeNow(), { regions: 0, tokensSaved: 0 }, "unbound shake → zero, no crash");
    assert.equal(handle.pruneNow().prunedCount, 0, "unbound prune → zero, no crash");
    handle.requestCompact(); // unbound → silent no-op
    const model = new StubModel([]);
    const agent = new Agent({ model, agentId: "compaction-clean" });
    agent.use(handle.plugin);
    const own = agent.filters.filter((f) => f.id.startsWith("compaction/")).length;
    assert.ok(own >= 4, `watcher+onDemand+trigger+cleanup installed, got ${own}`);
    assert.ok(agent.listDeclaredCapabilities().some((c) => c.id === "compaction:prune"), "capability declared");
    agent.uninstall("compaction");
    assert.equal(agent.filters.filter((f) => f.id.startsWith("compaction/")).length, 0, "uninstall removes every compaction filter");
    assert.ok(!agent.listDeclaredCapabilities().some((c) => c.id === "compaction:prune"), "capability removed");
    // abort mid-compact clears the flag (cleanup filter)
    agent.use(handle.plugin);
    agent.state.compacting = true;
    agent.abort("test");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(agent.state.compacting, false, "cleanup clears compacting on abort");
    await agent.terminate();
});

test("estimateTokens: char/4 ceiling, shared with the loop estimator", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("abcde"), 2);
});
