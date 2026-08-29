// ============================================================================
// test/e2e/mcp-real.test.ts — MCP against a REAL stdio server. No mocks.
// ============================================================================
// Spawns the mcp-agent-driver as a real subprocess (the way production runs)
// with two REAL MCP peers:
//
//   good → the official-SDK fixture server over genuine JSON-RPC/stdio
//   dead → a nonexistent binary (the degradation path)
//
// The gauntlet, in order — if any link breaks, THIS burns red:
//   1. handshake + tools/list        → namespaced tools (server_tool)
//   2. dead server                   → degraded status, init never throws
//   3. add(19,23) through the loop   → "42" computed on the other process
//   4. fail_now                      → isError becomes error-as-TEXT, no throw
//   5. install_extra mid-run         → tools/list_changed → live re-list
//   6. the new tool                  → callable through the same loop
//   7. state.mcp                     → per-server truth for observers

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { runNode, REPO_ROOT } from "./helpers/spawn.ts";

test("mcp real servers (stdio + remote http): full gauntlet, bounded, exit 0", async () => {
    const r = await runNode(
        join(REPO_ROOT, "test", "e2e", "fixtures", "mcp-agent-driver.ts"),
        { timeoutMs: 45_000 },
    );

    // never hang — the harness kills at the deadline and we fail WITH evidence
    assert.equal(r.timedOut, false, `driver hung — killed at deadline\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.equal(
        r.code,
        0,
        `exit ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
    );

    const s = r.stdout;

    // 1+2. handshake story, IN ORDER (indexOf monotony = the plot never rewinds)
    const story: Array<[string, RegExp]> = [
        ["good connected with namespaced tools",
            /\[mcp:status\] good=\{"status":"connected","tools":\["good_add","good_fail_now","good_install_extra"\]\}/],
        ["dead degraded to failed", /\[mcp:status\] dead=\{"status":"failed"/],
        ["remote http connected",
            /\[mcp:status\] http=\{"status":"connected","tools":\["http_mul"\]\}/],
        ["real sum over the wire",
            /\[tool:good_add\] error=false answer="[^"]*\bis 42\b/],
        ["isError surfaced as error-as-text",
            /\[tool:good_fail_now\] error=true answer="[^"]*deliberate failure: because-i-said-so/],
        ["dynamic tool visible before call 4",
            /\[driver\] dynamic tool visible before call 4: true/],
        ["dynamic tool callable through the loop",
            /\[tool:good_bonus_time\] error=false answer="[^"]*bonus delivered/],
        ["real product over remote streamable HTTP",
            /\[tool:http_mul\] error=false answer="[^"]*\bis 42\b/],
        ["state.mcp truth", /"dead":\{"status":"failed"/],
    ];
    let cursor = -1;
    for (const [what, re] of story) {
        // each marker must appear AFTER the previous one — order matters
        const rest = s.slice(cursor + 1);
        const m = re.exec(rest);
        assert.ok(m, `story broke before "${what}" — pattern not found:\n${rest.slice(-1200)}`);
        cursor += m.index;
    }

    // 5. the mid-run list change actually repainted the agent's tool list.
    // The re-list churns (remove×N then add×N) so we assert on the SETTLED
    // (last) toolListChanged line, not the first flash of the shuffle.
    const listLines = [...s.matchAll(/\[filter:toolListChanged\] tools now: ([^\n]*)/g)];
    assert.ok(listLines.length > 0, "toolListChanged never fired");
    const settled = listLines[listLines.length - 1][1];
    assert.match(
        settled,
        /\bgood_bonus_time\b/,
        `bonus_time missing from the settled live tool list: "${settled}"`,
    );
    for (const base of ["good_add", "good_fail_now", "good_install_extra", "http_mul"]) {
        assert.match(settled, new RegExp(`\\b${base}\\b`),
            `${base} lost from the settled tool list: "${settled}"`);
    }

    // 6. the dynamic tool's result landed as a committed toolResult message
    assert.match(
        s,
        /\[toolResult\][^\n]*bonus delivered from the dynamic tool/,
        "dynamic tool result never committed to messages",
    );
});
