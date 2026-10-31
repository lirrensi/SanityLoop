// ============================================================================
// sanity/src/extras/cache-trace/index.ts — cache-break diagnostics.
// ============================================================================
// WHY the hell did the prompt cache break? This watcher traces the wire head
// (first N messages + visible tool defs + model id) before every provider
// response lands, diffs against the previous call, and emits `cache/break`
// with the OPS — what moved, before/after clipped — each tagged with the
// triggering mutation(s) seen since the last call.
//
// Best-effort by canon: it traces the STORED head + tool defs, not the exact
// post-normalization wire bytes (normalization merges systems, drops disabled
// and dangling calls). Close enough to name culprits: tool edits, skill/
// rules injections, compaction rebuilds, model swaps, enable flips.
//
// Custom `cache/break` event (agent.emit, published) — diagnostics stay out
// of core's versioned EVENTS. First call establishes the baseline silently.
// No ops = silent (cache holds, nothing to say).
import { EVENTS, answerText } from "@sanityloop/core";
import type { GodObject, Message, Plugin, ToolType } from "@sanityloop/core";
import { removeFiltersByPrefix } from "@sanityloop/util";

/** One head movement between two consecutive provider calls. */
export interface CacheBreakOp {
  /** Where: `head[<i>].<field>`, `tools[<name>].<field>`, or `model`. */
  path: string;
  /** Clipped before/after (see `clip`). */
  before: string;
  after: string;
  /** Mutations seen since the last call (event names + tool names). */
  causes: string[];
}

export interface CacheTraceOptions {
  /** Stored-head window (first N enabled messages). Default 10. */
  headMessages?: number;
  /** Clip before/after text to this many chars. Default 200. */
  clip?: number;
  /** Where trace activity lives in session state. Default "cacheTrace". */
  stateKey?: string;
}

export const CACHE_TRACE_STATE_KEY = "cacheTrace";
export const CACHE_BREAK_EVENT = "cache/break";

const clipText = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

function headText(m: Message): string {
  return `${m.type}:${m.enabled === false ? "off" : "on"}:${answerText(m.content)}`;
}

function toolText(t: ToolType): string {
  return `${t.name}:${t.description ?? ""}:${JSON.stringify(t.inputSchema ?? null)}`;
}

interface HeadSnapshot {
  messages: string[];
  tools: string[];
  modelId: string;
}

function snapshotHead(agent: GodObject, headMessages: number): HeadSnapshot {
  const messages = agent.messages.filter((m) => m.enabled !== false).slice(0, headMessages).map(headText);
  const tools = agent.visibleTools().map(toolText);
  const modelId = agent.model?.modelId ?? "?";
  return { messages, tools, modelId };
}

function diffHeads(prev: HeadSnapshot, next: HeadSnapshot, clip: number, causes: string[]): CacheBreakOp[] {
  const ops: CacheBreakOp[] = [];
  const n = Math.max(prev.messages.length, next.messages.length);
  for (let i = 0; i < n; i++) {
    const b = prev.messages[i];
    const a = next.messages[i];
    if (b !== a) {
      ops.push({
        path: `head[${i}]`,
        before: clipText(b ?? "<none>", clip),
        after: clipText(a ?? "<none>", clip),
        causes: [...causes],
      });
    }
  }
  const pm = new Map(prev.tools.map((t) => [t.split(":")[0] as string, t]));
  const nm = new Map(next.tools.map((t) => [t.split(":")[0] as string, t]));
  for (const [name, after] of nm) {
    const before = pm.get(name);
    if (before === undefined) {
      ops.push({ path: `tools[${name}]`, before: "<none>", after: clipText(after, clip), causes: [...causes] });
    } else if (before !== after) {
      ops.push({ path: `tools[${name}]`, before: clipText(before, clip), after: clipText(after, clip), causes: [...causes] });
    }
  }
  for (const [name, before] of pm) {
    if (!nm.has(name)) {
      ops.push({ path: `tools[${name}]`, before: clipText(before, clip), after: "<none>", causes: [...causes] });
    }
  }
  if (prev.modelId !== next.modelId) {
    ops.push({ path: "model", before: prev.modelId, after: next.modelId, causes: [...causes] });
  }
  return ops;
}

/** Mutation events that can move the head — recorded as op causes. */
const CAUSE_EVENTS = [
  EVENTS.toolListChanged,
  EVENTS.toolChanged,
  EVENTS.messageAdded,
  EVENTS.messageUpdate,
  EVENTS.messageRemoved,
  EVENTS.fragmentUpdate,
] as const;

export function createCacheTrace(opts: CacheTraceOptions = {}): Plugin {
  const headMessages = opts.headMessages ?? 10;
  const clip = opts.clip ?? 200;
  const stateKey = opts.stateKey ?? CACHE_TRACE_STATE_KEY;
  let prev: HeadSnapshot | undefined;
  let callIndex = 0;
  const causes: string[] = [];

  return {
    id: "cache-trace",
    install(agent) {
      for (const event of CAUSE_EVENTS) {
        agent.addFilter({
          event,
          id: `cache-trace/cause/${event}`,
          priority: 1000, // runs last — observes, never interferes
          fn: async (_agent, payload) => {
            const p = payload as { toolName?: unknown; change?: unknown } | undefined;
            const detail = typeof p?.toolName === "string"
              ? `:${p.toolName}${typeof p?.change === "string" ? `/${p.change}` : ""}`
              : "";
            const cause = `${event}${detail}`;
            if (!causes.includes(cause)) causes.push(cause);
          },
        });
      }
      agent.addFilter({
        event: EVENTS.afterProviderResponse,
        id: "cache-trace/watch",
        priority: 1000, // after all response filters — traces what actually fired
        fn: async (agent) => {
          callIndex++;
          const next = snapshotHead(agent, headMessages);
          if (prev !== undefined) {
            const ops = diffHeads(prev, next, clip, causes);
            if (ops.length > 0) {
              agent.setState(stateKey, { at: Date.now(), callIndex, ops: ops.length });
              agent.emit(CACHE_BREAK_EVENT, { type: CACHE_BREAK_EVENT, callIndex, ops });
            }
          }
          prev = next;
          causes.length = 0;
        },
      });
      agent.addDeclaredCapability({
        id: "cache-trace",
        description: "cache-break diagnostics: wire-head diff ops per provider call on `cache/break`",
      });
    },
    uninstall(agent) {
      prev = undefined;
      callIndex = 0;
      causes.length = 0;
      removeFiltersByPrefix(agent, "cache-trace/");
      agent.removeDeclaredCapability("cache-trace");
      delete agent.state[stateKey];
    },
  };
}
