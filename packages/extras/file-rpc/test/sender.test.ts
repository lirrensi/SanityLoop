// ============================================================================
// file-rpc tests — sender: resolution, ambiguity, timeout, stale flags.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { Agent } from "@sanityloop/core";
import { StubModel } from "@sanityloop/test-kit/core";
import { makeTempDir, waitUntil } from "@sanityloop/test-kit";
import { createFileRpc, readEvents } from "@sanityloop/file-rpc";
import {
  FileRpcError,
  listRooms,
  listRoomsSync,
  sendCommand,
} from "@sanityloop/file-rpc/sender";

test("sendCommand round-trips health with id correlation", async (t) => {
  const lobby = await makeTempDir(t);
  const agent = new Agent({ model: new StubModel([]), agentId: "target" });
  agent.install(createFileRpc({ dir: lobby, pollMs: 25 }));

  const res = await sendCommand(lobby, { body: { id: "s1", type: "health" } });
  assert.ok(res, "a response came back");
  assert.equal(res?.id, "s1");
  assert.equal(res?.type, "response");
  assert.equal(res?.command, "health");
  assert.equal(res?.success, true);
  assert.equal((res?.data as { ok: boolean }).ok, true);

  agent.uninstall("file-rpc");
});

test("single room needs no --to; multi-room without --to lists + exits 2", async (t) => {
  const lobby = await makeTempDir(t);
  const a = new Agent({ model: new StubModel([]), agentId: "one" });
  const b = new Agent({ model: new StubModel([]), agentId: "two" });
  a.install(createFileRpc({ dir: lobby, pollMs: 25 }));
  b.install(createFileRpc({ dir: lobby, pollMs: 25 }));

  const err = await sendCommand(lobby, {
    body: { id: "x", type: "health" },
  }).then(
    () => null,
    (e: unknown) => e as FileRpcError,
  );
  assert.ok(err instanceof FileRpcError, "ambiguity throws FileRpcError");
  assert.equal(err?.code, "ROOMS_AVAILABLE");
  assert.equal(err?.rooms.length, 2, "the error lists the rooms");
  assert.match(err?.message ?? "", /--to/);

  // explicit --to resolves
  const res = await sendCommand(lobby, {
    to: a.id,
    body: { id: "y", type: "health" },
  });
  assert.equal(res?.id, "y");
  assert.equal(res?.success, true);

  // unknown --to names the lobby's rooms
  const missing = await sendCommand(lobby, {
    to: "ghost",
    body: { id: "z", type: "health" },
  }).then(
    () => null,
    (e: unknown) => e as FileRpcError,
  );
  assert.equal(missing?.code, "NO_SUCH_ROOM");

  a.uninstall("file-rpc");
  b.uninstall("file-rpc");
});

test("no rooms → NO_ROOMS; bad body → BAD_COMMAND", async (t) => {
  const lobby = await makeTempDir(t);
  const empty = await sendCommand(lobby, {
    body: { id: "x", type: "health" },
  }).then(
    () => null,
    (e: unknown) => e as FileRpcError,
  );
  assert.equal(empty?.code, "NO_ROOMS");

  const bad = await sendCommand(lobby, {
    body: { id: "x", noType: true },
  }).then(
    () => null,
    (e: unknown) => e as FileRpcError,
  );
  assert.equal(bad?.code, "BAD_COMMAND");
});

test("timeout rejects when nobody answers", async (t) => {
  const lobby = await makeTempDir(t);
  const agent = new Agent({ model: new StubModel([]), agentId: "silent" });
  // pollMs 0 + no fs.watch delivery under a frozen scan: install, then
  // uninstall the watcher path by using heartbeat only — simpler: the room
  // exists but no plugin processes (uninstall keeps the room for explicit dirs).
  agent.install(createFileRpc({ dir: lobby, pollMs: 0, heartbeatMs: 0 }));
  agent.uninstall("file-rpc"); // room stays (explicit), nobody home
  // re-create the inbox so the drop has somewhere to land
  mkdirSync(join(lobby, agent.id, "inbox"), { recursive: true });
  writeFileSync(
    join(lobby, agent.id, "live.json"),
    JSON.stringify({
      pid: process.pid,
      agentId: "silent",
      id: agent.id,
      started: 0,
      loopState: "idle",
      activity: "",
      updated: 0,
    }),
  );

  const started = Date.now();
  const err = await sendCommand(lobby, {
    to: agent.id,
    body: { id: "t1", type: "health" },
    timeoutMs: 300,
  }).then(
    () => null,
    (e: unknown) => e as Error,
  );
  assert.ok(err, "a timeout error was thrown");
  assert.match(err?.message ?? "", /timed out/);
  assert.ok(Date.now() - started < 5000, "the timeout is bounded");
});

test("listRooms flags stale rooms instead of hiding them", async (t) => {
  const lobby = await makeTempDir(t);
  const live = new Agent({ model: new StubModel([]), agentId: "live" });
  live.install(createFileRpc({ dir: lobby, pollMs: 25 }));

  const staleId = "stale-room";
  mkdirSync(join(lobby, staleId, "inbox"), { recursive: true });
  writeFileSync(
    join(lobby, staleId, "live.json"),
    JSON.stringify({
      pid: 2_000_000_000,
      agentId: "stale",
      id: staleId,
      started: 0,
      loopState: "idle",
      activity: "",
      updated: 0,
    }),
  );

  const rooms = await listRooms(lobby);
  assert.equal(rooms.length, 2);
  const stale = rooms.find((r) => r.id === staleId);
  assert.ok(stale, "the stale room is listed");
  assert.equal(stale?.live, false, "dead pid → live:false");
  const fresh = rooms.find((r) => r.id === live.id);
  assert.equal(fresh?.live, true);

  const syncRooms = listRoomsSync(lobby);
  assert.equal(syncRooms.length, 2, "sync variant agrees");

  // concurrent drops from two writers land exactly once each
  const room = join(lobby, live.id);
  await Promise.all([
    sendCommand(lobby, { to: live.id, body: { id: "m1", type: "health" } }),
    sendCommand(lobby, { to: live.id, body: { id: "m2", type: "health" } }),
  ]);
  const events = await readEvents(room);
  assert.ok(
    events.some(
      (e) => e.type === "response" && (e as { id?: string }).id === "m1",
    ),
  );
  assert.ok(
    events.some(
      (e) => e.type === "response" && (e as { id?: string }).id === "m2",
    ),
  );

  // sender without wait drops and returns null
  const dropped = await sendCommand(lobby, {
    to: live.id,
    body: { type: "health" },
    wait: false,
  });
  assert.equal(dropped, null);
  await waitUntil(
    async () =>
      (await readEvents(room)).some(
        (e) =>
          e.type === "response" &&
          (e as { command?: string }).command === "health",
      ),
    { what: "id-less health response", timeout: 5000 },
  );

  live.uninstall("file-rpc");
});

test("cli: --rooms lists, send returns the reply, ambiguity exits 2", async (t) => {
  const lobby = await makeTempDir(t);
  const agent = new Agent({ model: new StubModel([]), agentId: "cli-target" });
  agent.install(createFileRpc({ dir: lobby, pollMs: 25 }));

  const node = process.execPath;
  const cli = new URL("../cli.ts", import.meta.url).pathname;
  // Async execFile: spawnSync blocks this process's event loop, starving the
  // in-process agent's poll/fs.watch delivery — the child then times out.
  const run = (args: string[]): Promise<{ code: number; out: string }> =>
    new Promise((resolve) => {
      execFile(
        node,
        ["--experimental-strip-types", "--experimental-transform-types", cli, ...args],
        { encoding: "utf8", timeout: 30_000 },
        (err, stdout, stderr) => {
          resolve({
            code: (err as { code?: number } | null)?.code ?? 0,
            out: `${stdout ?? ""}${stderr ?? ""}`,
          });
        },
      );
    });

  const rooms = await run(["--lobby", lobby, "--rooms"]);
  assert.equal(rooms.code, 0);
  assert.match(rooms.out, new RegExp(agent.id));

  const reply = await run([
    "--lobby",
    lobby,
    "--type",
    "health",
    "--id",
    "cli1",
  ]);
  assert.equal(reply.code, 0);
  assert.match(reply.out, /"id": "cli1"/);

  const second = new Agent({ model: new StubModel([]), agentId: "cli-second" });
  second.install(createFileRpc({ dir: lobby, pollMs: 25 }));
  const ambiguous = await run([
    "--lobby",
    lobby,
    "--type",
    "health",
    "--id",
    "cli2",
  ]);
  assert.equal(ambiguous.code, 2, "multi-room without --to exits 2");
  assert.match(ambiguous.out, /--to/);

  const routed = await run([
    "--lobby",
    lobby,
    "--to",
    agent.id,
    "--type",
    "health",
    "--id",
    "cli3",
  ]);
  assert.equal(routed.code, 0);

  agent.uninstall("file-rpc");
  second.uninstall("file-rpc");
});
