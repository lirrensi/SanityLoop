// ============================================================================
// file-rpc tests — room lifecycle: claim / refuse / takeover / uninstall.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "@sanityloop/core";
import { StubModel } from "@sanityloop/test-kit/core";
import { makeTempDir } from "@sanityloop/test-kit";
import { createFileRpc } from "@sanityloop/file-rpc";

function idleAgent(id?: string): Agent {
  return new Agent({
    model: new StubModel([]),
    agentId: "file-rpc-test",
    ...(id ? { id } : {}),
  });
}

test("install claims the room: dirs, live.json, state.rpc, capability", async (t) => {
  const lobby = await makeTempDir(t);
  const agent = idleAgent();
  agent.install(createFileRpc({ dir: lobby }));

  const room = join(lobby, agent.id);
  assert.ok(existsSync(join(room, "inbox")));
  assert.ok(existsSync(join(room, "processed")));
  assert.ok(
    existsSync(join(room, "outbox", "events.jsonl")) === false,
    "no events file before any command",
  );
  const card = JSON.parse(readFileSync(join(room, "live.json"), "utf8"));
  assert.equal(card.pid, process.pid);
  assert.equal(card.id, agent.id);
  assert.equal(card.agentId, "file-rpc-test");
  assert.ok(
    typeof card.started === "number" && typeof card.updated === "number",
  );
  assert.deepEqual(agent.state.rpc, { lobby, room });
  assert.ok(agent.getDeclaredCapability("file-rpc"));

  agent.uninstall("file-rpc");
  assert.ok(existsSync(room), "explicit dirs survive uninstall");
  assert.equal(agent.state.rpc, undefined, "state.rpc stamp removed");
  assert.equal(
    agent.getDeclaredCapability("file-rpc"),
    undefined,
    "capability removed",
  );
  assert.equal(
    agent.filters.some((f) => f.id.startsWith("file-rpc/")),
    false,
    "no filters left behind",
  );
});

test("second live claim with the same id refuses loudly", async (t) => {
  const lobby = await makeTempDir(t);
  const id = "same-room";
  const a = idleAgent(id);
  a.install(createFileRpc({ dir: lobby }));
  const b = idleAgent(id);
  assert.throws(
    () => b.install(createFileRpc({ dir: lobby })),
    /already claimed by live pid/,
  );
  a.uninstall("file-rpc");
});

test("stale-pid claim takes over and notes it", async (t) => {
  const lobby = await makeTempDir(t);
  const id = "takeover-room";
  const room = join(lobby, id);
  mkdirSync(join(room, "inbox"), { recursive: true });
  const deadPid = 2_000_000_000; // no live pid is this large
  writeFileSync(
    join(room, "live.json"),
    JSON.stringify({
      pid: deadPid,
      agentId: "x",
      id,
      started: 1,
      loopState: "idle",
      activity: "",
      updated: 1,
    }),
  );

  const agent = idleAgent(id);
  agent.install(createFileRpc({ dir: lobby }));
  const card = JSON.parse(readFileSync(join(room, "live.json"), "utf8"));
  assert.equal(card.pid, process.pid, "the live pid re-stamps the card");
  assert.equal(card.tookOverFrom, deadPid, "takeover noted on the card");
  agent.uninstall("file-rpc");
});

test("two agents in one lobby get two rooms", async (t) => {
  const lobby = await makeTempDir(t);
  const a = idleAgent();
  const b = idleAgent();
  a.install(createFileRpc({ dir: lobby }));
  b.install(createFileRpc({ dir: lobby }));
  assert.notEqual(a.id, b.id);
  assert.ok(existsSync(join(lobby, a.id, "live.json")));
  assert.ok(existsSync(join(lobby, b.id, "live.json")));
  assert.deepEqual(a.state.rpc, { lobby, room: join(lobby, a.id) });
  assert.deepEqual(b.state.rpc, { lobby, room: join(lobby, b.id) });
  a.uninstall("file-rpc");
  b.uninstall("file-rpc");
});

test("uninstall matrix: only ephemeral rooms are removed", async (t) => {
  // explicit dir stays
  const explicit = await makeTempDir(t, "filerpc-explicit-");
  const e1 = idleAgent();
  e1.install(createFileRpc({ dir: explicit }));
  const e1room = join(explicit, e1.id);
  e1.uninstall("file-rpc");
  assert.ok(existsSync(e1room), "explicit room survives uninstall");

  // session-nested stays
  const sessionDir = await makeTempDir(t, "filerpc-session-");
  const e2 = idleAgent();
  e2.install(createFileRpc({ sessionDir }));
  const e2room = join(sessionDir, "rpc", e2.id);
  assert.ok(
    existsSync(e2room),
    "session-nested room claimed under sessionDir/rpc",
  );
  e2.uninstall("file-rpc");
  assert.ok(existsSync(e2room), "session-nested room survives uninstall");

  // ephemeral (no dir at all) is removed
  const e3 = idleAgent();
  const plugin = createFileRpc();
  e3.install(plugin);
  const e3room = (e3.state.rpc as { room: string }).room;
  assert.ok(existsSync(e3room), "ephemeral room claimed");
  e3.uninstall("file-rpc");
  assert.ok(!existsSync(e3room), "ephemeral room removed on uninstall");
});
