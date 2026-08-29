// ============================================================================
// test/e2e/crash-hardening.test.ts — THE BURN TESTS.
// ============================================================================
// Production promise: when things explode mid-turn, the process LANDS —
// bounded, diagnosed, never hung. Two documented contracts under fire:
//   - provider throw → fail(err,"provider") → terminal "errored" landing,
//     stderr carries "[sanity] turn failed:", quit-on-end exits 1.
//   - tool throw → error-as-result → the MODEL sees the failure, the turn
//     COMPLETES, graceful exit 0.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runNode } from "./helpers/spawn.ts";
import { deriveAgent, CRASH_WORKER_SOURCE } from "./helpers/derive.ts";

test("crash: exploding PROVIDER lands terminal, diagnosed, bounded — never hangs", async (t) => {
    const { file, dir } = await deriveAgent(t, "crash-model.ts", CRASH_WORKER_SOURCE);
    const r = await runNode(file, { cwd: dir, timeoutMs: 20_000, env: { CRASH_MODE: "model" } });

    assert.equal(r.timedOut, false, "THE BURN: provider crash HUNG the process");
    assert.equal(
        r.code,
        1,
        `expected terminal exit 1, got ${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    assert.ok(r.stdout.includes("CRASH_WORKER_RUNNING mode=model"), "never started");
    assert.ok(
        r.stderr.includes("[sanity] turn failed:") && r.stderr.includes("BOMB_MODEL_EXPLODED"),
        "the explosion was not diagnosed on stderr",
    );
});

test("crash: exploding TOOL becomes error-as-result, turn completes, graceful exit 0", async (t) => {
    const { file, dir } = await deriveAgent(t, "crash-tool.ts", CRASH_WORKER_SOURCE);
    const r = await runNode(file, { cwd: dir, timeoutMs: 20_000, env: { CRASH_MODE: "tool" } });

    assert.equal(r.timedOut, false, "THE BURN: tool crash HUNG the process");
    assert.equal(r.code, 0, `expected graceful 0, got ${r.code}\nstderr: ${r.stderr}`);
    assert.ok(r.stdout.includes("SAW_ERROR_RESULT:"), "synthetic error result never surfaced");
    assert.ok(
        r.stdout.includes("survived the tool explosion"),
        "turn did not complete after tool failure",
    );
});
