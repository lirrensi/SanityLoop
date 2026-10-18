// Async methods — soft, handoff, remote. Each produces a summary string
// for the shared rebuild; none touches agent.messages. The plugin awaits
// the producer at the landing, then calls rebuildWithSummary once.

import { randomUUID } from "node:crypto";
import type { Message } from "@sanityloop/core";
import { messageText } from "./rebuild.ts";
import { flattenSnapshot, type RemoteCompactor, type RemoteModel } from "./remote.ts";

export interface SummarizerAgent {
  model: {
    maxOutputTokens?: unknown;
    callNextTurn(agent: {
      messages: Message[];
      tools: { name: string; description: string; inputSchema: unknown }[];
      visibleTools(): { name: string; description: string; inputSchema: unknown }[];
      streamSink: undefined;
      abortSignal?: AbortSignal;
    }): Promise<{ message: Message }>;
  };
}
export interface SoftOptions {
  /** Override the whole summary call. Receives the FULL snapshot. */
  summarize?: (messages: Message[]) => Promise<string>;
  /** Extra user focus appended to the summary instruction. */
  focus?: string;
  /** Previous compaction summary — chained as context (update, not rewrite). */
  previousSummary?: string;
  /** Max words for the built-in instruction. Default 80 (small-window safe). */
  maxWords?: number;
  /** Cap for the summary call's max_tokens. Default 1024 — gemma needs headroom for its thinking trace; small caps emit `length`. */
  maxTokens?: number;
}

/**
 * Silent side-channel summary: the agent's own model, no tools, one flat
 * system+user call. History shape never reaches the summarizer — only text.
 */
export function createSoftSummarizer(agent: SummarizerAgent, opts: SoftOptions = {}) {
  return async (messages: Message[]): Promise<string> => {
    if (opts.summarize) return opts.summarize(messages);
    // Summarizer input is the TEXT the model saw, clamped newest-first to a
    // flat ~500-token budget. gemma on llama.cpp emits `length` whenever the
    // OUTPUT budget can't cover its thinking trace on a long repetitive
    // input — preShake already shrunk the sludge, this caps what remains.
    // Whole messages, never split.
    const flat = messages.map((m) => `${m.type}: ${messageText(m)}`).filter((s) => s.trim().length > 0);
    const kept: string[] = [];
    let used = 0;
    for (let i = flat.length - 1; i >= 0; i--) {
      const cost = Math.ceil(flat[i].length / 4);
      if (used + cost > 500 && kept.length > 0) break;
      kept.unshift(flat[i]);
      used += cost;
    }
    const conversationText = kept.join("\n\n");
    const prev = opts.previousSummary ? `\n\nPrevious summary (update it, don't rewrite from scratch):\n${opts.previousSummary}` : "";
    const focus = opts.focus ? `\n\nPay special attention to: ${opts.focus}` : "";
    const words = opts.maxWords ?? 80;
    const prompt: Message[] = [
      {
        id: `summary-instr-${randomUUID().slice(0, 8)}`,
        enabled: true,
        type: "system",
        content: [
          {
            type: "text",
            content:
              `You are a conversation summarizer for an agent session. Produce a concise but complete summary ` +
              `of the conversation below: decisions made, facts learned, files touched, code changed, open ` +
              `threads. Write it so a fresh context could continue the work. Keep it under ${words} words.${prev}${focus}`,
          },
        ],
      },
      {
        id: `summary-history-${randomUUID().slice(0, 8)}`,
        enabled: true,
        type: "user",
        content: [{ type: "text", content: conversationText }],
      },
    ];
    const prevTokens = (agent.model as { maxOutputTokens?: unknown }).maxOutputTokens;
    (agent.model as { maxOutputTokens?: unknown }).maxOutputTokens = opts.maxTokens ?? 1024;
    let result;
    try {
      result = await agent.model.callNextTurn({
        messages: prompt,
        tools: [],
        visibleTools: () => [],
        streamSink: undefined,
      });
    } finally {
      (agent.model as { maxOutputTokens?: unknown }).maxOutputTokens = prevTokens;
    }
    const c = result.message.content;
    if (c === null) return "(empty summary)";
    const blocks = Array.isArray(c) ? c.filter((b) => "type" in b && b.type === "text") : [];
    const text = blocks.map((b) => b.content).join("").trim();
    return text.length > 0 ? text : "(empty summary)";
  };
}

// ---------------------------------------------------------------------------
// Handoff — the summary is produced by the SAME model in-loop, so it can
// use its own tools. Two-phase: inject the request + wake, then the catcher
// (turnEnd) rebuilds with the model's reply. The file write is best-effort;
// the reply text is the summary either way.
// ---------------------------------------------------------------------------

export interface HandoffOptions {
  keepRecent?: number;
  stateKey?: string;
  dir?: string;
  instruction?: string;
  focus?: string;
  previousSummary?: string;
}

export const DEFAULT_HANDOFF_INSTRUCTION =
  "You are asked to produce a SESSION HANDOVER because the conversation has grown past the context budget. " +
  "Write the handover to the file path given below using your file-write tool. If you have NO file-writing tool, " +
  "write the full handover inline in your reply instead.\n\n" +
  "The handover must contain, in this order:\n" +
  "1. THEME — one line: what this session is about.\n" +
  "2. QUICK DESCRIPTION — 2-4 sentences.\n" +
  "3. CHRONOLOGICAL WALK — each theme/topic in the order it appeared, with direct QUOTES + importance marks.\n" +
  "4. FINAL STATE — files touched, decisions made, open threads, next step.\n\n" +
  "When done, reply with a short confirmation: the file path and the one-line THEME.";

export interface HandoffRun {
  start(agent: { messages: Message[]; wake(): void }): void;
  /** True when the catcher should rebuild — the request turn completed. */
  pending(): boolean;
  /** Snapshot taken when the request went in (rebuild base). */
  snapshot(): Message[];
  /** Request message id (distinguishes real user input that arrived mid-turn). */
  requestId(): string;
  reset(): void;
}

export function createHandoffRun(opts: HandoffOptions = {}): HandoffRun {
  let requested = false;
  let request = "";
  let base: Message[] = [];
  return {
    start(agent) {
      requested = true;
      base = [...agent.messages];
      request = `handover-request-${randomUUID().slice(0, 8)}`;
      const prev = opts.previousSummary ? `\n\nPrevious handover (update it):\n${opts.previousSummary}` : "";
      const focus = opts.focus ? `\n\nAdditional focus: ${opts.focus}` : "";
      const instruction = opts.instruction ?? DEFAULT_HANDOFF_INSTRUCTION;
      agent.messages.push({
        id: request,
        enabled: true,
        type: "user",
        content: [{ type: "text", content: `${instruction}${prev}${focus}` }],
      });
      agent.wake();
    },
    pending: () => requested,
    snapshot: () => base,
    requestId: () => request,
    reset: () => {
      requested = false;
      request = "";
      base = [];
    },
  };
}

// ---------------------------------------------------------------------------
// Remote — resolve route, flatten, call, return summary. Gated + isolated:
// `available()` mismatch → throw (plugin records + skips, history intact).
// ---------------------------------------------------------------------------

export interface RemoteRunOptions {
  compactors: RemoteCompactor[];
  focus?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  resolveApiKey?: (model: RemoteModel) => string | undefined;
}

export async function runRemoteSummary(
  model: RemoteModel,
  snapshot: Message[],
  opts: RemoteRunOptions,
): Promise<{ summary: string; preserveData?: Record<string, unknown>; compactorId: string }> {
  const pick = opts.compactors.find((c) => {
    try {
      return c.available(model);
    } catch {
      return false;
    }
  });
  if (!pick) throw new Error("[sanity] remote compaction: no compactor available for this model");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
  try {
    const out = await pick.compact(model, { conversationText: flattenSnapshot(snapshot, opts.focus), focus: opts.focus, signal: ctrl.signal });
    return { summary: out.summary, preserveData: out.preserveData, compactorId: pick.id };
  } finally {
    clearTimeout(timer);
  }
}
