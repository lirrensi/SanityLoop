// ============================================================================
// @sanityloop/file-rpc/room — the filesystem primitives every side shares.
// ============================================================================
// Lobby/room paths, the live.json aliveness card, atomic writes, pid
// liveness, and the events.jsonl tail. No core import — pure fs + types.
// The plugin (index.ts) and the client (sender.ts) both build on this.
// ============================================================================

import { renameSync, writeFileSync } from "node:fs";
import { open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The aliveness card — a fresh claim ticket, rewritten on lifecycle + heartbeat. */
export interface LiveCard {
  pid: number;
  agentId: string;
  id: string;
  started: number;
  loopState: string;
  activity: string;
  updated: number;
  tookOverFrom?: number;
}

/** The pi-shaped response record — appended to outbox/events.jsonl. */
export interface RpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/** A forwarded voice — stream or lifecycle — appended to the same events.jsonl. */
export interface RpcVoice {
  type: "event";
  event: string;
  payload?: unknown;
  ts: number;
}

/** Room paths, derived once per install. */
export interface RoomPaths {
  lobby: string;
  room: string;
  inbox: string;
  processed: string;
  failed: string;
  eventsPath: string;
}

export function roomPaths(lobby: string, roomId: string): RoomPaths {
  const room = join(lobby, roomId);
  return {
    lobby,
    room,
    inbox: join(room, "inbox"),
    processed: join(room, "processed"),
    failed: join(room, "processed", "failed"),
    eventsPath: join(room, "outbox", "events.jsonl"),
  };
}

let tmpSeq = 0;

/** Atomic file write (tmp + rename): a reader never sees a half file.
 * Same rule as base-storage's writeStateCard, incl. the Windows rename quirk —
 * plus a unique tmp name, because senders are multi-writer. */
export async function writeFileAtomic(
  target: string,
  data: string,
): Promise<void> {
  const tmp = `${target}.${process.pid}.${tmpSeq++}.tmp`;
  await writeFile(tmp, data, "utf8");
  try {
    await rename(tmp, target);
  } catch {
    // Windows rename-over-existing can race; fall back to a sync rename
    renameSync(tmp, target);
  }
}

/** Sync variant for exit-path and heartbeat writes — guaranteed on disk before return. */
export function writeFileAtomicSync(target: string, data: string): void {
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, data, "utf8");
  try {
    renameSync(tmp, target);
  } catch {
    writeFileSync(target, data, "utf8");
  }
}

/** Liveness: ESRCH = dead; EPERM = alive but not ours; anything else = dead. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Append one JSON line to events.jsonl (creating the outbox on first use). */
export async function appendEvent(
  eventsPath: string,
  record: RpcResponse | RpcVoice,
): Promise<void> {
  await writeFile(eventsPath, `${JSON.stringify(record)}\n`, {
    flag: "a",
    encoding: "utf8",
  });
}

/** Read every response/voice record currently in a room's events.jsonl. */
export async function readEvents(
  roomDir: string,
): Promise<Array<RpcResponse | RpcVoice>> {
  let raw: string;
  try {
    raw = await readFile(join(roomDir, "outbox", "events.jsonl"), "utf8");
  } catch {
    return [];
  }
  const out: Array<RpcResponse | RpcVoice> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as RpcResponse | RpcVoice);
    } catch {
      // torn tail line (concurrent append mid-read) — skip it
    }
  }
  return out;
}

/** Poll a room's events.jsonl until a matching response id appears (or the deadline).
 * Tails from the end-offset at call time — backlog from before the drop never matches. */
export async function waitForResponse(
  roomDir: string,
  id: string,
  opts: { timeoutMs?: number; fromSize?: number } = {},
): Promise<RpcResponse> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const path = join(roomDir, "outbox", "events.jsonl");
  let offset = opts.fromSize ?? -1;
  if (offset < 0) {
    try {
      offset = (await stat(path)).size;
    } catch {
      offset = 0; // not created yet — the agent hasn't answered anything
    }
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fh = await open(path, "r");
      try {
        const size = (await fh.stat()).size;
        if (size > offset) {
          const buf = Buffer.alloc(size - offset);
          await fh.read(buf, 0, buf.length, offset);
          const text = buf.toString("utf8");
          const lines = text.split("\n");
          const torn = text.endsWith("\n") ? "" : (lines.pop() ?? "");
          offset = size - Buffer.byteLength(torn, "utf8");
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const rec = JSON.parse(trimmed) as RpcResponse;
            if (rec.type === "response" && rec.id === id) return rec;
          }
        }
      } finally {
        await fh.close();
      }
    } catch {
      // missing file or a torn line mid-parse — keep waiting for the deadline
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `[sanity] file-rpc: timed out after ${timeoutMs}ms waiting for response "${id}" in ${path}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
