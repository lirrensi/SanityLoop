// ============================================================================
// packages/extras/mcp/test/mcp.test.ts — thin unit suite for the MCP adapter.
// ============================================================================
// Fast (<5s), deterministic, no network and no real server binaries: a
// nonexistent command proves init() degrades instead of throwing, and
// install/uninstall run against a StubModel agent with zero connected
// servers. The real handshake/wire calls stay in the e2e suite only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcp, McpAdapter } from "@sanityloop/mcp";
import { makeAgent } from "@sanityloop/test-kit/core";

/** A binary that can never exist — spawn fails fast with ENOENT, no I/O. */
const DEAD = "/sanityloop-does-not-exist-xyz";

test("getPlugin() before init() throws the init-must-resolve error", () => {
    const m = createMcp({ fs: { command: ["npx", "-y", "x"] } });
    assert.throws(() => m.getPlugin(), /init\(\) must resolve/);
});

test("pre-init status mirrors the declaration: disabled vs not-initialized failed", () => {
    const m = createMcp({
        live: { command: ["npx", "-y", "x"] },
        off: { enabled: false },
    });
    assert.deepEqual(m.status, {
        live: { status: "failed", error: "not initialized" },
        off: { status: "disabled" },
    });
});

test("the constructor declares synchronously: a real instance, empty tools, no I/O", () => {
    const m: unknown = createMcp({ live: { command: ["npx", "-y", "x"] } });
    assert.ok(m instanceof McpAdapter);
    assert.ok(!(m instanceof Promise), "createMcp returns the adapter itself, not a promise");
    assert.deepEqual((m as McpAdapter).tools, []);
    assert.deepEqual((m as McpAdapter).status, {
        live: { status: "failed", error: "not initialized" },
    });
});

test(
    "init() with a nonexistent binary resolves (never throws) and degrades to failed",
    { timeout: 30_000 },
    async () => {
        const m = createMcp({ dead: { command: [DEAD], timeout: 5_000 } });
        const ret = await m.init(5_000);
        assert.equal(ret, m);
        const st = m.status.dead;
        assert.equal(st.status, "failed");
        assert.ok(
            st.status === "failed" && st.error.length > 0,
            "the failure carries a real spawn error message",
        );
    },
);

test(
    "init() leaves disabled servers untouched",
    { timeout: 30_000 },
    async () => {
        const m = createMcp({
            dead: { command: [DEAD], timeout: 5_000 },
            off: { enabled: false },
        });
        await m.init(5_000);
        assert.deepEqual(m.status.off, { status: "disabled" });
    },
);

test(
    "the second init() is a no-op returning the same instance",
    { timeout: 30_000 },
    async () => {
        const m = createMcp({
            dead: { command: [DEAD], timeout: 5_000 },
            off: { enabled: false },
        });
        const first = await m.init(5_000);
        const before = m.status;
        const second = await m.init();
        assert.equal(second, m);
        assert.equal(second, first);
        assert.deepEqual(m.status, before);
    },
);

test(
    "install with zero connected adds no tools but populates state.mcp with no capability",
    { timeout: 30_000 },
    async () => {
        const m = createMcp({
            dead: { command: [DEAD], timeout: 5_000 },
            off: { enabled: false },
        });
        await m.init(5_000);
        const { agent } = makeAgent({ script: [], agentId: "mcp-zero-test" });
        const toolsBefore = agent.tools.length;
        await agent.install(m.getPlugin());
        assert.equal(agent.tools.length, toolsBefore, "zero connected → zero tools land");
        const mcpState: unknown = agent.state.mcp;
        assert.ok(mcpState !== null && typeof mcpState === "object");
        assert.deepEqual(Object.keys(mcpState).sort(), ["dead", "off"]);
        assert.ok("off" in mcpState && "dead" in mcpState);
        assert.deepEqual(mcpState.off, { status: "disabled" });
        assert.ok(mcpState.dead !== undefined, "the dead server lands a failed status");
        assert.equal(
            agent.getDeclaredCapability("mcp"),
            undefined,
            "no connected servers → no mcp capability",
        );
    },
);

test(
    "uninstall deletes state.mcp",
    { timeout: 30_000 },
    async () => {
        const m = createMcp({
            dead: { command: [DEAD], timeout: 5_000 },
            off: { enabled: false },
        });
        await m.init(5_000);
        const { agent } = makeAgent({ script: [], agentId: "mcp-uninstall-test" });
        await agent.install(m.getPlugin());
        assert.equal("mcp" in agent.state, true, "install populates state.mcp first");
        agent.uninstall("mcp");
        assert.equal("mcp" in agent.state, false, "state.mcp is gone after uninstall");
        assert.equal(agent.getDeclaredCapability("mcp"), undefined);
    },
);
