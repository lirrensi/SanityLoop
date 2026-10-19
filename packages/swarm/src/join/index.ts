// ============================================================================
// sanity/src/packages/swarm/src/join/index.ts — the COUPLING. The one extension
// an agent imports to join a swarm. Without this import the agent is completely
// independent — this file is the whole difference.
//
//   createSwarmJoin({ mode, server, token, persistent }) → Plugin
//     · register with the daemon (sessionId, agentId, description, mode, persistent)
//     · report UP: stream events + lifecycle only — voices, never memories (patched
//       stays local, the worker's own storage owns it)
//     · receive DOWN: input → agent.input(), control → stop/abort/pause/wake — the
//       SAME doors a human REPL would use, so a worker never knows who steers it
//     · reconnect + heartbeat (the daemon dies? we come back)
//     · tools per mode: peer (agents_list/agents_get/send/listen/control),
//       admin (+proc/task/drop/broadcast). worker gets none — it just reports.
//
//   wireSwarm(agent, opts) — the BOOT flow, verified: restore → install storage →
//   re-key → join. One call instead of a paragraph.
// ============================================================================
import WebSocket from "ws";
import { Tool } from "@sanityloop/core";
import type { Filter, GodObject, Plugin, ToolResult } from "@sanityloop/core";
import { DEFAULT_PORT, LIFECYCLE_EVENTS, STREAM_EVENTS } from "../protocol.ts";
import type {
	ClientFrame,
	ServerFrame,
	SwarmRole,
	AgentInfo,
} from "../protocol.ts";

export interface SwarmJoinOptions {
	mode?: SwarmRole;
	/** The daemon address. Default ws://127.0.0.1:5317. */
	server?: string;
	/** Where this worker lives (worker mode) / the mount point (peer/admin mode).
	 *  A room is a "/"-path prefix; an ancestor sees its descendants. Default "global". */
	room?: string;
	/** Per-role token (when the daemon has tokens configured). */
	token?: string;
	/** Storage enabled → this session is resumable. Reported at register. */
	persistent?: boolean;
	/** Fork backlink — stamped by the daemon as SWARM_SPAWN_ID, echoed as parent. Workers normally leave this unset. */
	spawnId?: string;
	/** Heartbeat interval ms. Default 15s. */
	heartbeatMs?: number;
	/** Max reconnect delay ms. Default 30s. */
	maxReconnectMs?: number;
}

interface Pending {
	resolve: (data: unknown) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

const defaultServer = `ws://127.0.0.1:${DEFAULT_PORT}`;

export function createSwarmJoin(opts: SwarmJoinOptions = {}): Plugin {
	const {
		mode = "worker",
		server = defaultServer,
		room,
		token,
		persistent = false,
		spawnId,
		heartbeatMs = 15_000,
		maxReconnectMs = 30_000,
	} = opts;

	const id = "swarm";
	let ws: WebSocket | undefined;
	let connected = false;
	let registered = false;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	/** Dropped ≠ disconnected: a drop tears down and stays gone until a
	 *  deliberate re-register (fresh wireSwarm/register clears it). */
	let dropped = false;
	let attempt = 0;
	let seq = 0;
	const pending = new Map<string, Pending>();

	function send(frame: ClientFrame): void {
		if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
	}

	/** RPC: send a frame with a request id, resolve on the matching result/error. */
	function rpc(frame: ClientFrame, timeoutMs = 10_000): Promise<unknown> {
		const rid = `r${++seq}`;
		const p = new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(rid);
				reject(
					new Error(`swarm rpc timed out: ${(frame as { op?: string }).op}`),
				);
			}, timeoutMs);
			pending.set(rid, { resolve, reject, timer });
		});
		send({ ...frame, id: rid } as ClientFrame);
		return p;
	}

	function register(agent: GodObject): void {
		// SWARM_SPAWN_ID (stamped by the daemon at fork) wins over the option —
		// the fork backlink is the daemon's truth, not the worker's claim.
		const envSpawn = process.env.SWARM_SPAWN_ID;
		send({
			op: "register",
			sessionId: agent.id,
			agentId: agent.agentId,
			description: agent.description,
			mode,
			room,
			persistent,
			token,
			spawnId: envSpawn || spawnId,
		});
	}

	function handleMessage(agent: GodObject, raw: WebSocket.RawData): void {
		const text = typeof raw === "string" ? raw : raw.toString();
		let frame: ServerFrame;
		try {
			frame = JSON.parse(text) as ServerFrame;
		} catch {
			return;
		}
		switch (frame.op) {
			case "welcome":
				registered = true;
				attempt = 0;
				agent.emit("swarm/welcome", {
					type: "swarm/welcome",
					swarm: frame.swarm,
					registry: frame.registry,
				});
				return;
			case "input":
				// the daemon is type-blind, so are we — the receiving filters wear the hats
				agent.input(frame.body as never);
				return;
			case "control":
				{
					const a = frame.action;
					if (a === "stop") agent.stop();
					else if (a === "abort") agent.abort("swarm/control");
					else if (a === "pause") agent.pause();
					else if (a === "wake") agent.wake();
				}
				return;
			case "drop":
				teardown();
				dropped = true;
				agent.emit("swarm/dropped", {
					type: "swarm/dropped",
					reason: frame.reason ?? "dropped",
				});
				return;
			case "result":
				{
					const id = frame.id;
					const p = id ? pending.get(id) : undefined;
					if (!id || !p) return;
					pending.delete(id);
					clearTimeout(p.timer);
					p.resolve(frame.data);
				}
				return;
			case "error":
				{
					const id = frame.id;
					const p = id ? pending.get(id) : undefined;
					if (!id || !p) return;
					pending.delete(id);
					clearTimeout(p.timer);
					p.reject(new Error(frame.error));
				}
				return;
			case "pong":
				return;
			case "event":
				// a relayed voice from a worker we subscribed to — re-emit for local observers
				agent.emit("swarm/event", {
					type: "swarm/event",
					target: frame.target,
					event: frame.event,
					payload: frame.payload,
				});
				return;
			case "closed":
				agent.emit("swarm/closed", {
					type: "swarm/closed",
					reason: frame.reason,
				});
				scheduleReconnect(agent);
				return;
		}
	}

	function teardown(): void {
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = undefined;
		}
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
		}
		for (const [, p] of pending) {
			clearTimeout(p.timer);
			p.reject(new Error("swarm dropped"));
		}
		pending.clear();
		if (ws) {
			try {
				ws.terminate();
			} catch {
				/* ignore */
			}
			ws = undefined;
		}
		connected = false;
		registered = false;
	}

	function scheduleReconnect(agent: GodObject): void {
		if (dropped) return;
		if (reconnectTimer) return;
		connected = false;
		registered = false;
		const delay = Math.min(500 * 2 ** attempt, maxReconnectMs);
		attempt++;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined;
			connect(agent);
		}, delay);
	}

	function connect(agent: GodObject): void {
		if (ws) {
			try {
				ws.terminate();
			} catch {
				/* ignore */
			}
			ws = undefined;
		}
		const socket = new WebSocket(server);
		ws = socket;
		socket.on("open", () => {
			connected = true;
			register(agent);
		});
		socket.on("message", (data) => handleMessage(agent, data));
		socket.on("error", () => {
			/* the close handler owns reconnection */
		});
		socket.on("close", () => {
			if (ws === socket) ws = undefined;
			connected = false;
			registered = false;
			// reject anything still pending — the wire is gone
			for (const [, p] of pending) {
				clearTimeout(p.timer);
				p.reject(new Error("swarm connection closed"));
			}
			pending.clear();
			// a dropped agent stays gone; a plain disconnect retries
			if (!dropped) scheduleReconnect(agent);
		});
	}

	/** The report filter — forward the worker's voices while connected. */
	function reportFilter(event: string): Filter {
		return {
			event,
			id: `swarm/report/${event}`,
			priority: -100,
			fn: (async (
				agent: GodObject,
				payload: { streamDelta?: unknown } | undefined,
			) => {
				if (connected && registered) {
					send({
						op: "report",
						event: event as never,
						payload:
							payload && "streamDelta" in (payload as object)
								? {
										streamDelta: (payload as { streamDelta?: unknown })
											.streamDelta,
									}
								: (payload ?? {}),
					});
				}
			}) as never,
		};
	}

	// ---------------------------------------------------------------------------
	// tools per mode — the hats the AGENT wears. The server enforces the same
	// permissions independently (tokens), so the tools are convenience, not security.
	// ---------------------------------------------------------------------------

	function toolsFor(): ReturnType<typeof Tool.define>[] {
		interface SwarmToolDef {
			name: string;
			description: string;
			inputSchema: Record<string, unknown>;
			execute: (p: Record<string, unknown>) => Promise<ToolResult>;
		}
		const defs: SwarmToolDef[] = [];
		if (mode === "peer" || mode === "admin") {
			defs.push(
				{
					name: "swarm_agents_list",
					description: "List the agents in the swarm (registry snapshot).",
					inputSchema: { type: "object", properties: {} },
					execute: async () => ({
						answer: JSON.stringify(await rpc({ op: "agents_list" }), null, 2),
					}),
				},
				{
					name: "swarm_agents_get",
					description: "Get one agent's registry info by sessionId.",
					inputSchema: {
						type: "object",
						properties: { sessionId: { type: "string" } },
						required: ["sessionId"],
					},
					execute: async (p) => ({
						answer: JSON.stringify(
							await rpc({ op: "agents_get", sessionId: String(p.sessionId) }),
							null,
							2,
						),
					}),
				},
				{
					name: "swarm_send",
					description:
						"Send an input (message/steer/followup) to a worker. body.type is the input type, e.g. input_followup or input_steer; text is the message.",
					inputSchema: {
						type: "object",
						properties: {
							target: { type: "string" },
							body: { type: "object" },
						},
						required: ["target", "body"],
					},
					execute: async (p) => ({
						answer: JSON.stringify(
							await rpc({
								op: "input",
								target: String(p.target),
								body: (p.body ?? {}) as Record<string, unknown>,
							}),
							null,
							2,
						),
					}),
				},
				{
					name: "swarm_listen",
					description:
						"Subscribe (on: true) or unsubscribe (on: false) to a worker's stream events. Streams arrive as swarm/event emits on this agent.",
					inputSchema: {
						type: "object",
						properties: {
							sessionId: { type: "string" },
							on: { type: "boolean" },
						},
						required: ["sessionId", "on"],
					},
					execute: async (p) => ({
						answer: JSON.stringify(
							await rpc({
								op: "listen",
								sessionId: String(p.sessionId),
								on: Boolean(p.on),
							}),
							null,
							2,
						),
					}),
				},
				{
					name: "swarm_control",
					description:
						"Send a control action to a worker: stop, abort, pause, wake.",
					inputSchema: {
						type: "object",
						properties: {
							target: { type: "string" },
							action: {
								type: "string",
								enum: ["stop", "abort", "pause", "wake"],
							},
						},
						required: ["target", "action"],
					},
					execute: async (p) => ({
						answer: JSON.stringify(
							await rpc({
								op: "control",
								target: String(p.target),
								action: p.action as never,
							}),
							null,
							2,
						),
					}),
				},
			);
		}
		if (mode === "admin") {
			defs.push(
				{
					name: "swarm_drop",
					description:
						"Remove one agent from the swarm: its socket closes and its registry entry is deleted. Idempotent — dropping a ghost succeeds silently. The dropped agent tears down and never reconnects until it deliberately re-registers.",
					inputSchema: {
						type: "object",
						properties: { sessionId: { type: "string" } },
						required: ["sessionId"],
					},
					execute: async (p) => ({
						answer: JSON.stringify(
							await rpc({ op: "drop", sessionId: String(p.sessionId) }),
							null,
							2,
						),
					}),
				},
				{
					name: "swarm_proc_start",
					description:
						"Remember (creating when missing) + fork a process now. Source: from (template id) or file (agent path). Returns { name, sessionId, pid }.",
					inputSchema: {
						type: "object",
						properties: {
							name: { type: "string" },
							from: { type: "string" },
							file: { type: "string" },
							autorestart: { type: "boolean" },
							prompt: { type: "string" },
						},
						required: ["name"],
					},
					execute: async (p) => ({
						answer: JSON.stringify(
							await rpc({
								op: "proc_start",
								name: String(p.name),
								from: p.from !== undefined ? String(p.from) : undefined,
								file: p.file !== undefined ? String(p.file) : undefined,
								autorestart: typeof p.autorestart === "boolean" ? p.autorestart : undefined,
								prompt: p.prompt !== undefined ? String(p.prompt) : undefined,
							}),
							null,
							2,
						),
					}),
				},
				{
					name: "swarm_proc_stop",
					description: "Murder a process's pid. Desired state → stopped.",
					inputSchema: {
						type: "object",
						properties: { name: { type: "string" } },
						required: ["name"],
					},
					execute: async (p) => ({
						answer: JSON.stringify(
							await rpc({ op: "proc_stop", name: String(p.name) }),
							null,
							2,
						),
					}),
				},
				{
					name: "swarm_proc_restart",
					description: "Fresh fork under the same process name.",
					inputSchema: {
						type: "object",
						properties: {
							name: { type: "string" },
							prompt: { type: "string" },
						},
						required: ["name"],
					},
					execute: async (p) => ({
						answer: JSON.stringify(
							await rpc({
								op: "proc_restart",
								name: String(p.name),
								prompt: p.prompt !== undefined ? String(p.prompt) : undefined,
							}),
							null,
							2,
						),
					}),
				},
				{
					name: "swarm_proc_list",
					description: "List process definitions.",
					inputSchema: { type: "object", properties: {} },
					execute: async () => ({
						answer: JSON.stringify(await rpc({ op: "proc_list" }), null, 2),
					}),
				},
				{
					name: "swarm_task_define",
					description:
						"Create or replace a task definition. fire: every (needs everyMs) | at (needs at epoch ms) | manual.",
					inputSchema: {
						type: "object",
						properties: {
							name: { type: "string" },
							from: { type: "string" },
							file: { type: "string" },
							fire: { type: "string", enum: ["every", "at", "manual"] },
							everyMs: { type: "number" },
							at: { type: "number" },
						},
						required: ["name", "fire"],
					},
					execute: async (p) => ({
						answer: JSON.stringify(
							await rpc({
								op: "task_define",
								name: String(p.name),
								from: p.from !== undefined ? String(p.from) : undefined,
								file: p.file !== undefined ? String(p.file) : undefined,
								fire: p.fire as never,
								everyMs: typeof p.everyMs === "number" ? p.everyMs : undefined,
								at: typeof p.at === "number" ? p.at : undefined,
							}),
							null,
							2,
						),
					}),
				},
				{
					name: "swarm_task_fire",
					description: "Fork a task once through the same fork path. Returns { name, run, sessionId, pid }.",
					inputSchema: {
						type: "object",
						properties: {
							name: { type: "string" },
							prompt: { type: "string" },
						},
						required: ["name"],
					},
					execute: async (p) => ({
						answer: JSON.stringify(
							await rpc({
								op: "task_fire",
								name: String(p.name),
								prompt: p.prompt !== undefined ? String(p.prompt) : undefined,
							}),
							null,
							2,
						),
					}),
				},
				{
					name: "swarm_task_trigger",
					description:
						"Manual run on the paused-immune path: forks even when paused, schedule untouched, transient context delivered as the prompt, at-most-once (busy when a claim is in flight).",
					inputSchema: {
						type: "object",
						properties: {
							name: { type: "string" },
							context: { type: "string" },
							prompt: { type: "string" },
						},
						required: ["name"],
					},
					execute: async (p) => ({
						answer: JSON.stringify(
							await rpc({
								op: "task_trigger",
								name: String(p.name),
								context: p.context !== undefined ? String(p.context) : undefined,
								prompt: p.prompt !== undefined ? String(p.prompt) : undefined,
							}),
							null,
							2,
						),
					}),
				},
				{
					name: "swarm_task_list",
					description: "List task definitions.",
					inputSchema: { type: "object", properties: {} },
					execute: async () => ({
						answer: JSON.stringify(await rpc({ op: "task_list" }), null, 2),
					}),
				},
				{
					name: "swarm_broadcast",
					description:
						"Send an input to every online worker (or a target subset).",
					inputSchema: {
						type: "object",
						properties: {
							body: { type: "object" },
							targets: { type: "array", items: { type: "string" } },
						},
						required: ["body"],
					},
					execute: async (p) => ({
						answer: JSON.stringify(
							await rpc({
								op: "broadcast",
								body: (p.body ?? {}) as Record<string, unknown>,
								targets: Array.isArray(p.targets)
									? (p.targets as string[])
									: undefined,
							}),
							null,
							2,
						),
					}),
				},
			);
		}
		return defs.map((d) => Tool.define(d));
	}

	return {
		id,

		install(agent) {
			// manual re-register (fresh wireSwarm/install) clears the dropped flag
			dropped = false;
			// report filters — the worker's voices, forwarded while connected
			for (const name of STREAM_EVENTS)
				agent.addFilter(reportFilter(name) as never);
			for (const name of LIFECYCLE_EVENTS)
				agent.addFilter(reportFilter(name) as never);

			// tools per mode
			for (const tool of toolsFor()) agent.addTool(tool);

			connect(agent);

			heartbeatTimer = setInterval(() => {
				if (connected && registered) send({ op: "ping", t: Date.now() });
			}, heartbeatMs);
			heartbeatTimer.unref?.();

			agent.addDeclaredCapability({
				id: "swarm",
				description: `swarm ${mode}${room ? ` @ ${room}` : ""} @ ${server}${persistent ? " (persistent)" : ""}`,
			});
		},

		uninstall(agent) {
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
				reconnectTimer = undefined;
			}
			if (heartbeatTimer) {
				clearInterval(heartbeatTimer);
				heartbeatTimer = undefined;
			}
			for (const [, p] of pending) {
				clearTimeout(p.timer);
				p.reject(new Error("swarm uninstalled"));
			}
			pending.clear();
			if (ws) {
				try {
					ws.terminate();
				} catch {
					/* ignore */
				}
				ws = undefined;
			}
			connected = false;
			registered = false;
			agent.removeDeclaredCapability("swarm");
		},
	};
}

// ---------------------------------------------------------------------------
// wireSwarm — the verified boot flow in one call:
//   restore (content first) → install storage → re-key (fork event, taped) → join
// ---------------------------------------------------------------------------

export interface WireSwarmOptions extends SwarmJoinOptions {
	/** Explicit sessionId — the re-key (a fork or a resume-with-env). Default: keep the agent's current id. */
	sessionId?: string;
	/** A jsonlSession()-shaped storage: restore, then install its plugin. */
	storage?: {
		restoreInto(agent: GodObject): Promise<boolean>;
		plugin: Plugin;
	};
}

export async function wireSwarm(
	agent: GodObject,
	opts: WireSwarmOptions = {},
): Promise<{ restored: boolean }> {
	let restored = false;
	if (opts.storage) {
		// content first — the tape tells the agent who it was
		restored = await opts.storage.restoreInto(agent);
		agent.install(opts.storage.plugin);
	}
	if (opts.sessionId && opts.sessionId !== agent.id) {
		// the re-key AFTER restore — last write wins, visible on the tape (a fork's birth)
		agent.id = opts.sessionId;
	}
	agent.install(createSwarmJoin(opts));
	return { restored };
}
