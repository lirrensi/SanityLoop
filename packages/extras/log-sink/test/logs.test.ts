// ============================================================================
// tests/extras/logs.test.ts — THE LOG CONVENTION: one channel, any producer,
// any sink (@sanityloop/util log.ts + @sanityloop/log-sink + observer logs:true).
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Agent } from "@sanityloop/core";
import { LOG_CHANNEL, emitLog, formatLogLine, jsonlLine } from "@sanityloop/util";
import type { LogEntry } from "@sanityloop/util";
import { createFileLog, createConsoleLog } from "@sanityloop/log-sink";
import { createObserverPlugin } from "@sanityloop/observer";
import { StubModel } from "@sanityloop/test-kit/core";
import { makeTempDir } from "@sanityloop/test-kit";

function newAgent() {
    return new Agent({ model: new StubModel([]), agentId: "log-test" });
}

test("LOG_CHANNEL is exactly \"log\"", () => {
    assert.equal(LOG_CHANNEL, "log");
});

test("emitLog produces the envelope on the `log` channel (level/source/message/data)", async () => {
    const agent = newAgent();
    const seen: LogEntry[] = [];
    agent.addFilter({
        event: LOG_CHANNEL, id: "t/capture", priority: 0,
        fn: async (_a, e) => seen.push(e as unknown as LogEntry),
    });
    emitLog(agent, "warn", "permission", "denied bash: nope", { tool: "bash" });

    assert.equal(seen.length, 1);
    const entry = seen[0];
    assert.equal(entry.level, "warn");
    assert.equal(entry.source, "permission");
    assert.equal(entry.message, "denied bash: nope");
    assert.deepEqual(entry.data, { tool: "bash" });
});

test("emitLog without data omits the data field entirely", async () => {
    const agent = newAgent();
    const seen: LogEntry[] = [];
    agent.addFilter({
        event: LOG_CHANNEL, id: "t/capture", priority: 0,
        fn: async (_a, e) => void seen.push(e as unknown as LogEntry),
    });
    emitLog(agent, "info", "me", "plain line");
    assert.equal(seen.length, 1);
    assert.equal("data" in seen[0], false);
});

test("formatLogLine renders `[iso] [level] [source] message` (+ JSON data when present)", () => {
    const ts = Date.UTC(2026, 7, 22, 12, 0, 0);
    const plain = formatLogLine({ level: "info", source: "core", message: "hello", ts });
    assert.match(plain, /^\[2026-08-22T12:00:00\.000Z\] \[info\] \[core\] hello$/);

    const withData = formatLogLine({ level: "warn", source: "s", message: "m", data: { a: 1 }, ts });
    assert.match(withData, /\{"a":1\}$/);

    // receipt stamp: missing ts gets stamped by the SINK
    const unstamped = formatLogLine({ level: "debug", source: "s", message: "m" });
    assert.ok(!unstamped.includes("undefined"), "receipt stamp applied, never 'undefined'");
});

test("jsonlLine: one self-contained parseable JSON object per line, receipt-stamped", () => {
    const line = jsonlLine({ level: "error", source: "x", message: "boom" });
    const parsed = JSON.parse(line) as LogEntry;
    assert.equal(parsed.level, "error");
    assert.equal(parsed.message, "boom");
    assert.equal(typeof parsed.ts, "number", "sink stamps receipt when producer didn't");
    assert.ok(!line.includes("\n"), "rotation-safe: a line never spans lines");
});

// ---------------------------------------------------------------------------
// Observer fan-in
// ---------------------------------------------------------------------------

test("observer with logs:true catches every producer's lines through ONE subscription", () => {
    const agent = newAgent();
    const lines: string[] = [];
    agent.install(createObserverPlugin({ logs: true, write: (l) => void lines.push(l) }));

    emitLog(agent, "info", "pluginA", "A did something");
    emitLog(agent, "warn", "pluginB", "B warns", { code: 7 });

    assert.equal(lines.length, 2, "fan-in: both producers, one sink");
    assert.match(lines[0]!, /\[info\] \[pluginA\] A did something$/);
    assert.match(lines[1]!, /\[warn\] \[pluginB\] B warns \{"code":7\}$/);
});

test("observer WITHOUT logs:true does NOT subscribe to the channel", () => {
    const agent = newAgent();
    agent.install(createObserverPlugin({ write: () => {} }));
    assert.equal(agent.filters.some((f) => f.id === "observer/log"), false);
    // and with it:
    const agent2 = newAgent();
    agent2.install(createObserverPlugin({ logs: true, write: () => {} }));
    assert.ok(agent2.filters.some((f) => f.id === "observer/log"));
});

test("observer auto-subscribes DECLARED log/* siblings (producers declare, sinks discover)", () => {
    const agent = newAgent();
    const lines: string[] = [];
    // declared BEFORE install — that's the contract window
    agent.addDeclaredEvent({ id: "log/metrics", description: "structured metrics" });
    agent.install(createObserverPlugin({ logs: true, write: (l) => void lines.push(l) }));

    assert.ok(
        agent.filters.some((f) => f.id === "observer/log/metrics"),
        "a filter per declared log/* event",
    );
    agent.emit("log/metrics", { tokens: 42 });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^\[log\/metrics\] \{"tokens":42\}$/);
});

test("file sink writes JSONL-parseable entries in emission order; uninstall sweeps + closes", async (t) => {
    const base = await makeTempDir(t);
    const path = join(base, "logs", "agent.log.jsonl");
    const agent = newAgent();

    agent.install(createFileLog({ path }));
    emitLog(agent, "info", "one", "first line");
    emitLog(agent, "warn", "two", "second line", { k: "v" });
    agent.uninstall("log-sink");

    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    assert.equal(lines.length, 2, "emission order IS file order (sync appends)");
    const first = JSON.parse(lines[0]!) as LogEntry;
    const second = JSON.parse(lines[1]!) as LogEntry;
    assert.equal(first.level, "info");
    assert.equal(first.message, "first line");
    assert.equal(second.source, "two");
    assert.deepEqual(second.data, { k: "v" });
    for (const p of [first, second]) assert.equal(typeof p.ts, "number");

    // channel declaration swept when the LAST listener stopped
    assert.equal(agent.getDeclaredEvent(LOG_CHANNEL), undefined);
});

test("console sink formats via formatLogLine by default (spies console.log)", async (t) => {
    const captured: string[] = [];
    const orig = console.log;
    console.log = (line: unknown) => void captured.push(String(line));
    t.after(() => {
        console.log = orig;
    });

    const agent = newAgent();
    agent.install(createConsoleLog());
    emitLog(agent, "error", "sys", "dying", { code: 1 });
    agent.uninstall("log-sink");

    assert.equal(captured.length, 1);
    assert.match(captured[0]!, /\[error\] \[sys\] dying \{"code":1\}$/);
});
