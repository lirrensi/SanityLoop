// Shared rebuild — the ONE splice dance every async method ends in.
//
// The method produces a summary string; rebuild swaps history to
// [existing system messages + summary-as-USER + alternation-safe recent
// window], stamps state, and wakes the loop. Sync methods (shake/prune)
// never reach here — they mutate in place, no rebuild needed.

import { randomUUID } from "node:crypto";
import { answerText as coreAnswerText, normalizeForAlternation } from "@sanityloop/core";
import type { Message } from "@sanityloop/core";

export interface RebuildOptions {
  /** Non-system messages kept after the summary. */
  keepRecent: number;
  /** Where compaction metadata lives in session state. */
  stateKey: string;
  /** Label for the summary message + state record (method name). */
  label: string;
  /** Method-specific extras merged into the state record (e.g. remote preserveData, handoff file). */
  stateExtra?: Record<string, unknown>;
}

export interface RebuildAgent {
  messages: Message[];
  state: Record<string, unknown>;
  loopState: string;
  wake(): void;
  setState?(key: string, value: unknown): void;
}

/**
 * Flatten a message to its visible text — role-labeled input for summarizers.
 * Tool results contribute their `answer` face (what the model saw); the
 * `stored` side stays searchable via session-search, never re-summarized.
 */
export function messageText(m: Message): string {
  const c = m.content;
  if (c === null) return "";
  if (Array.isArray(c)) {
    let out = "";
    for (const b of c) {
      // TextBlock carries type:"text"; FragmentBlock { id, content } has no
      // `type` key — both are text (same rule as core's toBlockList).
      if (typeof b !== "object" || b === null) continue;
      if ("type" in b && b.type === "text") out += (b as { content?: unknown }).content ?? "";
      else if (!("type" in b) && typeof (b as { content?: unknown }).content === "string") out += (b as { content: string }).content;
    }
    return out;
  }
  if (typeof c === "object" && "answer" in c) return coreAnswerText((c as { answer: unknown }).answer);
  return "";
}

/**
 * Recent non-system window + alternation trims. The summary is a USER
 * message, so the tail must not start with user (user→user) or end with
 * assistant (assistant→assistant); dangling toolCalls and orphaned
 * toolResults drop too. Shared by soft, handoff, and remote rebuilds.
 */
export function recentTail(snapshot: Message[], extra: Message[], keepRecent: number): Message[] {
  // Trim the WINDOW first, then append extra raw: extra is LIVE input that
  // arrived mid-compaction — trimming the concatenation would eat a
  // leading-user arrival (user input wiped silently). normalizeForAlternation
  // merges any boundary adjacency downstream (content preserved, never dropped).
  const tail = snapshot
    .filter((m) => m.type !== "system" && m.enabled)
    .slice(-keepRecent);
  while (tail.length > 0 && tail[0].type === "user") tail.shift();
  while (tail.length > 0 && tail[tail.length - 1].type === "assistant") tail.pop();
  while (tail.length > 0 && tail[0].type === "toolResult") tail.shift();
  return tail.concat(extra);
}

/** Swap history for [systems + summary-as-user + tail]. Never splices mid-turn. */
export function rebuildWithSummary(
  agent: RebuildAgent,
  snapshot: Message[],
  summary: string,
  opts: RebuildOptions,
): void {
  // Messages that arrived while the summarizer ran are NOT in the summary —
  // preserve them so a user/API input during compaction isn't wiped.
  const tail = recentTail(snapshot, agent.messages.slice(snapshot.length), opts.keepRecent);
  const systemMessages = snapshot.filter((m) => m.type === "system");
  const summaryMsg: Message = {
    id: `summary-${opts.label}-${randomUUID().slice(0, 8)}`,
    enabled: true,
    type: "user",
    content: [{ type: "text", content: `[Earlier conversation compacted — ${opts.label}]\n\n${summary}` }],
  };
  const rebuilt = normalizeForAlternation([...systemMessages, summaryMsg, ...tail]);
  agent.messages.splice(0, agent.messages.length, ...rebuilt);
  agent.setState?.(opts.stateKey, { at: Date.now(), method: opts.label, summary, ...opts.stateExtra });
}
