// Unified compaction — ONE method per install, explicit pick, no fallback.
//
//   createCompaction({ method: "soft" })       portable local summary (default)
//   createCompaction({ method: "handoff" })    in-loop handover turn + file
//   createCompaction({ method: "shake" })      threshold-triggered in-place elision
//   createCompaction({ method: "prune" })      threshold-triggered whole-result blanking
//   createCompaction({ method: "remote" })     provider-native route (gated)
//
// Triggers (shared by all rebuild methods): threshold watcher on
// afterProviderResponse (contextUsage >= threshold), on-demand via
// `agent.input({ type: requestCompactInput })`. Mid-turn → stop(), compact
// at the landing; idle → compact now. Shake/prune are ALSO sync-safe: call
// `handle.shakeNow()` / `handle.pruneNow()` from anywhere (tool, slash,
// filter) — no loop interaction, idempotent, undoable for prune.
import { randomUUID } from "node:crypto";
import { EVENTS, normalizeForAlternation } from "@sanityloop/core";
import type { Filter, Message, Plugin, ToolDefinition } from "@sanityloop/core";
import { removeFiltersByPrefix, requestCompactInput } from "@sanityloop/util";
import { recentTail, rebuildWithSummary, type RebuildOptions } from "./rebuild.ts";
import { pruneNow, shakeNow, type PruneOptions, type PruneResult, type ShakeOptions } from "./sync.ts";
import { createHandoffRun, createSoftSummarizer, runRemoteSummary, type HandoffOptions, type SoftOptions } from "./methods.ts";
import { defaultCompactors, type RemoteCompactor, type RemoteModel, type RemoteRunOptions } from "./remote.ts";

export type CompactionMethod = "soft" | "handoff" | "shake" | "prune" | "remote";
export interface CompactionOptions {
  /** THE pick — one method, no fallback chain. Default "soft". */
  method?: CompactionMethod;
  /** Fraction of maxContext that triggers compaction. Default 0.7. */
  threshold?: number;
  /** Non-system messages kept after the summary (rebuild methods). Default 8. */
  keepRecent?: number;
  /** Where compaction metadata lives in session state. Default "compaction". */
  stateKey?: string;
  /** Soft-method options (summarizer, focus, previousSummary chaining). */
  soft?: SoftOptions;
  /** Handoff-method options (instruction, dir, focus). */
  handoff?: HandoffOptions;
  /** Shake-method options (protectTokens, minSavings, protectedTools). */
  shake?: ShakeOptions;
  /** Prune-method options (protectTokens, minimumSavings, protectedTools). */
  prune?: PruneOptions;
  /** Remote-method options (compactors, focus, timeout). Default: built-in OpenAI + Anthropic. */
  remote?: Partial<RemoteRunOptions> & { compactors?: RemoteCompactor[] };
  /** Sync pre-pass before a rebuild: shrink first, summarize less. Default off. */
  preShake?: ShakeOptions | false;
  /** Expose `shrink_context` model tool (manual shake/prune/compact). Default false. */
  exposeTool?: boolean;
}

export interface CompactionHandle {
  plugin: Plugin;
  /** Sync-safe from anywhere: elide heavy regions in place. Returns savings. */
  shakeNow(opts?: ShakeOptions): { regions: number; tokensSaved: number };
  /** Sync-safe from anywhere: blank whole stale results. Returns counts + undo. */
  pruneNow(opts?: PruneOptions): PruneResult;
  /** Schedule a rebuild-method compaction (lands correctly mid-turn or idle). */
  requestCompact(reason?: string): void;
  /** The explicit pick — inspectable, never silently switched. */
  method: CompactionMethod;
}

interface AgentLike {
  model: {
    maxOutputTokens?: unknown;
    callNextTurn(agent: {
      messages: Message[];
      tools: { name: string; description: string; inputSchema: unknown }[];
      visibleTools(): { name: string; description: string; inputSchema: unknown }[];
      streamSink: undefined;
      abortSignal?: AbortSignal;
    }): Promise<{ message: Message }>;
  } & RemoteModel;
  messages: Message[];
  state: Record<string, unknown>;
  loopState: string;
  stats: { contextUsage?: unknown };
  currentInput?: { type: string } | null;
  stop(): void;
  wake(): void;
  setState?(key: string, value: unknown): void;
  addFilter(f: Filter): void;
  addTool?(t: ToolDefinition): void;
  addDeclaredCapability?(c: { id: string; description: string }): void;
  removeDeclaredCapability?(id: string): void;
}

export function createCompaction(opts: CompactionOptions = {}): CompactionHandle {
  const method: CompactionMethod = opts.method ?? "soft";
  const threshold = opts.threshold ?? 0.7;
  const keepRecent = opts.keepRecent ?? 8;
  const stateKey = opts.stateKey ?? "compaction";
  const label = method;

  const rebuildOpts = (extra?: Record<string, unknown>): RebuildOptions => ({
    keepRecent,
    stateKey,
    label,
    ...(extra ? { stateExtra: extra } : {}),
  });

  // Running-agent binding is fixed at install: filters close over it, and the
  // handle's manual calls delegate to the same message list. Rebinding would
  // let two agents share one compactRunning guard — the failure mode the
  // guard exists to prevent.
  let bound: AgentLike | undefined;
  let compactRunning = false;
  const handoff = createHandoffRun({ keepRecent, stateKey, ...(opts.handoff ?? {}) });

  async function compactNow(agent: AgentLike): Promise<void> {
    if (compactRunning) return;
    compactRunning = true;
    try {
      // Sync pre-pass ALWAYS (rebuild methods): shrink first, summarize less.
      // Protects the summarizer from itself on small windows — the summary
      // call must never exhaust the context it is trying to save.
      if (method === "soft" || method === "remote") {
        shakeNow(agent.messages, { protectTokens: 4000, minSavings: 0, ...(opts.preShake ?? {}) });
      }
      const snapshot = [...agent.messages];
      while (agent.loopState === "running") {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 20);
        await promise;
      }
      if (method === "shake") {
        shakeNow(agent.messages, opts.shake ?? {});
        agent.setState?.(stateKey, { at: Date.now(), method });
      } else if (method === "prune") {
        const out = pruneNow(agent.messages, opts.prune ?? {});
        agent.setState?.(stateKey, { at: Date.now(), method, prunedCount: out.prunedCount, tokensSaved: out.tokensSaved });
      } else if (method === "remote") {
        const compactors = opts.remote?.compactors ?? defaultCompactors();
        try {
          const out = await runRemoteSummary(agent.model, snapshot, {
            compactors,
            focus: opts.remote?.focus,
            timeoutMs: opts.remote?.timeoutMs,
            fetch: opts.remote?.fetch,
            resolveApiKey: opts.remote?.resolveApiKey,
          });
          rebuildWithSummary(agent, snapshot, out.summary, rebuildOpts({ compactor: out.compactorId, ...out.preserveData }));
        } catch (err) {
          // Gated route, explicit pick: failure keeps history INTACT + records.
          // Never a silent fallback to another method.
          agent.setState?.(stateKey, { at: Date.now(), method, error: String(err) });
          console.error("[sanity] remote compaction failed (history kept):", err);
        }
      } else if (method === "handoff") {
        handoff.start(agent);
        return; // the catcher rebuilds at turnEnd; compactRunning clears there
      } else {
        const prev = agent.state[stateKey];
        const previousSummary =
          prev !== null && typeof prev === "object" && "summary" in prev && typeof prev.summary === "string" ? prev.summary : undefined;
        const summarize = createSoftSummarizer(agent, { ...opts.soft, ...(previousSummary ? { previousSummary } : {}) });
        const summary = await summarize(snapshot);
        rebuildWithSummary(agent, snapshot, summary, rebuildOpts());
      }
    } catch (err) {
      console.error("[sanity] compaction failed:", err);
    } finally {
      if (method !== "handoff" || !handoff.pending()) {
        compactRunning = false;
        agent.state.compacting = false;
        if (agent.loopState !== "running") agent.wake();
      }
    }
  }

  const watcher: Filter = {
    event: EVENTS.afterProviderResponse,
    id: "compaction/watcher",
    priority: 100,
    fn: async (agent) => {
      const a = agent as unknown as AgentLike;
      if (a.state.compacting) return;
      if (method === "shake" || method === "prune") {
        // Sync methods run inline at the boundary — no stop/landing needed.
        const usage = a.stats.contextUsage;
        if (typeof usage !== "number" || usage < threshold) return;
        if (method === "shake") shakeNow(a.messages, opts.shake ?? {});
        else pruneNow(a.messages, opts.prune ?? {});
        a.setState?.(stateKey, { at: Date.now(), method, auto: true });
        return;
      }
      const usage = a.stats.contextUsage;
      if (typeof usage !== "number" || usage < threshold) return;
      a.state.compacting = true;
      a.stop();
    },
  };

  const onDemand: Filter = {
    event: EVENTS.inputReceived,
    id: "compaction/on-demand",
    priority: 0,
    fn: async (agent) => {
      const a = agent as unknown as AgentLike;
      const input = a.currentInput;
      if (!input || input.type !== requestCompactInput) return;
      if (a.state.compacting) return;
      a.state.compacting = true;
      if (a.loopState === "running") a.stop();
      else void compactNow(a);
    },
  };

  const trigger: Filter = {
    event: EVENTS.stop,
    id: "compaction/trigger",
    priority: 0,
    fn: async (agent) => {
      const a = agent as unknown as AgentLike;
      if (a.state.compacting) void compactNow(a);
    },
  };

  const catcher: Filter = {
    event: EVENTS.turnEnd,
    id: "compaction/catcher",
    priority: 100,
    fn: async (agent) => {
      const a = agent as unknown as AgentLike;
      if (method !== "handoff" || !handoff.pending()) return;
      const snapshot = handoff.snapshot();
      const last = [...a.messages].reverse().find((m) => m.type === "assistant");
      const content = last?.content;
      const blocks = content !== null && content !== undefined && Array.isArray(content) ? content.filter((b) => "type" in b && b.type === "text") : [];
      const text = blocks.map((b) => b.content).join("");
      const tail = recentTail(snapshot, a.messages.slice(snapshot.length).filter((m) => m.id !== handoff.requestId()), keepRecent);
      const systemMessages = snapshot.filter((m) => m.type === "system");
      const summaryMsg: Message = {
        id: `summary-handoff-${randomUUID().slice(0, 8)}`,
        enabled: true,
        type: "user",
        content: [{ type: "text", content: `[Earlier conversation compacted — handover]\n\n${text.trim().length > 0 ? text : "(empty handover)"}` }],
      };
      const rebuilt = normalizeForAlternation([...systemMessages, summaryMsg, ...tail]);
      a.messages.splice(0, a.messages.length, ...rebuilt);
      a.setState?.(opts.handoff?.stateKey ?? stateKey, { at: Date.now(), method: "handoff" });
      a.state.compacting = false;
      handoff.reset();
      compactRunning = false;
      a.wake();
    },
  };

  const cleanup: Filter = {
    event: EVENTS.abort,
    id: "compaction/cleanup",
    priority: 0,
    fn: async (agent) => {
      (agent as unknown as AgentLike).state.compacting = false;
      handoff.reset();
    },
  };

  const plugin: Plugin = {
    id: "compaction",
    install(agent) {
      bound = agent as unknown as AgentLike;
      agent.addFilter(watcher);
      agent.addFilter(onDemand);
      agent.addFilter(trigger);
      if (method === "handoff") agent.addFilter(catcher);
      agent.addFilter(cleanup);
      agent.addDeclaredCapability?.({ id: `compaction:${method}`, description: `context compaction via ${method}` });
      if (opts.exposeTool === true) {
        const tool: ToolDefinition = {
          name: "shrink_context",
          description:
            "Reclaim context: mode shake (elide heavy regions, instant) | prune (blank stale results, instant) | compact (full scheduled compaction at the landing).",
          inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["shake", "prune", "compact"] } }, required: ["mode"] },
          execute: (params: unknown) => {
            if (typeof params !== "object" || params === null || !("mode" in params)) {
              return { answer: "shrink_context: mode required (shake|prune|compact)", stored: { ok: false } };
            }
            if (!bound) return { answer: "shrink_context: no agent bound", stored: { ok: false } };
            const modeParam = params.mode;
            if (modeParam === "shake") {
              const out = shakeNow(bound.messages, opts.shake ?? {});
              return { answer: `shook ${out.regions} region(s), ~${out.tokensSaved} tokens reclaimed`, stored: { ok: true, ...out } };
            }
            if (modeParam === "prune") {
              const out = pruneNow(bound.messages, opts.prune ?? {});
              return { answer: `pruned ${out.prunedCount} result(s), ~${out.tokensSaved} tokens reclaimed`, stored: { ok: true, prunedCount: out.prunedCount, tokensSaved: out.tokensSaved } };
            }
            bound.state.compacting = true;
            if (bound.loopState === "running") bound.stop();
            else void compactNow(bound);
            return { answer: "compaction scheduled at the landing", stored: { ok: true } };
          },
        };
        agent.addTool(tool);
      }
    },
    uninstall(agent) {
      removeFiltersByPrefix(agent, "compaction/");
      agent.removeDeclaredCapability?.(`compaction:${method}`);
      if (bound && agent === (bound as unknown)) bound = undefined;
    },
  };

  return {
    plugin,
    method,
    shakeNow: (o) => {
      if (!bound) return { regions: 0, tokensSaved: 0 };
      return shakeNow(bound.messages, o ?? opts.shake ?? {});
    },
    pruneNow: (o) => {
      if (!bound) return { prunedCount: 0, tokensSaved: 0, undo: () => {} };
      return pruneNow(bound.messages, o ?? opts.prune ?? {});
    },
    requestCompact: (reason) => {
      if (!bound || bound.state.compacting) return;
      if (reason !== undefined) console.info(`[sanity] compaction requested: ${reason}`);
      bound.state.compacting = true;
      if (bound.loopState === "running") bound.stop();
      else void compactNow(bound);
    },
  };
}

/** Default — 70% threshold, keep 8, portable local summary. */
export const compaction: Plugin = createCompaction().plugin;

export type { SoftOptions, HandoffOptions, HandoffRun, RemoteRunOptions } from "./methods.ts";
export type {
  RemoteCompactor,
  RemoteCompactInput,
  RemoteCompactResult,
  RemoteModel,
  OpenAiResponsesOptions,
  AnthropicCompactionOptions,
} from "./remote.ts";
export {
  shakeNow as shakeMessages,
  pruneNow as pruneMessages,
  findBlockRanges,
  estimateTokens,
  DEFAULT_SHAKE_OPTIONS,
  AGGRESSIVE_SHAKE_OPTIONS,
  RESCUE_SHAKE_OPTIONS,
  DEFAULT_PRUNE_OPTIONS,
} from "./sync.ts";
export type { ShakeOptions, PruneOptions, PruneResult, ShakeRegion, ProtectedToolMatcher } from "./sync.ts";
export { createOpenAiResponsesCompactor, createAnthropicCompactor, defaultCompactors, flattenSnapshot, ANTHROPIC_COMPACTION_BETA } from "./remote.ts";
export { messageText, recentTail, rebuildWithSummary } from "./rebuild.ts";
export type { RebuildOptions, RebuildAgent } from "./rebuild.ts";
export { createSoftSummarizer, createHandoffRun, runRemoteSummary, DEFAULT_HANDOFF_INSTRUCTION } from "./methods.ts";
