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
// messages / dangling toolCalls / a trailing assistant. Applied right before
// the provider call (SimpleModelOptions.normalizeMessages), and shared with the
// compaction extras so rebuilt STORED lists stay legal too. Cross-provider
// adapters (PiAdapterModel) shape messages their own way and override
// callNextTurn — they never pass through here. Idempotent: running it twice
// is safe.
// ============================================================================

/**
 * Enforce strict role alternation on a message list. Rules:
 *  - a toolCall is kept only with its matching toolResult(s) immediately after
 *  - orphaned toolResults (no preceding toolCall) are dropped
 *  - consecutive same-role user/assistant messages collapse (earlier dropped)
 *  - the list must NOT end with an assistant or a dangling toolCall (the
 *    resumed turn's response will follow)
 */
export function normalizeForAlternation(list: Message[]): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (m.type === "system") {
      out.push(m);
      continue;
    }
    if (m.type === "toolCall") {
      const callIds = new Set(((m.content as { stored?: { id?: string }[] }).stored ?? []).map((c) => c.id));
      const results: Message[] = [];
      let j = i + 1;
      while (j < list.length && list[j].type === "toolResult") {
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
      continue; // dangling toolCall (no matching result) → dropped
    }
    if (m.type === "toolResult") continue; // orphaned result → dropped

    const last = out[out.length - 1];
    if (last && last.type === m.type) out.pop(); // collapse consecutive same-role
    out.push(m);
  }
  // end must be non-assistant so the resumed turn's response is legal
  while (out.length > 0 && (out[out.length - 1].type === "assistant" || out[out.length - 1].type === "toolCall")) {
    out.pop();
  }
  return out;
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
   * call. Default: normalizeForAlternation (strict role alternation — llama.cpp
   * 400s on consecutive same-role / trailing assistant). Pass (m) => m to
   * disable. The strategy is the SIMPLE model's own concern — cross-provider
   * adapters (PiAdapterModel) shape messages their own way and override
   * callNextTurn, so they never pass through here.
   */
  normalizeMessages?: (messages: Message[]) => Message[];
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
    // tools travel with the request — the model can actually call them now
    const tools = (agent.tools ?? []).map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
    if (tools.length > 0) body.tools = tools;

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
      const perr = new Error(
        `[sanity] provider error ${res.status} for model "${this.modelId}" @ ${this.baseUrl ?? "https://api.openai.com/v1"}: ${capped}`,
      ) as Error & { code?: string; status?: number; retryable?: boolean };
      perr.code = "provider_error";
      perr.status = res.status;
      perr.retryable = res.status >= 500 || res.status === 429;
      throw perr;
    }

    if (this.stream && sink) {
      return this.streamAndAssemble(res, sink, agent);
    }
    return res.json();
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
      choices?: { message?: { content?: string | null; tool_calls?: unknown[] }; finish_reason?: string }[];
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

    const message: Message = toolCalls?.length
      ? {
          id: `runtime-${crypto.randomUUID().slice(0, 8)}`,
          enabled: true,
          type: "toolCall",
          content: {
            answer: content,
            stored: this.parseToolCalls(toolCalls),
          },
        }
      : {
          id: `runtime-${crypto.randomUUID().slice(0, 8)}`,
          enabled: true,
          type: "assistant",
          content: [{ type: "text", content }],
        };

    const usage = completion.usage;
    // NaN-guarded — some providers omit usage entirely.
    const promptTokens = usage?.prompt_tokens ?? estimateInputTokens(inputMessages ?? []);
    const completionTokens = usage?.completion_tokens ?? estimateOutputTokens(content);
    const totalTokens = usage?.total_tokens ?? promptTokens + completionTokens;
    const cachedTokens = usage?.cached_tokens ?? 0;
    const reasoningTokens = usage?.reasoning_tokens ?? 0;
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
    switch (m.type) {
      case "system":
      case "user":
      case "assistant":
        return { role: m.type, content: this.toText(m.content) };
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
        return { role: "assistant", content: face.answer, tool_calls: toolCalls };
      }
      case "toolResult": {
        const face = m.content as ToolResultContent | null;
        return {
          role: "tool",
          tool_call_id: (m as ToolResultMessage).toolCallId,
          // null content = catastrophic failure — feed the model a synthetic answer anyway
          content: face?.answer ?? "[tool failed catastrophically — no result produced]",
        };
      }
      default:
        // custom types collapse here (item 21.7) — the transform decides
        return { role: "user", content: this.toText(m.content) };
    }
  }

  protected toText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((b) => (typeof b === "object" && b !== null && "content" in b ? String((b as { content: unknown }).content) : ""))
        .join("\n");
    }
    if (typeof content === "object" && content !== null && "answer" in content) {
      return String((content as { answer: unknown }).answer);
    }
    return String(content ?? "");
  }
}
