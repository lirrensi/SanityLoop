// sanity/src/extras/compaction.ts — simple transparent compaction (stats-watcher + on-demand).
//
// NOT a tool — a filter's job (decided). Two ways to trigger, one dance:
//
//   A. THRESHOLD (stats-watcher). When the context window fills past a
//      threshold, the filters do exactly four things, in order:
//   1. WATCHER (afterProviderResponse): `contextUsage >= threshold` and not
//      already compacting → mark `state.compacting` and `agent.stop()` — the
//      current response commits, the loop halts at the landing.
//   2. TRIGGER (stop): the loop is now idle → run the summarizer over the
//      ENTIRE history.
//   3. REBUILD: replace the history with [existing system messages (identity
//      prompt, AGENTS.md…) + summary-as-USER-message + alternation-safe recent
//      window]. The summary is a USER message (pi/opencode best practice) so
//      role alternation stays legal for strict chat templates (llama.cpp 400s
//      on assistant→assistant). Tail is trimmed: no leading users after the
//      summary, no trailing assistants (dangling toolCalls dropped).
//   4. CONTINUE: an internal wake input restarts the loop — the model sees the
//      compacted context and carries on. "Runs the whole history to summarize,
//      then restarts everything."
//
//   B. ON-DEMAND (inputReceived): a consumer fires
//      `agent.input({ type: requestCompactInput })` — a UI button, a REPL slash
//      command, an API call. No threshold check: the requester decides when the
//      context is too fat. Mid-turn requests stop() the loop (compaction runs
//      at the landing); idle requests compact immediately. Same dance A2→A4.
//
// Uses filters + stats (contextUsage vs maxContext, populated by SimpleModel)
// + state (compacting flag). Threshold/keepRecent/summarizer all configurable.
import { randomUUID } from "node:crypto";
import { EVENTS } from "@sanityloop/core";
import { normalizeForAlternation } from "@sanityloop/core";
import type { Filter, Message, Plugin } from "@sanityloop/core";
import { removeFiltersByPrefix, requestCompactInput } from "@sanityloop/util";

export interface CompactionOptions {
  /** Fraction of maxContext that triggers compaction. Default: 0.7. */
  threshold?: number;
  /** Non-system messages kept after the summary. Default: 8. */
  keepRecent?: number;
  /** Custom summarizer. Default: the agent's own model, built-in prompt. */
  summarize?: (messages: Message[]) => Promise<string>;
  /** Where compaction metadata lives in session state. Default: "compaction". */
  stateKey?: string;
}

const SUMMARY_INSTRUCTION =
  "You are a conversation summarizer for an agent session. Produce a concise but complete summary " +
  "of the conversation below: decisions made, facts learned, files touched, code changed, open " +
  "threads. Write it so a fresh context could continue the work. Keep it under 400 words.";

/** Flatten a message to its visible text — role-labeled, one continuous stream. */
function messageText(m: Message): string {
  const c = m.content;
  if (Array.isArray(c)) {
    return (c as { type?: string; content?: string }[])
      .filter((b) => b.type === "text")
      .map((b) => b.content ?? "")
      .join("");
  }
  if (c && typeof c === "object" && "answer" in c) {
    const face = c as unknown as { answer?: unknown; stored?: unknown };
    const names =
      Array.isArray(face.stored) && (face.stored as { name?: string }[]).length > 0
        ? ` [${(face.stored as { name?: string }[]).map((s) => s.name ?? "?").join(", ")}]`
        : "";
    return `${String(face.answer ?? "")}${names}`;
  }
  return "";
}


/** Default compaction — 70% threshold, keep 8 messages, same-model summarizer. */
export const compaction: Plugin = createCompaction();

export function createCompaction(opts: CompactionOptions = {}): Plugin {
  const threshold = opts.threshold ?? 0.7;
  const keepRecent = opts.keepRecent ?? 8;
  const stateKey = opts.stateKey ?? "compaction";

  /** Default summarizer: the agent's own model, no tools, silent, one call.
   * The history is flattened to a single system + user pair — the summary
   * call itself must never hit alternation problems or see tool machinery. */
  function defaultSummarizer(agent: {
    model: { callNextTurn(agent: unknown): Promise<{ message: Message }> };
  }) {
    return async (messages: Message[]): Promise<string> => {
      const conversationText = messages
        .map((m) => `${m.type}: ${messageText(m)}`)
        .filter((s) => s.trim().length > 0)
        .join("\n\n");
      const prompt: Message[] = [
        {
          id: `summary-instr-${randomUUID().slice(0, 8)}`,
          enabled: true,
          type: "system",
          content: [{ type: "text", content: SUMMARY_INSTRUCTION }],
        },
        {
          id: `summary-history-${randomUUID().slice(0, 8)}`,
          enabled: true,
          type: "user",
          content: [{ type: "text", content: conversationText }],
        },
      ];
      const result = await agent.model.callNextTurn({
        ...agent,
        messages: prompt, // system + user only — flat, alternation-safe
        tools: [], // the summarizer must NOT call tools
        streamSink: undefined, // silent — no stream events during compaction
      } as never);
      const blocks = (result.message.content as { type: string; content: string }[]).filter(
        (b) => b.type === "text",
      );
      return blocks.map((b) => b.content).join("").trim() || "(empty summary)";
    };
  }

  /** The rebuild + continue step — runs after the loop has fully settled. */
  let compactRunning = false;
  async function compactNow(agent: {
    model: { callNextTurn(agent: unknown): Promise<{ message: Message }> };
    messages: Message[];
    state: Record<string, unknown>;
    loopState: string;
    wake(): void;
    setState?(key: string, value: unknown): void;
  }): Promise<void> {
    if (compactRunning) return; // the stop event can fire twice — only one compaction
    compactRunning = true;
    try {
      const snapshot = [...agent.messages];
      const summarize = opts.summarize ?? defaultSummarizer(agent);
      const summary = await summarize(snapshot);

      // never splice mid-turn — wait for the loop to settle first
      while (agent.loopState === "running") {
        await new Promise((r) => setTimeout(r, 20));
      }

      // messages that arrived while the summarizer ran are NOT in the summary —
      // preserve them so a user/API input during compaction isn't wiped
      const newOnes = agent.messages.slice(snapshot.length);
      const systemMessages = snapshot.filter((m) => m.type === "system");
      const tail = snapshot
        .filter((m) => m.type !== "system" && m.enabled)
        .slice(-keepRecent)
        .concat(newOnes);

      // ALTERNATION (pi/opencode best practice, llama.cpp enforces it hard):
      // the summary is a USER message, and the tail must never start with a user
      // (user→user) or end with an assistant (the resumed turn's response would
      // create assistant→assistant). Trailing dangling toolCalls get dropped too.
      while (tail.length > 0 && tail[0].type === "user") tail.shift();
      while (tail.length > 0 && tail[tail.length - 1].type === "assistant") tail.pop();
      while (tail.length > 0 && tail[0].type === "toolResult") tail.shift(); // orphaned

      const summaryMsg: Message = {
        id: `summary-${randomUUID().slice(0, 8)}`,
        enabled: true,
        type: "user", // a user message — keeps role alternation legal
        content: [{ type: "text", content: `[Earlier conversation compacted]\n\n${summary}` }],
      };
      // rebuild + full alternation normalization — the observer tapes it honestly
      const rebuilt = normalizeForAlternation([...systemMessages, summaryMsg, ...tail]);
      agent.messages.splice(0, agent.messages.length, ...rebuilt);
      agent.setState?.(stateKey, { at: Date.now(), summary });
    } catch (err) {
      console.error("[sanity] compaction failed:", err);
    } finally {
      compactRunning = false;
      agent.state.compacting = false;
      if (agent.loopState !== "running") {
        agent.wake(); // continue the loop
      }
    }
  }

  const watcher: Filter = {
    event: EVENTS.afterProviderResponse,
    id: "compaction/watcher",
    priority: 100,
    fn: async (agent) => {
      if (agent.state.compacting) return;
      const usage = agent.stats.contextUsage;
      if (typeof usage !== "number" || usage < threshold) return;
      agent.state.compacting = true;
      agent.stop(); // current response commits, loop halts at the landing
    },
  };

  const onDemand: Filter = {
    event: EVENTS.inputReceived,
    id: "compaction/on-demand",
    priority: 0,
    fn: async (agent) => {
      const input = agent.currentInput;
      if (!input || input.type !== requestCompactInput) return;
      if (agent.state.compacting) return; // already compacting — one at a time
      agent.state.compacting = true;
      if (agent.loopState === "running") {
        // mid-turn → current response commits, the loop lands, the trigger runs
        // compaction at the landing (never splice mid-turn)
        agent.stop();
      } else {
        // idle/parked → no landing coming; compact right now
        void compactNow(agent);
      }
    },
  };

  const trigger: Filter = {
    event: EVENTS.stop,
    id: "compaction/trigger",
    priority: 0,
    fn: async (agent) => {
      if (agent.state.compacting) {
        void compactNow(agent);
      }
    },
  };

  const cleanup: Filter = {
    event: EVENTS.abort,
    id: "compaction/cleanup",
    priority: 0,
    fn: async (agent) => {
      // a hard abort during compaction shouldn't leave a stuck flag
      agent.state.compacting = false;
    },
  };

  return {
    id: "compaction",
    install(agent) {
      agent.addFilter(watcher);
      agent.addFilter(onDemand);
      agent.addFilter(trigger);
      agent.addFilter(cleanup);
      agent.addDeclaredCapability({ id: "basic-compaction", description: "context compaction (threshold + summarizer)" });
    },
    uninstall(agent) {
      removeFiltersByPrefix(agent, "compaction/");
      agent.removeDeclaredCapability("basic-compaction");
    },
  };
}
