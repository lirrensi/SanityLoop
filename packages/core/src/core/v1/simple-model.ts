// ============================================================================
// sanity/src/simple-model.ts — SimpleModel
// ============================================================================
// Speaks chat_completions / responses — covers ~99% of LLMs (fuck mistanthropic).
// The transform is light because OpenAI-compatible providers return roughly the
// same shapes. prepareMessages is the SEAM — override it for adjustments without
// touching callNextTurn.
//
//   callNextTurn(agent)
//     ├── prepareMessages(agent.messages)   ← OVERRIDE THIS for adjustments
//     ├── THE CALL                        ← tools sent, abort signal passed
//     │     → streaming assembles content + tool calls from SSE
//     └── return the normal message       ← what the runtime expects, always
//
// Adapter responsibility (item 21.5): bad finish_reason (length/content_filter)
// is an ERROR, not a result. Malformed tool args become preResolved error
// results — the model sees them and self-corrects (item 21.6).
// ============================================================================

import type { GodObject, Message, StreamSink, ToolResultContent, ToolResultMessage, TurnResult } from "./types.ts";
import type { ToolCallRecord } from "./agent.ts";
import { estimateInputTokens, estimateOutputTokens } from "./token-estimate.ts";
// ============================================================================
// normalizeForAlternation — the SIMPLE model's own message-shaping strategy.
// Role alternation is a model concern: llama.cpp 400s on consecutive same-role
// messages / dangling toolCalls / a trailing assistant — and its Qwen template
// wants the first message to be system, so the LEADING run of consecutive
// system messages (simple + compound) merges into ONE head. Systems sitting
// mid-array are NEVER moved — order is truth, producers own placement.
// Applied right before the provider call (SimpleModelOptions.normalizeMessages),
// and shared with the compaction extras so rebuilt STORED lists stay legal too.
// Cross-provider adapters (PiAdapterModel) shape messages their own way and
// override callNextTurn — they never pass through here. Idempotent: running it
// twice is safe.
// ============================================================================

/** Strip the "-compound" flavor suffix — compound is OUR dynamic-fragment convenience; the wire wants the base type. */
function baseType(type: string): string {
  return type.endsWith("-compound") ? type.slice(0, -"-compound".length) : type;
}

/** A message that may carry the model's thinking — only attached when keepReasoning is on. */
type ReasonedMessage = Message & { reasoningContent?: string };

/**
 * Canonical OpenAI-compatible content part for one message block.
 * Text stays text; media maps to parts OpenRouter accepts:
 * image → image_url, audio → input_audio, document/pdf → file_data,
 * video → video_url (url or base64 data-URL; optional `processing`
 * "agentic"|"static" is a Gemini-only hint, ignored by other providers).
 * Unknown blocks → dropped.
 */
export function toWirePart(block: unknown): Record<string, unknown> | undefined {
  if (typeof block !== "object" || block === null) return undefined;
  const b = block as { type?: unknown; content?: unknown; data?: unknown; mimeType?: unknown; name?: unknown; processing?: unknown };
  if (b.type === "text" && typeof b.content === "string") return { type: "text", text: b.content };
  if (typeof b.data !== "string" || typeof b.mimeType !== "string") return undefined;
  const url = b.data.startsWith("data:") || b.data.startsWith("http") ? b.data : `data:${b.mimeType};base64,${b.data}`;
  if (b.type === "image") return { type: "image_url", image_url: { url } };
  if (b.type === "audio") return { type: "input_audio", input_audio: { data: b.data, format: audioFormat(b.mimeType) } };
  if (b.type === "video") {
    const part: Record<string, unknown> = { type: "video_url", video_url: { url } };
    if (b.processing === "agentic" || b.processing === "static") (part.video_url as Record<string, unknown>).processing = b.processing;
    return part;
  }
  if (b.type === "document") {
    if (b.mimeType === "application/pdf") return { type: "file", file: { filename: typeof b.name === "string" ? b.name : "document.pdf", file_data: url } };
    return { type: "text", text: `[document ${b.mimeType}${typeof b.name === "string" ? ` ${b.name}` : ""}: ${url.slice(0, 120)}…]` };
  }
  return undefined;
}

function audioFormat(mime: string): string {
  const low = mime.toLowerCase();
  if (low.includes("wav")) return "wav";
  if (low.includes("mp3") || low.includes("mpeg")) return "mp3";
  return "wav";
}

/** Flatten any message content to a wire string — text blocks, compound fragments, tool faces. Media blocks contribute a short descriptor (never base64). */
function toWireText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b !== "object" || b === null) return "";
        if ("content" in b && typeof (b as { content: unknown }).content === "string") return (b as { content: string }).content;
        if ("type" in b && typeof (b as { type: unknown }).type === "string") {
          const t = (b as { type: string }).type;
          if (t !== "text") return `[${t} omitted — text-only fallback]`;
        }
        return "";
      })
      .join("\n");
  }
  if (typeof content === "object" && content !== null && "answer" in content) {
    return String((content as { answer: unknown }).answer);
  }
  return String(content ?? "");
}

/** Canonical wire content: string when pure text, multipart array when any media. */
export function toWireContent(content: unknown): string | Record<string, unknown>[] {
  const parts = toWireParts(content);
  if (parts.every((p) => p.type === "text")) return parts.map((p) => String(p.text ?? "")).join("\n");
  return parts;
}

function toWireParts(content: unknown): { type: string; text?: unknown }[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [{ type: "text", text: toWireText(content) }];
  const parts: { type: string; text?: unknown }[] = [];
  for (const b of content) {
    if (typeof b !== "object" || b === null) continue;
    // custom wire-ready parts (video_url, image_url, input_audio, file, ...) pass verbatim —
    // the user knows what their provider eats. Known blocks map via toWirePart.
    if ("type" in b && typeof (b as { type: unknown }).type === "string") {
      const t = (b as { type: string }).type;
      if (t.includes("_") || t === "file") {
        parts.push({ ...(b as Record<string, unknown>) } as { type: string });
        continue;
      }
    }
    const part = toWirePart(b);
    if (part) parts.push(part as { type: string; text?: unknown });
  }
  return parts.length > 0 ? parts : [{ type: "text", text: "" }];
}

/** Concat two simple contents block-wise. Adjacent text joins with blank lines; media/custom parts append verbatim. Pure helper — inputs untouched. */
export function concatBlocks(
  a: unknown,
  b: unknown,
): { type: string; content?: string; data?: string; mimeType?: string; name?: string; processing?: string }[] {
  const parts = [...toBlockList(a), ...toBlockList(b)];
  const out: { type: string; content?: string; data?: string; mimeType?: string; name?: string; processing?: string }[] = [];
  for (const p of parts) {
    out.push({ ...p });
  }
  // join runs of adjacent text (the old toWireText join, block-safe)
  const joined: { type: string; content?: string; data?: string; mimeType?: string; name?: string; processing?: string }[] = [];
  for (const p of out) {
    const prev = joined[joined.length - 1];
    if (p.type === "text" && prev?.type === "text") {
      const text = [prev.content ?? "", p.content ?? ""].filter((s) => s.length > 0).join("\n\n");
      joined[joined.length - 1] = { type: "text", content: text };
    } else {
      joined.push(p);
    }
  }
  return joined;
}

type BlockLike = { type: string; content?: string; data?: string; mimeType?: string; name?: string; processing?: string };

function toBlockList(content: unknown): BlockLike[] {
  if (typeof content === "string") return content.length > 0 ? [{ type: "text", content }] : [];
  if (!Array.isArray(content)) return [];
  const list: BlockLike[] = [];
  for (const b of content) {
    if (typeof b !== "object" || b === null) continue;
    if (!("type" in b) || typeof (b as { type: unknown }).type !== "string") continue;
    list.push({ ...(b as Record<string, string>) } as BlockLike);
  }
  return list;
}

/**
 * Order-preserving message shaping. RULE ONE — order is absolute:
 *  - NO message ever changes position / index / order. Never hoisted, never
 *    reordered, never deleted.
 *  - Alternation is achieved ONLY by merging consecutive same-base-type text
 *    messages (system/user/assistant, simple or compound) IN PLACE — the first
 *    keeps its id + position, later content appends. Merging never reorders.
 *  - Tools ALWAYS pair by ID: a toolCall is kept only with its matching
 *    toolResult(s) immediately after; anything not matched by ID is NOT
 *    included (orphaned results, dangling calls).
 *  - compound flavors count as their base type (user-compound == user, …).
 */
export function normalizeForAlternation(list: Message[]): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m.enabled) continue; // not in context — never contributes, never merges
    const base = baseType(m.type);
    if (base === "toolCall") {
      // tools ALWAYS pair by ID — a call is kept only with its matching
      // results immediately after; anything unmatched is not included
      const callIds = new Set(((m.content as { stored?: { id?: string }[] }).stored ?? []).map((c) => c.id));
      const results: Message[] = [];
      let j = i + 1;
      while (j < list.length && baseType(list[j].type) === "toolResult") {
        const rid = (list[j] as ToolResultMessage).toolCallId;
        if (rid && callIds.has(rid)) {
          callIds.delete(rid);
          results.push(list[j]);
        }
        j++;
      }
      if (results.length > 0) {
        out.push(m, ...results);
        i = j - 1;
      }
      continue; // dangling toolCall (no matching result) → not included
    }
    if (base === "toolResult") continue; // orphaned result (no matching call) → not included

    const last = out[out.length - 1];
    if (
      last &&
      baseType(last.type) === base &&
      (base === "system" || base === "user" || base === "assistant")
    ) {
      // alternation via merge — consecutive same-type fold IN PLACE. The first
      // keeps its id + position, later content appends. Never mutates the input.
      // Block concat, not string flatten: text parts join with blank lines,
      // media/custom parts append verbatim so user-supplied parts survive.
      // concatBlocks returns ContentBlock[] — assignable: only simple-type
      // messages reach this branch (tool/compound never merge).
      out[out.length - 1] = { ...last, content: concatBlocks(last.content, m.content) as Message["content"] };
    } else {
      out.push(m);
    }
  }
  return out;
}
/** The error shape the adapter throws for non-OK provider responses. Stamped
 * with structured facts errorFacts() forwards verbatim onto the `error` event. */
export type ProviderError = Error & { code?: string; status?: number; retryable?: boolean; attempts?: number; elapsedMs?: number };

/** One failed attempt, handed to `onRetry` before the backoff sleep. */
export interface RetryAttempt {
  /** 1-based: the attempt that just failed. */
  attempt: number;
  /** The error that failed it (provider error or transport failure). */
  error: unknown;
  /** How long the whole callApi has been running (ms). */
  elapsedMs: number;
  /** How long we are about to sleep (ms, jitter already applied). */
  waitMs: number;
}

export interface SimpleModelOptions {
  api?: "chat_completions" | "responses" | string;
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  stream?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  /** The context window — the compaction trigger reads this. */
  maxContext?: number;
  /**
   * Normalization strategy applied to the message list RIGHT BEFORE the provider
   * call. Default: normalizeForAlternation (strict role alternation; the LEADING
   * run of consecutive system messages merges into one head — llama.cpp 400s on
   * consecutive same-role / trailing assistant / any list that doesn't start
   * with system). Mid-array systems are never moved. Pass (m) => m to disable.
   * The strategy is the SIMPLE model's own concern — cross-provider adapters
   * (PiAdapterModel) shape messages their own way and override callNextTurn, so
   * they never pass through here.
   */
  normalizeMessages?: (messages: Message[]) => Message[];
  /**
   * PRESERVE the model's thinking (reasoning_content) in history and replay it
   * on subsequent requests. Default false: thinking is streamed to the console
   * so the loop looks alive, then DISCARDED — the next request never carries it
   * (minimal wire, no multi-turn surprises). Set true for providers/templates
   * that want thinking replayed on every assistant message.
   */
  preserveThinking?: boolean;
  /**
   * Network-level retries — the honest loop the error path already promises
   * ("Adapter retries first"). Bounded, retryable-only: transport failures +
   * HTTP 429/5xx. Non-retryable (4xx, bad finish_reason, parse) throws on the
   * first attempt. The loop-level decision stays the filter's (the `error`
   * event carries everything after retries exhaust). Default 3 attempts total.
   */
  retries?: number;
  /**
   * Total wall-clock budget for the whole callApi in ms — attempts + backoffs
   * included. Checked after every failure BEFORE deciding to retry: when the
   * budget is spent, the last error throws immediately (no trailing sleep).
   * Omit = unbounded. Pair `retries: Infinity` with a budget for "retry
   * forever until the provider comes back, but give up after an hour".
   */
  retryBudgetMs?: number;
  /**
   * Base delay between retries in ms (exponential: base * 2^(attempt-1),
   * capped by retryMaxDelayMs, plus ±50% jitter). Default 500.
   */
  retryDelayMs?: number;
  /**
   * Ceiling for a single backoff sleep in ms. Default 10_000. Lower it when
   * the provider recovers fast and you want tight polling; raise it for
   * hour-long budget runs so a dead provider doesn't get hammered.
   */
  retryMaxDelayMs?: number;
  /**
   * Called after each failed retryable attempt, BEFORE the backoff sleep.
   * Sync or async — awaited. Throwing/returning false vetoes the retry: the
   * original error throws immediately. Use it to log attempts, update a
   * status line, or enforce a custom stop policy (consecutive-429 cap, ...).
   */
  onRetry?: (attempt: RetryAttempt) => void | false | Promise<void | false>;
}

export class SimpleModel {
  api: string;
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  stream: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  maxContext?: number;
  /** The strategy applied before the provider call (see options). */
  normalizeMessages: (messages: Message[]) => Message[];
  /** Whether thinking (reasoning_content) is kept in history + replayed (see options). */
  /** Total network attempts (1 = no retry, Infinity = until budget/abort/veto). Default 3. Zero/negative/NaN → 1. Infinity passes through. */
  retries: number;
  /** Total wall-clock budget in ms. Omit (undefined) = unbounded. Zero/negative = no retries at all. */
  retryBudgetMs?: number;
  /** Base retry delay in ms. Default 500. */
  retryDelayMs: number;
  /** Single-backoff ceiling in ms. Default 10_000. */
  retryMaxDelayMs: number;
  /** Per-attempt hook, awaited before the backoff sleep. False/throw = stop. */
  onRetry?: (attempt: RetryAttempt) => void | false | Promise<void | false>;
  /** The runtime's open bag — satisfies ModelContract's index signature. */
  [key: string]: unknown;

  constructor(opts: SimpleModelOptions) {
    this.api = opts.api ?? "chat_completions";
    this.modelId = opts.modelId;
    const env = (globalThis as { process?: { env?: Record<string, string> } }).process?.env;
    this.apiKey = opts.apiKey ?? env?.OPENAI_API_KEY;
    this.baseUrl = opts.baseUrl;
    this.stream = opts.stream ?? true;
    this.temperature = opts.temperature;
    this.maxOutputTokens = opts.maxOutputTokens;
    this.maxContext = opts.maxContext;
    this.normalizeMessages = opts.normalizeMessages ?? normalizeForAlternation;
    this.retries = opts.retries ?? 3;
    this.retryBudgetMs = opts.retryBudgetMs;
    this.retryDelayMs = opts.retryDelayMs ?? 500;
    this.retryMaxDelayMs = opts.retryMaxDelayMs ?? 10_000;
    this.onRetry = opts.onRetry;
  }

  // ==========================================================================
  // THE function the runtime calls — receives the WHOLE context
  // ==========================================================================
  async callNextTurn(agent: GodObject): Promise<TurnResult> {
    // 0. normalize BEFORE the call — the strategy is this model's own concern
    const normalized = this.normalizeMessages(agent.messages);
    // 1. prepare messages — the seam (override this for adjustments)
    const apiMessages = this.prepareMessages(normalized) as unknown[];

    // 2. THE CALL — the guts (library / Pi SDK / raw fetch)
    //    tools travel with the request; the abort signal cooperates with the loop
    const response = await this.callApi(apiMessages, agent.streamSink, agent);

    // 3. return the normal message — what the runtime expects
    return this.parseResponse(response, normalized);
  }

  // ==========================================================================
  // The seam — OVERRIDE THIS for adjustments
  // ==========================================================================
  /** Grab all current messages, return what the provider expects to be passed. */
  prepareMessages(messages: Message[]): unknown {
    return messages.filter((m) => m.enabled).map((m) => this.toApiMessage(m));
  }

  // ==========================================================================
  // The guts — swap this one function to swap the whole world
  // ==========================================================================
  protected async callApi(apiMessages: unknown[], sink: StreamSink | undefined, agent: GodObject): Promise<unknown> {
    const url = `${this.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.modelId,
      messages: apiMessages,
      temperature: this.temperature,
      stream: this.stream,
    };
    // NO max_tokens by default — the context window is the ceiling. Omitting it
    // means "length" finish_reason only fires on GENUINE context exhaustion
    // (compaction territory), never on an artificial cap.
    if (this.maxOutputTokens != null) body.max_tokens = this.maxOutputTokens;
    // tools travel with the request — the model can actually call them now.
    // visibleTools() = the wire list: hidden tools stay callable but never
    // reach context (progressive disclosure / tool_search).
    const tools = agent.visibleTools().map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
    if (tools.length > 0) body.tools = tools;

    // THE HONEST LOOP — "Adapter retries first" (see fail() in agent.ts).
    // Retryable-only: transport failures + HTTP 429/5xx. Everything else
    // (4xx, aborts, parse) throws on the first attempt. Retry STOPS when any
    // of these fires: attempt cap reached, budget spent, onRetry vetoes, abort
    // lands (even mid-backoff). The final throw carries `attempts` + the
    // terminal `elapsedMs` — errorFacts forwards both onto the `error` event.
    // `retries: Infinity` + no budget + no veto = retries forever; backoff
    // still paces each sleep so a dead provider never gets hammered.
    const maxAttempts = this.retries === Infinity ? Infinity : Math.max(1, Math.floor(this.retries) || 1);
    const budgetMs = this.retryBudgetMs;
    const startedAt = Date.now();
    let lastErr: unknown;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          // the abort controller — abort() reaches into the in-flight call
          signal: agent.abortSignal,
        });
        if (!res.ok) {
          throw await this.providerError(res);
        }
        if (this.stream && sink) {
          return await this.streamAndAssemble(res, sink, agent);
        }
        return await res.json();
      } catch (err) {
        lastErr = err;
        // abort = the loop's own kill signal — NEVER retried, thrown as-is.
        if (agent.abortSignal?.aborted) throw err;
        if (err instanceof Error && err.name === "AbortError") throw err;
        const stop = (error: unknown): never => {
          if (error instanceof Error) {
            const stamped = error as ProviderError;
            stamped.attempts = attempt;
            stamped.elapsedMs = Date.now() - startedAt;
          }
          throw error;
        };
        // retryable = our stamped provider errors (429/5xx) + raw transport
        // failures (fetch threw before a response existed = TypeError). 4xx is
        // permanent — auth/billing/shape — throws on the first attempt. A
        // mid-stream death retries too: the next attempt re-emits the stream
        // from scratch (a second streamStarted, no textEnd for the dead one).
        const tagged = err as { retryable?: unknown; status?: unknown } | null;
        const retryable =
          (typeof tagged?.retryable === "boolean" ? tagged.retryable : undefined) ??
          (typeof tagged?.status === "number" ? (tagged.status === 429 || tagged.status >= 500) : undefined) ??
          err instanceof TypeError;
        if (!retryable) stop(err);
        if (attempt >= maxAttempts) stop(err);
        // wall-clock budget: attempts + backoffs. Spent = throw NOW, no trailing sleep.
        const elapsedMs = Date.now() - startedAt;
        if (budgetMs !== undefined && (budgetMs <= 0 || elapsedMs >= budgetMs)) stop(err);
        // exponential backoff + jitter, capped by retryMaxDelayMs
        const waitMs = Math.min(this.retryMaxDelayMs, this.retryDelayMs * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2);
        // the hook runs BEFORE the sleep: observe, or veto (false/throw = stop).
        if (this.onRetry !== undefined) {
          let verdict: void | false;
          try {
            verdict = await this.onRetry({ attempt, error: err, elapsedMs, waitMs });
          } catch {
            stop(err); // the hook's own throw vetoes — the ORIGINAL error throws
            verdict = false; // unreachable (stop throws) — satisfies definite assignment
          }
          if (verdict === false) stop(err);
        }
        // abort-aware sleep: abort() mid-backoff throws the ORIGINAL error
        // immediately (no waiting out the timer, no AbortError swap — the
        // provider failure is the truth, the abort just ends the waiting).
        const signal = agent.abortSignal;
        if (signal?.aborted) throw err;
        // executor form, not Promise.withResolvers — target is ES2022 (see
        // shell-tool/bash.ts for the same call). Stored resolver: the abort
        // listener AND the timer release the same sleep.
        let release!: () => void;
        const backoff = new Promise<void>((res) => { release = res; });
        const timer = setTimeout(release, waitMs);
        if (signal !== undefined) {
          signal.addEventListener("abort", release, { once: true });
          await backoff;
          signal.removeEventListener("abort", release);
        } else {
          await backoff;
        }
        clearTimeout(timer);
        if (signal?.aborted) throw err;
      }
    }
    throw lastErr;
  }

  /** Build the informative provider error from a non-OK response. Own function
   * so subclasses (pi-ai) can reuse the shape without the fetch. */
  protected async providerError(res: Response): Promise<ProviderError> {
    // informative provider errors: model + endpoint + TRUNCATED body, plus
    // structured facts (code/status/retryable) forwarded verbatim by errorFacts.
    let bodyText: string;
    try {
      bodyText = await res.text();
    } catch {
      bodyText = "(body unavailable)";
    }
    const capped =
      bodyText.length > 400
        ? `${bodyText.slice(0, 400)}…[truncated, ${bodyText.length} chars total]`
        : bodyText;
    const perr: ProviderError = new Error(
      `[sanity] provider error ${res.status} for model "${this.modelId}" @ ${this.baseUrl ?? "https://api.openai.com/v1"}: ${capped}`,
    );
    perr.code = "provider_error";
    perr.status = res.status;
    perr.retryable = res.status >= 500 || res.status === 429;
    return perr;
  }

  /**
   * SSE streaming with FULL assembly: content + tool_calls both stream and
   * assemble; the batch runs only when the response is completely ready.
   * Cooperative abort: checks agent.abortSignal between chunks.
   */
  protected async streamAndAssemble(res: Response, sink: StreamSink, agent: GodObject): Promise<unknown> {
    sink.emit({ type: "streamStarted" });
    const reader = res.body?.getReader();
    if (!reader) return { choices: [] };

    const decoder = new TextDecoder();
    let buffer = "";
    let malformedChunks = 0;
    let content = "";
    let reasoning = "";
    let finishReason: string | undefined;
    let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
    const toolCalls: Record<number, { id: string; name: string; args: string }> = {};

    while (true) {
      if (agent.abortSignal?.aborted) break; // cooperative stop — "kill it now"
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") break;
        try {
          const chunk = JSON.parse(data);
          const choice = chunk?.choices?.[0];
          if (chunk?.usage) usage = chunk.usage;
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          const delta = choice?.delta;
          if (delta?.content) {
            content += delta.content;
            sink.emit({ type: "textDelta", delta: delta.content });
          }
          // Qwen/llama.cpp stream thinking as delta.reasoning_content; some
          // OpenAI-compatible endpoints use delta.reasoning / delta.reasoning_text.
          // Take the FIRST non-empty field — providers can send the same thinking
          // under two names (double-processing). Always emit it so the console
          // shows life; PRESERVING it is the preserveThinking flag's job.
          const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"] as const;
          const deltaRec = delta as Record<string, unknown>;
          const thinkingField = reasoningFields.find(
            (f) => typeof deltaRec[f] === "string" && (deltaRec[f] as string).length > 0,
          );
          if (thinkingField) {
            const rd = deltaRec[thinkingField] as string;
            reasoning += rd;
            sink.emit({ type: "textDelta", delta: rd });
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls as {
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }[]) {
              const slot = toolCalls[tc.index ?? 0] ?? { id: "", name: "", args: "" };
              if (tc.id) slot.id = tc.id;
              if (tc.function?.name) slot.name += tc.function.name;
              if (tc.function?.arguments) {
                slot.args += tc.function.arguments;
                sink.emit({ type: "toolcallDelta", delta: tc.function.arguments });
              }
              toolCalls[tc.index ?? 0] = slot;
            }
          }
        } catch {
          // skip malformed chunks (stream resilience) — but the operator should
          // know the stream is dirty: warn ONCE with the offending snippet,
          // count the rest silently so a chatty provider can't spam.
          malformedChunks++;
          if (malformedChunks === 1) {
            console.warn(
              `[sanity] bad SSE chunk from model "${this.modelId}" @ ${this.baseUrl ?? "https://api.openai.com/v1"}: ${data.slice(0, 120)}…`,
            );
          }
        }
      }
    }
    sink.emit({ type: "textEnd" });

    // assemble into a completion-shaped object parseResponse can consume
    const toolCallList = Object.values(toolCalls)
      .filter((tc) => tc.name)
      .map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.args } }));
    return {
      choices: [
        {
          message: {
            content: content || null,
            reasoning_content: reasoning || undefined,
            tool_calls: toolCallList.length ? toolCallList : undefined,
          },
          finish_reason: finishReason,
        },
      ],
      usage,
    };
  }

  // ==========================================================================
  // Response → our normal message
  // ==========================================================================
  protected parseResponse(response: unknown, inputMessages?: Message[]): TurnResult {
    const completion = response as {
      choices?: { message?: { content?: string | null; tool_calls?: unknown[]; reasoning_content?: string }; finish_reason?: string }[];
      // OpenAI standard: prompt_tokens (input), completion_tokens (output), total_tokens.
      // Pi-style providers / extensions can add cached_tokens, reasoning_tokens, ...
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cached_tokens?: number; reasoning_tokens?: number; cost?: number };
    };
    const choice = completion.choices?.[0];

    // ADAPTER RESPONSIBILITY (item 21.5): bad outcomes are ERRORS, not results.
    const finishReason = choice?.finish_reason;
    if (finishReason === "length" || finishReason === "content_filter") {
      // ADAPTER-AUTHORED FACTS — stamp structured facts on the throw; the core's
      // errorFacts() forwards them verbatim on the `error` event payload.
      const err = new Error(`[sanity] provider finished with bad reason: ${finishReason}`) as Error & { reason?: string; truncated?: boolean };
      err.reason = finishReason;
      if (finishReason === "length") err.truncated = true;
      throw err;
    }

    const content = choice?.message?.content ?? "";
    const toolCalls = choice?.message?.tool_calls;
    const reasoningContent = choice?.message?.reasoning_content;

    const message: ReasonedMessage = toolCalls?.length
      ? {
          id: `runtime-${crypto.randomUUID().slice(0, 8)}`,
          enabled: true,
          type: "toolCall",
          content: {
            answer: content,
            stored: this.parseToolCalls(toolCalls),
          },
          // thinking is preserved ONLY on demand — default: streamed then discarded
          ...(this.preserveThinking && reasoningContent ? { reasoningContent } : {}),
        }
      : {
          id: `runtime-${crypto.randomUUID().slice(0, 8)}`,
          enabled: true,
          type: "assistant",
          content: [{ type: "text", content }],
          ...(this.preserveThinking && reasoningContent ? { reasoningContent } : {}),
        };

    const usage = completion.usage;
    // NaN-guarded — some providers omit usage entirely.
    const promptTokens = usage?.prompt_tokens ?? estimateInputTokens(inputMessages ?? []);
    const completionTokens = usage?.completion_tokens ?? estimateOutputTokens(content);
    const totalTokens = usage?.total_tokens ?? promptTokens + completionTokens;
    const cachedTokens = usage?.cached_tokens ?? 0;
    const reasoningTokens = usage?.reasoning_tokens ?? (reasoningContent ? estimateOutputTokens(reasoningContent) : 0);
    return {
      message,
      stats: {
        // Pi-shape — universal. Providers that only know prompt_tokens/completion_tokens
        // still fit: input=prompt, output=completion, cacheRead=cached_tokens.
        input: promptTokens,
        output: completionTokens,
        cacheRead: cachedTokens,
        cacheWrite: 0,
        totalTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage?.cost ?? 0 },
        // Identity — chat_completions is what we are. Provider/model can be set by subclasses.
        api: this.api,
        provider: undefined,
        model: this.modelId,
        stopReason: finishReason ?? "stop",
        timestamp: Date.now(),
        // Open-index extras: reasoning tokens live here when not in the standard shape.
        ...(reasoningTokens ? { reasoningTokens } : {}),
      },
      stopReason: finishReason ?? "stop",
      raw: response,
    };
  }

  /** Parse tool call args — malformed args become preResolved error results. */
  protected parseToolCalls(toolCalls: unknown[]): ToolCallRecord[] {
    return toolCalls.map((tc: any) => {
      const id: string = tc.id ?? `call-${crypto.randomUUID().slice(0, 8)}`;
      const name: string = tc.function?.name ?? "unknown";
      try {
        return { id, type: "function", name, parameters: JSON.parse(tc.function?.arguments || "{}") };
      } catch (err) {
        // item 21.6: the model sees the parse error and repeats — never a turn-killer
        return {
          id,
          type: "function",
          name,
          parameters: {},
          preResolved: {
            answer: `Tool call "${name}" failed to parse its arguments: ${(err as Error).message}. Please re-issue the call with valid JSON arguments.`,
          },
        };
      }
    });
  }

  // ==========================================================================
  // Light transform — private, inside the class, never leaks
  // ==========================================================================
  protected toApiMessage(m: Message): unknown {
    // compound flavors are OUR dynamic-fragment convenience — on the wire they
    // collapse to their base type's normal role/shape (system-compound → system,
    // user-compound → user, …)
    const base = baseType(m.type);
    switch (base) {
      case "system":
      case "user":
        return { role: base, content: toWireContent(m.content) };
      case "assistant": {
        const reasoned = m as ReasonedMessage;
        const parts = toWireParts(m.content);
        return {
          role: "assistant",
          // pure text stays a string (llama.cpp/Qwen templates prefer it);
          // any media → multipart array
          content: parts.every((p) => p.type === "text") ? parts.map((p) => String(p.text ?? "")).join("\n") : parts,
          // replay thinking ONLY when preserveThinking is on and the message
          // actually carries it — default: the next request never sees it
          ...(this.preserveThinking && reasoned.reasoningContent
            ? { reasoning_content: reasoned.reasoningContent }
            : {}),
        };
      }
      case "assistant": {
        const reasoned = m as ReasonedMessage;
        return {
          role: "assistant",
          content: this.toText(m.content),
          // replay thinking ONLY when preserveThinking is on and the message
          // actually carries it — default: the next request never sees it
          ...(this.preserveThinking && reasoned.reasoningContent
            ? { reasoning_content: reasoned.reasoningContent }
            : {}),
        };
      }
      case "toolCall": {
        const face = m.content as { answer: string; stored: ToolCallRecord[] };
        // canonical stored shape { id, type, name, parameters } → OpenAI wire
        // shape { id, type, function: { name, arguments } } — arguments is a
        // JSON STRING. THE TRANSFORM owns this fuckery, the loop never sees it.
        const toolCalls = (face.stored ?? []).map((c) => ({
          id: c.id,
          type: c.type,
          function: { name: c.name, arguments: JSON.stringify(c.parameters ?? {}) },
        }));
        const reasoned = m as ReasonedMessage;
        return {
          role: "assistant",
          content: face.answer,
          tool_calls: toolCalls,
          ...(this.preserveThinking && reasoned.reasoningContent
            ? { reasoning_content: reasoned.reasoningContent }
            : {}),
        };
      }
      case "toolResult": {
        const face = m.content as ToolResultContent | null;
        const answer = face?.answer ?? "[tool failed catastrophically — no result produced]";
        // tool results ride the answer face; media blocks ride along when present
        const extra = face !== null && typeof face === "object" && "media" in face && Array.isArray((face as { media: unknown }).media) ? ((face as { media: unknown[] }).media ?? []) : [];
        const mediaParts = extra.map((b) => toWirePart(b)).filter((p) => p !== undefined);
        return {
          role: "tool",
          tool_call_id: (m as ToolResultMessage).toolCallId,
          // null content = catastrophic failure — feed the model a synthetic answer anyway
          content: mediaParts.length === 0 ? answer : [{ type: "text", text: answer }, ...mediaParts],
        };
      }
      default:
        // custom types collapse here (item 21.7) — the transform decides
        return { role: "user", content: this.toText(m.content) };
    }
  }

  protected toText(content: unknown): string {
    return toWireText(content);
  }
}
