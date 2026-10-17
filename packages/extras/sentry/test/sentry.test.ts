// test/sentry.test.ts — every Success criterion: lanes, gating, wire format.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, EVENTS } from "@sanityloop/core";
import type { Tool } from "@sanityloop/core";
import {
  StubModel,
  assistantTurn,
  callTo,
  makeAgent,
  seedUserMessage,
  toolCallTurn,
  withDriver,
} from "@sanityloop/test-kit/core";
import { awaitLanded } from "@sanityloop/test-kit";
import { emitLog } from "@sanityloop/util";
import {
  authHeader,
  buildEnvelope,
  createSentryPlugin,
  envelopeUrl,
  isNoiseResult,
  isThrownResult,
  newEventId,
  parseDsn,
  parseStackTrace,
} from "@sanityloop/sentry";
import type { SentryEvent, SentryPlugin } from "@sanityloop/sentry";

const DSN = "https://public123@example.com/42";

function capture() {
  const envelopes: string[] = [];
  const headers: Array<{ auth: string; contentType: string }> = [];
  const plugin = createSentryPlugin({
    dsn: DSN,
    transport: (bytes, h) => {
      envelopes.push(bytes);
      headers.push(h);
    },
  });
  return { envelopes, headers, plugin };
}

/** Install the plugin, fire one lane event, flush the fire-and-forget path. */
async function fired(plugin: SentryPlugin, envelopes: string[], event: string, payload: Record<string, unknown>): Promise<void> {
  const agent = new Agent({ model: new StubModel([() => assistantTurn("ok")]) });
  await agent.install(plugin);
  await agent.bus.runFromRegistry(event, payload);
  await plugin.flush();
}

function lastEvent(envelopes: string[]): SentryEvent {
  const lines = envelopes[envelopes.length - 1].trim().split("\n");
  assert.equal(lines.length, 3, "envelope must be exactly 3 lines");
  return JSON.parse(lines[2]) as SentryEvent;
}

test("fatal error lane → issue with exception + mechanism + tags", async () => {
  const { envelopes, plugin } = capture();
  await fired(plugin, envelopes, EVENTS.error, {
    error: new TypeError("boom"),
    message: "boom",
    source: "provider",
  });
  assert.equal(envelopes.length, 1);
  const evt = lastEvent(envelopes);
  assert.equal(evt.platform, "node");
  assert.equal(evt.exception?.values[0].type, "TypeError");
  assert.equal(evt.exception?.values[0].value, "boom");
  assert.deepEqual(evt.exception?.values[0].mechanism, { type: "auto.sanity.error", handled: false });
  assert.equal(evt.tags?.lane, "error");
  assert.match(evt.event_id, /^[0-9a-f]{32}$/);
  assert.equal(typeof evt.timestamp, "number");
});

test("handlerError from a crashing filter → issue; own sentry/* crashes skipped", async () => {
  const { envelopes, plugin } = capture();
  const agent = new Agent({ model: new StubModel([() => assistantTurn("ok")]) });
  await agent.install(plugin);
  agent.addFilter({
    event: "probe",
    id: "crash/other",
    priority: 0,
    fn: async () => {
      throw new Error("filter blew up");
    },
  });
  await agent.bus.runFromRegistry("probe", {});
  await plugin.flush();
  assert.equal(envelopes.length, 1);
  const evt = lastEvent(envelopes);
  assert.deepEqual(evt.exception?.values[0].mechanism, { type: "auto.sanity.filter", handled: true });
  assert.equal(evt.tags?.filter, "crash/other");

  // Self-feedback: a crash blamed on our own filter id must not report.
  await agent.bus.runFromRegistry(EVENTS.handlerError, {
    error: new Error("own crash"),
    filterId: "sentry/tool",
    event: EVENTS.toolEnd,
  });
  await plugin.flush();
  assert.equal(envelopes.length, 1, "own-filter crash must not produce an envelope");
});

test("tool lane off by default — outcomes become crumbs, no issues", async () => {
  const { envelopes, plugin } = capture();
  const agent = new Agent({ model: new StubModel([() => assistantTurn("ok")]) });
  await agent.install(plugin);
  await agent.bus.runFromRegistry(EVENTS.toolEnd, {
    call: { name: "bash", parameters: {} },
    result: { answer: "exit 1", error: true, errorMessage: "exit 1", stored: { trace: "Error: x\n    at f (/a.ts:1:2)" } },
  });
  await plugin.flush();
  assert.equal(envelopes.length, 0, "tool lane must be silent by default");
  // But the crumb trail exists — prove it via the next fatal's breadcrumbs.
  await agent.bus.runFromRegistry(EVENTS.error, { error: new Error("later"), message: "later", source: "loop" });
  await plugin.flush();
  assert.equal(envelopes.length, 1);
  const evt = lastEvent(envelopes);
  assert.equal(evt.breadcrumbs?.values.length, 1);
  assert.equal(evt.breadcrumbs?.values[0].category, "tool");
});

test("tool lane mapping: thrown→issue, returned→crumb, noise→crumb", async () => {
  const envelopes: string[] = [];
  const agent = new Agent({ model: new StubModel([() => assistantTurn("ok")]) });
  const plugin = createSentryPlugin({
    dsn: DSN,
    tools: { enabled: true },
    transport: (bytes) => {
      envelopes.push(bytes);
    },
  });
  await agent.install(plugin);

  // thrown (executeOne catch shape: stored.trace) → issue
  await agent.bus.runFromRegistry(EVENTS.toolEnd, {
    call: { name: "bash", parameters: {} },
    result: { answer: "Tool bash failed: kaboom", error: true, errorMessage: "kaboom", stored: { trace: "Error: kaboom\n    at f (/a.ts:1:2)" } },
  });
  // returned error:true (bash exit≠0 shape, no trace) → crumb
  await agent.bus.runFromRegistry(EVENTS.toolEnd, {
    call: { name: "bash", parameters: {} },
    result: { answer: "exit 1", error: true, errorMessage: "exit 1" },
  });
  // noise (invalid_arguments) → crumb
  await agent.bus.runFromRegistry(EVENTS.toolEnd, {
    call: { name: "bash", parameters: {} },
    result: { answer: "Invalid arguments for bash: bad", error: true, errorMessage: "invalid_arguments", stored: { errors: ["bad"] } },
  });
  // noise (unknown tool) → crumb
  await agent.bus.runFromRegistry(EVENTS.toolEnd, {
    call: { name: "nope", parameters: {} },
    result: { answer: "Unknown tool: nope", error: true },
  });
  await plugin.flush();
  assert.equal(envelopes.length, 1, "only the thrown result becomes an issue");
  const evt = lastEvent(envelopes);
  assert.equal(evt.tags?.lane, "tool");
  assert.equal(evt.tags?.tool, "bash");
  assert.deepEqual(evt.exception?.values[0].mechanism, { type: "auto.sanity.tool", handled: true });
  assert.equal(evt.exception?.values[0].stacktrace?.frames.length, 1);
});

test("tool lane per-tool include/exclude + match escalation", async () => {
  const envelopes: string[] = [];
  const agent = new Agent({ model: new StubModel([() => assistantTurn("ok")]) });
  const plugin = createSentryPlugin({
    dsn: DSN,
    tools: {
      enabled: true,
      include: ["bash"],
      exclude: ["noisy"],
      match: (call) => (call.parameters as Record<string, boolean>).escalate === true,
    },
    transport: (bytes) => {
      envelopes.push(bytes);
    },
  });
  await agent.install(plugin);
  const thrown = (name: string, params: Record<string, unknown> = {}) => ({
    call: { name, parameters: params },
    result: { answer: `Tool ${name} failed: x`, error: true, errorMessage: "x", stored: { trace: "Error: x\n    at f (/a.ts:1:2)" } },
  });
  await agent.bus.runFromRegistry(EVENTS.toolEnd, thrown("other")); // not included
  await agent.bus.runFromRegistry(EVENTS.toolEnd, thrown("bash")); // included → issue
  await agent.bus.runFromRegistry(EVENTS.toolEnd, thrown("noisy")); // excluded (also not included)
  // match escalates a plain returned failure (no trace) to an issue
  await agent.bus.runFromRegistry(EVENTS.toolEnd, {
    call: { name: "bash", parameters: { escalate: true } },
    result: { answer: "exit 1", error: true, errorMessage: "exit 1" },
  });
  await plugin.flush();
  assert.equal(envelopes.length, 2);
});

test("log lane off by default; when on, error→issue, warn→crumb", async () => {
  const { envelopes, plugin } = capture();
  const agent = new Agent({ model: new StubModel([() => assistantTurn("ok")]) });
  await agent.install(plugin);
  emitLog(agent, "error", "perm", "denied");
  await plugin.flush();
  assert.equal(envelopes.length, 0, "log lane must be silent by default");

  agent.uninstall("sentry");
  const envelopes2: string[] = [];
  const plugin2 = createSentryPlugin({
    dsn: DSN,
    logs: { enabled: true },
    transport: (bytes) => {
      envelopes2.push(bytes);
    },
  });
  await agent.install(plugin2);
  emitLog(agent, "warn", "perm", "almost");
  emitLog(agent, "error", "perm", "denied");
  await plugin2.flush();
  assert.equal(envelopes2.length, 1);
  const evt = JSON.parse(envelopes2[0].trim().split("\n")[2]) as SentryEvent;
  assert.equal(evt.tags?.lane, "log");
  assert.equal(evt.logger, "perm");
  assert.deepEqual(evt.exception?.values[0].mechanism, { type: "auto.sanity.log", handled: true });
});

test("DSN parse + envelope bytes + auth header", () => {
  const d = parseDsn("https://pub:sec@example.com:9000/sub/42");
  assert.equal(envelopeUrl(d), "https://example.com:9000/sub/api/42/envelope/");
  assert.equal(authHeader(d), "Sentry sentry_version=7, sentry_client=sanityloop.sentry/0.1.0, sentry_key=pub, sentry_secret=sec");
  assert.equal(authHeader(parseDsn(DSN)), "Sentry sentry_version=7, sentry_client=sanityloop.sentry/0.1.0, sentry_key=public123");

  const evt: SentryEvent = { event_id: "a".repeat(32), timestamp: 1700000000, platform: "node" };
  const bytes = buildEnvelope(evt);
  const lines = bytes.split("\n");
  assert.equal(lines.length, 4, "trailing newline included");
  assert.equal((JSON.parse(lines[0]) as { event_id: string }).event_id, evt.event_id);
  assert.equal((JSON.parse(lines[1]) as { type: string }).type, "event");
  assert.equal((JSON.parse(lines[2]) as SentryEvent).event_id, evt.event_id);

  assert.throws(() => parseDsn("not-a-dsn"), /malformed DSN/);
  assert.throws(() => createSentryPlugin({}), /no DSN/);
  assert.throws(() => createSentryPlugin({ dsn: "junk" }), /malformed DSN/);
  assert.match(newEventId(), /^[0-9a-f]{32}$/);
});

test("uninstall sweep removes all sentry/ filters", async () => {
  const { envelopes, plugin } = capture();
  const agent = new Agent({ model: new StubModel([() => assistantTurn("ok")]) });
  await agent.install(plugin);
  assert.ok(agent.filters.some((f) => f.id.startsWith("sentry/")));
  agent.uninstall("sentry");
  assert.equal(agent.filters.filter((f) => f.id.startsWith("sentry/")).length, 0);
  await agent.bus.runFromRegistry(EVENTS.error, { error: new Error("x"), message: "x", source: "loop" });
  await plugin.flush();
  assert.equal(envelopes.length, 0, "no capture after uninstall");
});

test("self-guards: throwing transport + throwing match/beforeSend never feed back", async () => {
  const agent = new Agent({ model: new StubModel([() => assistantTurn("ok")]) });
  const plugin = createSentryPlugin({
    dsn: DSN,
    tools: {
      enabled: true,
      match: () => {
        throw new Error("match bug");
      },
    },
    transport: () => {
      throw new Error("network down");
    },
    beforeSend: () => {
      throw new Error("beforeSend bug");
    },
  });
  await agent.install(plugin);
  let handlerErrors = 0;
  agent.addFilter({
    event: EVENTS.handlerError,
    id: "spy/handler-errors",
    priority: 100,
    fn: async (_a, e) => {
      const filterId = (e as Record<string, unknown> | undefined)?.filterId;
      if (typeof filterId === "string" && filterId.startsWith("sentry/")) handlerErrors++;
    },
  });
  await agent.bus.runFromRegistry(EVENTS.toolEnd, {
    call: { name: "bash", parameters: {} },
    result: { answer: "Tool bash failed: x", error: true, errorMessage: "x", stored: { trace: "Error: x\n    at f (/a.ts:1:2)" } },
  });
  await agent.bus.runFromRegistry(EVENTS.error, { error: new Error("y"), message: "y", source: "loop" });
  await plugin.flush();
  assert.equal(handlerErrors, 0, "sentry filters must never produce handlerError feedback");
});

test("V8 stack parser: frame order + shapes", () => {
  const stack = "Error: x\n    at foo (/a.ts:10:20)\n    at async bar (/b.ts:1:2)\n    at /c.ts:3:4\n    at weird line here";
  const frames = parseStackTrace(stack);
  assert.equal(frames.length, 3);
  // Sentry order: oldest → newest (reverse of V8)
  assert.equal(frames[0].filename, "/c.ts");
  assert.equal(frames[0].function, "<anonymous>");
  assert.equal(frames[1].function, "bar");
  assert.equal(frames[2].filename, "/a.ts");
  assert.equal(frames[2].lineno, 10);
  assert.equal(frames[2].colno, 20);
  assert.deepEqual(parseStackTrace("garbage\nmore garbage"), []);
});

test("pure gating helpers", () => {
  assert.equal(isThrownResult({ error: true, stored: { trace: "Error: x\n    at f" } }), true);
  assert.equal(isThrownResult({ error: true }), false);
  assert.equal(isThrownResult({}), false);
  assert.equal(isNoiseResult({ answer: "x", error: true, errorMessage: "invalid_arguments" }), true);
  assert.equal(isNoiseResult({ answer: "Unknown tool: z", error: true }), true);
  assert.equal(isNoiseResult({ answer: "This tool is currently disabled: z", error: true }), true);
  assert.equal(isNoiseResult({ answer: "exit 1", error: true }), false);
});

test("SENTRY_DSN env fallback; beforeSend drop + flush()", async () => {
  process.env.SENTRY_DSN = DSN;
  try {
    const envelopes: string[] = [];
    const plugin = createSentryPlugin({
      transport: (bytes) => {
        envelopes.push(bytes);
      },
      beforeSend: () => null, // drop everything
    });
    const agent = new Agent({ model: new StubModel([() => assistantTurn("ok")]) });
    await agent.install(plugin);
    await agent.bus.runFromRegistry(EVENTS.error, { error: new Error("dropped"), message: "dropped", source: "loop" });
    await plugin.flush();
    assert.equal(envelopes.length, 0, "beforeSend null must drop the event");
  } finally {
    delete process.env.SENTRY_DSN;
  }
});

test("full loop: throwing tool → turn → issue with crumb trail (test-kit harness)", async () => {
  const envelopes: string[] = [];
  const plugin = createSentryPlugin({
    dsn: DSN,
    tools: { enabled: true },
    transport: (bytes) => {
      envelopes.push(bytes);
    },
  });
  const throwing: Tool = {
    name: "explode",
    description: "always throws",
    inputSchema: { type: "object", properties: {} },
    execute: () => {
      throw new Error("tool kaboom");
    },
  };
  const { agent } = makeAgent({
    script: [
      () => toolCallTurn([callTo("explode", {})]),
      () => assistantTurn("recovered"),
    ],
    tools: [throwing],
  });
  await agent.install(plugin);
  await withDriver(agent, async () => {
    seedUserMessage(agent, "go");
    agent.input({ type: "__test_kick__" });
    await awaitLanded(agent, { timeout: 10000 });
  });
  await plugin.flush();
  assert.ok(envelopes.length >= 1, `expected a tool issue, got ${envelopes.length} envelopes`);
  const evt = lastEvent(envelopes);
  assert.equal(evt.tags?.lane, "tool");
  assert.equal(evt.tags?.tool, "explode");
  assert.match(evt.exception?.values[0].value ?? "", /kaboom/);
});
