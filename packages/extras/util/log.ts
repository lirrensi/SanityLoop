// packages/extras/util/log.ts — THE LOG CONVENTION (one channel, any producer, any sink)
// ============================================================================
// No core primitive — by design. Logging is a SUBSCRIPTION problem, not a
// dependency problem:
//
//   producers  — any plugin, anywhere:  emitLog(agent, level, source, msg, data)
//                fires on ONE agreed channel. Zero listeners = empty-queue walk
//                = free. Nobody imports a logger. Nobody `requires` a logger.
//   consumers  — a sink subscribes ONCE to that channel and catches EVERYONE's
//                lines into one place (stdout, a JSONL file, a socket...).
//
// The envelope is pure JSON, open-indexed, house-style (open enums). `type` on
// the wire is BUS-OWNED (fire() stamps { type: event, ...payload }) — never
// pass your own `type` in a log payload.
//
// File sinks write JSONL: one entry per line, self-contained (ts inside), so
// logs parse with jq / ConvertFrom-Json and ROTATE cleanly — every line stands
// alone across file boundaries.
// ============================================================================

import type { EventPayload, GodObject } from "@sanityloop/core";

/**
 * THE channel. The whole convention is this one string. Sinks subscribe here;
 * producers emit here; neither knows the other exists.
 */
export const LOG_CHANNEL = "log";

/**
 * Severity. Four standard levels everyone agrees on + open tail for custom
 * vocabularies (same open-enum pattern as MessageType / RunState).
 */
export type LogLevel = "debug" | "info" | "warn" | "error" | (string & {});

/**
 * The envelope riding on the `log` channel. Pure JSON, restorable, inspectable.
 * - `source`  — who's talking: the plugin id / namespace ("permission").
 * - `message` — the human line. A log without a message is telemetry.
 * - `data`    — optional structured payload, any JSON.
 * - `ts`      — OPTIONAL producer stamp (ms epoch). Sinks stamp RECEIPT when
 *               absent (see jsonlLine / formatLogLine) — producers stay dumb,
 *               audit-paranoid producers stamp their own.
 */
export interface LogEntry {
  source: string;
  level: LogLevel;
  message: string;
  data?: unknown;
  ts?: number;
  /** Open — correlation ids, topics, anything. Just never `type` (bus-owned). */
  [key: string]: unknown;
}

/**
 * The producer door. Fire-and-forget onto the shared channel:
 *
 *   emitLog(agent, "warn", "permission", `denied ${call.name}`, { path });
 *
 * No listener → free. Listener → every sink catches it.
 */
export function emitLog(
  agent: Pick<GodObject, "emit">,
  level: LogLevel,
  source: string,
  message: string,
  data?: unknown,
): void {
  // CAST, not lie: the GodObject INTERFACE still types payload as EventPayload
  // (requires `type`), while the IMPLEMENTATION takes Omit<EventPayload,"type">
  // and stamps `type: event` itself in fire(). We honor the impl — the bus owns
  // `type`. If the interface ever catches up, this cast shrinks to nothing.
  const payload = (
    data === undefined
      ? { level, source, message }
      : { level, source, message, data }
  ) as unknown as EventPayload;
  agent.emit(LOG_CHANNEL, payload);
}

/** Receipt stamp — sinks call this when the producer didn't stamp. */
export function withReceiptStamp(entry: LogEntry): LogEntry {
  return entry.ts === undefined ? { ...entry, ts: Date.now() } : entry;
}

/**
 * Human format — for stdout/console sinks. `[iso] [level] [source] message {data}`
 */
export function formatLogLine(entry: LogEntry): string {
  const e = withReceiptStamp(entry);
  const head = `[${new Date(e.ts ?? Date.now()).toISOString()}] [${e.level}] [${e.source}] ${e.message}`;
  return e.data === undefined ? head : `${head} ${JSON.stringify(e.data)}`;
}

/**
 * JSONL format — one self-contained JSON object per line, ts stamped on
 * receipt when absent. THE file format: machine-parseable, rotation-safe
 * (no line ever spans two files), jq-able forever.
 */
export function jsonlLine(entry: LogEntry): string {
  return JSON.stringify(withReceiptStamp(entry));
}
