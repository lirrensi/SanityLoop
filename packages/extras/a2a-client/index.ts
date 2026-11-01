// ============================================================================
// @sanityloop/a2a-client — client-only A2A adapter (outbound tools, no server)
// ============================================================================
// Our agents call REMOTE A2A agents as tools, with taskId+contextId threading
// so multi-turn conversations keep working. Scope is CLIENT ONLY: no AgentCard
// endpoint, no inbound routes, nothing listens.
//
// Lifecycle (mirrors extras/mcp):
//
//   const a2a = createA2aClient({              // 1. declare — sync, no I/O
//     agents: { researcher: { url: "https://remote/agent" } },
//   });
//   await a2a.init();                          // 2. fetch cards — the ONLY await.
//                                              //    Per-agent failure degrades to
//                                              //    status, never throws init.
//   agent.install(a2a.getPlugin());            // 3. insert the READY tool list.
//
// Per agent TWO tools land: `a2a_<key>_send` (new/continued message, blocking)
// and `a2a_<key>_cancel` (cancel a live task). getTask is NOT a tool — the
// blocking sendMessage already waits until terminal or interrupted.
//
// The @a2a-js/sdk runtime loads LAZILY inside init()/execute (same pattern as
// mcp/index.ts lazy Client import), so unit tests and type checks never touch
// the network or the real SDK. Tests inject fake clients through the
// documented `deps.createClient` seam on createA2aClient.
// ============================================================================
import { randomUUID } from "node:crypto";
import type {
	GodObject,
	JsonSchema,
	Plugin,
	ToolResult,
	ToolType,
} from "@sanityloop/core";

/** Auth for one remote agent. */
export interface A2aAuthConfig {
	bearer?: string;
	apiKey?: {
		name: string;
		value: string;
		location?: "header" | "query" | "cookie";
	};
}

/** One remote agent declaration. */
export interface A2aAgentConfig {
	url: string;
	auth?: A2aAuthConfig;
	preferredTransports?: ("JSONRPC" | "HTTP+JSON")[];
	timeoutMs?: number;
}

/** The declaration object: agent key → config. */
export interface A2aClientConfig {
	agents: Record<string, A2aAgentConfig>;
	preferredTransports?: ("JSONRPC" | "HTTP+JSON")[];
	timeoutMs?: number;
}

export type A2aAgentStatus =
	| { status: "ready"; tools: string[]; card?: A2aCardSummary }
	| { status: "failed"; error: string };

export interface A2aCardSummary {
	name: string;
	description: string;
	url: string;
	skills: { name: string; description?: string }[];
}

/** Minimal structural view of an A2A part (proto oneof JSON shape). */
export interface A2aPart {
	content?: { $case: string; value?: unknown };
	metadata?: unknown;
	filename?: string;
	mediaType?: string;
	// legacy/loose shapes tolerated by flattenParts:
	type?: string;
	text?: unknown;
	data?: unknown;
	uri?: unknown;
	url?: unknown;
}

export interface A2aMessage {
	messageId: string;
	/** "user" in fakes/tests; execute() swaps in numeric Role.ROLE_USER for the real wire. */
	role: string | number;
	parts: A2aPart[];
	taskId?: string;
	contextId?: string;
}

export interface A2aTaskStatus {
	/** String in fakes/tests; numeric TaskState enum from the real SDK. */
	state: string | number;
	message?: { parts?: A2aPart[] };
}

export interface A2aTask {
	id: string;
	contextId: string;
	status: A2aTaskStatus;
	artifacts?: { parts?: A2aPart[] }[];
	history?: A2aMessage[];
}

export type A2aSendResult = A2aTask | A2aMessage;

/** The slice of the SDK Client we actually use — also the fake seam. */
export interface A2aClientLike {
	sendMessage(
		params: Record<string, unknown>,
		options?: { signal?: AbortSignal },
	): Promise<A2aSendResult>;
	cancelTask(
		params: Record<string, unknown>,
		options?: { signal?: AbortSignal },
	): Promise<A2aTask>;
}

/** Test seam: override how SDK clients are constructed (no network). */
export interface A2aClientDeps {
	createClient?: (
		url: string,
		opts: {
			headers: Record<string, string>;
			query: Record<string, string>;
			preferredTransports?: ("JSONRPC" | "HTTP+JSON")[];
		},
	) => Promise<{ client: A2aClientLike; card?: A2aCardSummary }>;
}

const DEFAULT_TIMEOUT = 30_000;
const CAPABILITY_ID = "a2a-client";
const CONTINUE_STATES: Record<string, true> = {
	INPUT_REQUIRED: true,
	AUTH_REQUIRED: true,
	TASK_STATE_INPUT_REQUIRED: true,
	TASK_STATE_AUTH_REQUIRED: true,
};

function sanitize(name: string): string {
	return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

function sendToolName(key: string): string {
	return `a2a_${sanitize(key)}_send`;
}

function cancelToolName(key: string): string {
	return `a2a_${sanitize(key)}_cancel`;
}

/** Task-shaped (has .status) vs bare Message — mirrors `'status' in result`. */
export function isTaskResult(result: A2aSendResult): result is A2aTask {
	return (
		typeof result === "object" &&
		result !== null &&
		"status" in result &&
		typeof (result as A2aTask).status === "object"
	);
}

/** One part → one text line. Unknown shapes degrade to JSON, never throw. */
export function flattenPart(part: A2aPart): string {
	const content = part.content;
	if (content && typeof content.$case === "string") {
		switch (content.$case) {
			case "text":
				return typeof content.value === "string"
					? content.value
					: JSON.stringify(content.value);
			case "data":
				return JSON.stringify(content.value);
			case "file":
			case "url": {
				const v = content.value as
					| string
					| { uri?: unknown; url?: unknown; name?: unknown }
					| undefined;
				const u =
					typeof v === "string"
						? v
						: String(v?.uri ?? v?.url ?? v?.name ?? "");
				return `file: ${u} (${part.mediaType ?? "application/octet-stream"})`;
			}
			case "bytes":
			case "raw":
				return `[binary ${part.mediaType ?? "application/octet-stream"} ${part.filename ?? "unnamed"}]`;
			default:
				return JSON.stringify(content.value);
		}
	}
	// loose/legacy shapes
	if (typeof part.text === "string") return part.text;
	if (part.type === "text" && typeof part.text === "string") return part.text;
	if (part.data !== undefined) return JSON.stringify(part.data);
	if (typeof part.uri === "string" || typeof part.url === "string")
		return `file: ${part.uri ?? part.url} (${part.mediaType ?? "application/octet-stream"})`;
	return JSON.stringify(part);
}

export function flattenParts(parts: A2aPart[] | undefined): string {
	if (!parts || parts.length === 0) return "";
	return parts.map(flattenPart).join("\n");
}

/**
 * Build the outbound user message. Fresh messageId every call; supplied ids
 * are echoed verbatim (continuation), empty ids stay undefined (brand-new
 * task). Proto required-but-emptyable props are present as undefined literals.
 * role stays the "user" string here; execute() swaps in the numeric Role
 * enum the real wire needs ("user" would encode UNRECOGNIZED).
 */
export function buildUserMessage(args: {
	prompt: string;
	contextTaskId?: string;
	contextId?: string;
}): A2aMessage {
	const taskId =
		args.contextTaskId && args.contextTaskId.length > 0
			? args.contextTaskId
			: undefined;
	const contextId =
		args.contextId && args.contextId.length > 0 ? args.contextId : undefined;
	return {
		messageId: randomUUID(),
		role: "user",
		parts: [
			{
				content: { $case: "text", value: args.prompt },
				metadata: undefined,
				filename: "",
				mediaType: "text/plain",
			},
		],
		taskId,
		contextId,
		metadata: undefined,
	} as A2aMessage;
}

/**
 * A2A errors → `ClassName: reason (code X)`. Brand matching (constructor
 * name), never `err.code` — the SDK surfaces envelope/status codes on
 * differently-shaped fields, so we probe the known ones.
 */
export function a2aErrorText(err: unknown): string {
	const rec = (err ?? {}) as Record<string, unknown>;
	const ctor = (err as { constructor?: { name?: unknown } } | null)
		?.constructor?.name;
	const ctorName = typeof ctor === "string" ? ctor : "";
	// The SDK sets a semantic own `name` (e.g. TaskNotFoundError) while the
	// constructor carries the transport twin (JsonRpcTaskNotFoundError), so the
	// own name wins when present; plain-Error subclasses fall back to ctor.
	const ownName =
		Object.prototype.hasOwnProperty.call(rec, "name") &&
		typeof rec["name"] === "string"
			? (rec["name"] as string)
			: "";
	const genericCtor =
		ctorName === "" || ctorName === "Object" || ctorName === "Error";
	const name =
		ownName ||
		(!genericCtor && ctorName) ||
		(typeof rec["name"] === "string" && rec["name"]) ||
		ctorName ||
		"A2AError";
	const reason =
		err instanceof Error
			? err.message
			: typeof rec["message"] === "string"
				? rec["message"]
				: String(err);
	const envelope = rec["envelope"] as Record<string, unknown> | undefined;
	const code =
		rec["envelopeCode"] ??
		rec["statusCode"] ??
		rec["status"] ??
		envelope?.["code"] ??
		(rec["error"] as Record<string, unknown> | undefined)?.["code"];
	return code === undefined || code === null
		? `${name}: ${reason}`
		: `${name}: ${reason} (code ${String(code)})`;
}

function authHeaders(auth?: A2aAuthConfig): {
	headers: Record<string, string>;
	query: Record<string, string>;
} {
	const headers: Record<string, string> = {};
	const query: Record<string, string> = {};
	if (!auth) return { headers, query };
	if (auth.bearer) headers["Authorization"] = `Bearer ${auth.bearer}`;
	const apiKey = auth.apiKey;
	if (apiKey) {
		const location = apiKey.location ?? "header";
		if (location === "header") headers[apiKey.name] = apiKey.value;
		else if (location === "cookie")
			headers["Cookie"] = `${apiKey.name}=${apiKey.value}`;
		else query[apiKey.name] = apiKey.value;
	}
	return { headers, query };
}

/** TASK_STATE_* fallback if the SDK enum is unreachable (fakes / no SDK). */
const FALLBACK_NUMERIC_STATES: Record<number, string> = {
	0: "TASK_STATE_UNSPECIFIED",
	1: "TASK_STATE_SUBMITTED",
	2: "TASK_STATE_WORKING",
	3: "TASK_STATE_COMPLETED",
	4: "TASK_STATE_FAILED",
	5: "TASK_STATE_CANCELED",
	6: "TASK_STATE_INPUT_REQUIRED",
	7: "TASK_STATE_REJECTED",
	8: "TASK_STATE_AUTH_REQUIRED",
};

/** Numeric TaskState reverse-lookup, filled lazily from the real SDK. */
let cachedNumericStates: Record<number, string> | undefined;

async function numericStateNames(): Promise<Record<number, string>> {
	if (!cachedNumericStates) {
		let names = { ...FALLBACK_NUMERIC_STATES };
		try {
			const { TaskState } = await import("@a2a-js/sdk");
			const fromSdk: Record<number, string> = {};
			for (const [k, v] of Object.entries(
				TaskState as unknown as Record<string, unknown>,
			)) {
				if (typeof v === "number") fromSdk[v] = k;
			}
			names = { ...names, ...fromSdk };
		} catch {
			// fakes or missing SDK — the fallback map stands.
		}
		cachedNumericStates = names;
	}
	return cachedNumericStates;
}

/**
 * State display name: strings (tests/fakes) pass through untouched;
 * real-SDK numeric TaskState enums resolve to TASK_STATE_* names.
 */
async function displayTaskState(state: unknown): Promise<string> {
	if (typeof state === "string") return state;
	if (typeof state === "number")
		return (await numericStateNames())[state] ?? String(state);
	return String(state);
}

/** Numeric Role.ROLE_USER for the real wire, resolved lazily. */
let cachedUserRole: number | undefined;

async function userRoleValue(): Promise<number> {
	if (cachedUserRole === undefined) {
		try {
			const { Role } = await import("@a2a-js/sdk");
			const v: unknown = (Role as unknown as Record<string, unknown>)[
				"ROLE_USER"
			];
			cachedUserRole = typeof v === "number" ? v : 1;
		} catch {
			cachedUserRole = 1;
		}
	}
	return cachedUserRole;
}

/** Default client construction — the ONLY place that touches the real SDK. */
async function defaultCreateClient(
	url: string,
	opts: {
		headers: Record<string, string>;
		query: Record<string, string>;
		preferredTransports?: ("JSONRPC" | "HTTP+JSON")[];
	},
): Promise<{ client: A2aClientLike; card?: A2aCardSummary }> {
	// Structural view of the SDK client module — cast from unknown because the
	// real classes carry wider constructor signatures than this seam needs.
	// Lazy dynamic import (not static): the SDK loads ONLY when a connect
	// actually happens, so unit tests and type checks never touch it.
	interface SdkClientShape {
		getAgentCard(): Promise<unknown>;
	}
	interface SdkClientFactoryShape {
		createFromUrl(url: string, path?: string): Promise<SdkClientShape>;
	}
	interface SdkClientModuleShape {
		ClientFactory: new (options: unknown) => SdkClientFactoryShape;
		JsonRpcTransportFactory: new (options: unknown) => unknown;
		RestTransportFactory: new (options: unknown) => unknown;
		DefaultAgentCardResolver: new (options: unknown) => unknown;
	}
	let sdk: SdkClientModuleShape;
	try {
		sdk = (await import("@a2a-js/sdk/client")) as unknown as SdkClientModuleShape;
	} catch (err) {
		throw new Error(
			'[sanity] a2a-client: this brick needs "@a2a-js/sdk", which is not installed. Run: npm i @a2a-js/sdk',
			{ cause: err },
		);
	}
	// Auth headers ride a fetch wrapper plumbed through the transport
	// factories (and the card resolver) — createFromUrl takes no fetch option.
	const fetchImpl = (async (input: unknown, init?: RequestInit) => {
		const merged = new Headers(init?.headers);
		for (const [k, v] of Object.entries(opts.headers)) merged.set(k, v);
		return fetch(input as URL | RequestInfo, { ...init, headers: merged });
	}) as typeof fetch;
	const target =
		Object.keys(opts.query).length > 0
			? `${url}${url.includes("?") ? "&" : "?"}${new URLSearchParams(opts.query).toString()}`
			: url;
	const factory = new sdk.ClientFactory({
		transports: [
			new sdk.JsonRpcTransportFactory({ fetchImpl }),
			new sdk.RestTransportFactory({ fetchImpl }),
		],
		preferredTransports: opts.preferredTransports,
		cardResolver: new sdk.DefaultAgentCardResolver({ fetchImpl }),
	});
	const client = await factory.createFromUrl(target);
	let card: A2aCardSummary | undefined;
	try {
		const rawCard = (await client.getAgentCard()) as unknown as Record<
			string,
			unknown
		>;
		const skills = Array.isArray(rawCard["skills"])
			? (rawCard["skills"] as Record<string, unknown>[]).map((s) => ({
					name: typeof s["name"] === "string" ? s["name"] : "unnamed",
					description:
						typeof s["description"] === "string" ? s["description"] : undefined,
				}))
			: [];
		card = {
			name: typeof rawCard["name"] === "string" ? rawCard["name"] : url,
			description:
				typeof rawCard["description"] === "string" ? rawCard["description"] : "",
			url,
			skills,
		};
	} catch {
		// Card unreadable — the client still works; tools use degraded text.
		card = undefined;
	}
	return {
		client: client as unknown as A2aClientLike,
		...(card ? { card } : {}),
	};
}

function describeAgent(key: string, card: A2aCardSummary | undefined): string {
	if (!card)
		return (
			`Send a message to the remote A2A agent "${key}". ` +
			`Its agent card could not be fetched, so calls will report the stored connection error. ` +
			`Pass prompt plus the contextTaskId/contextId from a previous answer to continue a conversation.`
		);
	const skills = card.skills.slice(0, 3).map((s) => s.name);
	const skillBit =
		skills.length > 0 ? ` Skills: ${skills.join(", ")}.` : "";
	return (
		`Send a message to the remote A2A agent "${card.name}" at ${card.url}. ` +
		`${card.description}${skillBit} ` +
		`Pass prompt plus the contextTaskId/contextId from a previous answer to continue a conversation.`
	);
}

interface AgentRuntime {
	key: string;
	cfg: A2aAgentConfig;
	status: A2aAgentStatus;
	client?: A2aClientLike;
	card?: A2aCardSummary;
	tools: ToolType[];
}

const sendSchema: JsonSchema = {
	type: "object",
	properties: {
		prompt: { type: "string", description: "The message to send." },
		contextTaskId: {
			type: "string",
			description:
				"Task id from a previous answer to continue that task. Omit/empty for a brand-new task.",
		},
		contextId: {
			type: "string",
			description:
				"Context id from a previous answer to stay in the same conversation. Omit/empty for a brand-new task.",
		},
	},
	required: ["prompt"],
	additionalProperties: false,
};

const cancelSchema: JsonSchema = {
	type: "object",
	properties: {
		taskId: {
			type: "string",
			description: "The task id to cancel (from a previous send answer).",
		},
	},
	required: ["taskId"],
	additionalProperties: false,
};

function toSendTool(agent: AgentRuntime, timeoutMs: number): ToolType {
	const key = agent.key;
	return {
		name: sendToolName(key),
		description: describeAgent(key, agent.card),
		inputSchema: sendSchema,
		execute: async (params: unknown): Promise<ToolResult> => {
			const p = (params ?? {}) as {
				prompt?: unknown;
				contextTaskId?: unknown;
				contextId?: unknown;
			};
			const prompt = typeof p.prompt === "string" ? p.prompt : "";
			const contextTaskId =
				typeof p.contextTaskId === "string" ? p.contextTaskId : "";
			const contextId = typeof p.contextId === "string" ? p.contextId : "";
			if (!agent.client) {
				const reason =
					agent.status.status === "failed"
						? agent.status.error
						: "not connected";
				return {
					answer: `a2a agent "${key}" is not connected: ${reason}.`,
					stored: {
						agent: key,
						taskId: "",
						contextId: "",
						taskState: "failed",
						artifacts: [],
					},
					error: true,
					errorMessage: reason,
				};
			}
			const message = buildUserMessage({ prompt, contextTaskId, contextId });
			// The real wire needs the numeric Role enum ("user" encodes UNRECOGNIZED).
			if (typeof message.role === "string") message.role = await userRoleValue();
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const result = await agent.client.sendMessage(
					{
						message,
						configuration: undefined,
						metadata: undefined,
						tenant: "",
					},
					{ signal: controller.signal },
				);
				if (!isTaskResult(result)) {
					const text = flattenParts(result.parts);
					return {
						answer: text,
						stored: {
							agent: key,
							taskId: result.taskId ?? "",
							contextId: result.contextId ?? "",
							taskState: "message",
							artifacts: [],
							messageId: result.messageId,
						},
					};
				}
			// Real SDK states are numeric TaskState enums; displayTaskState maps
			// them to TASK_STATE_* names and passes strings (tests) through.
			const state = await displayTaskState(result.status.state);
			const reply = flattenParts(result.status.message?.parts);
			const artifactText = (result.artifacts ?? [])
				.map((a) => flattenParts(a.parts))
				.filter((t) => t.length > 0)
				.join("\n");
			const body = [reply, artifactText].filter((t) => t.length > 0).join("\n");
			const lines = body.length > 0 ? [body] : ["(empty reply)"];
			lines.push(
				`task ${result.id} (${state}) in context ${result.contextId}`,
			);
			if (CONTINUE_STATES[state])
				lines.push(
					"Call again with contextTaskId/contextId to continue.",
				);
			return {
				answer: lines.join("\n"),
				stored: {
					agent: key,
					taskId: result.id,
					contextId: result.contextId,
					taskState: state,
					artifacts: result.artifacts ?? [],
					messageId: message.messageId,
				},
				};
			} catch (err) {
				const text = a2aErrorText(err);
				return {
					answer: `a2a agent "${key}" send failed — ${text}.`,
					stored: {
						agent: key,
						taskId: contextTaskId,
						contextId,
						taskState: "failed",
						artifacts: [],
						messageId: message.messageId,
					},
					error: true,
					errorMessage: text,
				};
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

function toCancelTool(agent: AgentRuntime, timeoutMs: number): ToolType {
	const key = agent.key;
	return {
		name: cancelToolName(key),
		description:
			`Cancel a running task on the remote A2A agent "${key}". ` +
			`Pass the taskId from a previous send answer.`,
		inputSchema: cancelSchema,
		execute: async (params: unknown): Promise<ToolResult> => {
			const p = (params ?? {}) as { taskId?: unknown };
			const taskId = typeof p.taskId === "string" ? p.taskId : "";
			if (!agent.client) {
				const reason =
					agent.status.status === "failed"
						? agent.status.error
						: "not connected";
				return {
					answer: `a2a agent "${key}" is not connected: ${reason}.`,
					stored: { agent: key, taskId, taskState: "failed" },
					error: true,
					errorMessage: reason,
				};
			}
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const task = await agent.client.cancelTask(
					{ id: taskId, metadata: undefined, tenant: "" },
					{ signal: controller.signal },
				);
				const state = await displayTaskState(task.status.state);
				return {
					answer: `task ${task.id} (${state}) in context ${task.contextId}`,
					stored: {
						agent: key,
						taskId: task.id,
						contextId: task.contextId,
						taskState: state,
						artifacts: task.artifacts ?? [],
					},
				};
			} catch (err) {
				const text = a2aErrorText(err);
				return {
					answer: `a2a agent "${key}" cancel failed — ${text}.`,
					stored: { agent: key, taskId, taskState: "failed" },
					error: true,
					errorMessage: text,
				};
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

/**
 * The A2A client adapter. create → init (the ONLY await) → getPlugin().
 * init is idempotent; getPlugin() before init throws.
 */
export class A2aClientAdapter {
	private readonly agents: AgentRuntime[];
	private readonly deps: A2aClientDeps;
	private readonly defaultTimeout: number;
	private readonly defaultTransports: ("JSONRPC" | "HTTP+JSON")[] | undefined;
	private ready = false;
	private plugin: Plugin | undefined;

	constructor(config: A2aClientConfig, deps?: A2aClientDeps) {
		this.deps = deps ?? {};
		this.defaultTimeout = config.timeoutMs ?? DEFAULT_TIMEOUT;
		this.defaultTransports = config.preferredTransports;
		this.agents = Object.entries(config.agents).map(([key, cfg]) => ({
			key,
			cfg,
			status: { status: "failed", error: "not initialized" } as A2aAgentStatus,
			tools: [],
		}));
	}

	/**
	 * Fetch every agent card. Per-agent failure degrades to a `failed` status
	 * (the send tool still registers and reports the error) — init never
	 * throws for one dead agent. Idempotent.
	 */
	async init(): Promise<this> {
		if (this.ready) return this;
		const createClient = this.deps.createClient ?? defaultCreateClient;
		await Promise.all(
			this.agents.map(async (agent) => {
				const timeout = agent.cfg.timeoutMs ?? this.defaultTimeout;
				try {
					const { headers, query } = authHeaders(agent.cfg.auth);
					const { client, card } = await createClient(agent.cfg.url, {
						headers,
						query,
						preferredTransports:
							agent.cfg.preferredTransports ?? this.defaultTransports,
					});
					agent.client = client;
					agent.card = card;
					agent.tools = [
						toSendTool(agent, timeout),
						toCancelTool(agent, timeout),
					];
					agent.status = {
						status: "ready",
						tools: agent.tools.map((t) => t.name),
						...(card ? { card } : {}),
					};
				} catch (err) {
					const reason = err instanceof Error ? err.message : String(err);
					agent.status = { status: "failed", error: reason };
					// degraded tools still register so the model sees the failure
					agent.tools = [
						toSendTool(agent, timeout),
						toCancelTool(agent, timeout),
					];
				}
			}),
		);
		this.ready = true;
		return this;
	}

	/** The ready Plugin — install it and the tool list lands as-is. */
	getPlugin(): Plugin {
		if (!this.ready) {
			throw new Error(
				`[sanity] a2a-client: init() must resolve before getPlugin() — the tool list must be ready before install. ` +
					`await a2a.init(); then agent.install(a2a.getPlugin());`,
			);
		}
		if (this.plugin) return this.plugin;
		const agents = this.agents;
		const defaultTimeout = this.defaultTimeout;
		this.plugin = {
			id: CAPABILITY_ID,
			install(agent: GodObject) {
				for (const a of agents) for (const t of a.tools) agent.addTool(t);
				agent.state.a2a ??= {};
				const a2aState = agent.state.a2a as Record<string, unknown>;
				const agentStates: Record<string, unknown> = {};
				for (const a of agents) agentStates[a.key] = a.status;
				a2aState["agents"] = agentStates;
				a2aState["defaults"] = { timeoutMs: defaultTimeout };
				const readyCount = agents.filter(
					(a) => a.status.status === "ready",
				).length;
				agent.addDeclaredCapability({
					id: CAPABILITY_ID,
					description:
						`${agents.length} remote A2A agent${agents.length === 1 ? "" : "s"}` +
						` (${readyCount} ready)`,
				});
			},
			uninstall(agent: GodObject) {
				for (const t of agent.tools.filter((x) => x.name.startsWith("a2a_")))
					agent.removeTool(t.name);
				agent.removeDeclaredCapability(CAPABILITY_ID);
				delete agent.state.a2a;
			},
		};
		return this.plugin;
	}

	/** The ready tools, flat — take the list, skip the plugin entirely. */
	get tools(): ToolType[] {
		return this.agents.flatMap((a) => a.tools);
	}

	/** Per-agent statuses — mirrors what install writes to state.a2a. */
	get status(): Record<string, A2aAgentStatus> {
		return Object.fromEntries(this.agents.map((a) => [a.key, a.status]));
	}
}

/** The factory — declare, init, install. */
export function createA2aClient(
	config: A2aClientConfig,
	deps?: A2aClientDeps,
): A2aClientAdapter {
	return new A2aClientAdapter(config, deps);
}
