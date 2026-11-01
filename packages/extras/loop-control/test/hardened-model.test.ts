// hardened-model tests — chain walk, verdicts, timeouts, exhaustion, swap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "@sanityloop/core";
import type { GodObject, ModelContract, TurnResult } from "@sanityloop/core";
import { StubModel, assistantTurn } from "@sanityloop/test-kit/core";
import { withDriver } from "@sanityloop/test-kit/core";
import { awaitLanded } from "@sanityloop/test-kit";
import { loopControl } from "@sanityloop/loop-control";
import { HardenedModel, StallError, defaultClassify } from "../hardened-model.ts";

/** A model script that throws on demand — counts calls, fails per plan. */
function flakyModel(modelId: string, plan: Array<"throw" | "ok">, err = new Error("boom-500")): ModelContract & { calls: number } {
  const m = {
    api: "test",
    modelId,
    stream: false,
    calls: 0,
    async callNextTurn(_ctx: GodObject): Promise<TurnResult> {
      m.calls++;
      const step = plan.shift() ?? "ok";
      if (step === "throw") throw err;
      return assistantTurn(`from-${modelId}`);
    },
  };
  return m;
}

const ctx = () => ({ abortSignal: undefined } as unknown as GodObject);

test("defaultClassify: abort escapes, everything else retries", () => {
  assert.equal(defaultClassify(new Error("x")), "retry");
  const abort = new Error("x");
  abort.name = "AbortError";
  assert.equal(defaultClassify(abort), "stop");
  // a call-abort is a DECISION, never retried (core contract)
  const callAbort = Object.assign(new Error("killed"), { attemptAborted: true });
  assert.equal(defaultClassify(callAbort), "stop");
  const stamped = new Error("killed");
  stamped.name = "AttemptAbortedError";
  assert.equal(defaultClassify(stamped), "stop");
});

test("chain walk: primary exhausts attempts, fallback answers", async () => {
  const primary = flakyModel("primary", ["throw", "throw", "throw"]);
  const fallback = flakyModel("fallback", ["ok"]);
  const h = new HardenedModel(primary, { fallback: [fallback], attempts: 2, backoffMs: 1 });
  const result = await h.callNextTurn(ctx());
  assert.equal(primary.calls, 2, "primary tried twice");
  assert.equal(fallback.calls, 1, "fallback answered");
  assert.deepEqual(result.message.content, [{ type: "text", content: "from-fallback" }]);
});

test("classify fallback: skips remaining attempts of the dead model", async () => {
  const primary = flakyModel("primary", ["throw", "throw", "throw"]);
  const fallback = flakyModel("fallback", ["ok"]);
  const seen: unknown[] = [];
  const h = new HardenedModel(primary, {
    fallback: [fallback],
    attempts: 5,
    backoffMs: 1,
    classify: (err) => { seen.push(err); return "fallback"; },
  });
  await h.callNextTurn(ctx());
  assert.equal(primary.calls, 1, "one strike — no wasted retries");
  assert.equal(fallback.calls, 1);
  assert.equal(seen.length, 1, "classify called once per failure");
});

test("classify stop: gives up immediately", async () => {
  const primary = flakyModel("primary", ["throw", "throw"]);
  const fallback = flakyModel("fallback", ["ok"]);
  const h = new HardenedModel(primary, {
    fallback: [fallback],
    attempts: 5,
    backoffMs: 1,
    classify: () => "stop",
  });
  const result = await h.callNextTurn(ctx());
  assert.equal(primary.calls, 1);
  assert.equal(fallback.calls, 0, "chain abandoned");
  assert.equal(result.stopReason, "error");
});

test("exhaustion synthesizes an honest assistant message (never throws)", async () => {
  const primary = flakyModel("primary", ["throw", "throw"], new Error("down-503"));
  const h = new HardenedModel(primary, { attempts: 2, backoffMs: 1 });
  const result = await h.callNextTurn(ctx());
  assert.equal(result.stopReason, "error");
  assert.equal(result.message.type, "assistant");
  const text = (result.message.content as Array<{ content: string }>)[0].content;
  assert.match(text, /2 attempt\(s\)/);
  assert.match(text, /down-503/);
});

test("onExhausted throw: rethrows the last error (fail path preserved)", async () => {
  const err = new Error("auth-401");
  const primary = flakyModel("primary", ["throw"], err);
  const h = new HardenedModel(primary, { attempts: 1, onExhausted: "throw" });
  await assert.rejects(() => h.callNextTurn(ctx()), /auth-401/);
});

test("attemptTimeoutMs abandons the hung attempt and retries", async () => {
  let calls = 0;
  const hanging = {
    api: "test",
    modelId: "hang",
    stream: false,
    async callNextTurn(_ctx: GodObject): Promise<TurnResult> {
      calls++;
      if (calls === 1) await new Promise(() => {}); // hangs forever (orphaned)
      return assistantTurn("recovered");
    },
  };
  const h = new HardenedModel(hanging, { attempts: 2, attemptTimeoutMs: 30, backoffMs: 1 });
  const result = await h.callNextTurn(ctx());
  assert.equal(calls, 2);
  assert.deepEqual(result.message.content, [{ type: "text", content: "recovered" }]);
});

test("stall firstTokenMs fires when the stream never starts", async () => {
  const silent = {
    api: "test",
    modelId: "silent",
    stream: true,
    async callNextTurn(_ctx: GodObject): Promise<TurnResult> {
      await new Promise(() => {}); // no deltas, never settles
      throw new Error("unreachable");
    },
  };
  const h = new HardenedModel(silent, { attempts: 1, stall: { firstTokenMs: 30 } });
  const result = await h.callNextTurn(ctx());
  assert.equal(result.stopReason, "error");
  const text = (result.message.content as Array<{ content: string }>)[0].content;
  assert.match(text, /first-token/);
});

test("stall does NOT fire when deltas flow", async () => {
  const chatty = {
    api: "test",
    modelId: "chatty",
    stream: true,
    async callNextTurn(ctx: GodObject): Promise<TurnResult> {
      const sink = (ctx as unknown as { streamSink?: { emit(e: unknown): void } }).streamSink;
      for (let i = 0; i < 5; i++) {
        sink?.emit({ type: "textDelta", delta: "x" });
        await new Promise((r) => setTimeout(r, 10));
      }
      return assistantTurn("streamed");
    },
  };
  const h = new HardenedModel(chatty, { attempts: 1, stall: { firstTokenMs: 50, idleMs: 50 } });
  const result = await h.callNextTurn(ctx());
  assert.deepEqual(result.message.content, [{ type: "text", content: "streamed" }]);
});
test("transparency: contract fields delegate to the primary", () => {
  const primary = new StubModel([() => assistantTurn("x")]);
  primary.maxContext = 128000;
  const h = new HardenedModel(primary, { attempts: 1 });
  assert.equal(h.modelId, "stub-model-001");
  assert.equal(h.maxContext, 128000);
  h.maxContext = 64000;
  assert.equal(primary.maxContext, 64000, "writes pass through");
});

test("loop integration: harden swaps at install, restores at uninstall, survives provider death", async () => {
  const primary = flakyModel("primary", ["throw"]);
  const fallback = flakyModel("fallback", ["ok"]);
  const agent = new Agent({ model: primary, agentId: "harden-loop" });
  const plugin = loopControl({ harden: { enabled: true, fallback: [fallback], attempts: 1, backoffMs: 1 } });
  await agent.install(plugin);
  assert.ok(agent.model instanceof HardenedModel, "model swapped");
  let landedLoopState: string | undefined;
  await withDriver(agent, async () => {
    agent.messages.push({
      id: "u-1", enabled: true, type: "user", committedAt: Date.now(),
      content: [{ type: "text", content: "go" }],
    });
    agent.input({ type: "__test_kick__" });
    await awaitLanded(agent);
    landedLoopState = agent.loopState;
  });
  assert.equal(primary.calls, 1);
  assert.equal(fallback.calls, 1, "fallback answered inside the real loop");
  assert.equal(landedLoopState, "idle", "landed idle — no errored morgue");
  agent.uninstall("loop-control");
  // plain-object models pass through the observer Proxy (isProxyable) — so
  // identity is unobservable; assert structural restore (wrapper gone).
  assert.ok(!(agent.model instanceof HardenedModel), "wrapper removed");
  assert.equal(agent.model.modelId, "primary", "original restored");
});

test("loop integration: exhaustion synthesizes, transcript shows the failure", async () => {
  const primary = flakyModel("primary", ["throw", "throw", "throw"]);
  const agent = new Agent({ model: primary, agentId: "harden-exhaust" });
  await agent.install(loopControl({ harden: { enabled: true, attempts: 3, backoffMs: 1 } }));
  await withDriver(agent, async () => {
    agent.messages.push({
      id: "u-1", enabled: true, type: "user", committedAt: Date.now(),
      content: [{ type: "text", content: "go" }],
    });
    agent.input({ type: "__test_kick__" });
    await awaitLanded(agent);
  });
  const last = agent.messages.at(-1);
  assert.equal(last?.type, "assistant");
  const text = ((last?.content ?? []) as Array<{ content: string }>)[0]?.content ?? "";
  assert.match(text, /loop-control/);
  assert.match(text, /3 attempt/);
});
