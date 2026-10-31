// cache-trace: baseline silent, tool edit traced, stable calls silent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, Tool } from "@sanityloop/core";
import type { TurnResult } from "@sanityloop/core";
import { StubModel, assistantTurn, toolCallTurn, callTo } from "@sanityloop/test-kit/core";
import { withDriver } from "@sanityloop/test-kit/core";
import { awaitLanded } from "@sanityloop/test-kit";
import { createCacheTrace, CACHE_BREAK_EVENT } from "../index.ts";
import type { CacheBreakOp } from "../index.ts";

test("cache-trace: first call silent, tool edit traced with cause, stable silent", async () => {
  const tool = Tool.define({
    name: "dummy",
    description: "v1",
    inputSchema: { type: "object" },
    async execute() { return { answer: "ran" }; },
  });
  const model = new StubModel([
    () => toolCallTurn([callTo("dummy", {}, "c-1")]),
    () => toolCallTurn([callTo("dummy", {}, "c-2")]),
    () => assistantTurn("done"),
  ]);
  const agent = new Agent({ model, tools: [tool], agentId: "cache-trace-test" });
  const breaks: Array<{ callIndex: number; ops: CacheBreakOp[] }> = [];
  agent.addFilter({
    event: CACHE_BREAK_EVENT, id: "test/catch", priority: 0,
    fn: async (_a, payload) => {
      const p = payload as unknown as { callIndex: number; ops: CacheBreakOp[] };
      breaks.push(p);
    },
  });
  await agent.install(createCacheTrace());
  await withDriver(agent, async () => {
    agent.messages.push({
      id: "u-1", enabled: true, type: "user", committedAt: Date.now(),
      content: [{ type: "text", content: "go" }],
    });
    agent.input({ type: "__test_kick__" });
    // wait for the first tool result, then mutate the tool mid-run
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (agent.messages.some((m) => m.type === "toolResult")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    agent.updateTool("dummy", { description: "v2-mutated" });
    await awaitLanded(agent);
  });
  assert.ok(breaks.length >= 1, `expected ≥1 break, got ${breaks.length}`);
  const toolOp = breaks.flatMap((b) => b.ops).find((op) => op.path === "tools[dummy]");
  assert.ok(toolOp, `tool op traced: ${JSON.stringify(breaks.flatMap((b) => b.ops).map((o) => o.path))}`);
  assert.match(toolOp.before, /v1/);
  assert.match(toolOp.after, /v2-mutated/);
  assert.ok(toolOp.causes.some((c) => c.includes("toolChanged")), `cause tagged: ${toolOp.causes}`);
});

test("cache-trace: stable transcript across calls emits nothing", async () => {
  const turns: Array<() => TurnResult> = [() => assistantTurn("one")];
  const model = new StubModel(turns);
  const agent = new Agent({ model, agentId: "cache-trace-quiet" });
  let fired = 0;
  agent.addFilter({
    event: CACHE_BREAK_EVENT, id: "test/catch", priority: 0,
    fn: async () => { fired++; },
  });
  await agent.install(createCacheTrace());
  await withDriver(agent, async () => {
    agent.messages.push({
      id: "u-1", enabled: true, type: "user", committedAt: Date.now(),
      content: [{ type: "text", content: "go" }],
    });
    agent.input({ type: "__test_kick__" });
    await awaitLanded(agent);
  });
  assert.equal(fired, 0, "single call = baseline only, no break event");
});
