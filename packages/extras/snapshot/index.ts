// sanity/src/extras/snapshot.ts — the OPTIONAL inspection read.
//
// agentSnapshot(agent) — a pure function of state. It reads EXISTING data
// only: nothing to install, nothing to store, nothing to clean up. UI,
// dashboard, or protocol all call it; nobody hand-assembles the shape.
//
// Why it's an EXTRA and not core: the core's only promise addition is
// capabilities (the controlled manifest). Everything else in the snapshot
// already exists as public state — this file just flattens it. "The part we
// need to add" is small on purpose.
//
// The comprehension payload (for a stranger agent, a dashboard, a UI):
//   capabilities   — the trusted promise: what this agent can do
//   runState       — the phase it's in
//   currentTool    — what it's DOING right now (derived: last toolCall while tools in flight)
//   pendingAwaits  — what it's WAITING for
//   transcript     — the last few messages, the conversation it's mid-way through
import type { DeclaredCapability, GodObject, Message } from "@sanityloop/core";

export interface AgentSnapshot {
	/** The session's own name — self-identifying, discoverable from the card alone. */
	id: string;
	agentId: string;
	/** The agent's one-line description — what it does. */
	description?: string;
	/** The LIVE activity string — what it's doing right now. */
	activity: string;
	cwd: string;
	model: { api: string; modelId: string; stream: boolean; maxContext?: number };
	stats: {
		// MessageStats flat shape + derived contextUsage
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; [key: string]: number | undefined };
		ttftMs?: number;
		durationMs?: number;
		tps?: number;
		stallsMs?: number;
		latencyMs?: number;
		routerLatencyMs?: number;
		listPrice?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; [key: string]: number | undefined };
		api?: string;
		provider?: string;
		model?: string;
		stopReason?: string;
		generationId?: string;
		timestamp?: number;
		contextUsage?: number;
		[key: string]: unknown;
	};
	loopState: string;
	runState: string;
	inTurn: boolean;
	hasWork: boolean;
	inFlight: { provider: boolean; tools: boolean };
	/** The tool being executed right now, if any. */
	currentTool?: { name: string; parameters?: unknown };
	/** What the agent is parked waiting for, if anything. */
	pendingAwaits: { type: string; id?: string; schema?: unknown }[];
	ticks: number;
	tickPlan: string[];
	/** The current event's payload — what the agent is doing RIGHT NOW (transient, not stored). */
	currentEvent?: { type: string; [key: string]: unknown };
	messages: number;
	/** The recent conversation — capped for portability. */
	transcript: Message[];
	pendingInputs: { sync: number; async: number };
	plugins: string[];
	tools: string[];
	/** THE CORE PROMISE — trusted, controlled, plugin-declared. */
	capabilities: DeclaredCapability[];
}

/** How many recent messages the transcript carries. */
export const TRANSCRIPT_MAX = 6;

/** The tool being executed: the last toolCall message while tools are in flight. */
function currentToolOf(
	agent: GodObject,
): { name: string; parameters?: unknown } | undefined {
	if (!agent.inFlight.tools) return undefined;
	const last = agent.messages.at(-1);
	if (last?.type !== "toolCall") return undefined;
	const calls =
		(last.content as { stored?: { name?: string; parameters?: unknown }[] })
			.stored ?? [];
	const first = calls[0];
	if (!first?.name) return undefined;
	return { name: first.name, parameters: first.parameters };
}

/** The flat, queryable summary — reads existing data only. */
export function agentSnapshot(agent: GodObject): AgentSnapshot {
	return {
		id: agent.id,
		agentId: agent.agentId,
		description: agent.description || undefined,
		activity: agent.activity,
		cwd: agent.cwd,
		model: {
			api: agent.model.api,
			modelId: agent.model.modelId,
			stream: agent.model.stream,
			maxContext: agent.model.maxContext,
		},
		stats: {
			...agent.stats,
			contextUsage: agent.stats.contextUsage,
		},
		loopState: agent.loopState,
		runState: agent.runState,
		inTurn: agent.inTurn,
		hasWork: agent.hasWork,
		inFlight: { ...agent.inFlight },
		currentTool: currentToolOf(agent),
		pendingAwaits: agent.pendingAwaits.map((a) => ({
			type: a.type,
			id: a.id,
			schema: a.schema,
		})),
		ticks: agent.ticks,
		tickPlan: [...agent.tickPlan],
		currentEvent: (agent.transient as { currentEvent?: { type: string; [key: string]: unknown } }).currentEvent,
		messages: agent.messages.length,
		transcript: agent.messages.slice(-TRANSCRIPT_MAX),
		pendingInputs: {
			sync: agent.pendingInputs.sync.length,
			async: agent.pendingInputs.async.length,
		},
		plugins: agent.plugins.map((p) => p.id),
		tools: agent.tools.map((t) => t.name),
		capabilities: agent.listDeclaredCapabilities(),
	};
}
