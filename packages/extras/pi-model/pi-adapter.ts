// ============================================================================
// sanity/src/extras/model/pi-adapter.ts — PiAdapterModel
// ============================================================================
// THE cross-provider path (components.md #10). Same `callNextTurn` contract as
// SimpleModel; the ONLY difference at construction is `provider`. Underneath it
// calls the Pi SDK — `@earendil-works/pi-ai` from npm — which normalizes ~40
// providers (anthropic, google, mistral, deepseek, groq, openrouter, ...) into
// ONE event stream. `prepareMessages` is STILL the seam.
//
//   callNextTurn(agent)
//     ├── prepareMessages(agent.messages)   ← OVERRIDE THIS (pi-ai Context)
//     ├── THE CALL                        ← pi-ai: provider.stream(model, agent)
//     │     → text_delta / toolcall_delta → our stream deltas
//     └── return the normal message       ← what the runtime expects, always
//
// Swap SimpleModel ↔ PiAdapterModel at runtime, nothing else moves.
// Adapter responsibility (item 21.5): a bad outcome (length / error / aborted)
// is an ERROR, not a result.
// ============================================================================
// heavy pi-ai values load LAZILY inside callApi (see below) so installing
// @sanityloop/extras never pulls pi-ai; type imports stay static (erased).
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context as PiContext,
	Message as PiMessage,
	ToolCall,
} from "@earendil-works/pi-ai";
import type {
  GodObject,
  Message,
  StreamSink,
  ToolResultContent,
  ToolResultMessage,
  TurnResult,
} from "@sanityloop/core";
import type { ToolCallRecord } from "@sanityloop/core";
import { SimpleModel } from "@sanityloop/core";

export interface PiAdapterModelOptions {
	/** pi-ai provider id: "anthropic", "openai", "google", "mistral", "deepseek", "groq", ... */
	provider: string;
	modelId: string;
	/** Explicit key — falls back to the provider's env var (OPENAI_API_KEY, ANTHROPIC_API_KEY, ...). */
	apiKey?: string;
	/** Override the endpoint (e.g. llama.cpp at http://localhost:58080/v1). */
	baseUrl?: string;
	stream?: boolean;
	temperature?: number;
	maxTokens?: number;
	/** The context window — the compaction trigger reads this. */
	maxContext?: number;
}

/** The cross-provider model — pi-ai guts, SimpleModel contract. */
export class PiAdapterModel extends SimpleModel {
	/** pi-ai provider id. */
	provider: string;

	constructor(opts: PiAdapterModelOptions) {
		super({
			modelId: opts.modelId,
			apiKey: opts.apiKey,
			baseUrl: opts.baseUrl,
			stream: opts.stream ?? true,
			temperature: opts.temperature,
			maxOutputTokens: opts.maxTokens,
			maxContext: opts.maxContext,
		});
		this.provider = opts.provider;
		// informational only — the loop never interprets `api`
		this.api = opts.provider;
	}

	// ==========================================================================
	// THE function the runtime calls — pi-ai needs agent.tools inside the Context,
	// so this override assembles the full Context (seam + tools) and calls down.
	// ==========================================================================
	override async callNextTurn(agent: GodObject): Promise<TurnResult> {
		const base = this.prepareMessages(agent.messages) as PiContext;
		const context: PiContext = {
			...base,
			// visibleTools() = the wire list — hidden tools stay callable but never reach context
			tools: this.toolsToPi(agent.visibleTools()),
		};
		const response = await this.callApi(context, agent.streamSink, agent);
		return this.parseResponse(response);
	}

	// ==========================================================================
	// The seam — OVERRIDE THIS for adjustments.
	// Returns a pi-ai Context: systemPrompt + messages.
	// ==========================================================================
	override prepareMessages(messages: Message[]): PiContext {
		const systemParts: string[] = [];
		const piMessages: PiMessage[] = [];

		for (const m of messages) {
			if (!m.enabled) continue;
			switch (m.type) {
				case "system":
					systemParts.push(this.toText(m.content));
					break;
				case "user":
					piMessages.push({
						role: "user",
						content: this.toText(m.content),
						timestamp: Date.now(),
					});
					break;
				case "assistant": {
					const text = this.toText(m.content);
					piMessages.push({
						role: "assistant",
						content: text ? [{ type: "text", text }] : [],
						api: this.api,
						provider: this.provider,
						model: this.modelId,
						stopReason: "stop",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0,
							},
						},
						timestamp: Date.now(),
					});
					break;
				}
				case "toolCall": {
					const face = m.content as {
						answer: string;
						stored: ToolCallRecord[];
					};
					const calls: ToolCall[] = (face.stored ?? []).map((c) => ({
						type: "toolCall",
						id: c.id,
						name: c.name,
						arguments: (c.parameters ?? {}) as Record<string, unknown>,
					}));
					const text = face.answer;
					const content = [
						...(text ? [{ type: "text" as const, text }] : []),
						...calls,
					];
					piMessages.push({
						role: "assistant",
						content,
						api: this.api,
						provider: this.provider,
						model: this.modelId,
						stopReason: "toolUse",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0,
							},
						},
						timestamp: Date.now(),
					});
					break;
				}
        case "toolResult": {
          const face = m.content as ToolResultContent | null;
          piMessages.push({
            role: "toolResult",
            toolCallId: (m as ToolResultMessage).toolCallId ?? "",
            toolName: (m as ToolResultMessage).toolName ?? "unknown",
            content: [{ type: "text", text: face?.answer ?? "[tool failed catastrophically — no result produced]" }],
            isError: face ? face.error === true : true,
						timestamp: Date.now(),
					});
					break;
				}
				default:
					// custom types collapse here (item 21.7) — the transform decides
					piMessages.push({
						role: "user",
						content: this.toText(m.content),
						timestamp: Date.now(),
					});
			}
		}

		return {
			systemPrompt: systemParts.join("\n\n") || undefined,
			messages: piMessages,
		};
	}

	// ==========================================================================
	// The guts — swap raw fetch for the Pi SDK. One function, the whole world.
	// ==========================================================================
	protected override async callApi(
		apiMessages: unknown,
		sink: StreamSink | undefined,
		agent: GodObject,
	): Promise<unknown> {
		const context = apiMessages as PiContext;

		// lazy-optional: pi-ai loads ONLY when this model is actually used.
		// @sanityloop/extras ships zero deps; this subpath declares its need.
		let piSdk: typeof import("@earendil-works/pi-ai");
		let piAll: typeof import("@earendil-works/pi-ai/providers/all");
		try {
			piSdk = await import("@earendil-works/pi-ai");
			piAll = await import("@earendil-works/pi-ai/providers/all");
		} catch (err) {
			throw new Error(
				'[sanity] pi-model: this subpath needs "@earendil-works/pi-ai", which is not installed. Run: npm i @earendil-works/pi-ai',
				{ cause: err },
			);
		}

		// resolve the provider + the model from pi-ai's builtin catalog
		const provider = piAll.builtinProviders().find((p) => p.id === this.provider);
		if (!provider)
			throw new Error(
				`[sanity] pi-adapter: unknown provider "${this.provider}"`,
			);
		const model = piAll.getBuiltinModel(
			this.provider as never,
			this.modelId as never,
		);
		if (!model)
			throw new Error(
				`[sanity] pi-adapter: unknown model "${this.modelId}" for provider "${this.provider}"`,
			);

		// baseUrl override rides on the model (the documented pi pattern)
		const requestModel = this.baseUrl
			? { ...model, baseUrl: this.baseUrl }
			: model;
		const stream = piSdk.lazyStream(requestModel as never, async () =>
			(
				provider.stream as (
					m: unknown,
					c: PiContext,
					o: Record<string, unknown>,
				) => AssistantMessageEventStream
			)(requestModel, context, {
				apiKey: this.apiKey ?? resolveEnvKey(this.provider),
				signal: agent.abortSignal,
				temperature: this.temperature,
				maxTokens: this.maxOutputTokens,
			}),
		);

		const final = await consumePiStream(
			stream,
			sink,
			agent,
			this.provider,
			this.modelId,
		);
		return final; // AssistantMessage → parseResponse
	}

	// ==========================================================================
	// AssistantMessage → our normal message
	// ==========================================================================
	protected override parseResponse(response: unknown): TurnResult {
		const msg = response as AssistantMessage;

		// ADAPTER RESPONSIBILITY (item 21.5): bad outcomes are ERRORS, not results.
		if (msg.stopReason === "length") {
			// structured facts for errorFacts parity with SimpleModel (truncated/reason)
			const err = new Error(
				`[sanity] pi-adapter: provider finished with bad reason: length`,
			) as Error & { reason?: string; truncated?: boolean };
			err.reason = "length";
			err.truncated = true;
			throw err;
		}
		if (msg.stopReason === "error" || msg.stopReason === "aborted") {
			// structured facts for errorFacts parity with SimpleModel (code/reason)
			const err = new Error(
				`[sanity] pi-adapter: ${msg.errorMessage ?? msg.stopReason}`,
			) as Error & { code?: string; reason?: string };
			err.code = "provider_error";
			err.reason = msg.stopReason;
			throw err;
		}

		const text = msg.content
			.filter(
				(b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
			)
			.map((b) => b.text)
			.join("");
		const calls = msg.content.filter(
			(b): b is ToolCall => b.type === "toolCall",
		);

		const message: Message = calls.length
			? {
					id: `runtime-${crypto.randomUUID().slice(0, 8)}`,
					enabled: true,
					type: "toolCall",
					content: {
						answer: text,
						stored: calls.map((c) => ({
							id: c.id,
							type: "function",
							name: c.name,
							parameters: c.arguments,
						})),
					},
				}
			: {
					id: `runtime-${crypto.randomUUID().slice(0, 8)}`,
					enabled: true,
					type: "assistant",
					content: [{ type: "text", content: text }],
				};

		const usage = msg.usage;
		const inputTokens = usage?.input ?? 0;
		const outputTokens = usage?.output ?? 0;
		const cacheRead = usage?.cacheRead ?? 0;
		const cacheWrite = usage?.cacheWrite ?? 0;
		return {
			message,
			stats: {
				// Pi-shape — same shape pi-ai uses, just flattened into MessageStats.
				input: inputTokens,
				output: outputTokens,
				cacheRead,
				cacheWrite,
				totalTokens: usage?.totalTokens ?? inputTokens + outputTokens + cacheRead + cacheWrite,
				cost: {
					input: usage?.cost?.input ?? 0,
					output: usage?.cost?.output ?? 0,
					cacheRead: usage?.cost?.cacheRead ?? 0,
					cacheWrite: usage?.cost?.cacheWrite ?? 0,
					total: usage?.cost?.total ?? 0,
				},
				// Identity — which provider + model actually answered.
				api: this.api,
				provider: this.provider,
				model: this.modelId,
				stopReason: msg.stopReason === "toolUse" ? "tool_calls" : "stop",
				timestamp: Date.now(),
			},
			stopReason: msg.stopReason === "toolUse" ? "tool_calls" : "stop",
			raw: response,
		};
	}

	/** Our Tool[] → pi-ai Tool[] (TypeBox schema slot — cast: plain JSON schema serializes fine). */
	private toolsToPi(tools: GodObject["tools"]): PiContext["tools"] {
		return tools.map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.inputSchema as never,
		}));
	}
}

/** Consume pi-ai's event stream → forward deltas → return the final AssistantMessage. */
async function consumePiStream(
	stream: AssistantMessageEventStream,
	sink: StreamSink | undefined,
	agent: GodObject,
	provider: string,
	modelId: string,
): Promise<AssistantMessage> {
	sink?.emit({ type: "streamStarted" });
	let final: AssistantMessage | undefined;

	for await (const ev of stream) {
		if (agent.abortSignal?.aborted) break; // cooperative stop — "kill it now"
		switch (ev.type) {
			case "text_delta":
				sink?.emit({ type: "textDelta", delta: ev.delta });
				break;
			case "thinking_delta":
				sink?.emit({ type: "thinkingDelta", delta: ev.delta });
				break;
			case "toolcall_delta":
				sink?.emit({ type: "toolcallDelta", delta: ev.delta });
				break;
			case "done":
				final = ev.message;
				break;
			case "error":
				throw new Error(
					`[sanity] pi-adapter: ${ev.error.errorMessage ?? ev.error.stopReason} (${provider}/${modelId})`,
				);
			default:
				break; // start / *_start / *_end — nothing to forward
		}
	}

	sink?.emit({ type: "textEnd" });
	if (!final)
		throw new Error(
			`[sanity] pi-adapter: stream ended without a result (${provider}/${modelId})`,
		);
	return final;
}

/** Known provider → env var candidates, in priority order (pi-ai's env-api-keys, distilled). */
const ENV_KEYS: Record<string, string[]> = {
	anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
	openai: ["OPENAI_API_KEY"],
	google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
	mistral: ["MISTRAL_API_KEY"],
	deepseek: ["DEEPSEEK_API_KEY"],
	groq: ["GROQ_API_KEY"],
	xai: ["XAI_API_KEY"],
	openrouter: ["OPENROUTER_API_KEY"],
	cerebras: ["CEREBRAS_API_KEY"],
	fireworks: ["FIREWORKS_API_KEY"],
	together: ["TOGETHER_API_KEY"],
	nvidia: ["NVIDIA_API_KEY"],
};

/** Resolve the provider's API key from the environment (or undefined). */
function resolveEnvKey(provider: string): string | undefined {
	const env = (globalThis as { process?: { env?: Record<string, string> } })
		.process?.env;
	const candidates = ENV_KEYS[provider] ?? [
		`${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`,
	];
	for (const key of candidates) {
		const value = env?.[key];
		if (value) return value;
	}
	return undefined;
}
