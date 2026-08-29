// ============================================================================
// test/e2e/mcp-realworld.optin.test.ts — REAL SERVERS FROM THE WILD. OPT-IN.
// ============================================================================
// Feeds the user's ACTUAL opencode.json `mcp` section to the adapter and makes
// real calls through real third-party servers (playwright-mcp driving a real
// Chromium, skill-store querying the real registry). Machine-dependent by
// nature → clean SKIP unless armed. CI stays hermetic; locals get truth.
//
//   SANITYLOOP_MCP_REALWORLD=1          - required to arm
//   SANITYLOOP_OPENCODE_CONFIG          - optional alternate config path
//
// Prereqs when armed: `playwright-mcp` + `skill-store-mcp` on PATH and a
// local HTTP server at localhost:58080 (llama.cpp) for the navigate target.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { runNode, REPO_ROOT } from "./helpers/spawn.ts";

const ARMED = process.env.SANITYLOOP_MCP_REALWORLD === "1";

test("mcp real-world servers (opencode config): connect + real calls", async (t) => {
    if (!ARMED) {
        t.skip("SANITYLOOP_MCP_REALWORLD=1 not set — staying hermetic");
        return;
    }

    const r = await runNode(
        join(REPO_ROOT, "test", "e2e", "fixtures", "mcp-realworld-driver.ts"),
        { timeoutMs: 90_000 },
    );

    assert.equal(
        r.timedOut,
        false,
        `driver hung — killed at deadline\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
    );
    assert.equal(r.code, 0, `exit ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

    const s = r.stdout;
    // both stdio servers from the real config connected with tools listed
    assert.match(s, /\[mcp:status\] playwright="connected" tools=\d+/);
    assert.match(s, /\[mcp:status\] skill-store="connected" tools=\d+/);
    // real browser really went somewhere
    assert.match(s, /\[tool:playwright_browser_navigate\] error=false/);
    assert.match(s, /Page URL: http:\/\/localhost:58080\//);
    // real registry query came back
    assert.match(s, /\[tool:skill_store_(?:search|list)_skills\] error=false/);
});
