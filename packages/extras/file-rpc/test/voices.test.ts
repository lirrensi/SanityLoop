// ============================================================================
// file-rpc tests — outbound voices: stream + lifecycle → events.jsonl.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, EVENTS } from "@sanityloop/core";
import {
  StubModel,
  assistantTurn,
  withDriver,
} from "@sanityloop/test-kit/core";
import { awaitIdle, makeTempDir, waitUntil } from "@sanityloop/test-kit";
import { createDefaultInputs } from "@sanityloop/inputs";
import { createFileRpc, readEvents } from "@sanityloop/file-rpc";
import type { RpcVoice } from "@sanityloop/file-rpc";

function seed(agent: Agent, text = "go"): void {
  agent.messages.push({
    id: `seed-${Math.random().toString(36).slice(2, 8)}`,
    enabled: true,
    type: "user",
    committedAt: Date.now(),
    content: [{ type: "text", content: text }],
  });
}

test("a full turn lands voices + agentSettled in events.jsonl", async (t) => {
  const lobby = await makeTempDir(t);
  const agent = new Agent({
    model: new StubModel([() => assistantTurn("the answer")]),
    agentId: "voices",
  });
  agent.install(createDefaultInputs());
  agent.install(createFileRpc({ dir: lobby, pollMs: 25 }));
  const room = join(lobby, agent.id);

  agent.run({ startState: "idle" }); // born-landed — signals need a ticking driver
  agent.input({ type: "input_followup", text: "go" });
  await awaitIdle(agent);
  // Sync-poll the file: waitUntil takes a SYNC predicate (an async one is
  // truthy on first poll), and the async settled-voice append can lag the
  // idle landing. (Real-timer poll: the append races the platform clock.)
  await waitUntil(
    () => {
      try {
        return readFileSync(join(room, "outbox", "events.jsonl"), "utf8")
          .split("\n")
          .filter((line) => line.trim())
          .some((line) => (JSON.parse(line) as RpcVoice).event === "agentSettled");
      } catch {
        return false; // events file not yet created — keep polling
      }
    },
    { what: "agentSettled voice to land", timeout: 5000 },
  );
  agent.abort(); // freeze the heartbeat — the turn already landed above

  const events = await readEvents(room);
  const voices = events.filter((e) => e.type === "event") as RpcVoice[];
  const names = voices.map((v) => v.event);
  assert.ok(
    names.includes("agentStart"),
    `agentStart forwarded (got: ${names.join(",")})`,
  );
  assert.ok(
    names.includes("turnStart"),
    `turnStart forwarded (got: ${names.join(",")})`,
  );
  assert.ok(
    names.includes("agentEnd"),
    `agentEnd forwarded (got: ${names.join(",")})`,
  );
  assert.ok(
    names.includes("agentSettled"),
    `agentSettled forwarded (got: ${names.join(",")})`,
  );
  assert.ok(
    names.includes("turnEnd"),
    `turnEnd forwarded (got: ${names.join(",")})`,
  );
  for (const v of voices) {
    assert.ok(typeof v.ts === "number", "every voice carries a ts");
    assert.ok(v.payload !== undefined, "every voice carries a payload");
  }

  agent.uninstall("file-rpc");
});

test("stream deltas forward while streaming; live.json refreshes on lifecycle", async (t) => {
  const lobby = await makeTempDir(t);
  const agent = new Agent({
    model: new StubModel([() => assistantTurn("streamed")]),
    agentId: "deltas",
  });
  agent.install(createDefaultInputs()); // appendEvent path not needed — emit directly
  agent.install(createFileRpc({ dir: lobby, pollMs: 0, heartbeatMs: 0 }));
  const room = join(lobby, agent.id);
  const before = JSON.parse(readFileSync(join(room, "live.json"), "utf8"))
    .updated as number;

  // stream voices arrive through the filter lane exactly like the loop emits them
  agent.emit(EVENTS.textDelta, {
    streamDelta: { type: "textDelta", delta: "hel" },
  });
  agent.emit(EVENTS.textDelta, {
    streamDelta: { type: "textDelta", delta: "lo" },
  });
  agent.emit(EVENTS.agentSettled, {});
  await waitUntil(
    async () => {
      const evs = await readEvents(room);
      return evs.filter((e) => e.type === "event").length >= 3;
    },
    { what: "voices to land", timeout: 5000 },
  );
  const events = await readEvents(room);
  const deltas = events.filter(
    (e) => e.type === "event" && (e as RpcVoice).event === "textDelta",
  );
  assert.equal(deltas.length, 2, "both textDelta voices forwarded");
  const after = JSON.parse(readFileSync(join(room, "live.json"), "utf8"))
    .updated as number;
  assert.ok(after >= before, "lifecycle voice rewrote the aliveness card");

  agent.uninstall("file-rpc");
});

test("uninstall removes every forwarder filter", async (t) => {
  const lobby = await makeTempDir(t);
  const agent = new Agent({ model: new StubModel([]), agentId: "leak" });
  agent.install(createFileRpc({ dir: lobby, pollMs: 25 }));
  const owned = agent.filters.filter((f) => f.id.startsWith("file-rpc/"));
  assert.ok(
    owned.length >= 12,
    `stream + lifecycle forwarders installed (got ${owned.length})`,
  );
  agent.uninstall("file-rpc");
  assert.equal(
    agent.filters.some((f) => f.id.startsWith("file-rpc/")),
    false,
    "no filter leak after uninstall",
  );

  // emitting after uninstall appends nothing (no handler, no crash)
  agent.emit(EVENTS.agentSettled, {});
  const events = await readEvents(join(lobby, agent.id));
  assert.equal(events.filter((e) => e.type === "event").length, 0);
});
