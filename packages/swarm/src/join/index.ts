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
//     · tools per mode: peer (list/get/send/listen/control), admin (+create/kill/
//       restart/broadcast). worker gets none — it just reports.
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
	WorkerInfo,
} from "../protocol.ts";

export interface SwarmJoinOptions {
	/** The hat: "worker" (report only) | "peer" (query+talk) | "admin" (+create/kill/broadcast). */
	mode?: SwarmRole;
	/** The daemon address. Default ws://127.0.0.1:5317. */
	server?: string;
	/** Per-role token (when the daemon has tokens configured). */
	token?: string;
	/** Storage enabled → this session is resumable. Reported at register. */
	persistent?: boolean;
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
		token,
		persistent = false,
		heartbeatMs = 15_000,
		maxReconnectMs = 30_000,
	} = opts;

	const id = "swarm";
	let ws: WebSocket | undefined;
	let connected = false;
	let registered = false;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
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
		send({
			op: "register",
			sessionId: agent.id,
			agentId: agent.agentId,
			description: agent.description,
			mode,
			persistent,
			token,
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

	function scheduleReconnect(agent: GodObject): void {
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
			scheduleReconnect(agent);
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
					name: "swarm_list",
					description: "List the workers in the swarm (registry snapshot).",
					inputSchema: { type: "object", properties: {} },
					execute: async () => ({
						answer: JSON.stringify(await rpc({ op: "list" }), null, 2),
					}),
				},
				{
					name: "swarm_get",
					description: "Get one worker's registry info by sessionId.",
					inputSchema: {
						type: "object",
						properties: { sessionId: { type: "string" } },
						required: ["sessionId"],
					},
					execute: async (p) => ({
						answer: JSON.stringify(
							await rpc({ op: "get", sessionId: String(p.sessionId) }),
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
					name: "swarm_create",
					description:
						"Spawn a worker from a template (the daemon runs it). Returns { sessionId, pid }.",
					inputSchema: {
						type: "object",
						properties: {
							template: { type: "string" },
							sessionId: { type: "string" },
						},
						required: ["template"],
					},
					execute: async (p) => ({
						answer: JSON.stringify(
							await rpc({
								op: "create",
								template: String(p.template),
								sessionId:
									p.sessionId !== undefined ? String(p.sessionId) : undefined,
							}),
							null,
							2,
						),
					}),
				},
				{
					name: "swarm_kill",
					description:
						"Kill a worker the daemon spawned. Ad-hoc workers can't be killed by the daemon.",
					inputSchema: {
						type: "object",
						properties: { sessionId: { type: "string" } },
						required: ["sessionId"],
					},
					execute: async (p) => ({
						answer: JSON.stringify(
							await rpc({ op: "kill", sessionId: String(p.sessionId) }),
							null,
							2,
						),
					}),
				},
				{
					name: "swarm_restart",
					description:
						"Restart a daemon-spawned worker: same sessionId, fresh process (resumes its storage when persistent).",
					inputSchema: {
						type: "object",
						properties: { sessionId: { type: "string" } },
						required: ["sessionId"],
					},
					execute: async (p) => ({
						answer: JSON.stringify(
							await rpc({ op: "restart", sessionId: String(p.sessionId) }),
							null,
							2,
						),
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
				description: `swarm ${mode} @ ${server}${persistent ? " (persistent)" : ""}`,
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
