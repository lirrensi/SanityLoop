// ============================================================================
// tests/extras/tool-discovery.test.ts — the hidden-tool discovery pair.
// ============================================================================
// The discovery tools run against the FULL registry (agent.tools), so they see
// hidden tools too. Tested by calling execute() directly with a real Agent —
// no loop needed for inventory/search logic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolDiscoveryPlugin, createToolSearchTool, createEnumerateToolsTool, createCallToolTool } from "@sanityloop/tool-discovery";
import { Agent, Tool } from "@sanityloop/core";
import type { ToolType } from "@sanityloop/core";
import { StubModel } from "@sanityloop/test-kit/core";

function makeTool(name: string, description: string, opts: { hidden?: boolean; disabled?: boolean } = {}): ToolType {
    return Tool.define({
        name,
        description,
        inputSchema: { type: "object" },
        hidden: opts.hidden,
        disabled: opts.disabled,
        async execute() {
            return { answer: "ran" };
        },
    });
}

/** An agent with a known mix: 3 visible + 2 hidden (+ one hidden+disabled). */
function mixAgent() {
    const tools = [
        makeTool("add", "Add two numbers"),
        makeTool("read", "Read a file"),
        makeTool("git_commit", "Commit current changes", { hidden: true }),
        makeTool("deploy", "Deploy to production", { hidden: true }),
        makeTool("rotate_keys", "Rotate API keys", { hidden: true, disabled: true }),
    ];
    const agent = new Agent({ model: new StubModel([]), tools, agentId: "discovery-test" });
    return { agent };
}

// ---------------------------------------------------------------------------
// tool_search
// ---------------------------------------------------------------------------

test("tool_search finds HIDDEN tools by name and by description", async () => {
    const { agent } = mixAgent();
    const tool = createToolSearchTool();
    const byName = await tool.execute({ query: "commit" }, agent);
    assert.equal((byName.stored as { total: number }).total, 1);
    assert.match(byName.answer!, /git_commit/);
    assert.match(byName.answer!, /hidden/);

    const byDesc = await tool.execute({ query: "production" }, agent);
    assert.equal((byDesc.stored as { total: number }).total, 1);
    assert.match(byDesc.answer!, /deploy/);
});

test("tool_search: empty query lists everything; case-insensitive", async () => {
    const { agent } = mixAgent();
    const tool = createToolSearchTool();
    const all = await tool.execute({ query: "" }, agent);
    assert.equal((all.stored as { total: number }).total, 5, "empty query = everything");
    const caseFold = await tool.execute({ query: "READ" }, agent);
    assert.equal((caseFold.stored as { total: number }).total, 1);
});

test("tool_search: pagination — page 1 shows limit, page 2 continues, hint present", async () => {
    const { agent } = mixAgent();
    const tool = createToolSearchTool();
    const p1 = await tool.execute({ query: "", page: 1, limit: 2 }, agent);
    const p1s = p1.stored as { items: { name: string }[]; total: number };
    assert.equal(p1s.items.length, 2);
    assert.equal(p1s.total, 5);
    assert.match(p1.answer!, /\[Use page=2 to see more\.\]/);

    const p2 = await tool.execute({ query: "", page: 2, limit: 2 }, agent);
    const p2s = p2.stored as { items: { name: string }[] };
    assert.equal(p2s.items.length, 2);
    assert.match(p2.answer!, /\[Use page=3 to see more\.\]/);

    const p3 = await tool.execute({ query: "", page: 3, limit: 2 }, agent);
    const p3s = p3.stored as { items: { name: string }[] };
    assert.equal(p3s.items.length, 1, "last page has the remainder");
    assert.doesNotMatch(p3.answer!, /Use page=/, "no more hint on the final page");
});

test("tool_search: past-the-end page gets a reset hint, not a crash", async () => {
    const { agent } = mixAgent();
    const tool = createToolSearchTool();
    const res = await tool.execute({ query: "", page: 99, limit: 2 }, agent);
    assert.equal((res.stored as { items: unknown[] }).items.length, 0);
    assert.match(res.answer!, /past the end/);
});

test("tool_search: limit is clamped to maxPageSize", async () => {
    const { agent } = mixAgent();
    const tool = createToolSearchTool({ maxPageSize: 20 });
    const res = await tool.execute({ query: "", limit: 999 }, agent);
    const items = (res.stored as { items: unknown[] }).items;
    assert.ok(items.length <= 20, "never dumps more than the cap");
});

// ---------------------------------------------------------------------------
// enumerate_tools
// ---------------------------------------------------------------------------

test("enumerate_tools defaults to HIDDEN and reports the inventory counts", async () => {
    const { agent } = mixAgent();
    const tool = createEnumerateToolsTool();
    const res = await tool.execute({}, agent);
    const stored = res.stored as { visibility: string; total: number; visibleCount: number; hiddenCount: number; items: { name: string; disabled: boolean }[] };
    assert.equal(stored.visibility, "hidden", "defaults to hidden");
    assert.equal(stored.visibleCount, 2, "add + read are the only visible");
    assert.equal(stored.hiddenCount, 3, "git_commit, deploy, rotate_keys — hidden+disabled still counts as hidden");
    assert.equal(stored.total, 3);
    assert.equal(stored.items.length, 3);
    assert.deepEqual(stored.items.map((i) => i.name).sort(), ["deploy", "git_commit", "rotate_keys"]);
    assert.match(res.answer!, /Tool inventory: 2 visible \(in context\), 3 hidden/);
    assert.equal(stored.items.find((i) => i.name === "rotate_keys")?.disabled, true, "hidden+disabled is listed under hidden but FLAGGED disabled");
    assert.equal(stored.items.find((i) => i.name === "git_commit")?.disabled, false);
});

test("enumerate_tools visibility=visible lists only in-context tools", async () => {
    const { agent } = mixAgent();
    const tool = createEnumerateToolsTool();
    const res = await tool.execute({ visibility: "visible" }, agent);
    const stored = res.stored as { items: { name: string }[]; total: number };
    assert.equal(stored.total, 2);
    assert.deepEqual(stored.items.map((i) => i.name).sort(), ["add", "read"], "visible only");
});

test("enumerate_tools visibility=all lists everything", async () => {
    const { agent } = mixAgent();
    const tool = createEnumerateToolsTool();
    const res = await tool.execute({ visibility: "all" }, agent);
    const stored = res.stored as { items: { name: string }[]; total: number };
    assert.equal(stored.total, 5);
});

test("enumerate_tools paginates hidden tools with a page hint", async () => {
    // 25 hidden tools — page 1 = 20, page 2 = 5
    const tools = Array.from({ length: 25 }, (_, i) =>
        makeTool(`hidden_${String(i).padStart(2, "0")}`, `tool number ${i}`, { hidden: true }),
    );
    tools.push(makeTool("visible_one", "the only visible tool"));
    const agent = new Agent({ model: new StubModel([]), tools, agentId: "enum-paging" });
    const tool = createEnumerateToolsTool();
    const p1 = await tool.execute({}, agent);
    const p1s = p1.stored as { items: unknown[]; total: number };
    assert.equal(p1s.total, 25);
    assert.equal(p1s.items.length, 20);
    assert.match(p1.answer!, /\[Use page=2 to see more\.\]/);
    const p2 = await tool.execute({ page: 2 }, agent);
    const p2s = p2.stored as { items: unknown[] };
    assert.equal(p2s.items.length, 5);
});

// ---------------------------------------------------------------------------
// call_tool — the dispatcher bridge for hidden tools
// ---------------------------------------------------------------------------

test("call_tool resolves a HIDDEN tool by name and executes it (the grammar-bridge)", async () => {
    const hidden = makeTool("multiply", "Multiply two numbers", { hidden: true });
    const agent = new Agent({ model: new StubModel([]), tools: [hidden], agentId: "call-hidden" });
    const dispatcher = createCallToolTool();
    const res = await dispatcher.execute({ name: "multiply", arguments: {} }, agent);
    assert.equal(res.answer, "ran", "hidden tool executed through the dispatcher");
    assert.equal(res.error, undefined);
});

test("call_tool enforces the target tool's schema wall (invalid args blocked)", async () => {
    const strict = Tool.define({
        name: "strict",
        description: "needs a string path",
        inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
        },
        async execute() {
            return { answer: "ran" };
        },
    });
    const agent = new Agent({ model: new StubModel([]), tools: [strict], agentId: "call-schema" });
    const dispatcher = createCallToolTool();
    const bad = await dispatcher.execute({ name: "strict", arguments: { nope: 1 } }, agent);
    assert.equal(bad.error, true);
    assert.equal(bad.errorMessage, "invalid_arguments");
    assert.match(bad.answer!, /Invalid arguments for strict/);
    const good = await dispatcher.execute({ name: "strict", arguments: { path: "a.ts" } }, agent);
    assert.equal(good.answer, "ran");
});

test("call_tool: unknown name and disabled target return structured errors", async () => {
    const off = makeTool("off", "disabled tool", { disabled: true });
    const agent = new Agent({ model: new StubModel([]), tools: [off], agentId: "call-errors" });
    const dispatcher = createCallToolTool();
    const ghost = await dispatcher.execute({ name: "nope" }, agent);
    assert.equal(ghost.error, true);
    assert.equal(ghost.errorMessage, "unknown tool");
    const disabled = await dispatcher.execute({ name: "off" }, agent);
    assert.equal(disabled.error, true);
    assert.equal(disabled.errorMessage, "disabled");
});

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

test("createToolDiscoveryPlugin installs all three tools + capability; uninstall cleans up", () => {
    const agent = new Agent({ model: new StubModel([]), tools: [], agentId: "discovery-plugin" });
    agent.install(createToolDiscoveryPlugin());
    assert.ok(agent.tools.some((t) => t.name === "tool_search"));
    assert.ok(agent.tools.some((t) => t.name === "enumerate_tools"));
    assert.ok(agent.tools.some((t) => t.name === "call_tool"));
    assert.ok(agent.getDeclaredCapability("tool-discovery"));
    assert.equal(agent.visibleTools().length, 3, "the discovery tools themselves are visible");
    assert.equal(agent.uninstall("tool-discovery"), true);
    assert.ok(!agent.tools.some((t) => t.name === "tool_search"));
    assert.ok(!agent.tools.some((t) => t.name === "enumerate_tools"));
    assert.ok(!agent.tools.some((t) => t.name === "call_tool"));
    assert.equal(agent.getDeclaredCapability("tool-discovery"), undefined);
});