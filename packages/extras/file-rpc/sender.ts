// ============================================================================
// @sanityloop/file-rpc/sender — the other side of the room.
// ============================================================================
// Resolve a lobby → room, drop a command file (tmp+rename), optionally wait
// for the matching response id in events.jsonl. The agent side never imports
// this; a human, a cron script, or another agent's process does.
//
//   import { sendCommand, listRooms } from "@sanityloop/file-rpc/sender";
//   const res = await sendCommand(lobby, { body: { id, type: "health" } });
// ============================================================================

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { isPidAlive, waitForResponse, writeFileAtomic } from "./room.ts";
import type { LiveCard, RpcResponse } from "./room.ts";

/** A lobby room as seen from the outside: the card + a freshness verdict. */
export interface RoomInfo {
  agentId: string;
  id: string;
  lobby: string;
  room: string;
  live: boolean;
  card: LiveCard | null;
}

/** Sender failures: BAD_COMMAND, NO_ROOMS, NO_SUCH_ROOM, ROOMS_AVAILABLE (exit 2). */
export class FileRpcError extends Error {
  readonly code: string;
  readonly rooms: RoomInfo[];
  constructor(code: string, message: string, rooms: RoomInfo[] = []) {
    super(message);
    this.name = "FileRpcError";
    this.code = code;
    this.rooms = rooms;
  }
}

function readCard(room: string): LiveCard | null {
  let raw: string;
  try {
    raw = readFileSync(join(room, "live.json"), "utf8");
  } catch {
    return null; // claim in flight — no card yet
  }
  try {
    return JSON.parse(raw) as LiveCard;
  } catch {
    return null; // torn card mid-rewrite — treat as unclaimed
  }
}

function infoFor(lobby: string, name: string): RoomInfo | null {
  const room = join(lobby, name);
  let dirent: ReturnType<typeof statSync>;
  try {
    dirent = statSync(room);
    if (!dirent.isDirectory()) return null;
    if (!statSync(join(room, "live.json")).isFile()) return null;
  } catch {
    return null; // no card yet (claim in flight) — not a room to send to
  }
  const card = readCard(room);
  if (!card || typeof card.pid !== "number" || typeof card.id !== "string")
    return null;
  const live = isPidAlive(card.pid);
  return { agentId: card.agentId, id: card.id, lobby, room, live, card };
}

function sortRooms(out: RoomInfo[]): RoomInfo[] {
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** List every room in a lobby. Stale rooms (dead pid) are flagged, not hidden. */
export async function listRooms(lobby: string): Promise<RoomInfo[]> {
  let names: string[];
  try {
    names = await readdir(lobby);
  } catch {
    return [];
  }
  const out: RoomInfo[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const info = infoFor(lobby, name);
    if (info) out.push(info);
  }
  return sortRooms(out);
}

/** Sync variant for the CLI's fast path. */
export function listRoomsSync(lobby: string): RoomInfo[] {
  let names: string[];
  try {
    names = readdirSync(lobby);
  } catch {
    return [];
  }
  const out: RoomInfo[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const info = infoFor(lobby, name);
    if (info) out.push(info);
  }
  return sortRooms(out);
}

export interface SendOptions {
  /** Room id (the agent.id that claimed it). Omitted + one room → it;
   * omitted + many → FileRpcError code ROOMS_AVAILABLE. */
  to?: string;
  /** The command. Must carry a string `type`; add `id` to wait for the reply. */
  body: Record<string, unknown>;
  /** Wait for the matching response id. Default true when body has an id. */
  wait?: boolean;
  /** Response-wait ceiling. Default 10s (swarm-rpc rule). */
  timeoutMs?: number;
}

function commandId(body: Record<string, unknown>): string | undefined {
  const raw: unknown = body["id"];
  return typeof raw === "string" ? raw : undefined;
}

/** Drop a command file and (by default) wait for its response. */
export async function sendCommand(
  lobby: string,
  opts: SendOptions,
): Promise<RpcResponse | null> {
  const { to, body, timeoutMs = 10_000 } = opts;
  if (!body || typeof body.type !== "string") {
    throw new FileRpcError(
      "BAD_COMMAND",
      "sendCommand body requires a string `type`",
    );
  }
  const rooms = await listRooms(lobby);
  if (rooms.length === 0) {
    throw new FileRpcError("NO_ROOMS", `no file-rpc rooms in ${lobby}`);
  }
  let target: RoomInfo | undefined;
  if (to) {
    target = rooms.find((r) => r.id === to || r.agentId === to);
    if (!target) {
      throw new FileRpcError(
        "NO_SUCH_ROOM",
        `no file-rpc room "${to}" in ${lobby}`,
        rooms,
      );
    }
  } else if (rooms.length === 1) {
    target = rooms[0];
  } else {
    const listed = rooms
      .map((r) => `  - ${r.id}${r.live ? "" : " (stale)"}`)
      .join("\n");
    throw new FileRpcError(
      "ROOMS_AVAILABLE",
      `lobby ${lobby} holds ${rooms.length} rooms — pick one with --to:\n${listed}`,
      rooms,
    );
  }
  const id = commandId(body);
  const stem = id ?? randomUUID();
  const targetRoom = (target as RoomInfo).room;
  let fromSize = 0;
  try {
    fromSize = (await stat(join(targetRoom, "outbox", "events.jsonl"))).size;
  } catch {
    fromSize = 0; // no replies yet — wait from the start
  }
  await writeFileAtomic(
    join(targetRoom, "inbox", `req-${stem}.json`),
    `${JSON.stringify(body)}\n`,
  );

  const wait = opts.wait ?? id !== undefined;
  if (!wait || id === undefined) return null;
  return waitForResponse(targetRoom, id, { timeoutMs, fromSize });
}
