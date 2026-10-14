// ============================================================================
// @sanityloop/file-rpc — pi-RPC-shaped records over files.
// ============================================================================
// ANY agent talks to ANY other agent (or human) through a shared dir: no
// pipes, no ports, no daemon, cron-safe. `agent.install(createFileRpc(...))`
// claims a room `<lobby>/<agent.id>/`; anyone with dir access drops a command
// file into `inbox/` and reads pi-shaped responses + session voices from
// `outbox/events.jsonl`.
//
// LAYOUT (one room):
//   <lobby>/<agent.id>/live.json            aliveness card (pid, loopState, …)
//   <lobby>/<agent.id>/inbox/                command files `req-<uuid>.json`
//   <lobby>/<agent.id>/processed/            handled commands (receipts)
//   <lobby>/<agent.id>/processed/failed/      malformed / oversized commands
//   <lobby>/<agent.id>/outbox/events.jsonl   responses + voices (append-only)
//
// WIRE (see README.md — the canon):
//   command  `{ id?, type, ... }` via tmp+rename into inbox/
//   response `{ id?, type:"response", command, success, data|error }`
//   voice    `{ type:"event", event, payload, ts }`
// ============================================================================

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  watch,
} from "node:fs";
import type { FSWatcher } from "node:fs";
import { rename, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENTS } from "@sanityloop/core";
import type {
  DeclaredCapability,
  EventPayload,
  GodObject,
  Input,
  Plugin,
} from "@sanityloop/core";
import {
  appendEvent,
  isPidAlive,
  roomPaths,
  writeFileAtomicSync,
} from "./room.ts";
import type { LiveCard, RpcResponse, RpcVoice } from "./room.ts";
export {
  FileRpcError,
  listRooms,
  listRoomsSync,
  sendCommand,
} from "./sender.ts";
export type { RoomInfo, SendOptions } from "./sender.ts";
export {
  appendEvent,
  isPidAlive,
  readEvents,
  roomPaths,
  waitForResponse,
  writeFileAtomic,
  writeFileAtomicSync,
} from "./room.ts";
export type { LiveCard, RpcResponse, RpcVoice, RoomPaths } from "./room.ts";

/** Payload cap for one command file — the door stays small (http-server rule). */
export const MAX_INPUT_BYTES = 1024 * 1024;

/** Default heartbeat: rewrite live.json this often (0 disables the timer). */
export const DEFAULT_HEARTBEAT_MS = 15_000;

/** Default re-scan period for inbox/ (0 disables; fs.watch stays primary). */
export const DEFAULT_POLL_MS = 1000;

export interface FileRpcOptions {
  /** Explicit lobby dir. Wins over sessionDir. */
  dir?: string;
  /** Lobby becomes `<sessionDir>/rpc`. The caller threads the SAME path string
   * to base-storage — this plugin never touches session layout itself. */
  sessionDir?: string;
  /** live.json rewrite period. Default 15s; 0 disables (lifecycle rewrites stay). */
  heartbeatMs?: number;
  /** inbox/ re-scan period (NFS/cron safety net under fs.watch). Default 1s; 0 disables. */
  pollMs?: number;
}

/** A command file, parsed. `id` is OUR correlation envelope; the rest is the command. */
export interface RpcCommand {
  id?: string;
  type: string;
  body?: Input;
  op?: string;
  keys?: unknown;
  [key: string]: unknown;
}

/** The readable GodObject document — http-server's stateDoc minus the derived
 * `snapshot` view (that needs @sanityloop/snapshot; this package is core-only). */
function stateDoc(agent: GodObject): Record<string, unknown> {
  return {
    description: agent.description || undefined,
    activity: agent.activity,
    state: agent.state,
    transient: agent.transient,
    messages: agent.messages,
    capabilities: agent.listDeclaredCapabilities(),
    plugins: agent.plugins.map((p) => p.id),
    pendingAwaits: agent.pendingAwaits,
    pendingQuestions: agent.pendingQuestions,
    pendingInputs: agent.pendingInputs,
    tools: agent.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
    loopState: agent.loopState,
    runState: agent.runState,
    inTurn: agent.inTurn,
    hasWork: agent.hasWork,
    inFlight: agent.inFlight,
    ticks: agent.ticks,
    tickPlan: agent.tickPlan,
    model: {
      api: agent.model.api,
      modelId: agent.model.modelId,
      stream: agent.model.stream,
    },
  };
}

/** Dotted keys walk in ("state.todos"); missing → null (keeps JSON clean). */
function pickKeys(
  doc: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  if (keys.length === 0) return doc;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    let cursor: unknown = doc;
    for (const part of key.split(".")) {
      if (
        cursor === null ||
        cursor === undefined ||
        typeof cursor !== "object"
      ) {
        cursor = undefined;
        break;
      }
      if (part in cursor) {
        cursor = (cursor as Record<string, unknown>)[part];
      } else {
        cursor = undefined;
        break;
      }
    }
    out[key] = cursor === undefined ? null : cursor;
  }
  return out;
}

/** One tool row, as the model sees it (the UI-builder shape). */
export interface RpcToolRow {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** The six read doors — http-server's makeDoor, file-flavored. */
export interface FileRpcDoor {
  health(): {
    ok: boolean;
    pid: number;
    loopState: string;
    runState: string;
    time: number;
  };
  readState(keys: string[]): Record<string, unknown>;
  awaits(): GodObject["pendingAwaits"];
  questions(): GodObject["pendingQuestions"];
  tools(): RpcToolRow[];
  capabilities(): DeclaredCapability[];
  control(op: string): { ok: true; op: string } | null;
  write(body: Input): void;
}

function makeDoor(agent: GodObject): FileRpcDoor {
  return {
    write(body: Input) {
      agent.input(body);
    },
    readState(keys: string[]) {
      return pickKeys(stateDoc(agent), keys);
    },
    awaits() {
      return agent.pendingAwaits;
    },
    questions() {
      return agent.pendingQuestions;
    },
    tools() {
      return agent.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    },
    capabilities() {
      return agent.listDeclaredCapabilities();
    },
    health() {
      return {
        ok: true,
        pid: process.pid,
        loopState: agent.loopState,
        runState: agent.runState,
        time: Date.now(),
      };
    },
    control(op: string) {
      switch (op) {
        case "stop":
          agent.stop();
          return { ok: true, op };
        case "abort":
          agent.abort("file-rpc/control");
          return { ok: true, op };
        case "pause":
          agent.pause();
          return { ok: true, op };
        case "wake":
          agent.wake();
          return { ok: true, op };
        default:
          return null;
      }
    },
  };
}

/** A settled reply envelope — every handled command with an id gets one. */
export function respond(
  cmd: RpcCommand,
  success: boolean,
  dataOrError: unknown,
): RpcResponse {
  const envelope = cmd.id === undefined ? {} : { id: cmd.id };
  if (success) {
    return {
      ...envelope,
      type: "response",
      command: cmd.type,
      success,
      data: dataOrError,
    };
  }
  const message =
    dataOrError instanceof Error ? dataOrError.message : String(dataOrError);
  return {
    ...envelope,
    type: "response",
    command: cmd.type,
    success,
    error: message,
  };
}

/** The token-stream voices forwarded per room (http-server's STREAM_EVENTS). */
const STREAM_VOICES = [
  "streamStarted",
  "textDelta",
  "textEnd",
  "thinkingDelta",
  "thinkingEnd",
  "toolcallDelta",
];
/** The lifecycle voices — agentSettled is done-done (the loop fully landed);
 * agentEnd is one run (pi rule). */
const LIFECYCLE_VOICES = [
  "agentStart",
  "agentEnd",
  "agentSettled",
  "turnStart",
  "turnEnd",
  "error",
];

/** Dispatch one parsed command. Returns the response record, or null when the
 * command is unknown (ignored — the inputs rule: move to processed, no reply). */
export function dispatchCommand(
  door: FileRpcDoor,
  cmd: RpcCommand,
): RpcResponse | null {
  // input, two shapes: { type:"input", body } (pi-framed) or any input_* type
  // passed through as-is (type-blind — the core + filters assign meaning).
  if (cmd.type === "input") {
    if (
      !cmd.body ||
      typeof cmd.body !== "object" ||
      typeof cmd.body.type !== "string"
    ) {
      return respond(
        cmd,
        false,
        "input requires a `body` object with a string `type`",
      );
    }
    door.write(cmd.body);
    return respond(cmd, true, { ok: true, type: cmd.body.type });
  }
  if (cmd.type.startsWith("input_")) {
    const rest: Record<string, unknown> = {
      ...(cmd as Record<string, unknown>),
    };
    delete rest["id"];
    delete rest["type"];
    door.write({ type: cmd.type, ...rest });
    return respond(cmd, true, { ok: true, type: cmd.type });
  }
  if (cmd.type === "control") {
    if (typeof cmd.op !== "string")
      return respond(
        cmd,
        false,
        "control requires a string `op` (stop|abort|pause|wake)",
      );
    const result = door.control(cmd.op);
    if (!result) return respond(cmd, false, `unknown op: ${cmd.op}`);
    return respond(cmd, true, result);
  }
  if (cmd.type === "health") return respond(cmd, true, door.health());
  if (cmd.type === "get_state") {
    const keys = Array.isArray(cmd.keys)
      ? cmd.keys.filter((k: unknown): k is string => typeof k === "string")
      : [];
    return respond(cmd, true, door.readState(keys));
  }
  if (cmd.type === "awaits") return respond(cmd, true, door.awaits());
  if (cmd.type === "questions") return respond(cmd, true, door.questions());
  if (cmd.type === "tools") return respond(cmd, true, door.tools());
  if (cmd.type === "capabilities")
    return respond(cmd, true, door.capabilities());
  return null; // unknown type — ignored, no reply
}

/**
 * The file-rpc channel plugin — a room in a shared lobby, worked over files.
 */
export function createFileRpc(opts: FileRpcOptions = {}): Plugin {
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;

  // Install-time locals live here (uninstall is a separate method).
  let lobby = "";
  let room = "";
  let inbox = "";
  let processed = "";
  let failed = "";
  let eventsPath = "";
  let ephemeral = false;
  let lobbyOwned = false;
  let started = 0;
  let tookOver: number | undefined;
  let watcher: FSWatcher | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let debounceTimer: NodeJS.Timeout | undefined;
  let claimed = false;
  let exitCleanup: (() => void) | undefined;
  /** Files already picked up — exactly-once per install (backlog drains once). */
  const seen = new Set<string>();
  /** Files mid-flight — a poll overlapping a slow dispatch must not double-claim. */
  const inflight = new Set<string>();

  function card(agent: GodObject): LiveCard {
    const base: LiveCard = {
      pid: process.pid,
      agentId: agent.agentId,
      id: agent.id,
      started,
      loopState: agent.loopState,
      activity: agent.activity,
      updated: Date.now(),
    };
    if (tookOver !== undefined) base.tookOverFrom = tookOver;
    return base;
  }

  function refreshCardSync(agent: GodObject): void {
    try {
      writeFileAtomicSync(
        join(room, "live.json"),
        `${JSON.stringify(card(agent), null, 2)}\n`,
      );
    } catch (err) {
      console.error(
        `[sanity] file-rpc: live.json rewrite failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  function quarantine(
    agent: GodObject,
    name: string,
    command: string,
    id: string | undefined,
    error: string,
  ): Promise<void> {
    const full = join(inbox, name);
    console.error(`[sanity] file-rpc: ${name} rejected — ${error}`);
    const done = appendEvent(
      eventsPath,
      respond({ id, type: command }, false, error),
    ).catch((err: unknown) => {
      console.error(
        `[sanity] file-rpc: events.jsonl append failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    return done.then(() =>
      rename(full, join(failed, name)).catch((err: unknown) => {
        console.error(
          `[sanity] file-rpc: quarantine of ${name} failed — ${err instanceof Error ? err.message : String(err)}`,
        );
      }),
    );
  }

  async function settle(
    agent: GodObject,
    door: FileRpcDoor,
    name: string,
  ): Promise<void> {
    const full = join(inbox, name);
    let size = -1;
    try {
      size = (await stat(full)).size;
    } catch {
      return; // vanished between scan and stat — someone else ate it
    }
    if (size < 0) return;

    // The 1 MiB door rule — checked on raw bytes before parsing. The id is
    // best-effort here: a small prefix scan may still recover it so the
    // sender's wait can correlate the rejection.
    if (size > MAX_INPUT_BYTES) {
      let id: string | undefined;
      try {
        const head = readFileSync(full, "utf8").slice(0, 4096);
        const match = /"id"\s*:\s*"([^"]{1,256})"/.exec(head);
        if (match) id = match[1];
      } catch {
        // unreadable — the rejection stays id-less
      }
      await quarantine(
        agent,
        name,
        "parse",
        id,
        `payload too large (${size} > ${MAX_INPUT_BYTES})`,
      );
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(full, "utf8"));
    } catch (err) {
      await quarantine(
        agent,
        name,
        "parse",
        undefined,
        `malformed command file ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const shape = parsed as { id?: unknown; type?: unknown };
    const id = typeof shape.id === "string" ? shape.id : undefined;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof shape.type !== "string"
    ) {
      await quarantine(
        agent,
        name,
        "parse",
        id,
        "command requires a string `type`",
      );
      return;
    }

    const cmd = parsed as RpcCommand;
    let response: RpcResponse | null = null;
    try {
      response = dispatchCommand(door, cmd);
    } catch (err) {
      // Dispatch never crashes the queue — the failure IS the response.
      response = respond(cmd, false, err);
    }
    if (response) {
      await appendEvent(eventsPath, response).catch((err: unknown) => {
        console.error(
          `[sanity] file-rpc: events.jsonl append failed — ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
    await rename(full, join(processed, name)).catch((err: unknown) => {
      console.error(
        `[sanity] file-rpc: receipt of ${name} failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  function scan(agent: GodObject, door: FileRpcDoor): void {
    if (!claimed) return;
    let names: string[];
    try {
      names = readdirSync(inbox);
    } catch {
      return; // inbox gone (uninstall raced us) — nothing to do
    }
    for (const name of names) {
      if (
        name.endsWith(".tmp") ||
        name.startsWith(".") ||
        seen.has(name) ||
        inflight.has(name)
      )
        continue;
      seen.add(name);
      inflight.add(name);
      void settle(agent, door, name).finally(() => {
        inflight.delete(name);
      });
    }
  }

  function scheduleScan(agent: GodObject, door: FileRpcDoor): void {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      scan(agent, door);
    }, 25);
    debounceTimer.unref?.();
  }

  return {
    id: "file-rpc",

    install(agent) {
      // ---- lobby → room resolution: explicit > session-nested > ephemeral ----
      if (opts.dir) {
        lobby = opts.dir;
        ephemeral = false;
      } else if (opts.sessionDir) {
        lobby = join(opts.sessionDir, "rpc");
        ephemeral = false;
      } else {
        lobby = join(
          tmpdir(),
          `sanity-rpc-${process.pid}-${randomUUID().slice(0, 8)}`,
        );
        ephemeral = true;
        lobbyOwned = true;
      }
      const paths = roomPaths(lobby, agent.id);
      room = paths.room;
      inbox = paths.inbox;
      processed = paths.processed;
      failed = paths.failed;
      eventsPath = paths.eventsPath;

      let lobbyWasMissing = false;
      try {
        lobbyWasMissing = statSync(lobby).isDirectory() === false;
      } catch {
        lobbyWasMissing = true;
      }
      if (lobbyOwned) lobbyWasMissing = true;
      mkdirSync(inbox, { recursive: true });
      mkdirSync(failed, { recursive: true });
      mkdirSync(join(room, "outbox"), { recursive: true });

      // ---- claim-or-refuse: a live card with a live pid refuses loudly ----
      let existing: LiveCard | null = null;
      try {
        existing = JSON.parse(
          readFileSync(join(room, "live.json"), "utf8"),
        ) as LiveCard;
      } catch {
        existing = null; // unclaimed, or a torn card — takeover claims it
      }
      if (
        existing &&
        typeof existing.pid === "number" &&
        isPidAlive(existing.pid)
      ) {
        throw new Error(
          `[sanity] file-rpc: room "${agent.id}" is already claimed by live pid ${existing.pid} in ${lobby} — refusing second claim.`,
        );
      }
      tookOver =
        existing && typeof existing.pid === "number" ? existing.pid : undefined;
      started = Date.now();
      claimed = true;

      const door = makeDoor(agent);
      refreshCardSync(agent);
      agent.state.rpc = { lobby, room };

      // ---- outbound voices: stream + lifecycle → events.jsonl ----
      const forward = (name: string, rewriteCard: boolean) => {
        const event = EVENTS[name as keyof typeof EVENTS] ?? name;
        agent.addFilter({
          event,
          id: `file-rpc/voice/${name}`,
          priority: -100,
          fn: async (_a: GodObject, payload?: EventPayload) => {
            const rest: Record<string, unknown> = {
              ...(payload as Record<string, unknown>),
            };
            delete rest["type"];
            const voice: RpcVoice = {
              type: "event",
              event: name,
              payload: rest,
              ts: Date.now(),
            };
            await appendEvent(eventsPath, voice).catch(() => {
              // telemetry never breaks the loop
            });
            if (rewriteCard && claimed) refreshCardSync(agent);
          },
        });
      };
      for (const name of STREAM_VOICES) forward(name, false);
      for (const name of LIFECYCLE_VOICES) forward(name, true);

      // ---- live.json heartbeat (unref'd — telemetry never holds the process open) ----
      if (heartbeatMs > 0) {
        heartbeatTimer = setInterval(() => {
          if (claimed) refreshCardSync(agent);
        }, heartbeatMs);
        heartbeatTimer.unref?.();
      }

      // ---- inbox watcher (fs.watch primary, poll safety net, backlog drains now) ----
      let watchFailed = false;
      try {
        watcher = watch(inbox, (_ev, filename) => {
          const current = String(filename ?? "");
          if (current.endsWith(".tmp") || current.startsWith(".")) return;
          scheduleScan(agent, door);
        });
        watcher.on("error", () => {
          // fs.watch is best-effort — the poll net keeps covering inbox/
        });
        watcher.unref?.();
      } catch {
        watchFailed = true;
      }
      if (watchFailed) {
        console.error(
          `[sanity] file-rpc: fs.watch on ${inbox} unavailable — poll covers it`,
        );
        watcher = undefined;
      }
      if (pollMs > 0) {
        pollTimer = setInterval(() => scan(agent, door), pollMs);
        pollTimer.unref?.();
      }
      scan(agent, door); // backlog drains on (re)start, incl. takeover

      agent.addDeclaredCapability({
        id: "file-rpc",
        description: `file-backed RPC room (${room}) — drop commands in inbox/, read responses + voices from outbox/events.jsonl`,
      });

      // ---- ephemeral rooms die with the process (best-effort; explicit + session-nested stay) ----
      if (ephemeral) {
        const roomDir = room;
        const lobbyDir = lobby;
        const lobbyFresh = lobbyWasMissing;
        exitCleanup = () => {
          try {
            rmSync(roomDir, { recursive: true, force: true });
            if (lobbyFresh && existsSync(lobbyDir)) {
              try {
                if (readdirSync(lobbyDir).length === 0)
                  rmSync(lobbyDir, { recursive: true, force: true });
              } catch {
                // lobby sweep is best-effort
              }
            }
          } catch {
            // exit-time cleanup never throws
          }
        };
        process.once("exit", exitCleanup);
      }

      if (tookOver !== undefined) {
        console.error(
          `[sanity] file-rpc: took over room "${agent.id}" from dead pid ${tookOver}`,
        );
      }
    },

    uninstall(agent) {
      claimed = false;
      clearTimeout(debounceTimer);
      clearInterval(pollTimer);
      clearInterval(heartbeatTimer);
      try {
        watcher?.close();
      } catch {
        // already closed — teardown stays total
      }
      watcher = undefined;
      pollTimer = undefined;
      heartbeatTimer = undefined;
      debounceTimer = undefined;
      for (const f of [...agent.filters]) {
        if (f.id.startsWith("file-rpc/")) agent.removeFilter(f.event, f.id);
      }
      delete agent.state.rpc;
      agent.removeDeclaredCapability("file-rpc");
      if (exitCleanup) {
        process.removeListener("exit", exitCleanup);
        exitCleanup = undefined;
      }
      // Ephemeral rooms are ours alone — rm. Explicit + session-nested stay.
      if (ephemeral && room !== "") {
        try {
          rmSync(room, { recursive: true, force: true });
          if (
            lobbyOwned &&
            lobby !== "" &&
            existsSync(lobby) &&
            readdirSync(lobby).length === 0
          ) {
            rmSync(lobby, { recursive: true, force: true });
          }
        } catch {
          // best-effort — a torn rm must not break uninstall
        }
      }
      lobby = room = inbox = processed = failed = eventsPath = "";
      ephemeral = false;
      lobbyOwned = false;
      seen.clear();
      inflight.clear();
    },
  };
}
