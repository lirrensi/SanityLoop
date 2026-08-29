// ============================================================================
// packages/extras/log-sink — consumers of the shared `log` channel.
// ============================================================================
// THE PIGGYBACK STORY, made real. Any plugin, anywhere, does:
//
//   emitLog(agent, "warn", "permission", `denied ${call.name}`, { path })
//
// ...and every sink below catches it — without knowing the producer, without
// the producer knowing the sink. One filter per sink; the channel does the
// fan-in. Install two sinks, get two destinations. Uninstall, and the stream
// stops — producers never notice.
//
//   createFileLog({ path, maxBytes?, keep? })  → JSONL, one entry per line,
//     size-based rotation (timestamped sibling files), optional retention.
//     jq-able, rotation-safe: a line never spans two files.
//   createConsoleLog({ format? })              → human lines, default
//     formatLogLine. The observer with the noise filtered out.
//
// Both stamp `ts` on RECEIPT when the producer didn't — producers stay dumb.
// ============================================================================
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  appendFileSync,
  fstatSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { EventPayload, GodObject, Plugin } from "@sanityloop/core";
import {
  LOG_CHANNEL,
  formatLogLine,
  jsonlLine,
  removeFiltersByPrefix,
} from "@sanityloop/util";
import type { LogEntry } from "@sanityloop/util";

// ============================================================================
// FILE SINK — JSONL + size-based rotation
// ============================================================================

export interface FileLogOptions {
  /** Plugin id / filter namespace. Default "log-sink" — set your own when installing SEVERAL sinks. */
  id?: string;
  /** Target file — created (and parent dirs) lazily on the FIRST line. */
  path: string;
  /** Rotate when the file reaches this many bytes BEFORE appending a new line. Absent = never rotate. */
  maxBytes?: number;
  /** Max number of ROTATED files kept — oldest deleted first. Absent = keep everything. */
  keep?: number;
}

/**
 * The one-file-for-everyone sink. JSONL by default (pass your own `format`
 * if you know better). Appends are synchronous — emission order IS file
 * order, no buffering races. Rotation: `agent.log` →
 * `agent.log.20260822T101530` (lexicographic sort = chronological, for free).
 */
export function createFileLog(options: FileLogOptions): Plugin {
  const { path, maxBytes, keep } = options;
  const pid = options.id ?? "log-sink";
  let fd: number | undefined;
  /** Process-local rotation counter — guarantees unique targets even when
   * two rotations land in the same millisecond (fast emitters CAN). */
  let rotSeq = 0;

  const ensureOpen = (): number => {
    if (fd !== undefined) return fd;
    mkdirSync(dirname(path), { recursive: true });
    fd = openSync(path, "a");
    return fd;
  };

  /** Roll the current file to a timestamped sibling, reopen fresh. */
  const rotate = (): void => {
    if (fd !== undefined) {
      closeSync(fd);
      fd = undefined;
    }
    // `agent.log.20260822T113001992-7` — ms precision + seq: lexicographic
    // sort IS chronological, same-ms rotations never collide (and the
    // existsSync belt covers freak cross-restart ties).
    let target = `${path}.${timestamp()}-${(++rotSeq).toString(36)}`;
    while (existsSync(target)) target += "x";
    renameSync(path, target);
    if (keep !== undefined) pruneRotated(path, keep);
  };

  return {
    id: pid,
    install(agent) {
      agent.addFilter({
        event: LOG_CHANNEL,
        id: `${pid}/file`,
        priority: 100,
        fn: async (_agent, event) => {
          const line = jsonlLine(event as unknown as LogEntry);
          const handle = ensureOpen();
          if (maxBytes !== undefined && fstatSync(handle).size >= maxBytes) {
            rotate();
            fd = ensureOpen();
          }
          appendFileSync(fd as number, line + "\n");
        },
      });
      seedChannel(agent);
    },
    uninstall(agent) {
      removeFiltersByPrefix(agent, `${pid}/`);
      if (fd !== undefined) {
        closeSync(fd);
        fd = undefined;
      }
      sweepChannel(agent);
    },
  };
}

/** Compact UTC stamp with ms — 20260822T113001992. Fixed width = sortable as text. */
function timestamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${p(d.getUTCMilliseconds(), 3)}`
  );
}

/** Delete oldest rotated siblings beyond `keep`. Timestamped names sort ASC = oldest first. */
function pruneRotated(path: string, keep: number): void {
  const base = basename(path);
  const dir = dirname(path);
  if (!existsSync(dir)) return;
  const rotated = readdirSync(dir)
    .filter((f) => f !== base && f.startsWith(base + "."))
    .sort();
  for (const f of rotated.slice(0, Math.max(0, rotated.length - keep))) {
    try {
      unlinkSync(join(dir, f));
    } catch {
      // a lost deletion beats a lost log — never throw from a logger
    }
  }
}

// ============================================================================
// CONSOLE SINK — the human line
// ============================================================================

export interface ConsoleLogOptions {
  /** Plugin id / filter namespace. Default "log-sink" — set your own when installing SEVERAL sinks. */
  id?: string;
  /** Line formatter. Default: formatLogLine (pretty, receipt-stamped). */
  format?: (entry: LogEntry) => string;
}

/** The stdout sink. Every piggybacking plugin's lines, one pretty stream. */
export function createConsoleLog(options: ConsoleLogOptions = {}): Plugin {
  const format = options.format ?? formatLogLine;
  const pid = options.id ?? "log-sink";
  return {
    id: pid,
    install(agent) {
      agent.addFilter({
        event: LOG_CHANNEL,
        id: `${pid}/console`,
        priority: 100,
        fn: async (_agent, event) => {
          console.log(format(event as unknown as LogEntry));
        },
      });
      seedChannel(agent);
    },
    uninstall(agent) {
      removeFiltersByPrefix(agent, `${pid}/`);
      sweepChannel(agent);
    },
  };
}

// ============================================================================
// SHARED PLUMBING — declare the channel so discovery sees it; sweep it only
// when the LAST sink stops listening (bus.has is the honest test).
// ============================================================================

function seedChannel(agent: GodObject): void {
  // Idempotent: several sinks (or an early producer) may declare the channel —
  // first declaration wins, everyone else shrugs. Core refuses duplicates loudly.
  if (agent.getDeclaredEvent(LOG_CHANNEL) !== undefined) return;
  agent.addDeclaredEvent({
    id: LOG_CHANNEL,
    description:
      "shared log channel — any plugin may emit LogEntry envelopes; " +
      "sinks (log-sink) persist them. Producers declare, sinks subscribe, " +
      "neither imports the other.",
  });
}

function sweepChannel(agent: GodObject): void {
  if (!agent.bus.has(LOG_CHANNEL)) agent.removeDeclaredEvent(LOG_CHANNEL);
}

// Re-export — a sink author's whole vocabulary is one type.
export type { LogEntry, EventPayload };
