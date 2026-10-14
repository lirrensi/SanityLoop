// ============================================================================
// file-rpc tests — inbox dispatch: every door, malformed + unknown handling.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { Agent } from "@sanityloop/core";
import { StubModel, assistantTurn } from "@sanityloop/test-kit/core";
import { makeTempDir, waitUntil } from "@sanityloop/test-kit";
import { createDefaultInputs } from "@sanityloop/inputs";
import { createFileRpc, readEvents } from "@sanityloop/file-rpc";
import type { RpcResponse } from "@sanityloop/file-rpc";
function drop(
  room: string,
  body: unknown,
  name = `req-${Math.random().toString(36).slice(2)}.json`,
): void {
  writeFileSync(
    join(room, "inbox", `${name}.tmp`),
    `${JSON.stringify(body)}\n`,
    "utf8",
  );
  // tmp+rename, like every real sender
  renameSync(join(room, "inbox", `${name}.tmp`), join(room, "inbox", name));
}

async function responseFor(room: string, id: string): Promise<RpcResponse> {
  let found: RpcResponse | undefined;
  await waitUntil(
    () => {
      const recs = readEventsSync(room);
      found = recs.find((r) => r.type === "response" && r.id === id) as
        RpcResponse | undefined;
      return found !== undefined;
    },
    { what: `response ${id}`, timeout: 5000 },
  );
  return found as RpcResponse;
}
function readEventsSync(
  room: string,
): Array<{ type: string; id?: string; command?: string }> {
  try {
    return readFileSync(join(room, "outbox", "events.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

test("dispatch: health + get_state + awaits + questions + tools + capabilities", async (t) => {
  const lobby = await makeTempDir(t);
  const agent = new Agent({ model: new StubModel([]), agentId: "doors" });
  agent.install(createFileRpc({ dir: lobby, pollMs: 25 }));
  const room = join(lobby, agent.id);

  drop(room, { id: "h1", type: "health" });
  assert.equal((await responseFor(room, "h1")).success, true);
  const health = (await responseFor(room, "h1")).data as {
    ok: boolean;
    pid: number;
    loopState: string;
  };
  assert.equal(health.ok, true);
  assert.equal(health.pid, process.pid);

  drop(room, { id: "s1", type: "get_state", keys: ["loopState"] });
  const state = (await responseFor(room, "s1")).data as Record<string, unknown>;
  assert.equal(state["loopState"], "idle");

  agent.state.todos = [{ title: "x" }];
  drop(room, {
    id: "s2",
    type: "get_state",
    keys: ["state.todos", "state.missing"],
  });
  const picked = (await responseFor(room, "s2")).data as Record<
    string,
    unknown
  >;
  assert.deepEqual(picked["state.todos"], [{ title: "x" }]);
  assert.equal(picked["state.missing"], null);

  for (const [id, type] of [
    ["a1", "awaits"],
    ["q1", "questions"],
    ["t1", "tools"],
    ["c1", "capabilities"],
  ] as const) {
    drop(room, { id, type });
    assert.equal((await responseFor(room, id)).success, true, type);
  }
  const caps = (await responseFor(room, "c1")).data as Array<{ id: string }>;
  assert.ok(caps.some((c) => c.id === "file-rpc"));

  agent.uninstall("file-rpc");
});

test("dispatch: control ops + unknown op failure", async (t) => {
  const lobby = await makeTempDir(t);
  const agent = new Agent({ model: new StubModel([]), agentId: "ctl" });
  agent.install(createFileRpc({ dir: lobby, pollMs: 25 }));
  const room = join(lobby, agent.id);

  for (const op of ["stop", "abort", "pause", "wake"]) {
    drop(room, { id: `c-${op}`, type: "control", op });
    const res = await responseFor(room, `c-${op}`);
    assert.equal(res.success, true, op);
    assert.deepEqual(res.data, { ok: true, op });
  }
  // flags reset by landing? abort/stop leave halt flags until the loop lands —
  // the door only proves the calls happened (no throw) and the reply shape.
  drop(room, { id: "c-bad", type: "control", op: "dance" });
  const bad = await responseFor(room, "c-bad");
  assert.equal(bad.success, false);
  assert.match(bad.error ?? "", /unknown op/);
  agent.uninstall("file-rpc");
});

test("dispatch: input passthrough reaches agent.input verbatim", async (t) => {
  const lobby = await makeTempDir(t);
  const agent = new Agent({
    model: new StubModel([() => assistantTurn("hi")]),
    agentId: "passthru",
  });
  agent.install(createDefaultInputs());
  agent.install(createFileRpc({ dir: lobby, pollMs: 25 }));
  agent.run({ startState: "idle" });
  const room = join(lobby, agent.id);

  drop(room, { id: "i1", type: "input_followup", text: "hello cutie" });
  const res = await responseFor(room, "i1");
  assert.equal(res.success, true);
  const user = await waitUntil(
    () => agent.messages.some((m) => m.type === "user"),
    { what: "followup to land", timeout: 5000 },
  ).then(() => agent.messages.find((m) => m.type === "user"));
  assert.deepEqual(user?.content, [{ type: "text", content: "hello cutie" }]);

  // pi-framed shape
  drop(room, {
    id: "i2",
    type: "input",
    body: { type: "input_followup", text: "second" },
  });
  assert.equal((await responseFor(room, "i2")).success, true);

  // malformed input body → failure response, nothing lands
  const before = agent.messages.length;
  drop(room, { id: "i3", type: "input", body: { noType: true } });
  assert.equal((await responseFor(room, "i3")).success, false);
  assert.equal(
    agent.messages.length,
    before,
    "bad input never reaches the agent",
  );

  agent.uninstall("file-rpc");
});

test("malformed JSON → processed/failed + id-less response, never a crash", async (t) => {
  const lobby = await makeTempDir(t);
  const agent = new Agent({ model: new StubModel([]), agentId: "badjson" });
  agent.install(createFileRpc({ dir: lobby, pollMs: 25 }));
  const room = join(lobby, agent.id);

  writeFileSync(
    join(room, "inbox", "req-broken.json"),
    "{ this is not json",
    "utf8",
  );
  await waitUntil(
    () => existsSync(join(room, "processed", "failed", "req-broken.json")),
    { what: "quarantine", timeout: 5000 },
  );
  const events = await readEvents(room);
  const parseFail = events.find(
    (e) => e.type === "response" && (e as RpcResponse).command === "parse",
  );
  assert.ok(parseFail, "an id-less parse response was appended");
  assert.equal((parseFail as RpcResponse).success, false);
  assert.equal((parseFail as RpcResponse).id, undefined);

  // typeless object → same treatment
  drop(room, { id: "t1", type: 42 });
  const res = await responseFor(room, "t1");
  assert.equal(res.success, false);
  assert.equal(res.command, "parse");

  agent.uninstall("file-rpc");
});

test("unknown type ignored (no reply) + *.tmp files ignored", async (t) => {
  const lobby = await makeTempDir(t);
  const agent = new Agent({ model: new StubModel([]), agentId: "unknown" });
  agent.install(createFileRpc({ dir: lobby, pollMs: 25 }));
  const room = join(lobby, agent.id);

  writeFileSync(
    join(room, "inbox", "half.json.tmp"),
    JSON.stringify({ id: "ghost", type: "health" }),
    "utf8",
  );
  drop(room, { id: "u2", type: "nope_nope" }, "req-u2.json");
  await waitUntil(() => existsSync(join(room, "processed", "req-u2.json")), {
    what: "unknown receipt",
    timeout: 5000,
  });
  const events = await readEvents(room);
  assert.equal(
    events.some((e) => e.type === "response" && (e as RpcResponse).id === "u2"),
    false,
    "unknown type gets no reply",
  );
  assert.equal(
    existsSync(join(room, "inbox", "half.json.tmp")),
    true,
    "*.tmp never picked up",
  );
  assert.equal(existsSync(join(room, "processed", "half.json.tmp")), false);

  agent.uninstall("file-rpc");
});

test("backlog drains on (re)start, incl. takeover", async (t) => {
  const lobby = await makeTempDir(t);
  const id = "backlog-room";
  const first = new Agent({ model: new StubModel([]), agentId: "backlog", id });
  first.install(createFileRpc({ dir: lobby, pollMs: 0, heartbeatMs: 0 }));
  const room = join(lobby, first.id);
  drop(room, { id: "b1", type: "health" }, "req-b1.json");
  await responseFor(room, "b1");
  // fake the death: rewrite the card with a dead pid so the second install
  // takes over (a same-process re-install would refuse — the pid is live).
  writeFileSync(
    join(room, "live.json"),
    JSON.stringify({ pid: 2_000_000_000, agentId: "backlog", id, started: 0, loopState: "idle", activity: "", updated: 0 }),
    "utf8",
  );

  // queue while nobody listens
  writeFileSync(
    join(room, "inbox", "req-b2.json"),
    JSON.stringify({ id: "b2", type: "health" }),
    "utf8",
  );
  const second = new Agent({
    model: new StubModel([]),
    agentId: "backlog",
    id,
  });
  second.install(createFileRpc({ dir: lobby, pollMs: 25 })); // takeover + drain
  const res = await responseFor(room, "b2");
  assert.equal(
    res.success,
    true,
    "backlog command dispatched after takeover restart",
  );
  second.uninstall("file-rpc");
  first.uninstall("file-rpc"); // each agent uninstalls its own install
});

test("1 MiB payload cap rejects oversized commands", async (t) => {
  const lobby = await makeTempDir(t);
  const agent = new Agent({ model: new StubModel([]), agentId: "cap" });
  agent.install(createFileRpc({ dir: lobby, pollMs: 25 }));
  const room = join(lobby, agent.id);

  const big = "x".repeat(1024 * 1024 + 8);
  writeFileSync(
    join(room, "inbox", "req-big.json"),
    JSON.stringify({ id: "big1", type: "health", blob: big }),
    "utf8",
  );
  const res = await responseFor(room, "big1");
  assert.equal(res.success, false);
  assert.match(res.error ?? "", /too large/);
  assert.ok(existsSync(join(room, "processed", "failed", "req-big.json")));

  agent.uninstall("file-rpc");
});
