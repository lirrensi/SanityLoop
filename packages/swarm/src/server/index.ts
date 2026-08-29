// ============================================================================
// sanity/src/packages/swarm/src/server/index.ts — THE DAEMON. A dumb hypervisor:
//   · WS hub — routes frames by sessionId, fan-outs streams to subscribers. It
//     never interprets a payload, only its shape (the core is type-blind, so is
//     the hub).
//   · ONE API, MANY SURFACES — the ops live in FleetApi; WS frames, REST routes
//     (rest.ts) and the CLI (a WS client) are thin adapters over the same core.
//   · registry (live) + history (every worker ever seen) — resumable = persistent
//     workers the daemon recognizes; restartable = workers it spawned.
//   · the daemon FOLDS what it hears: lifecycle reports become per-worker state
//     (idle/busy/paused/error), counters, and a recent-events ring. State is truth.
//   · prompts on create/restart are queued and delivered the instant the worker
//     (re)registers — the daemon owns the register moment, so it orchestrates.
//   · tokens → roles: admin/peer/worker. Enforcement is HERE, not tool-absence.
//   · spawner: template scan → child_process → fleet manifest (resurrect after
//     a daemon restart).
//
// The daemon is NOT an agent. It manages agents; it never thinks.
// ============================================================================
import { createServer, type IncomingMessage, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { DEFAULT_PORT, parseFrame } from "../protocol.ts";
import type {
	ClientFrame,
	ControlAction,
	RecentEvent,
	RegisterFrame,
	SwarmEvent,
	SwarmRole,
	WorkerInfo,
	WorkerState,
	WorkerStats,
} from "../protocol.ts";
import { Spawner, type TemplateInfo } from "./spawner.ts";
import { ensureScaffold, ensureNodeModulesLink, homeLayout, resolveHome, writeConfig } from "./config.ts";
import { handleRest } from "./rest.ts";

export interface SwarmServerOptions {
	/** The daemon's home — where config.json, templates/, sessions/ and fleet.json live.
	 * Default: $SWARM_HOME or ~/.sanity/swarm (the one daemon per system). */
	home?: string;
	addr?: string;
	/** 0 = random port (lands in onPort + state). */
	port?: number;
	/** Per-role tokens. When configured, a register MUST present the token matching
	 *  its claimed mode (or no token → worker). Empty/undefined = open. */
	tokens?: Partial<Record<SwarmRole, string>>;
	/** Where the daemon scans for templates (spawnable workers). */
	templatesDir?: string;
	/** Fleet manifest path — lets the daemon resurrect its own fleet after restart. */
	manifestPath?: string;
	/** Respawn all recorded workers on boot (default false — you command it). */
	resurrectOnBoot?: boolean;
	onPort?: (port: number) => void;
}

interface Connection {
	ws: WebSocket;
	role: SwarmRole;
	sessionId?: string;
	mode: SwarmRole;
	persistent: boolean;
	subscribed: Set<string>;
}

interface RegistryEntry {
	sessionId: string;
	agentId: string;
	description?: string;
	mode: SwarmRole;
	persistent: boolean;
	spawned: boolean;
	pid?: number;
	status: "online" | "offline";
	lastSeen: number;
	/** Derived runtime activity — folded from the worker's own reports. */
	state?: WorkerState;
	lastEvent?: SwarmEvent;
	lastEventAt?: number;
	stats: WorkerStats;
	/** Recent-events ring — lifecycle payloads only, capped. */
	recent: RecentEvent[];
	conn?: Connection;
}

/** How lifecycle reports fold into derived state. The daemon never invents
 *  state — it only folds what it hears. */
const LIFECYCLE_FOLD: Record<string, { state?: WorkerState; stat?: keyof WorkerStats }> = {
	agentStart: { state: "busy" },
	agentSettled: { state: "idle" },
	cycleEnd: { state: "idle", stat: "cycles" },
	turnEnd: { state: "idle", stat: "turns" },
	stop: { state: "idle" },
	abort: { state: "idle" },
	error: { state: "error", stat: "errors" },
};

/** Ring cap per worker — enough to debug, too small to matter. */
const RECENT_LIMIT = 100;

/** A queued prompt dies of loneliness after this long (worker never came back). */
const PROMPT_TIMEOUT_MS = 60_000;

/** What each role may do. The daemon enforces; the client's tools are convenience. */
const PERMS: Record<SwarmRole, Set<string>> = {
	worker: new Set(["register", "report", "ping"]),
	peer: new Set([
		"register",
		"report",
		"ping",
		"list",
		"get",
		"listen",
		"events",
		"history",
		"templates",
		"input",
		"control",
	]),
	admin: new Set([
		"register",
		"report",
		"ping",
		"list",
		"get",
		"listen",
		"events",
		"history",
		"templates",
		"input",
		"control",
		"create",
		"kill",
		"restart",
		"broadcast",
	]),
};

// ---------------------------------------------------------------------------
// THE API — one core, many surfaces. WS frames, REST routes and the CLI all
// speak exactly this. Sync by design: prompts for (re)spawns are QUEUED and
// delivered on register, never awaited mid-frame. The daemon is the only one
// who knows when a worker (re)registers — so prompt orchestration lives here.
// ---------------------------------------------------------------------------
export interface FleetApi {
	list(filter?: {
		status?: "online" | "offline";
		mode?: SwarmRole;
		agentId?: string;
	}): WorkerInfo[];
	get(sessionId: string): WorkerInfo | null;
	history(): WorkerInfo[];
	templates(): TemplateInfo[];
	/** The recent-events ring of one worker (lifecycle payloads only). */
	events(
		sessionId: string,
		limit?: number,
	): { sessionId: string; events: RecentEvent[] } | null;
	/** Spawn a template worker. Returns null for an unknown template. */
	create(
		template: string,
		opts?: { sessionId?: string; prompt?: string },
	): { sessionId: string; pid?: number } | null;
	kill(sessionId: string): { ok: boolean; sessionId: string };
	/** Restart a daemon-spawned worker; optional prompt delivered after re-register. */
	restart(
		sessionId: string,
		opts?: { prompt?: string },
	): { ok: boolean; sessionId: string };
	control(
		target: string,
		action: ControlAction,
	): { ok: boolean; target: string; action: ControlAction } | null;
	input(
		target: string,
		body: Record<string, unknown>,
	): { ok: boolean; target: string } | null;
}

export interface SwarmServer {
	readonly port: number;
	start(): Promise<void>;
	stop(): Promise<void>;
	/** THE core — the same ops REST and the CLI speak. Embed away. */
	api: FleetApi;
	/** Registry snapshot — the observable truth. */
	registry(): WorkerInfo[];
	/** History — every worker ever seen (resumable discovery). */
	history(): WorkerInfo[];
	templates(): TemplateInfo[];
	/** Command the daemon: spawn an admin agent (or any template). */
	spawnTemplate(
		template: string,
		opts?: { sessionId?: string },
	): { sessionId: string; pid?: number } | null;
}

export function createSwarmServer(opts: SwarmServerOptions = {}): SwarmServer {
	const {
		addr = "127.0.0.1",
		port = DEFAULT_PORT,
		tokens = {},
		resurrectOnBoot = false,
	} = opts;

	// the daemon IS a location — resolve its home, scaffold it, derive the defaults
	const home = opts.home ?? resolveHome();
	ensureScaffold(home);
	ensureNodeModulesLink(home);
	const layout = homeLayout(home);
	const templatesDir = opts.templatesDir ?? layout.templatesDir;
	const manifestPath = opts.manifestPath ?? layout.manifestPath;
	const sessionsDir = layout.sessionsDir;

	const bootedAt = Date.now();
	const registry = new Map<string, RegistryEntry>();
	const history = new Map<string, RegistryEntry>();
	const connections = new Set<Connection>();
	const spawner = new Spawner({
		templatesDir,
		manifestPath,
	});

	/** Prompts waiting for a (re)register — the daemon owns that moment. */
	const pendingPrompts = new Map<
		string,
		{ body: Record<string, unknown>; timer: ReturnType<typeof setTimeout> }
	>();
	const queuePrompt = (sessionId: string, prompt: string): void => {
		const timer = setTimeout(
			() => pendingPrompts.delete(sessionId),
			PROMPT_TIMEOUT_MS,
		);
		timer.unref?.();
		pendingPrompts.set(sessionId, {
			body: { type: "input_followup", text: prompt },
			timer,
		});
	};

	let httpServer: Server | undefined;
	let wss: WebSocketServer | undefined;
	let actualPort = port;

	/** The env every spawned worker inherits from the daemon — where it lives + who to join. */
	const spawnEnv = (): Record<string, string> => ({
		SWARM_HOME: home,
		SWARM_SESSIONS_DIR: sessionsDir,
		SWARM_SERVER: `ws://${addr}:${actualPort}`,
	});
	const send = (conn: Connection, frame: unknown): void => {
		if (conn.ws.readyState === WebSocket.OPEN) {
			conn.ws.send(JSON.stringify(frame));
		}
	};

	const freshStats = (): WorkerStats => ({ cycles: 0, turns: 0, errors: 0 });

	const info = (e: RegistryEntry): WorkerInfo => ({
		sessionId: e.sessionId,
		agentId: e.agentId,
		description: e.description,
		mode: e.mode,
		persistent: e.persistent,
		spawned: e.spawned,
		status: e.status,
		state: e.state,
		lastEvent: e.lastEvent,
		lastEventAt: e.lastEventAt,
		stats: e.stats,
		pid: e.pid,
		lastSeen: e.lastSeen,
	});

	const snapshot = (): WorkerInfo[] => [...registry.values()].map(info);

	const hasPerm = (conn: Connection, op: string): boolean =>
		PERMS[conn.role].has(op);

	/** The request id, if the frame carried one — RPC correlation. */
	const rid = (frame: ClientFrame): string | undefined =>
		(frame as { id?: string }).id;

	const result = (
		conn: Connection,
		frame: ClientFrame,
		reqOp: string,
		data?: unknown,
	): void => {
		send(conn, { op: "result", reqOp, id: rid(frame), data });
	};
	const fail = (
		conn: Connection,
		frame: ClientFrame,
		reqOp: string,
		error: string,
	): void => {
		send(conn, { op: "error", reqOp, id: rid(frame), error });
	};
	const roleFor = (frame: RegisterFrame): SwarmRole | null => {
		const claimed = frame.mode;
		const token = frame.token;
		const anyTokens = Object.values(tokens).some((t) => t !== undefined);
		if (!anyTokens) {
			// open mode — no tokens configured, trust the claim
			return claimed;
		}
		const configured = tokens[claimed];
		if (configured !== undefined) {
			// a token exists for the claimed mode → it must match
			return token === configured ? claimed : null;
		}
		// no token for the claimed mode: a matching HIGHER-role token upgrades
		// the modest claim. When tokens are configured AT ALL, EVERY door requires
		// one — there is no anonymous baseline (not even worker). Matches REST.
		if (token) {
			for (const role of ["admin", "peer"] as const) {
				if (tokens[role] && tokens[role] === token) return role;
			}
			return null;
		}
		return null;
	};

	const onRegister = (conn: Connection, frame: RegisterFrame): void => {
		const role = roleFor(frame);
		if (!role) {
			send(conn, {
				op: "error",
				reqOp: "register",
				error: "token/mode mismatch — unauthorized",
			});
			conn.ws.close();
			return;
		}
		conn.role = role;
		conn.sessionId = frame.sessionId;
		conn.mode = frame.mode;
		conn.persistent = frame.persistent;

		// re-identity: the same sessionId reconnecting replaces the old socket
		const old = registry.get(frame.sessionId);
		if (old?.conn) {
			old.conn.ws.close();
			connections.delete(old.conn);
		}

		const entry: RegistryEntry = {
			sessionId: frame.sessionId,
			agentId: frame.agentId,
			description: frame.description,
			mode: frame.mode,
			persistent: frame.persistent,
			spawned: spawner.isSpawned(frame.sessionId),
			pid: spawner.pidOf(frame.sessionId),
			status: "online",
			stats: freshStats(),
			recent: [],
			lastSeen: Date.now(),
			conn,
		};
		registry.set(frame.sessionId, entry);
		const seen = history.get(frame.sessionId);
		history.set(frame.sessionId, { ...seen, ...entry, status: "online" });

		send(conn, {
			op: "welcome",
			sessionId: frame.sessionId,
			registry: snapshot(),
		});

		// a queued prompt (create/restart with prompt) is delivered the moment
		// the worker is back among the living
		const queued = pendingPrompts.get(frame.sessionId);
		if (queued) {
			pendingPrompts.delete(frame.sessionId);
			clearTimeout(queued.timer);
			send(conn, { op: "input", body: queued.body });
		}
	};

	/** Fold a reported event into the worker's derived state. */
	const fold = (
		entry: RegistryEntry,
		event: string,
		payload: unknown,
	): void => {
		entry.lastEvent = event as SwarmEvent;
		entry.lastEventAt = Date.now();
		const f = LIFECYCLE_FOLD[event];
		if (f?.state) entry.state = f.state;
		if (f?.stat) entry.stats[f.stat]++;
		if (f) {
			entry.recent.push({
				event: event as SwarmEvent,
				at: entry.lastEventAt,
				payload,
			});
			if (entry.recent.length > RECENT_LIMIT) entry.recent.shift();
		}
	};

	const onReport = (
		conn: Connection,
		frame: { event: string; payload?: unknown },
	): void => {
		if (!conn.sessionId) return;
		const entry = registry.get(conn.sessionId);
		if (entry) {
			entry.lastSeen = Date.now();
			fold(entry, frame.event, frame.payload);
		}
		// fan out to subscribers (never back to the reporter itself)
		for (const sub of connections) {
			if (sub === conn) continue;
			if (sub.subscribed.has(conn.sessionId)) {
				send(sub, {
					op: "event",
					target: conn.sessionId,
					event: frame.event,
					payload: frame.payload,
				});
			}
		}
	};

	// ---------------------------------------------------------------------------
	// THE CORE — every surface below this line is an adapter over `api`.
	// ---------------------------------------------------------------------------
	const api: FleetApi = {
		list(filter) {
			let rows = snapshot();
			if (filter?.status) rows = rows.filter((r) => r.status === filter.status);
			if (filter?.mode) rows = rows.filter((r) => r.mode === filter.mode);
			if (filter?.agentId) rows = rows.filter((r) => r.agentId === filter.agentId);
			return rows;
		},

		get(sessionId) {
			const e = registry.get(sessionId);
			return e ? info(e) : null;
		},

		history() {
			return [...history.values()].map(info);
		},

		templates() {
			return spawner.scanTemplates();
		},

		events(sessionId, limit = 100) {
			const e = registry.get(sessionId);
			if (!e) return null;
			return { sessionId, events: e.recent.slice(-Math.max(1, limit)) };
		},

		create(template, createOpts = {}) {
			const t = spawner.findTemplate(template);
			if (!t) return null;
			const spawned = spawner.spawn(t, {
				sessionId: createOpts.sessionId,
				extraEnv: spawnEnv(),
			});
			// registry shows it as offline until it registers (spawned → restartable)
			registry.set(spawned.sessionId, {
				sessionId: spawned.sessionId,
				agentId: t.id,
				description: t.description,
				// the manifest's mode is INDICATION only — the .ts decides its real mode at register
				mode: t.mode ?? "worker",
				persistent: true,
				spawned: true,
				pid: spawned.pid,
				status: "offline",
				stats: freshStats(),
				recent: [],
				lastSeen: Date.now(),
			});
			if (createOpts.prompt) queuePrompt(spawned.sessionId, createOpts.prompt);
			return spawned;
		},

		kill(sessionId) {
			const ok = spawner.kill(sessionId);
			const entry = registry.get(sessionId);
			if (entry?.conn) {
				entry.conn.ws.close();
				entry.status = "offline";
				entry.conn = undefined;
			}
			return { ok, sessionId };
		},

		restart(sessionId, restartOpts = {}) {
			if (restartOpts.prompt) queuePrompt(sessionId, restartOpts.prompt);
			const ok = spawner.restart(sessionId);
			if (!ok && restartOpts.prompt) pendingPrompts.delete(sessionId);
			return { ok, sessionId };
		},

		control(target, action) {
			const entry = registry.get(target);
			if (!entry?.conn) return null;
			send(entry.conn, { op: "control", action });
			// optimistic — the worker's next report corrects us if it disagrees
			entry.state = action === "pause" ? "paused" : "idle";
			return { ok: true, target, action };
		},

		input(target, body) {
			const entry = registry.get(target);
			if (!entry?.conn) return null;
			send(entry.conn, { op: "input", body });
			return { ok: true, target };
		},
	};

	const handleFrame = (conn: Connection, frame: ClientFrame): void => {
		switch (frame.op) {
			case "register":
				onRegister(conn, frame);
				return;
			case "report":
				if (hasPerm(conn, "report")) onReport(conn, frame);
				return;
			case "ping":
				send(conn, { op: "pong", t: frame.t });
				return;
			case "list":
				if (!hasPerm(conn, "list")) break;
				result(conn, frame, "list", api.list());
				return;
			case "get":
				if (!hasPerm(conn, "get")) break;
				result(conn, frame, "get", api.get(frame.sessionId));
				return;
			case "listen":
				if (!hasPerm(conn, "listen")) break;
				if (frame.on) conn.subscribed.add(frame.sessionId);
				else conn.subscribed.delete(frame.sessionId);
				result(conn, frame, "listen", {
					on: frame.on,
					sessionId: frame.sessionId,
				});
				return;
			case "events":
				if (!hasPerm(conn, "events")) break;
				{
					const r = api.events(frame.sessionId, frame.limit);
					if (!r) fail(conn, frame, "events", `unknown worker: ${frame.sessionId}`);
					else result(conn, frame, "events", r);
				}
				return;
			case "history":
				if (!hasPerm(conn, "history")) break;
				result(conn, frame, "history", api.history());
				return;
			case "templates":
				if (!hasPerm(conn, "templates")) break;
				result(conn, frame, "templates", api.templates());
				return;
			case "input":
				if (!hasPerm(conn, "input")) break;
				{
					const r = api.input(frame.target, frame.body);
					if (!r) fail(conn, frame, "input", `worker not online: ${frame.target}`);
					else result(conn, frame, "input", r);
				}
				return;
			case "control":
				if (!hasPerm(conn, "control")) break;
				{
					const r = api.control(frame.target, frame.action);
					if (!r) fail(conn, frame, "control", `worker not online: ${frame.target}`);
					else result(conn, frame, "control", r);
				}
				return;
			case "create":
				if (!hasPerm(conn, "create")) break;
				{
					const r = api.create(frame.template, {
						sessionId: frame.sessionId,
						prompt: frame.prompt,
					});
					if (!r) fail(conn, frame, "create", `unknown template: ${frame.template}`);
					else result(conn, frame, "create", r);
				}
				return;
			case "kill":
				if (!hasPerm(conn, "kill")) break;
				result(conn, frame, "kill", api.kill(frame.sessionId));
				return;
			case "restart":
				if (!hasPerm(conn, "restart")) break;
				result(conn, frame, "restart", api.restart(frame.sessionId, { prompt: frame.prompt }));
				return;
			case "broadcast":
				if (!hasPerm(conn, "broadcast")) break;
				{
					const targets = frame.targets
						? frame.targets.filter((t) => registry.has(t))
						: [...registry.values()]
								.filter((e) => e.status === "online")
								.map((e) => e.sessionId);
					let sent = 0;
					for (const t of targets) {
						if (api.input(t, frame.body)) sent++;
					}
					result(conn, frame, "broadcast", { sent, targets: targets.length });
				}
				return;
			default:
				fail(
					conn,
					frame,
					String((frame as { op?: unknown }).op),
					"unhandled op",
				);
				return;
		}
		fail(conn, frame, frame.op, `forbidden for role: ${conn.role}`);
	};

	return {
		get port(): number {
			return actualPort;
		},

		api,

		async start() {
			if (resurrectOnBoot) {
				spawner.resurrectAll();
			}
			httpServer = createServer();
			// the second door — same server, same port, same tokens, same ops
			httpServer.on("request", (req: IncomingMessage, res) => {
				handleRest(req, res, {
					api,
					tokens,
					prefix: "/api/v1",
					meta: () => ({
						port: actualPort,
						home,
						online: [...registry.values()].filter((e) => e.status === "online")
							.length,
						total: registry.size,
						uptimeMs: Date.now() - bootedAt,
					}),
				});
			});
			wss = new WebSocketServer({ server: httpServer });
			wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
				const conn: Connection = {
					ws,
					role: "worker",
					mode: "worker",
					persistent: false,
					subscribed: new Set(),
				};
				connections.add(conn);
				ws.on("message", (data) => {
					const text = typeof data === "string" ? data : data.toString();
					const frame = parseFrame(text);
					if (!frame) {
						send(conn, { op: "error", reqOp: "?", error: "bad frame" });
						return;
					}
					try {
						handleFrame(conn, frame);
					} catch (err) {
						send(conn, {
							op: "error",
							reqOp: frame.op,
							error: err instanceof Error ? err.message : String(err),
						});
					}
				});
				ws.on("close", () => {
					connections.delete(conn);
					if (conn.sessionId) {
						const entry = registry.get(conn.sessionId);
						if (entry) {
							entry.status = "offline";
							entry.conn = undefined;
							entry.lastSeen = Date.now();
						}
					}
				});
			});
			await new Promise<void>((resolve) => {
				httpServer!.listen({ port, hostname: addr }, () => {
					const a = httpServer!.address();
					actualPort = typeof a === "object" && a ? a.port : port;
					opts.onPort?.(actualPort);
					resolve();
				});
			});
			// the daemon declares itself — config.json is its identity
			writeConfig({
				version: 1,
				home,
				addr,
				port: actualPort,
				templatesDir,
				sessionsDir,
				manifestPath,
				tokens: Object.keys(tokens).length ? tokens : undefined,
			});
		},

		async stop() {
			for (const conn of connections) {
				try {
					conn.ws.close();
				} catch {
					/* ignore */
				}
			}
			connections.clear();
			await new Promise<void>((resolve) => {
				wss?.close(() => resolve());
				if (!wss) resolve();
			});
			await new Promise<void>((resolve) => {
				httpServer?.close(() => resolve());
				if (!httpServer) resolve();
			});
			wss = undefined;
			httpServer = undefined;
		},

		registry() {
			return snapshot();
		},

		history() {
			return [...history.values()].map(info);
		},

		templates() {
			return spawner.scanTemplates();
		},

		spawnTemplate(template: string, opts?: { sessionId?: string }) {
			return api.create(template, opts);
		},
	};
}
