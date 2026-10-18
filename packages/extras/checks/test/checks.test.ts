// packages/extras/checks/test/checks.test.ts — deterministic checks + verdict.
// Pure predicates over evidence; the plugin reduces at turn boundaries.
// Proven through real turns under the eternal heartbeat (withDriver).
import { test } from "node:test";
import assert from "node:assert/strict";
import { checks, createChecks, emptyEvidence } from "@sanityloop/checks";
import type { ChecksSnapshot } from "@sanityloop/checks";
import { Agent, Tool } from "@sanityloop/core";
import type { TurnResult } from "@sanityloop/core";
import { StubModel, assistantTurn, callTo, toolCallTurn } from "@sanityloop/test-kit/core";
import { withDriver } from "@sanityloop/test-kit/core";
import { awaitLanded } from "@sanityloop/test-kit";

function makeAgent(script: Array<() => TurnResult>, failTag?: string) {
  const tool = Tool.define({
    name: "dummy",
    description: "d",
    inputSchema: { type: "object" },
    async execute(p) {
      const tag = String((p as { tag?: string }).tag);
      if (failTag !== undefined && tag === failTag) {
        return { answer: "broke", error: true, errorMessage: "boom" };
      }
      return { answer: `ran ${tag}` };
    },
  });
  const model = new StubModel(script);
  const agent = new Agent({ model, tools: [tool], agentId: "checks-test" });
  agent.use(
    createChecks({
      gates: [checks.noToolErrors(), checks.calledTool("dummy")],
      metrics: [checks.maxToolCalls(5)],
    }),
  );
  const seedAndKick = () => {
    agent.messages.push({
      id: `u-${Math.random().toString(36).slice(2, 8)}`,
      enabled: true,
      type: "user",
      committedAt: Date.now(),
      content: [{ type: "text", content: "go" }],
    });
    agent.input({ type: "__test_kick__" });
  };
  return { agent, seedAndKick };
}

const snap = (agent: Agent): ChecksSnapshot =>
  agent.state.checks as ChecksSnapshot;

test("pure checks score evidence without a loop", () => {
  const e = emptyEvidence();
  e.texts.push("all done here");
  e.tools.push("search", "fetch");
  e.results.push({ name: "search", error: false }, { name: "fetch", error: false });
  assert.equal(checks.includes("done").run(e), 1);
  assert.equal(checks.includes("missing").run(e), 0);
  assert.equal(checks.calledTool("search").run(e), 1);
  assert.equal(checks.didNotCall("write").run(e), 1);
  assert.equal(checks.noToolErrors().run(e), 1);
  assert.equal(checks.maxToolCalls(2).run(e), 1);
  assert.equal(checks.maxToolCalls(1).run(e), 0);
  assert.equal(checks.toolOrder(["search", "fetch"]).run(e), 1);
  assert.equal(checks.toolOrder(["fetch", "search"]).run(e), 0);
  e.errorTools.push("fetch");
  assert.equal(checks.noToolErrors().run(e), 0);
});

test("verdict passes when every gate scores 1", async () => {
  const { agent, seedAndKick } = makeAgent([
    () => toolCallTurn([callTo("dummy", { tag: "a" }, "c-1")]),
    () => assistantTurn("done"),
  ]);
  await withDriver(agent, async () => {
    seedAndKick();
    await awaitLanded(agent);
  });
  const s = snap(agent);
  assert.equal(s.verdict, "passed");
  assert.equal(s.scores.find((x) => x.id === "noToolErrors")?.score, 1);
  assert.equal(s.scores.find((x) => x.id === "calledTool:dummy")?.score, 1);
  assert.equal(s.scores.find((x) => x.id === "maxToolCalls:5")?.gate, false);
});

test("verdict fails when a gate scores 0 (tool error), evidence resets next turn", async () => {
  const { agent, seedAndKick } = makeAgent(
    [
      () => toolCallTurn([callTo("dummy", { tag: "bad" }, "c-1")]),
      () => assistantTurn("tried"),
    ],
    "bad",
  );
  await withDriver(agent, async () => {
    seedAndKick();
    await awaitLanded(agent);
  });
  const s = snap(agent);
  assert.equal(s.verdict, "failed");
  assert.equal(s.scores.find((x) => x.id === "noToolErrors")?.score, 0);
  // the failing gate still records the call — the other gate holds
  assert.equal(s.scores.find((x) => x.id === "calledTool:dummy")?.score, 1);
});

test("onVerdict fires with the verdict + scores", async () => {
  const seen: { verdict: string; n: number }[] = [];
  const model = new StubModel([() => assistantTurn("done")]);
  const agent = new Agent({ model, tools: [], agentId: "checks-cb" });
  agent.use(
    createChecks({
      gates: [checks.includes("done")],
      onVerdict: (verdict, scores) => void seen.push({ verdict, n: scores.length }),
    }),
  );
  await withDriver(agent, async () => {
    agent.messages.push({
      id: "u-1",
      enabled: true,
      type: "user",
      committedAt: Date.now(),
      content: [{ type: "text", content: "go" }],
    });
    agent.input({ type: "__test_kick__" });
    await awaitLanded(agent);
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].verdict, "passed");
  assert.equal(seen[0].n, 1);
});
