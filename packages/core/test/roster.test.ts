// roster tests — model array, preset ids, side calls, one-turn swaps, call abort.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, SimpleModel, attemptAborted } from "@sanityloop/core";
import type { GodObject, TurnResult } from "@sanityloop/core";
import { StubModel, assistantTurn } from "@sanityloop/test-kit/core";
import { makeAgent, seedUserMessage, kick } from "@sanityloop/test-kit/core";
import { withDriver } from "@sanityloop/test-kit/core";
import { awaitLanded, awaitIdle } from "@sanityloop/test-kit";

test("roster: single model = driver, presetId defaults to modelId", () => {
  const m = new StubModel([() => assistantTurn("x")]);
  const agent = new Agent({ model: m, agentId: "roster-1" });
  assert.equal(agent.models.length, 1);
  assert.equal(agent.model, m);
  assert.equal(m.presetId, "stub-model-001");
});

test("roster: array, first drives, ids addressable + deduped", () => {
  const a = new StubModel([() => assistantTurn("a")]);
  const b = new StubModel([() => assistantTurn("b")]);
  const agent = new Agent({ model: [a, b], agentId: "roster-2" });
  assert.equal(agent.models.length, 2);
  assert.equal(agent.model, a);
  assert.equal(a.presetId, "stub-model-001");
  assert.equal(b.presetId, "stub-model-001#2");
  assert.equal(agent.resolvePreset("stub-model-001"), a);
  assert.equal(agent.resolvePreset("stub-model-001#2"), b);
  assert.equal(agent.resolvePreset(1), b);
  assert.equal(agent.resolvePreset(a), a);
  assert.throws(() => agent.resolvePreset("nope"), /unknown preset/);
  assert.throws(() => agent.resolvePreset(9), /unknown preset/);
});

test("roster: explicit presetIds kept, empty array throws", () => {
  const a = new StubModel([() => assistantTurn("a")]);
  a.presetId = "judge";
  const agent = new Agent({ model: [a], agentId: "roster-3" });
  assert.equal(a.presetId, "judge");
  assert.equal(agent.resolvePreset("judge"), a);
  assert.throws(() => new Agent({ model: [], agentId: "roster-empty" }), /must not be empty/);
});

test("call: side call answers without committing or stats", async () => {
  const driver = new StubModel([() => assistantTurn("driven")]);
  const judge = new StubModel([() => assistantTurn("verdict:ok")]);
  const agent = new Agent({ model: [driver, judge], agentId: "side-1" });
  seedUserMessage(agent, "go");
  const before = agent.messages.length;
  const handle = agent.call("stub-model-001#2");
  assert.ok(handle.id.length > 0);
  const result = await handle.done;
  assert.deepEqual(result.message.content, [{ type: "text", content: "verdict:ok" }]);
  assert.equal(agent.messages.length, before, "no commit from side calls");
  assert.equal(agent.stats.totalTokens, 0, "no stats from side calls");
});

test("call: aborts via adapter, loop untouched", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const hanging = new SimpleModel({ modelId: "hang", stream: false });
  hanging.callNextTurn = (async (_ctx: GodObject): Promise<TurnResult> => {
    await gate;
    return assistantTurn("escaped");
  }) as typeof hanging.callNextTurn;
  const agent = new Agent({ model: [new StubModel([() => assistantTurn("d")]), hanging], agentId: "side-abort" });
  const handle = agent.call(1);
  assert.equal(handle.abort("test-abort"), true, "handle aborts (side controller fallback — stub never minted)");
  release();
  const result = await handle.done;
  assert.deepEqual(result.message.content, [{ type: "text", content: "escaped" }], "signal-ignoring stub still resolves; honoring adapters reject (see fetch tests)");
  assert.equal(agent.loopState, "idle", "loop untouched throughout");
});

test("call: survives loop abort, dies on terminate", async () => {
  const slow = new SimpleModel({ modelId: "slow", stream: false });
  slow.callNextTurn = (async (ctx: GodObject): Promise<TurnResult> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, 50);
    ctx.abortSignal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    await promise;
    if (ctx.abortSignal?.aborted) throw attemptAborted(ctx.abortSignal.reason);
    return assistantTurn("finished");
  }) as typeof slow.callNextTurn;
  const agent = new Agent({ model: [new StubModel([() => assistantTurn("d")]), slow], agentId: "side-life" });
  // survives abort()
  const h1 = agent.call(1);
  agent.abort("loop-death");
  const r1 = await h1.done;
  assert.deepEqual(r1.message.content, [{ type: "text", content: "finished" }], "loop abort does not touch side chains");
  // dies on terminate()
  const agent2 = new Agent({ model: [new StubModel([() => assistantTurn("d")]), slow], agentId: "side-life-2" });
  const h2 = agent2.call(1);
  void agent2.terminate("over");
  await assert.rejects(() => h2.done, /aborted/, "terminate kills side chains");
});

test("driveOnce: loop drives the preset for exactly one turn, then reverts", async () => {
  const driver = new StubModel([() => assistantTurn("driven")]);
  const other = new StubModel([() => assistantTurn("swapped")]);
  const agent = new Agent({ model: [driver, other], agentId: "drive-once" });
  agent.driveOnce("stub-model-001#2");
  assert.equal(agent.model, driver, "pointer untouched until the money call");
  seedUserMessage(agent, "go");
  kick(agent);
  await awaitIdle(agent);
  const texts = agent.messages.filter((m) => m.type === "assistant").map((m) => (m.content as Array<{ content: string }>)[0].content);
  assert.deepEqual(texts, ["swapped"], "the override drove the turn");
  assert.equal(driver.calls.length, 0, "driver never fired");
  assert.equal(other.calls.length, 1);
  assert.equal(agent.model, driver, "reverted after one turn");
});

test("adapter abortCall: kills the in-flight fetch, stamped, no retry", async () => {
  let attempts = 0;
  const model = new SimpleModel({
    modelId: "m",
    stream: false,
    retries: 3,
    fetchImpl: (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      attempts++;
      await new Promise<void>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new Error("AbortError: fetch aborted")), { once: true });
      });
      throw new Error("unreachable");
    }) as unknown as typeof fetch,
  });
  const { agent } = makeAgent({ script: [() => assistantTurn("unused")] });
  seedUserMessage(agent, "go");
  const pending = model.callNextTurn(agent);
  assert.equal(model.inFlightCalls?.length, 1, "call registered synchronously");
  const id = model.inFlightCalls![0]!;
  assert.equal(model.abortCall(id, "keyword: foo"), true);
  assert.equal(model.abortCall(id), false, "already aborted");
  assert.equal(model.abortCall("nope"), false, "unknown id");
  const err = await pending.then(
    () => { throw new Error("must throw"); },
    (e: unknown) => e as { attemptAborted?: unknown; reason?: unknown; name?: string },
  );
  assert.equal(err.attemptAborted, true);
  assert.equal(err.reason, "keyword: foo");
  assert.equal(err.name, "AttemptAbortedError");
  assert.equal(attempts, 1, "no adapter retry on a decision");
  assert.equal(model.inFlightCalls?.length, 0, "registry cleaned on settle");
});

test("adapter abortCall: loop-abort wins outright over call-abort", async () => {
  const model = new SimpleModel({
    modelId: "m",
    stream: false,
    retries: 3,
    fetchImpl: (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      await new Promise<void>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new Error("AbortError: fetch aborted")), { once: true });
      });
      throw new Error("unreachable");
    }) as unknown as typeof fetch,
  });
  const { agent } = makeAgent({ script: [() => assistantTurn("unused")] });
  seedUserMessage(agent, "go");
  const pending = model.callNextTurn(agent);
  agent.abort("loop-death");
  model.abortCall(undefined, "late-call-abort");
  const err = await pending.then(
    () => { throw new Error("must throw"); },
    (e: unknown) => e as { attemptAborted?: unknown },
  );
  assert.equal(err.attemptAborted, undefined, "loop death is not a call decision");
});
