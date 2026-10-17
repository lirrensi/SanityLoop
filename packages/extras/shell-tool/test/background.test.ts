// packages/extras/shell-tool/test/background.test.ts — background bash end to end.
//
// Real shells (sleep/echo), real agent, stub model. The delivery path runs
// through the actual inputs plugin — followup → user message → new turn.
//
// TURN SHAPE — every backgrounded call costs THREE provider turns: the toolCall,
// a post-batch assistant (toolResults don't advance lastResponse, so the loop
// calls once more before landing), and the delivery turn. Scripts carry all three.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, type TurnResult } from "@sanityloop/core";
import { StubModel, assistantTurn, toolCallTurn, callTo, makeAgent, withDriver, seedUserMessage } from "@sanityloop/test-kit/core";
import { waitUntil, awaitLanded } from "@sanityloop/test-kit";
import { createDefaultInputs } from "@sanityloop/inputs";
import { createBashPlugin } from "../bash.ts";

function bgAgent(script: Array<() => TurnResult>, bgOpts: { autoThresholdMs?: number } = {}) {
  const { agent } = makeAgent({ script, agentId: "bg-test" });
  agent.install(createDefaultInputs());
  const bash = createBashPlugin({ background: { autoThresholdMs: 60_000, ...bgOpts } });
  agent.install(bash);
  return { agent, bash };
}

/** Seed work + kick: withDriver boots disarmed (born-landed) — the poke arms the loop. */
function seedAndKick(agent: Agent, text: string): void {
  seedUserMessage(agent, text);
  agent.input({ type: "__test_kick__" });
}

function userTexts(agent: Agent): string[] {
  return agent.messages.filter((m) => m.type === "user").map((m) => JSON.stringify(m.content));
}

/** Wait for a job's delivery message (it arrives on its own schedule, after landings). */
function awaitDelivery(agent: Agent, id: string): Promise<void> {
  return waitUntil(() => userTexts(agent).some((t) => t.includes(`Background job ${id}`)), {
    timeout: 15_000,
    what: `delivery of ${id}`,
  });
}
function bashCall(params: Record<string, unknown>) {
  return toolCallTurn([callTo("bash", params)]);
}

test("explicit background: true returns bg_N immediately, result delivers as a new turn", async () => {
  const { agent, bash } = bgAgent([
    () => bashCall({ command: "echo delivered-ok", background: true }),
    () => assistantTurn("working on it"),
    () => assistantTurn("saw it"),
  ]);
  await withDriver(agent, async () => {
    seedAndKick(agent, "run it in background");
    await waitUntil(() => agent.messages.some((m) => m.type === "toolResult"), { what: "bg toolResult to commit" });
    const result = agent.messages.find((m) => m.type === "toolResult")!;
    const answer = (result.content as { answer: string }).answer;
    assert.match(answer, /Backgrounded as job bg_1/);
    assert.match(answer, /Do NOT poll/);
    // delivery → completion turn → land
    await awaitDelivery(agent, "bg_1");
    await awaitLanded(agent, { timeout: 10_000 });
    const texts = userTexts(agent);
    assert.ok(texts.some((t) => t.includes("Background job bg_1 completed")), `delivery message missing: ${texts.join(" | ")}`);
    assert.ok(texts.some((t) => t.includes("delivered-ok")), `job output missing: ${texts.join(" | ")}`);
    assert.equal(bash.jobs.hasRunningJobs(), false);
  });
});

test("fast call with auto-bg enabled returns INLINE (never surfaces as a job)", async () => {
  const { agent, bash } = bgAgent(
    [() => bashCall({ command: "echo fast" }), () => assistantTurn("done")],
    { autoThresholdMs: 5_000 },
  );
  await withDriver(agent, async () => {
    seedAndKick(agent, "run fast");
    await awaitLanded(agent, { timeout: 10_000 });
    const result = agent.messages.find((m) => m.type === "toolResult")!;
    const answer = (result.content as { answer: string }).answer;
    assert.match(answer, /fast/);
    assert.doesNotMatch(answer, /Backgrounded as job/);
    assert.equal(bash.jobs.listJobs().length, 0);
  });
});

test("slow call auto-backgrounds after the threshold, then delivers", async () => {
  const { agent, bash } = bgAgent(
    [
      () => bashCall({ command: "sleep 1 && echo slow-ok" }),
      () => assistantTurn("working on it"),
      () => assistantTurn("done"),
    ],
    { autoThresholdMs: 200 },
  );
  await withDriver(agent, async () => {
    seedAndKick(agent, "run slow");
    await waitUntil(() => agent.messages.some((m) => m.type === "toolResult"), { what: "auto-bg toolResult to commit" });
    const result = agent.messages.find((m) => m.type === "toolResult")!;
    assert.match((result.content as { answer: string }).answer, /Backgrounded as job bg_1/);
    assert.equal(bash.jobs.hasRunningJobs(), true);
    await awaitDelivery(agent, "bg_1");
    await awaitLanded(agent, { timeout: 10_000 });
    const texts = userTexts(agent);
    assert.ok(texts.some((t) => t.includes("slow-ok")), `delivery missing: ${texts.join(" | ")}`);
    assert.equal(bash.jobs.hasRunningJobs(), false);
  });
});

test("timeout kills the whole run and delivers TIMED OUT", async () => {
  const { agent } = bgAgent([
    () => bashCall({ command: "sleep 30", background: true, timeout: 1 }),
    () => assistantTurn("working on it"),
    () => assistantTurn("done"),
  ]);
  await withDriver(agent, async () => {
    seedAndKick(agent, "run with deadline");
    await awaitDelivery(agent, "bg_1");
    await awaitLanded(agent, { timeout: 15_000 });
    const texts = userTexts(agent);
    assert.ok(texts.some((t) => t.includes("TIMED OUT")), `timeout delivery missing: ${texts.join(" | ")}`);
  });
});

test("job_kill cancels without delivery; jobs/job_read observe", async () => {
  const { agent } = makeAgent({
    script: [
      () => bashCall({ command: "sleep 30", background: true }),
      () => toolCallTurn([callTo("jobs", {})]),
      () => toolCallTurn([callTo("job_kill", { id: "bg_1" })]),
      () => assistantTurn("killed it"),
    ],
    agentId: "bg-test",
  });
  agent.install(createDefaultInputs());
  agent.install(createBashPlugin({ background: {} }));
  await withDriver(agent, async () => {
    seedAndKick(agent, "spawn then kill");
    await awaitLanded(agent, { timeout: 15_000 });
    const results = agent.messages.filter((m) => m.type === "toolResult").map((m) => (m.content as { answer: string }).answer);
    assert.ok(results.some((a) => a.includes("Backgrounded as job bg_1")), `bg notice missing: ${results.join(" || ")}`);
    assert.ok(results.some((a) => a.includes("bg_1 [bash] running")), `jobs list missing: ${results.join(" || ")}`);
    assert.ok(results.some((a) => a.includes("Killed bg_1")), `kill confirm missing: ${results.join(" || ")}`);
    const users = agent.messages.filter((m) => m.type === "user").map((m) => JSON.stringify(m.content));
    assert.ok(!users.some((t) => t.includes("Background job bg_1")), "killed job must never deliver");
  });
});

test("nonzero exit delivers FAILED with the code", async () => {
  const { agent } = bgAgent([
    () => bashCall({ command: "echo oops; exit 3", background: true }),
    () => assistantTurn("working on it"),
    () => assistantTurn("done"),
  ]);
  await withDriver(agent, async () => {
    seedAndKick(agent, "run failing");
    await awaitDelivery(agent, "bg_1");
    await awaitLanded(agent, { timeout: 10_000 });
    const texts = userTexts(agent);
    assert.ok(texts.some((t) => t.includes("FAILED (exit 3)")), `failure delivery missing: ${texts.join(" | ")}`);
    assert.ok(texts.some((t) => t.includes("oops")), `output missing: ${texts.join(" | ")}`);
  });
});

test("delivery input never sets backticksCommand (output can't execute)", async () => {
  const { agent } = bgAgent([
    () => bashCall({ command: "echo '`touch /tmp/pwned`'", background: true }),
    () => assistantTurn("working on it"),
    () => assistantTurn("done"),
  ]);
  const seen: unknown[] = [];
  agent.addFilter({
    event: "inputReceived",
    id: "test/capture-inputs",
    priority: 0,
    fn: async (a) => {
      if (a.currentInput) seen.push({ ...a.currentInput });
    },
  });
  await withDriver(agent, async () => {
    seedAndKick(agent, "run tricky output");
    await awaitDelivery(agent, "bg_1");
    await awaitLanded(agent, { timeout: 10_000 });
    const followups = seen.filter((i) => (i as { type: string }).type === "input_followup");
    assert.ok(followups.length >= 1, "expected a followup delivery");
    for (const f of followups) {
      assert.equal((f as { backticksCommand?: unknown }).backticksCommand, undefined);
    }
  });
});

test("terminate() kills a running job via the signal — no delivery, no orphan", async () => {
  const { agent, bash } = bgAgent([
    () => bashCall({ command: "sleep 30", background: true }),
    () => assistantTurn("working on it"),
    () => assistantTurn("done"),
  ]);
  agent.run({ startState: "idle" });
  seedAndKick(agent, "spawn then die");
  await waitUntil(() => bash.jobs.hasRunningJobs(), { what: "job to start running" });
  await agent.terminate("owner cleanup");
  assert.equal(bash.jobs.hasRunningJobs(), false, "the signal killed the job");
  const users = userTexts(agent);
  assert.ok(!users.some((t) => t.includes("Background job bg_1")), "killed job never delivers");
  assert.equal(agent.loopState, "terminated");
});

test("foreground stays foreground: no background opt = no param, no companions, no requires", async () => {
  const agent = new Agent({ model: new StubModel([() => assistantTurn("done")]), agentId: "fg-test" });
  const bash = createBashPlugin();
  agent.install(createDefaultInputs());
  agent.install(bash);
  const tool = agent.tools.find((t) => t.name === "bash")!;
  assert.ok(!("background" in (tool.inputSchema.properties ?? {})), "schema must lack `background`");
  assert.equal(agent.tools.some((t) => t.name === "jobs"), false);
  assert.equal(bash.jobs.hasRunningJobs(), false);
  assert.deepEqual(bash.jobs.listJobs(), []);
  agent.uninstall("bash");
  assert.equal(agent.tools.some((t) => t.name === "bash"), false);
});
