// ============================================================================
// test/e2e/smoke-simple-agent.test.ts — THE STOCK TEMPLATE, RUN FOR REAL.
// ============================================================================
// Spawns templates/simple-agent.ts as a real subprocess (the exact way a
// production user runs it) and asserts the whole lifecycle story appeared in
// order: start → discard → park on permission → answer → resume → tool ran →
// stop landed → stats dumped → clean exit 0. If THIS burns, everything burns.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { runNode, REPO_ROOT } from "./helpers/spawn.ts";

test("stock simple-agent: full lifecycle story, bounded, exit 0", async () => {
    const r = await runNode(join(REPO_ROOT, "templates", "simple-agent.ts"), {
        timeoutMs: 20_000,
    });

    assert.equal(r.timedOut, false, "template hung — killed at deadline");
    assert.equal(r.code, 0, `exit ${r.code}\nstderr: ${r.stderr}`);

    // The story, IN ORDER (indexOf monotony = the plot never rewinds).
    const story: Array<[string, string]> = [
        ["banner", "=== sanity simple-agent running (stub model) ==="],
        ["beforeAgentStart fired", "[filter:beforeAgentStart]"],
        ["discard-first-response", "[filter:discard] discarding the response"],
        ["permission PARKS the loop", "[filter:permission] issuing a pending await"],
        ["parked state observed", "loopState after first input: awaiting"],
        ["permission answer resumed it", "[filter:permission] await cleared — resume!"],
        ["tool actually executed", "[tool:echo] got:"],
        ["stop landed", "[filter:stop] landing: loopState="],
        ["messages dumped", "=== messages after turn ==="],
        ["stats accumulated", "=== stats (accumulated) ==="],
    ];
    let cursor = -1;
    for (const [what, marker] of story) {
        const at = r.stdout.indexOf(marker, cursor + 1);
        assert.ok(at > cursor, `story broke before "${what}" — missing "${marker}"`);
        cursor = at;
    }

    // Stream phase painted its dots (textDelta visibility).
    assert.ok(r.stdout.includes("[filter:fragmentUpdate]"), "fragment update never surfaced");
    assert.ok(r.durationMs < 15_000, `took ${r.durationMs}ms — way past its ~700ms design`);
});
