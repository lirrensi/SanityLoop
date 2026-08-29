// sanity/src/extras/util.ts — shared tool-output truncation (vendored from pi).
import type { Filter, Message } from "@sanityloop/core";

/**
 * The on-demand compaction input type. Any compaction extra (basic-compaction,
 * compact-handover) listens on inputReceived for this and compacts immediately,
 * bypassing the context-usage threshold:
 *
 *   agent.input({ type: requestCompactInput, reason: "user asked" })
 *
 * It is a control signal — never stored in history (like abort/stop).
 */
export const requestCompactInput = "request_compact";

/**
 * The on-demand clear input type. The default input vocabulary (extras/inputs)
 * listens on inputReceived for this and hides the conversation from the context
 * window — every non-system message is marked `enabled: false` so prepareMessages
 * drops it — WITHOUT destroying the history (messages stay in `agent.messages`):
 *
 *   agent.input({ type: requestClearInput })
 *
 * It is a control signal — never stored in history (like abort/stop).
 */
export const requestClearInput = "request_clear";

/**
 * The on-demand reset input type. The default input vocabulary (extras/inputs)
 * listens on inputReceived for this and wipes the whole session back to its
 * starting state — system messages only, fresh `state`, zeroed `stats`,
 * `lastResponse` repointed — WITHOUT killing the process or the REPL. The loop
 * stays alive and re-prompts:
 *
 *   agent.input({ type: requestResetInput })
 *
 * It is a control signal — never stored in history (like abort/stop).
 */
export const requestResetInput = "request_reset";

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB

/**
 * Tool names inside a toolCall/toolResult message's two-face `stored`.
 * A toolResult's pairing lives at MESSAGE level (`toolCallId`) — the name
 * resolves through the matching toolCall message in the history.
 */
export function toolNames(agent: { messages: Message[] }, turn: Message | undefined): string {
  if (!turn) return "?";
  const stored = (turn.content as { stored?: unknown }).stored;
  if (turn.type === "toolCall" && Array.isArray(stored)) {
    const names = stored.map((c) => (c as { name?: string }).name ?? "?").filter(Boolean);
    return names.join(",") || "?";
  }
  const t = turn as { toolName?: string; toolCallId?: string };
  // first-class record — the core stamps the tool name on the result
  if (t.toolName) return t.toolName;
  const callId = t.toolCallId;
  if (callId) {
    for (const m of agent.messages) {
      if (m.type !== "toolCall") continue;
      const recs = (m.content as { stored?: { id?: string; name?: string }[] }).stored ?? [];
      const name = recs.find((r) => r.id === callId)?.name;
      if (name) return name;
    }
  }
  return "?";
}

/** The tool result's `answer` face — what the model sees. */
export function toolAnswer(turn: Message | undefined): string {
  const answer = (turn?.content as { answer?: unknown } | undefined)?.answer;
  if (typeof answer !== "string") return "";
  const flat = answer.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? flat.slice(0, 200) + "…" : flat;
}

/**
 * Remove every filter whose id starts with `prefix` — the plugin namespace.
 * A plugin's uninstall() walks back everything its install() added: filters
 * registered under `${id}/...` and tools under the same namespace.
 */
export function removeFiltersByPrefix(
  agent: { filters: Filter[]; removeFilter(event: string, id: string): boolean },
  prefix: string,
): void {
  for (const f of [...agent.filters]) {
    if (f.id.startsWith(prefix)) agent.removeFilter(f.event, f.id);
  }
}

/**
 * List every filter whose id starts with `prefix` — the symmetric INSPECT to
 * `removeFiltersByPrefix`'s teardown. Lets a caller see exactly what a plugin
 * owns before disabling / overriding one of its filters by id.
 */
export function listFiltersByPrefix(
  agent: { filters: Filter[] },
  prefix: string,
): Filter[] {
  return agent.filters.filter((f) => f.id.startsWith(prefix));
}

export interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
  firstLineExceedsLimit: boolean;
  maxLines: number;
  maxBytes: number;
}

export interface TruncationOptions {
  maxLines?: number;
  maxBytes?: number;
}

function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
    };
  }

  const firstLineBytes = Buffer.byteLength(lines[0] ?? "", "utf-8");
  if (firstLineBytes > maxBytes) {
    return {
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      totalLines,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      lastLinePartial: false,
      firstLineExceedsLimit: true,
      maxLines,
      maxBytes,
    };
  }

  const outputLines: string[] = [];
  let outputBytes = 0;
  let truncatedBy: "lines" | "bytes" | null = null;

  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line + "\n", "utf-8");
    if (outputLines.length + 1 > maxLines) {
      truncatedBy = "lines";
      break;
    }
    if (outputBytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    outputLines.push(line);
    outputBytes += lineBytes;
  }

  return {
    content: outputLines.join("\n") + (outputLines.length > 0 ? "\n" : ""),
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLines.length,
    outputBytes,
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

/**
 * Truncate content from the tail (keep last N lines/bytes).
 * Suitable for bash output where you want to see the END (errors, final results).
 * May return a partial last line if the final line of the original exceeds the
 * byte limit — same edge case pi handles in its truncate.ts.
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
    };
  }

  const outputLines: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  let lastLinePartial = false;

  for (let i = lines.length - 1; i >= 0 && outputLines.length < maxLines; i--) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLines.length > 0 ? 1 : 0); // +1 for newline

    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      // Edge case: the last line alone exceeds maxBytes — take its end (partial).
      if (outputLines.length === 0) {
        const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
        outputLines.unshift(truncatedLine);
        outputBytesCount = Buffer.byteLength(truncatedLine, "utf-8");
        lastLinePartial = true;
      }
      break;
    }

    outputLines.unshift(line);
    outputBytesCount += lineBytes;
  }

  if (outputLines.length >= maxLines && outputBytesCount <= maxBytes) {
    truncatedBy = "lines";
  }

  const outputContent = outputLines.join("\n");
  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLines.length,
    outputBytes: Buffer.byteLength(outputContent, "utf-8"),
    lastLinePartial,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

/** Keep the END of a string within maxBytes, never splitting a multi-byte char. */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let outputBytes = 0;
  let start = str.length;
  for (let i = str.length - 1; i >= 0; i--) {
    const code = str.charCodeAt(i);
    let charBytes: number;
    if (code >= 0xdc00 && code <= 0xdfff && i > 0) {
      const prev = str.charCodeAt(i - 1);
      if (prev >= 0xd800 && prev <= 0xdbff) {
        i--; // consume the high surrogate with its low
        charBytes = 4;
      } else {
        charBytes = 3;
      }
    } else if (code >= 0xd800 && code <= 0xdfff) {
      charBytes = 3;
    } else {
      charBytes = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
    }
    if (outputBytes + charBytes > maxBytes) break;
    outputBytes += charBytes;
    start = i;
  }
  return str.slice(start);
}

export * from "./context-inject.ts";
export * from "./log.ts";
export * from "./backticks.ts";
