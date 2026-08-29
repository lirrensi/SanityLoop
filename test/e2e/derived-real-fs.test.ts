// ============================================================================
// test/e2e/derived-real-fs.test.ts — "TAKE TEMPLATE, CHANGE SOMETHING, RUN IT".
// ============================================================================
// The production story, literally: we derive a worker from the template shape,
// run it as a REAL process, and require REAL consequences — a file that exists
// on disk after the process is gone, a session tape that survives, and a
// SECOND fresh process that restores that tape (the crash-resume promise).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runNode } from "./helpers/spawn.ts";
import { deriveAgent, PERSISTENT_WORKER_SOURCE } from "./helpers/derive.ts";

test("derived worker: real file effect + cross-process session restore", async (t) => {
    const { file, dir } = await deriveAgent(t, "worker.ts", PERSISTENT_WORKER_SOURCE);

    // ---- PASS 1: the worker runs, writes a REAL file, persists its tape ----
    const w = await runNode(file, { cwd: dir, timeoutMs: 20_000 });
    assert.equal(w.timedOut, false, "derived worker hung");
    assert.equal(w.code, 0, `exit ${w.code}\nstderr: ${w.stderr}`);
    assert.ok(w.stdout.includes("DERIVED_WORKER_RUNNING"), "worker never started");

    // THE REAL EFFECT — verified post-mortem, from OUTSIDE the process.
    const notePath = join(dir, "hello.txt");
    assert.ok(existsSync(notePath), "hello.txt never landed on disk — effect was imaginary");
    const note = await readFile(notePath, "utf8");
    assert.equal(note, "REAL EFFECT FROM A SPAWNED PROCESS");

    // The tape: state card written by the spawned process.
    const card = join(dir, "sessions", "e2e-persistent-worker", "state.json");
    assert.ok(existsSync(card), "session state card missing — persistence lied");

    // ---- PASS 2: a FRESH process restores the SAME session dir ----
    const r = await runNode(file, { cwd: dir, timeoutMs: 20_000, env: { DERIVED_MODE: "restore" } });
    assert.equal(r.timedOut, false, "restore pass hung");
    assert.equal(r.code, 0, `exit ${r.code}\nstderr: ${r.stderr}`);

    const line = r.stdout.split("\n").find((l) => l.startsWith("RESTORE_RESULT:"));
    assert.ok(line, "no RESTORE_RESULT emitted\nstdout: " + r.stdout);
    const report = JSON.parse(line!.slice("RESTORE_RESULT:".length)) as {
        restored: boolean;
        count: number;
        texts: string[];
    };
    assert.equal(report.restored, true, "restoreInto returned false — nothing came back");
    assert.ok(report.count >= 4, `expected seed+toolCall+result+assistant, got ${report.count}`);
    const joined = report.texts.join("\n");
    assert.ok(joined.includes("please write hello.txt"), "seed user message lost");
    assert.ok(joined.includes("note written, work done"), "assistant reply lost");
});
