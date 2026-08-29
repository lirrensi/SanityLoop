// ============================================================================
// tests/extras/storage.test.ts — @sanityloop/base-storage: tape + card + restore.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
    jsonlSession,
    readStateCard,
    writeStateCard,
    STATE_VERSION,
    JsonlLog,
} from "@sanityloop/base-storage";
import type { StorageRecord } from "@sanityloop/base-storage";
import { EVENTS } from "@sanityloop/core";
import type { GodObject, Tool } from "@sanityloop/core";
import { makeAgent, kick, withDriver } from "@sanityloop/test-kit/core";
import type { Agent } from "@sanityloop/core";
import { assistantTurn } from "@sanityloop/test-kit/core";
import { awaitIdle, awaitLanded, sleep } from "@sanityloop/test-kit";
import { makeTempDir } from "@sanityloop/test-kit";

/** THE whitelist — docs/reference/state.md, verified against session.ts. */
const TAPE_KEYS = [
    "id", "agentId", "messages", "state", "stats", "loopState",
    "pendingAwaits", "pendingQuestions", "currentAction", "lastResponse",
    "capabilities", "cwd", "description", "activity",
];

async function readTapeRecords(dir: string): Promise<StorageRecord[]> {
    const raw = await readFile(join(dir, "session.jsonl"), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    // line 0 is the version header
    const header = JSON.parse(lines[0]!) as { v: number; kind: string };
    assert.equal(header.kind, "sanity-jsonl");
    assert.equal(header.v, 1);
    return lines.slice(1).map((l) => JSON.parse(l) as StorageRecord);
}

test("jsonlSession(path) returns { dir, storage, plugin, restoreInto }", async (t) => {
    const base = await makeTempDir(t);
    const session = jsonlSession(join(base, "sess"));
    assert.equal(typeof session.dir, "string");
    assert.ok(session.storage, "storage provider present");
    assert.equal(session.plugin.id, "session-storage");
    assert.equal(typeof session.restoreInto, "function");
});

test("baseline card contains EXACTLY the TAPE_KEYS whitelist (fresh tape)", async (t) => {
    const base = await makeTempDir(t);
    const dir = join(base, "baseline");
    const { agent } = makeAgent({ script: [], description: "tape me" });
    const session = jsonlSession(dir);
    agent.install(session.plugin);
    await session.storage.flush(); // baseline appends are queued async — drain before reading

    const records = await readTapeRecords(session.dir);
    const keys = [...new Set(records.map((r) => r.change.key))].sort();
    assert.deepEqual(keys, [...TAPE_KEYS].sort());
    // every record is a proper {t, change:{key,path,op,value}} envelope
    for (const r of records) {
        assert.equal(typeof r.t, "number");
        assert.equal(r.change.op, "set");
        assert.equal(r.change.path, r.change.key, "baseline sets whole keys");
    }
});

test("ephemeral churn stays OFF the tape: runState / tickPlan / transient never appear", async (t) => {
    const base = await makeTempDir(t);
    const session = jsonlSession(join(base, "ephemeral"));
    const { agent } = makeAgent({ script: [] });
    agent.install(session.plugin);
    await session.storage.flush();

    agent.runState = "generating";
    (agent as unknown as { tickPlan: string[] }).tickPlan = ["drain-inputs"];
    agent.transient.currentEvent = { type: "whatever" };
    agent.input({ type: "__test_flush__", async: true }); // dispatch pending patches
    await sleep(30); // settle beat — see deltas test note
    await session.storage.flush();

    const records = await readTapeRecords(session.dir);
    const keys = new Set(records.map((r) => r.change.key));
    assert.equal(keys.has("runState"), false);
    assert.equal(keys.has("tickPlan"), false);
    assert.equal(keys.has("transient"), false);
});

test("deltas append { t, change } lines after the baseline", async (t) => {
    const base = await makeTempDir(t);
    const session = jsonlSession(join(base, "deltas"));
    const { agent } = makeAgent({ script: [] });
    agent.install(session.plugin);
    await session.storage.flush(); // baseline on disk before we count

    const before = (await readTapeRecords(session.dir)).length;
    agent.setState("k", 1);
    // deliver the patched event through a seam. NOTE: a sleep beat is REQUIRED
    // before flush() — the async-input microtask chains the append onto the
    // tape queue, and flush() awaits the chain it sees at call time.
    agent.input({ type: "__test_flush__", async: true });
    await sleep(30);
    await session.storage.flush();

    const records = await readTapeRecords(session.dir);
    assert.ok(records.length > before, "tape grew");
    const delta = records.find((r) => r.change.path === "state.k");
    assert.ok(delta, "state.k delta taped");
    assert.deepEqual(delta!.change, { key: "state", path: "state.k", op: "set", value: 1 });
});

test("FLUSH BEFORE RESTORE: unflushed buffered appends are read by restoreInto", async (t) => {
    const base = await makeTempDir(t);
    const session = jsonlSession(join(base, "flushed"));
    const a = makeAgent({ script: [] }).agent;
    a.install(session.plugin);
    a.setState("unflushed-but-taped", "yes");
    a.input({ type: "__test_flush__", async: true }); // dispatches patched → tape queue
    await sleep(30); // let the microtask chain the appends BEFORE restore flushes
    // deliberately NOT calling storage.flush() here

    const b = makeAgent({ script: [] }).agent;
    const restored = await session.restoreInto(b);
    assert.equal(restored, true);
    assert.equal(b.state["unflushed-but-taped"], "yes");
});

test("RESTORE ROUND-TRIP (component scale): messages, identity, stats survive", async (t) => {
    const base = await makeTempDir(t);
    const session = jsonlSession(join(base, "roundtrip"));
    const a = makeAgent({
        script: [() => assistantTurn("first reply")],
        description: "traveler",
    }).agent;
    a.install(session.plugin);
    a.setState("mood", "fine");

    // one real turn so messages + stats hit the tape
    a.messages.push({ id: "u1", enabled: true, type: "user", committedAt: Date.now(), content: [{ type: "text", content: "hi" }] });
    kick(a);
    await awaitIdle(a);

    const b = makeAgent({ script: [] }).agent;
    assert.equal(await session.restoreInto(b), true);
    assert.equal(b.id, a.id, "session identity restored");
    assert.equal(b.description, "traveler");
    assert.equal(b.state.mood, "fine");
    assert.deepEqual(
        b.messages.map((m) => ({ id: m.id, type: m.type, content: m.content })),
        a.messages.map((m) => ({ id: m.id, type: m.type, content: m.content })),
    );
    assert.equal(b.lastResponse, a.lastResponse);
    assert.equal(b.stats.totalTokens, a.stats.totalTokens);
    // ONE merged event semantics: restoring fired merged on b
});

test("restore replays are SILENT except ONE merged event (no patch storm)", async (t) => {
    const base = await makeTempDir(t);
    const session = jsonlSession(join(base, "silent"));
    const a = makeAgent({ script: [] }).agent;
    a.install(session.plugin);
    a.setState("x", 42);
    a.input({ type: "__test_flush__", async: true });
    await sleep(30);

    const b = makeAgent({ script: [] }).agent;
    let merged = 0;
    let patched = 0;
    b.addFilter({ event: EVENTS.merged, id: "t/merged", priority: 0, fn: async () => void merged++ });
    b.addFilter({ event: EVENTS.patched, id: "t/patched", priority: 0, fn: async (_ag, e) => {
        const change = e?.change as { key?: string } | undefined;
        if (change?.key === "state") patched++;
    } });
    await session.restoreInto(b);
    assert.equal(merged, 1, "exactly one merged announcement");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(patched, 0, "restore applies silently — no patched storm");
});

test("version mismatch SCREAMS: reading a future-version card throws", async (t) => {
    const base = await makeTempDir(t);
    const dir = join(base, "vcard");
    await writeStateCard(dir, { id: "x", activity: "", cwd: ".", loopState: "idle", runState: "none", version: 999 } as never);
    assert.throws(() => readStateCard(dir), /version mismatch.*v999.*v1/s);
});

test("a TORN/corrupt card is IGNORED — the tape is the truth", async (t) => {
    const base = await makeTempDir(t);
    const dir = join(base, "torn");
    const session = jsonlSession(dir);
    const { agent } = makeAgent({ script: [] });
    agent.install(session.plugin);
    agent.setState("survivor", true);
    agent.input({ type: "__test_flush__", async: true });
    await sleep(30);

    // give the dir a real card first, then tear it
    await writeStateCard(dir, { id: "x", activity: "", cwd: ".", loopState: "idle", runState: "none" });
    await writeFile(join(dir, "state.json"), "{oops half-written", "utf8");
    assert.equal(readStateCard(dir), null, "corrupt card reads as null");
    // ...and restore still works off the tape alone
    const b = makeAgent({ script: [] }).agent;
    assert.equal(await session.restoreInto(b), true);
    assert.equal(b.state.survivor, true);
});

test("the landing writes the ATOMIC state.json card (versioned, no .tmp leftover)", async (t) => {
    const base = await makeTempDir(t);
    const dir = join(base, "card");
    const session = jsonlSession(dir);
    const { agent } = makeAgent({ script: [() => assistantTurn("landed")] });
    agent.install(session.plugin);

    agent.messages.push({ id: "u1", enabled: true, type: "user", committedAt: Date.now(), content: [{ type: "text", content: "go" }] });
    kick(agent);
    await awaitIdle(agent);

    assert.ok(existsSync(join(dir, "state.json")), "card written at the landing (sync writer)");
    assert.equal(existsSync(`${join(dir, "state.json")}.tmp`), false, "atomic rename leaves no tmp behind");
    const card = readStateCard(dir)!;
    assert.ok(card, "card parses");
    assert.equal(card.version, STATE_VERSION);
    assert.equal((card as unknown as { loopState: string }).loopState, "idle");
    assert.equal(typeof (card as unknown as { messages: number }).messages, "number", "snapshot carries a message COUNT");
    assert.ok(Array.isArray((card as unknown as { transcript: unknown[] }).transcript), "snapshot carries the transcript");
});

test("JsonlLog.size() is DISK-honest: a fresh instance over an existing tape resumes counting", async (t) => {
    const base = await makeTempDir(t);
    const dir = join(base, "diskhonest");
    const log1 = new JsonlLog({ dir });
    log1.append({ t: 1, change: { key: "state", path: "state.a", op: "set", value: 1 } });
    log1.append({ t: 2, change: { key: "state", path: "state.b", op: "set", value: 2 } });
    await log1.flush();
    assert.equal(log1.size(), 2);

    const log2 = new JsonlLog({ dir }); // brand-new instance, same file
    assert.equal(log2.size(), 2, "resume sees disk truth, not zero");
    const replayed = await log2.replay();
    assert.equal(replayed.length, 2);
});

test("replay drops a TORN TAIL (crash mid-append) instead of failing", async (t) => {
    const base = await makeTempDir(t);
    const dir = join(base, "torn-tail");
    const log = new JsonlLog({ dir });
    log.append({ t: 1, change: { key: "state", path: "state.a", op: "set", value: 1 } });
    await log.flush();
    // simulate the crash: garbage half-line at the end
    const path = join(dir, "session.jsonl");
    await writeFile(path, (await readFile(path, "utf8")).concat('{"t":2,"change":{"key":"sta'), "utf8");
    const records = await log.replay();
    assert.equal(records.length, 1, "only whole records survive");
});

// ---------------------------------------------------------------------------
// CRASH HEAL — at-most-once with healing (Crack 1).
// A tape ending with an OWED toolCall + partial results = a mid-batch crash.
// The tools that never ran must NOT auto-execute on resume.
// ---------------------------------------------------------------------------

/** Hand-write a "crash" tape. Mid-batch: user → toolCall(alpha,beta) →
 * toolResult(alpha only) — A committed, B never ran. Parked: user →
 * toolCall(alpha,beta) with NOTHING executed + a pending permission ask —
 * the crash happened at the gate, before any tool ran. */
function writeCrashTape(session: { storage: { log: { append(r: unknown): void } } }, parked: boolean): void {
    const t0 = Date.now();
    const user = { id: "u1", enabled: true, type: "user", committedAt: t0, content: [{ type: "text", content: "go" }] };
    const toolCall = {
        id: "tc1", enabled: true, type: "toolCall", committedAt: t0 + 1,
        content: {
            answer: "",
            stored: [
                { id: "call-A", type: "function", name: "alpha", parameters: {} },
                { id: "call-B", type: "function", name: "beta", parameters: {} },
            ],
        },
    };
    const records: unknown[] = [
        { t: t0, change: { key: "messages", path: "messages.0", op: "set", value: user } },
        { t: t0 + 1, change: { key: "messages", path: "messages.1", op: "set", value: toolCall } },
        { t: t0 + 3, change: { key: "lastResponse", path: "lastResponse", op: "set", value: 0 } },
    ];
    if (parked) {
        records.push(
            { t: t0 + 4, change: { key: "pendingAwaits", path: "pendingAwaits.0", op: "set", value: { type: "perm/ask", id: "ask-1", schema: null } } },
            { t: t0 + 5, change: { key: "currentAction", path: "currentAction", op: "set", value: { phase: "toolExec" } } },
            { t: t0 + 6, change: { key: "loopState", path: "loopState", op: "set", value: "awaiting" } },
        );
    } else {
        records.push({
            t: t0 + 2,
            change: {
                key: "messages", path: "messages.2", op: "set",
                value: {
                    id: "trA", enabled: true, type: "toolResult", committedAt: t0 + 2,
                    toolCallId: "call-A", toolName: "alpha",
                    content: { answer: "did alpha", stored: { ok: true } },
                },
            },
        });
    }
    for (const r of records) session.storage.log.append(r);
}

function spyTool(name: string, runs: { n: number }): Tool {
    return {
        name, description: "d", inputSchema: { type: "object" },
        execute: async () => { runs.n++; return { answer: "ran" }; },
    };
}

function restoredCalls(agent: Agent): Array<{ id: string; preResolved?: { answer: string; error?: boolean; errorMessage?: string } }> {
    const toolCall = [...agent.messages].reverse().find((m) => m.type === "toolCall") as unknown as
        { content: { stored: Array<{ id: string; preResolved?: { answer: string; error?: boolean; errorMessage?: string } }> } };
    assert.ok(toolCall, "the owed toolCall survived restore");
    return toolCall.content.stored;
}

test("CRASH HEAL: partial batch restore NEVER re-runs tools — missing calls get synthetic error results", async (t) => {
    const base = await makeTempDir(t);
    const session = jsonlSession(join(base, "heal"));
    writeCrashTape(session, false);

    const alpha = { n: 0 }, beta = { n: 0 };
    const { agent } = makeAgent({ script: [() => assistantTurn("post-heal reply")] });
    agent.tools.push(spyTool("alpha", alpha), spyTool("beta", beta));

    assert.equal(await session.restoreInto(agent), true);

    // HEALING ASSERTIONS — the calls carry the truth
    const [callA, callB] = restoredCalls(agent);
    assert.equal(callA.preResolved, undefined, "A already committed — batch will SKIP it, no heal needed");
    assert.equal(callB.preResolved?.error, true, "B healed — never ran");
    assert.match(callB.preResolved?.errorMessage ?? "", /crashed/);

    // DRIVE — no tool may execute; the transcript heals; the model continues
    await withDriver(agent, async () => {
        kick(agent);
        await awaitLanded(agent);
    });

    assert.equal(alpha.n, 0, "A must NOT re-run after the crash");
    assert.equal(beta.n, 0, "B must NOT run at all — its side effect never fires");
    const results = agent.messages.filter((m) => m.type === "toolResult");
    assert.equal(results.length, 2, "transcript is whole — exactly ONE result per call");
    const healed = results[1] as unknown as { content: { answer: string } };
    assert.match(healed.content.answer, /not executed/, "the healed result tells the model the truth");
    assert.equal(agent.messages.at(-1)!.type, "assistant", "the model continued after the healed batch");
});

test("PARKED restore is NOT healed — the ask survives, the batch runs FRESH after the answer", async (t) => {
    const base = await makeTempDir(t);
    const session = jsonlSession(join(base, "parked"));
    writeCrashTape(session, true);

    const alpha = { n: 0 }, beta = { n: 0 };
    const { agent } = makeAgent({ script: [() => assistantTurn("done")] });
    agent.tools.push(spyTool("alpha", alpha), spyTool("beta", beta));
    // the restored ask clears when the answer arrives (permission-style filter)
    agent.addFilter({
        event: EVENTS.inputReceived, id: "t/clear", priority: 0,
        fn: async (a) => {
            if (a.currentInput?.type === "t/answer") {
                const i = a.pendingAwaits.findIndex((w) => w.id === "ask-1");
                if (i !== -1) a.pendingAwaits.splice(i, 1);
            }
        },
    });

    assert.equal(await session.restoreInto(agent), true);

    // NO HEALING — the question was never answered; it must be re-presented
    const [callA, callB] = restoredCalls(agent);
    assert.equal(callA.preResolved, undefined, "A NOT healed — the ask is still live");
    assert.equal(callB.preResolved, undefined, "B NOT healed");
    assert.equal(agent.pendingAwaits.length, 1, "the ask survived the crash");
    assert.equal(agent.loopState, "awaiting", "still parked");

    // the fresh answer → the batch runs FRESH (side effects fire — re-presented, not auto-run)
    await withDriver(agent, async () => {
        agent.input({ type: "t/answer" });
        await awaitLanded(agent);
    });
    assert.equal(alpha.n, 1, "A ran after the re-presented ask was answered");
    assert.equal(beta.n, 1, "B ran too");
    assert.equal(agent.pendingAwaits.length, 0, "ask consumed");
    assert.equal(agent.messages.at(-1)!.type, "assistant");
});
