// packages/extras/loops/test/loops.test.ts — once + cron records.
// once fires exactly once and completes itself; cron arms at install with an
// honest nextFireAt and re-arms per slot. Matcher is pure — no agent needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loops, nextCronFire } from "@sanityloop/loops";
import type { LoopSnapshot } from "@sanityloop/loops";
import { Agent } from "@sanityloop/core";
import { createDefaultInputs } from "@sanityloop/inputs";
import { StubModel, assistantTurn } from "@sanityloop/test-kit/core";
import { withDriver } from "@sanityloop/test-kit/core";
import { awaitLanded, waitUntil } from "@sanityloop/test-kit";

const mirror = (agent: Agent): Record<string, LoopSnapshot> =>
  agent.state.loops as Record<string, LoopSnapshot>;

test("nextCronFire: weekday, step, list, OR-rule, tz, impossible, bad", () => {
  const sunNoon = Date.UTC(2026, 9, 18, 12, 0, 0); // a Sunday
  assert.equal(nextCronFire("0 9 * * 1", sunNoon, "UTC"), Date.UTC(2026, 9, 19, 9, 0, 0));
  assert.equal(nextCronFire("* * * * *", sunNoon + 30_000, "UTC"), Date.UTC(2026, 9, 18, 12, 1, 0));
  assert.equal(
    nextCronFire("0,30 9 * * *", Date.UTC(2026, 9, 18, 9, 15, 0), "UTC"),
    Date.UTC(2026, 9, 18, 9, 30, 0),
  );
  // Oct 19 2026 is a Monday: dom=1 OR dow=Mon matches via dow
  assert.equal(
    nextCronFire("0 0 1 * 1", sunNoon, "UTC"),
    Date.UTC(2026, 9, 19, 0, 0, 0),
  );
  // 09:00 New York (EDT = UTC-4) = 13:00 UTC
  assert.equal(
    nextCronFire("0 9 * * *", sunNoon, "UTC"),
    Date.UTC(2026, 9, 19, 9, 0, 0),
  );
  assert.equal(
    nextCronFire("0 9 * * *", sunNoon, "America/New_York"),
    Date.UTC(2026, 9, 18, 13, 0, 0),
  );
  assert.equal(nextCronFire("0 0 30 2 *", sunNoon, "UTC"), undefined);
  assert.throws(() => nextCronFire("not a cron", sunNoon));
  assert.throws(() => nextCronFire("0 0 * *", sunNoon));
});

test("once: fires exactly once, injects the message, completes itself", async () => {
  const model = new StubModel([() => assistantTurn("ack")]);
  const agent = new Agent({ model, agentId: "loops-once" });
  agent.use(createDefaultInputs());
  agent.use(loops({ once: { delayMs: 30, message: "one-shot ping" } }));
  await withDriver(agent, async () => {
    // integration by nature: a real 30ms timer must fire through the live
    // heartbeat — fake timers can't drive the agent's two clocks.
    await waitUntil(() => mirror(agent).once?.status === "completed", {
      what: "one-shot to fire + complete",
    });
    await awaitLanded(agent);
    // assert INSIDE the driver: withDriver's teardown abort() flips live
    // loops to "stopped" (TUI parity) — after the block the status is
    // teardown truth, not fire truth.
    const snap = mirror(agent).once;
    assert.equal(snap.status, "completed");
    assert.equal(snap.fires, 1);
  });
  // history survives teardown — the kick's landing is permanent
  assert.ok(
    agent.messages.some(
      (m) => m.type === "user" && JSON.stringify(m.content).includes("one-shot ping"),
    ),
    "the kick landed in history",
  );
});

test("once: bad options throw at install (fail fast)", () => {
  const model = new StubModel([]);
  const agent = new Agent({ model, agentId: "loops-once-bad" });
  agent.use(createDefaultInputs());
  assert.throws(() => agent.use(loops({ once: { message: "x" } })));
  assert.throws(() =>
    agent.use(loops({ once: { delayMs: 10, at: Date.now() + 100, message: "x" } })),
  );
});

test("cron: arms at install, mirror honest, uninstall cleans", async () => {
  const model = new StubModel([() => assistantTurn("ack")]);
  const agent = new Agent({ model, agentId: "loops-cron" });
  agent.use(createDefaultInputs());
  agent.use(loops({ cron: { expression: "* * * * *", message: "tick" } }));
  const snap = mirror(agent).cron;
  const now = Date.now();
  assert.equal(snap.status, "waiting");
  assert.ok(typeof snap.nextFireAt === "number" && snap.nextFireAt > now);
  assert.ok((snap.nextFireAt as number) <= now + 61_000, "next slot within a minute");
  assert.equal(snap.expression, "* * * * *");
  agent.uninstall("loops");
  assert.equal(agent.state.loops, undefined);
  agent.abort();
});

test("cron: bad expression throws at install", () => {
  const model = new StubModel([]);
  const agent = new Agent({ model, agentId: "loops-cron-bad" });
  agent.use(createDefaultInputs());
  assert.throws(() =>
    agent.use(loops({ cron: { expression: "nope", message: "x" } })),
  );
});
