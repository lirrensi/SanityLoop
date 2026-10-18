// Generic remote compactor — provider-native compaction behind a closed
// interface. The method never touches agent state: it takes a flattened
// snapshot, calls the provider's own compaction endpoint, and returns
// {summary, preserveData?}. The shared rebuild splices the result in.
//
// Gate per impl: `available(model)` is a PURE predicate on the model
// contract (api/provider/modelId/baseUrl). Mismatch → the plugin skips
// with a state note, history untouched — never a silent fallback.
//
// Enrichment path: implement RemoteCompactor for a new provider and pass it
// in `remote.compactors`. Built-ins: OpenAI Responses `/responses/compact`
// (V1) and Anthropic on-demand compaction (beta `compact-2026-09-04`).

import type { Message } from "@sanityloop/core";
import { messageText } from "./rebuild.ts";

export interface RemoteModel {
  api: string;
  modelId: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  maxContext?: number;
  [key: string]: unknown;
}

export interface RemoteCompactInput {
  /** Flattened role-labeled conversation (systems first, then turns). */
  conversationText: string;
  /** Extra user focus ("keep the auth plan verbatim"). */
  focus?: string;
  /** Abort a hung provider call. */
  signal?: AbortSignal;
}

export interface RemoteCompactResult {
  summary: string;
  /** Opaque provider payload the NEXT compaction may need (signed blocks, item ids). */
  preserveData?: Record<string, unknown>;
}

/**
 * One provider-native compaction route. Pure + closed: no agent handle,
 * no message mutation — independently callable (`compactor.compact(model,
 * input)`) for tests, scripts, or manual runs.
 */
export interface RemoteCompactor {
  /** Stable route id for logs + state records. */
  id: string;
  /** Pure availability gate — provider/model/endpoint match, no I/O. */
  available(model: RemoteModel): boolean;
  compact(model: RemoteModel, input: RemoteCompactInput): Promise<RemoteCompactResult>;
}

export interface RemoteRunOptions {
  /** Candidate routes, tried in order until one reports available. */
  compactors: RemoteCompactor[];
  /** Focus instructions appended to the provider's compaction request. */
  focus?: string;
  /** Fetch timeout ms. Default 120_000. */
  timeoutMs?: number;
  /** Custom fetch (tests, proxies). */
  fetch?: typeof fetch;
  /** Resolve the API key when the model carries none (env fallback). */
  resolveApiKey?: (model: RemoteModel) => string | undefined;
}

/** Flatten a snapshot to the role-labeled text every provider route consumes. Newest-first ~4k-token clamp. */
export function flattenSnapshot(snapshot: Message[], focus?: string): string {
  const flat = snapshot.map((m) => `${m.type}: ${messageText(m)}`).filter((s) => s.trim().length > 0);
  const kept: string[] = [];
  let used = 0;
  for (let i = flat.length - 1; i >= 0; i--) {
    const cost = Math.ceil(flat[i].length / 4);
    if (used + cost > 4000 && kept.length > 0) break;
    kept.unshift(flat[i]);
    used += cost;
  }
  const body = kept.join("\n\n");
  return focus ? `${body}\n\n[compaction focus: ${focus}]` : body;
}

// ---------------------------------------------------------------------------
// OpenAI Responses V1: POST {base}/responses/compact {model, input, instructions}
// Returns {summary} (or an item list carrying summary text). OMP's V2
// streaming `compaction_trigger` is a transport upgrade of the same route —
// a future compactor, same interface.
// ---------------------------------------------------------------------------

export interface OpenAiResponsesOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
  resolveApiKey?: (model: RemoteModel) => string | undefined;
}

function openAiBase(model: RemoteModel): string {
  const raw = (model.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  return raw.endsWith("/v1") ? `${raw}/responses/compact` : `${raw}/v1/responses/compact`;
}

function openAiKey(model: RemoteModel, resolve?: (m: RemoteModel) => string | undefined): string {
  const direct = typeof model.apiKey === "string" && model.apiKey.length > 0 ? model.apiKey : undefined;
  const via = resolve?.(model);
  const env = typeof process.env.OPENAI_API_KEY === "string" ? process.env.OPENAI_API_KEY : undefined;
  const key = direct ?? via ?? env;
  if (!key) throw new Error("[sanity] openai-responses compactor: no API key (model.apiKey, resolveApiKey, or OPENAI_API_KEY)");
  return key;
}

export function createOpenAiResponsesCompactor(opts: OpenAiResponsesOptions = {}): RemoteCompactor {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return {
    id: "openai-responses",
    available(model) {
      if (model.api === "openai-responses") return true;
      if (model.provider === "openai") return true;
      if (typeof model.baseUrl === "string" && model.baseUrl.includes("/codex")) return true;
      return false;
    },
    async compact(model, input) {
      const key = openAiKey(model, opts.resolveApiKey);
      const run = opts.fetch ?? fetch;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await run(openAiBase(model), {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: model.modelId, input: input.conversationText, instructions: input.focus ?? "Summarize this conversation for continuation." }),
          signal: input.signal ?? ctrl.signal,
        });
        if (!res.ok) throw new Error(`[sanity] openai-responses compact failed: ${res.status}`);
        const data = (await res.json()) as { summary?: unknown; output?: Array<{ type?: string; summary?: unknown; text?: unknown }> };
        if (typeof data.summary === "string" && data.summary.trim().length > 0) {
          return { summary: data.summary, preserveData: { remoteCompactor: "openai-responses" } };
        }
        if (Array.isArray(data.output)) {
          for (const item of data.output) {
            const text = typeof item.summary === "string" ? item.summary : typeof item.text === "string" ? item.text : undefined;
            if (text !== undefined && text.trim().length > 0) {
              return { summary: text, preserveData: { remoteCompactor: "openai-responses" } };
            }
          }
        }
        throw new Error("[sanity] openai-responses compact: response carried no summary");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic on-demand: POST {base}/v1/messages {compaction: {type:"summarize"}}
// with beta `compact-2026-09-04`. Returns a signed compaction block the
// next request replays — captured into preserveData for the state record.
// ---------------------------------------------------------------------------

export interface AnthropicCompactionOptions extends OpenAiResponsesOptions {}

export const ANTHROPIC_COMPACTION_BETA = "compact-2026-09-04";

function anthropicBase(model: RemoteModel): string {
  const raw = (model.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  return raw.endsWith("/v1") ? raw : `${raw}/v1`;
}

function anthropicKey(model: RemoteModel, resolve?: (m: RemoteModel) => string | undefined): string {
  const direct = typeof model.apiKey === "string" && model.apiKey.length > 0 ? model.apiKey : undefined;
  const via = resolve?.(model);
  const env = typeof process.env.ANTHROPIC_API_KEY === "string" ? process.env.ANTHROPIC_API_KEY : undefined;
  const key = direct ?? via ?? env;
  if (!key) throw new Error("[sanity] anthropic compactor: no API key (model.apiKey, resolveApiKey, or ANTHROPIC_API_KEY)");
  return key;
}

export function createAnthropicCompactor(opts: AnthropicCompactionOptions = {}): RemoteCompactor {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return {
    id: "anthropic",
    available(model) {
      return model.provider === "anthropic" || model.api === "anthropic-messages";
    },
    async compact(model, input) {
      const key = anthropicKey(model, opts.resolveApiKey);
      const run = opts.fetch ?? fetch;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await run(`${anthropicBase(model)}/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": ANTHROPIC_COMPACTION_BETA,
          },
          body: JSON.stringify({
            model: model.modelId,
            max_tokens: 4096,
            messages: [{ role: "user", content: input.conversationText }],
            compaction: { type: "summarize", ...(input.focus ? { instructions: input.focus } : {}) },
          }),
          signal: input.signal ?? ctrl.signal,
        });
        if (!res.ok) throw new Error(`[sanity] anthropic compact failed: ${res.status}`);
        const data = (await res.json()) as {
          content?: Array<{ type?: string; text?: unknown; content?: unknown; signature?: unknown }>;
          stop_reason?: string;
        };
        const blocks = Array.isArray(data.content) ? data.content : [];
        let summary = "";
        let signature: string | undefined;
        for (const b of blocks) {
          if (b.type === "compaction" && typeof b.content === "string") {
            summary = b.content;
            if (typeof b.signature === "string") signature = b.signature;
            break;
          }
          if (b.type === "text" && typeof b.text === "string") summary += b.text;
        }
        const text = summary.trim();
        if (text.length === 0) throw new Error("[sanity] anthropic compact: response carried no compaction block");
        return {
          summary: text,
          preserveData: {
            remoteCompactor: "anthropic",
            ...(signature ? { signature } : {}),
          },
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Default route table — OpenAI first, Anthropic second. Override to extend. */
export function defaultCompactors(opts: OpenAiResponsesOptions = {}): RemoteCompactor[] {
  return [createOpenAiResponsesCompactor(opts), createAnthropicCompactor(opts)];
}
