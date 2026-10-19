// ============================================================================
// sanity/src/packages/swarm/src/server/index.ts — THE DAEMON. A dumb hypervisor:
//   · WS hub — routes frames by address, fan-outs streams to subscribers. It
//     never interprets a payload, only its shape (the core is type-blind, so is
//     the hub).
//   · ONE API, MANY SURFACES — the ops live in FleetApi (agents/processes/tasks
//     namespaces); WS frames, REST routes (rest.ts) and the CLI (a WS client)
//     are thin adapters over the same core.
//   · registry (live agents only) + history (every agent ever seen). Agents are
//     whoever joined — wild (no parent) or forked (parent = process name or
//     task fire id, echoed from SWARM_SPAWN_ID).
//   · PROCESSES = named remembered forks (stores.ts is the only memory).
//     `start` forks now; `autorestart=true` reforks on crash; boot reforks
//     every process whose desired status is running.
//   · TASKS = named fire-and-die definitions. `fire` forks once through the
//     SAME fork path; a 60s clock fires due `every`/`at` tasks unless paused.
//   · ROOMS — a room is NOT an object, it is a "/"-path prefix on registry
//     entries. ONE visibility rule: an ancestor sees its descendants
//     (startsWith); sideways and upward: invisible. Workers claim where they
//     live; peer/admin mount where they look. The swarm name is STAMPED by the
//     daemon — a worker never claims which swarm it belongs to.
//   · FEDERATION (server/federate.ts) — the daemon dials another daemon as a
//     peer and mirrors its online agents under the remote's declared name as a
//     room subtree. State stays honest (reports are folded, not invented),
//     authority stays home (the remote's tokens decide), and federation does
//     not transit (mirrors of mirrors are never mirrored).
//   · the daemon FOLDS what it hears: lifecycle reports become per-agent state
//     (idle/busy/paused/error), counters, and a recent-events ring. State is truth.
//   · prompts on process (re)start / task fire are queued and delivered the
//     instant the worker (re)registers — the daemon owns the register moment,
//     so it orchestrates.
//   · processes = named remembered forks (stores.ts is the only memory).
//     `start` forks now (PM2 supervises, autorestart=true restarts with
//     backoff); boot clears stale PM2 state then submits kept processes.
//     The supervisor holds NO recipes — just live children and their death
//     facts. Definitions live in stores.ts.
// The daemon is NOT an agent. It manages agents; it never thinks.
// ============================================================================
import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import {
	ROOT_ROOM,
	DEFAULT_PORT,
	addressOf,
	normalizeRoom,
	parseFrame,
} from "../protocol.ts";
import type {
	AgentInfo,
	ClientFrame,
	ControlAction,
	RecentEvent,
	RegisterFrame,
	SwarmEvent,
	SwarmRole,
	WorkerState,
	WorkerStats,
} from "../protocol.ts";
import { Supervisor, type ExitFacts } from "./pm2.ts";
import { findTemplate, scanTemplates, type TemplateInfo } from "./templates.ts";
import {
	ensureNodeModulesLink,
	ensureScaffold,
	homeLayout,
	resolveHome,
	writeConfig,
} from "./config.ts";
import {
	TASK_GRACE_MIN_MS,
	computeNextFire,
	loadLegacyRecipes,
	loadProcesses,
	loadTasks,
	removeLegacyFile,
	saveProcesses,
	saveTasks,
	taskGraceFor,
	type ProcessDef,
	type TaskDef,
} from "./stores.ts";
import { handleRest } from "./rest.ts";
import { createMount } from "./federate.ts";
import type { FederationHost } from "./federate.ts";

export interface SwarmServerOptions {
	/** The daemon's home — where config.json, processes.json, tasks.json,
	 *  templates/ and sessions/ live. Default: $SWARM_HOME or ~/.sanity/swarm. */
	home?: string;
	addr?: string;
	/** 0 = random port (lands in onPort + state). */
	port?: number;
	/** The swarm's declared name — stamped onto every local address. Absent =
	 *  hermit mode: fully functional locally, federation refused in both directions. */
	name?: string;
	/** Per-role tokens. When configured, a register MUST present the token matching
	 *  its claimed mode (or no token → worker). Empty/undefined = open. */
	tokens?: Partial<Record<SwarmRole, string>>;
	/** Where the daemon scans for templates (spawnable workers). */
	templatesDir?: string;
	/** Legacy fleet.json path — read ONCE at boot for migration, then deleted.
	 *  processes.json + tasks.json are the only memory after that. */
	manifestPath?: string;
	/** Override the processes.json path (tests). */
	processesPath?: string;
	/** Override the tasks.json path (tests). */
	tasksPath?: string;
	onPort?: (port: number) => void;
}

interface Connection {
	ws: WebSocket;
	role: SwarmRole;
	sessionId?: string;
	/** Where this worker lives (worker) / the visibility prefix (peer/admin). */
	room: string;
	mode: SwarmRole;
	persistent: boolean;
	/** Subscribed addresses — the fan-out targets this connection listens to. */
	subscribed: Set<string>;
}

/** A mirror's live wire back to the daemon it came from. Mirrors route
 *  input/control/kill through this — the remote's tokens decide. */
export type MirrorForward = (frame: Record<string, unknown>) => void;

/** Agents only: whoever joined. No pid, no spawn flag — a process/task
 *  question is a category error here (ask processes/tasks, not agents). */
interface RegistryEntry {
	sessionId: string;
	agentId: string;
	description?: string;
	mode: SwarmRole;
	persistent: boolean;
	/** Backlink: process name / task fire id / spawn label (absent = wild). */
	parent?: string;
	/** Always set — the room this agent lives in (default "global"). */
	room: string;
	/** "local" | "mirrored" */
	origin: "local" | "mirrored";
	status: "online" | "offline";
	lastSeen: number;
	/** Derived runtime activity — folded from the agent's own reports. */
	state?: WorkerState;
	lastEvent?: SwarmEvent;
	lastEventAt?: number;
	stats: WorkerStats;
	/** Recent-events ring — lifecycle payloads only, capped. */
	recent: RecentEvent[];
	conn?: Connection;
	/** Mirrored only — routes ops to the home daemon over its peer socket. */
	forward?: MirrorForward;
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

/** The task clock period — due `every`/`at` tasks fire on this beat. */
const TASK_TICK_MS = 60_000;

/** What each role may do. The daemon enforces; the client's tools are convenience. */
const PERMS: Record<SwarmRole, Set<string>> = {
	worker: new Set(["register", "report", "ping"]),
	peer: new Set([
		"register",
		"report",
		"ping",
		"agents_list",
		"agents_get",
		// `list` is the federation mount's wire (federate.ts dials as peer and
		// rpcs `list`). Kept as a compat alias of agents_list — never advertised.
		"list",
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
		"agents_list",
		"agents_get",
		"list",
		"listen",
		"events",
		"history",
		"templates",
		"input",
		"control",
		// kill = terminate signal to ONE loop (never a process murder)
		"kill",
		"proc_start",
		"proc_save",
		"proc_stop",
		"proc_remove",
		"proc_set_autorestart",
		"proc_restart",
		"proc_list",
		"proc_get",
		"task_define",
		"task_fire",
		"task_trigger",
		"task_pause",
		"task_resume",
		"task_remove",
		"task_list",
		"task_get",
		"broadcast",
	]),
};

// ---------------------------------------------------------------------------
// THE API — one core, many surfaces. WS frames, REST routes and the CLI all
// speak exactly this. Sync by design: prompts for (re)starts and fires are
// QUEUED and delivered on register, never awaited mid-frame. The daemon is
// the only one who knows when a worker (re)registers — so prompt orchestration
// lives here.
// ---------------------------------------------------------------------------
export interface AgentApi {
	list(filter?: {
		status?: "online" | "offline";
		mode?: SwarmRole;
		agentId?: string;
		/** Visibility scope — only agents under this room subtree. */
		under?: string;
	}): AgentInfo[];
	get(sessionId: string, under?: string): AgentInfo | null;
	/** Terminate signal to one loop: a stop control to its socket, then the
	 *  socket drops. The process itself is untouched (phase 2 owns shutdown). */
	kill(sessionId: string, under?: string): { ok: boolean; sessionId: string };
}

export interface ProcessApi {
	list(): ProcessDef[];
	get(name: string): ProcessDef | null;
	/** Remember (creating when missing) + fork NOW. Async: connects first, then forks. */
	start(
		name: string,
		opts?: { file?: string; from?: string; autorestart?: boolean; prompt?: string },
	): Promise<{ name: string; sessionId: string; pid?: number } | null>;
	/** Remember without forking (create or update the definition). */
	save(
		name: string,
		opts?: { file?: string; from?: string; autorestart?: boolean },
	): ProcessDef | null;
	/** Murder the pid. Desired state → stopped. The agent socket is untouched. */
	stop(name: string): { ok: boolean; name: string };
	/** Stop + forget the definition. */
	remove(name: string): { ok: boolean; name: string };
	/** Flip the autorestart policy (PM2 owns enforcement). */
	setAutorestart(name: string, autorestart: boolean): { ok: boolean; name: string };
	/** Fresh fork under the same name; optional prompt delivered on re-register. Async: kill, then refork. */
	restart(name: string, opts?: { prompt?: string }): Promise<{ ok: boolean; name: string; sessionId?: string; pid?: number }>;
}

export interface TaskApi {
	list(): TaskDef[];
	get(name: string): TaskDef | null;
	/** Create or replace a definition (schedule recomputed, history preserved). */
	define(opts: {
		name: string;
		file?: string;
		from?: string;
		fire: "every" | "at" | "manual";
		everyMs?: number;
		at?: number;
	}): TaskDef | null;
	/** Fork once through the same fork path; stamps `task:<name>#<n>` parent. Async: connects first, then forks. */
	fire(name: string, opts?: { prompt?: string }): Promise<{ name: string; run: number; sessionId: string; pid?: number } | null>;
	/** Manual run on the paused-immune path: forks even when paused, schedule
	 *  untouched (definition's nextFire/at never move). Transient context is
	 *  delivered as the fork's prompt, never stored. At-most-once: a second
	 *  concurrent trigger while a claim is in flight returns busy instead of firing. */
	trigger(name: string, opts?: { context?: string; prompt?: string }): Promise<{ name: string; run: number; sessionId: string; pid?: number } | { busy: true; name: string } | null>;
	pause(name: string, paused?: boolean): { ok: boolean; name: string };
	resume(name: string): { ok: boolean; name: string };
	remove(name: string): { ok: boolean; name: string };
}

export interface FleetApi {
	agents: AgentApi;
	processes: ProcessApi;
	tasks: TaskApi;
	history(under?: string): AgentInfo[];
	templates(): TemplateInfo[];
	/** The recent-events ring of one agent (lifecycle payloads only). */
	events(
		sessionId: string,
		limit?: number,
		under?: string,
	): { sessionId: string; events: RecentEvent[] } | null;
	control(
		target: string,
		action: ControlAction,
		under?: string,
	): { ok: boolean; target: string; action: ControlAction } | null;
	input(
		target: string,
		body: Record<string, unknown>,
		under?: string,
	): { ok: boolean; target: string } | null;
}

/** One federation mount — the daemon dialing another daemon as a peer. */
export interface FederateOptions {
	/** The remote daemon's WS url — where. */
	url: string;
	/** Mount under this name instead of the remote's declared name. */
	as?: string;
	/** The peer token for the remote (when it has tokens configured). */
	token?: string;
}

export interface FederateResult {
	ok: boolean;
	/** The mount name actually claimed (remote's declared name or --as). */
	mount?: string;
	error?: string;
}

export interface SwarmServer {
	readonly port: number;
	start(): Promise<void>;
	stop(): Promise<void>;
	/** THE core — the same ops REST and the CLI speak. Embed away. */
	api: FleetApi;
	/** Registry snapshot — the observable truth. */
	registry(): AgentInfo[];
	/** History — every agent ever seen (resumable discovery). */
	history(): AgentInfo[];
	templates(): TemplateInfo[];
	/** Fire due `every`/`at` tasks now (the 60s clock calls this; tests call it directly). */
	tickTasks(now?: number): number;
	/** Test-only: mutate a task def in place (overdue setup without a redefine).
	 *  The daemon never calls this — only tests forcing nextFire into the past. */
	pokeTask(name: string, patch: Partial<TaskDef>): boolean;
	/** Dial another daemon and mirror its fleet under a room subtree.
	 *  Requires a declared name (hermits can't federate). Fire-and-forget:
	 *  the mount connects, retries, and follows the remote's truth. */
	federate(opts: FederateOptions): FederateResult;
}

export function createSwarmServer(opts: SwarmServerOptions = {}): SwarmServer {
	const {
		addr = "127.0.0.1",
		port = DEFAULT_PORT,
		tokens = {},
	} = opts;
	/** The stamp. Every local address starts with it (when declared). */
	const swarmName = opts.name?.trim() || undefined;

	// the daemon IS a location — resolve its home, scaffold it, derive the defaults
	const home = opts.home ?? resolveHome();
	ensureScaffold(home);
	ensureNodeModulesLink(home);
	const layout = homeLayout(home);
	const templatesDir = opts.templatesDir ?? layout.templatesDir;
	const sessionsDir = layout.sessionsDir;
	const processesPath = opts.processesPath ?? layout.processesPath;
	const tasksPath = opts.tasksPath ?? layout.tasksPath;
	const manifestPath = opts.manifestPath ?? layout.manifestPath;

	const bootedAt = Date.now();
	/** KEYED BY ADDRESS ("<swarm>/<room>/<sessionId>"). sessionId can collide
	 *  across swarms — never locally. The bySessionId index keeps bare sessionIds
	 *  working for everything local (first claim wins, locals outrank mirrors). */
	const registry = new Map<string, RegistryEntry>();
	const bySessionId = new Map<string, string>();
	const history = new Map<string, RegistryEntry>();
	/** Claimed mount names — collision policy is loud, never silent. */
	const mountNames = new Set<string>();
	const connections = new Set<Connection>();

	// ---- the only memory: definition files, loaded once, written through ----
	let processes = loadProcesses(processesPath);
	let tasks = loadTasks(tasksPath);
	const persistProcesses = (): void => saveProcesses(processesPath, [...processes.values()]);
	const persistTasks = (): void => saveTasks(tasksPath, [...tasks.values()]);

	/** Migrate fleet.json ONCE (pre-split recipes → remembered processes), then delete it. */
	const migrateLegacyFleet = (): void => {
		const recipes = loadLegacyRecipes(manifestPath);
		if (recipes.length === 0) {
			// still delete a present-but-empty/known file so the legacy is gone
			removeLegacyFile(manifestPath);
			return;
		}
		for (const r of recipes) {
			if (processes.has(r.sessionId)) continue;
			const now = Date.now();
			processes.set(r.sessionId, {
				name: r.sessionId,
				from: r.template,
				autorestart: false,
				status: "running",
				starts: 0,
				createdAt: now,
				updatedAt: now,
			});
		}
		persistProcesses();
		removeLegacyFile(manifestPath);
	};

	/** What the daemon does when a supervised child dies — the stores are the
	 *  memory, PM2 is the muscle. autorestart=true is ALREADY handled by PM2
	 *  (it restarts with backoff and the definition stays running); here we
	 *  only record the death when the child is staying dead. */
	const onChildExit = (label: string, facts: ExitFacts): void => {
		if (label.startsWith("proc:")) {
			const name = label.slice("proc:".length);
			const def = processes.get(name);
			if (!def) return;
			def.pid = undefined;
			def.lastExit = { ...facts };
			def.updatedAt = Date.now();
			// died and policy says stay dead — desired state follows.
			// (autorestart=true never reaches here as a final death: PM2
			// restarts it, the bus `restart` event clears the death.)
			def.status = "stopped";
			persistProcesses();
			return;
		}
		if (label.startsWith("task:")) {
			// `task:<name>#<n>` — record the outcome on the definition
			const rest = label.slice("task:".length);
			const hash = rest.lastIndexOf("#");
			const name = hash >= 0 ? rest.slice(0, hash) : rest;
			const def = tasks.get(name);
			if (!def) return;
			def.lastResult = { at: facts.at, code: facts.code, signal: facts.signal };
			def.updatedAt = Date.now();
			persistTasks();
		}
	};

	const supervisor = new Supervisor({
		homeDir: home,
		onExit: onChildExit,
		onRestart: (label) => {
			// PM2 restarted the child itself (autorestart=true) — the new life
			// owns the label. Count it like a refork and persist.
			if (!label.startsWith("proc:")) return;
			const def = processes.get(label.slice("proc:".length));
			if (!def) return;
			def.starts++;
			def.updatedAt = Date.now();
			persistProcesses();
		},
	});

	/** The visibility rule. A room is a path prefix; an ancestor sees its
	 *  descendants; sideways and upward: invisible. */
	const visible = (mount: string, room: string): boolean =>
		room === mount || room.startsWith(`${mount}/`);

	/** Target resolution — bare sessionId (index) or full address (contains "/").
	 *  Full address wins when it names a real entry; else fall back to the index. */
	const resolve = (target: string): RegistryEntry | null => {
		if (target.includes("/")) {
			const hit = registry.get(target);
			if (hit) return hit;
		}
		const addr = bySessionId.get(target);
		return addr ? (registry.get(addr) ?? null) : null;
	};

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
	let clockTimer: ReturnType<typeof setInterval> | undefined;

	/** The env every forked child inherits from the daemon — where it lives + who to join.
	 *  SWARM_SPAWN_ID (the parent backlink) is stamped per-fork by the supervisor. */
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

	const info = (e: RegistryEntry): AgentInfo => ({
		sessionId: e.sessionId,
		agentId: e.agentId,
		description: e.description,
		mode: e.mode,
		persistent: e.persistent,
		parent: e.parent,
		status: e.status,
		room: e.room,
		address: addressOf(swarmName, e.room, e.sessionId),
		origin: e.origin,
		state: e.state,
		lastEvent: e.lastEvent,
		lastEventAt: e.lastEventAt,
		stats: e.stats,
		lastSeen: e.lastSeen,
	});

	const snapshot = (mount: string = ROOT_ROOM): AgentInfo[] =>
		[...registry.values()]
			.filter((e) => visible(mount, e.room))
			.map(info);

	/** The registry key for a local worker — the swarm stamps itself. */
	const localKey = (room: string, sessionId: string): string =>
		addressOf(swarmName, room, sessionId);

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
		const room = normalizeRoom(frame.room);
		if (!room) {
			send(conn, {
				op: "error",
				reqOp: "register",
				error: `malformed room path: ${String(frame.room)}`,
			});
			conn.ws.close();
			return;
		}
		conn.role = role;
		conn.sessionId = frame.sessionId;
		// workers live where they claim; peer/admin MOUNT where they look
		conn.room = room;
		conn.mode = frame.mode;
		conn.persistent = frame.persistent;

		// re-identity: the same sessionId reconnecting replaces the old socket
		// (even under a different room — the old address is found and retired)
		const oldAddr = bySessionId.get(frame.sessionId);
		const old = oldAddr ? registry.get(oldAddr) : undefined;
		if (old?.conn) {
			old.conn.ws.close();
			connections.delete(old.conn);
		}
		if (oldAddr) registry.delete(oldAddr);

		const key = localKey(room, frame.sessionId);
		const entry: RegistryEntry = {
			sessionId: frame.sessionId,
			agentId: frame.agentId,
			description: frame.description,
			mode: frame.mode,
			persistent: frame.persistent,
			// the fork backlink: SWARM_SPAWN_ID echoed home (absent = wild)
			parent: typeof frame.spawnId === "string" && frame.spawnId ? frame.spawnId : undefined,
			room,
			origin: "local",
			status: "online",
			stats: old?.stats ?? freshStats(),
			recent: old?.recent ?? [],
			state: old?.state,
			lastSeen: Date.now(),
			conn,
		};
		registry.set(key, entry);
		bySessionId.set(frame.sessionId, key);
		const seen = history.get(key);
		history.set(key, { ...seen, ...entry, status: "online" });

		send(conn, {
			op: "welcome",
			sessionId: frame.sessionId,
			swarm: swarmName,
			registry: snapshot(conn.room),
		});

		// a queued prompt (process restart / task fire with prompt) is delivered
		// the moment the worker is back among the living
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

	/** Fan a voice out to subscribed mounts that can SEE it (the one visibility
	 *  rule), never back to the reporter itself. Mirrors report with no conn. */
	const fanOut = (
		entry: RegistryEntry,
		event: string,
		payload: unknown,
		except?: Connection,
	): void => {
		const key = addressOf(swarmName, entry.room, entry.sessionId);
		for (const sub of connections) {
			if (sub === except) continue;
			if (sub.subscribed.has(entry.sessionId) || sub.subscribed.has(key)) {
				if (!visible(sub.room, entry.room)) continue;
				send(sub, {
					op: "event",
					target: entry.sessionId,
					event: event as SwarmEvent,
					payload,
				});
			}
		}
	};

	const onReport = (
		conn: Connection,
		frame: { event: string; payload?: unknown },
	): void => {
		if (!conn.sessionId) return;
		const key = bySessionId.get(conn.sessionId);
		const entry = key ? registry.get(key) : undefined;
		if (entry) {
			entry.lastSeen = Date.now();
			fold(entry, frame.event, frame.payload);
		}
		if (entry) fanOut(entry, frame.event, frame.payload, conn);
	};

	/** Resolve a process/task source to an agent file. `file` wins when given;
	 *  `from` is a template id/file. Null = unknown (the caller 404s). */
	const resolveAgentFile = (
		file?: string,
		from?: string,
	): { path: string; env?: Record<string, string> } | null => {
		if (typeof file === "string" && file) {
			return existsSync(file) ? { path: file } : null;
		}
		if (typeof from === "string" && from) {
			const t = findTemplate(templatesDir, from);
			return t ? { path: t.path, env: t.env } : null;
		}
		return null;
	};

	/** THE one fork path — process start AND task fire share it. Deferred: the
	 *  caller enqueues this promise — the api stays sync, the fork lands async. */
	const forkLabeled = (
		parentLabel: string,
		internalLabel: string,
		agentFile: string,
		templateEnv?: Record<string, string>,
		prompt?: string,
		autorestart = false,
	): Promise<{ sessionId: string; pid?: number }> =>
		supervisor
			.fork(agentFile, {
				label: internalLabel,
				autorestart,
				templateEnv,
				extraEnv: { ...spawnEnv(), SWARM_SPAWN_ID: parentLabel },
			})
			.then((r) => {
				if (prompt) queuePrompt(r.sessionId, prompt);
				return r;
			});

	/** Durable claim — the heart of exactly-once. Bump runs, advance nextFire
	 *  (or consume the one-shot), stamp pendingFire, and PERSIST — all before
	 *  the fork. `fireClaimed` returns the claim; `fireSettled` clears
	 *  pendingFire after the fork lands (or converts a failed fork into a
	 *  logged skip). The claim's slot is the fire identity: crashes between
	 *  claim and fork leave pendingFire for boot to account as a logged skip. */
	const fireClaimed = (
		def: TaskDef,
		slot: number,
		now: number,
		origin: "tick" | "fire" | "trigger",
	): boolean => {
		if (def.pendingFire) return false;
		def.runs++;
		def.lastFire = now;
		def.lastSlot = slot;
		if (def.fire === "every" && def.everyMs) {
			def.nextFire = slot + def.everyMs;
		} else {
			if (def.fire === "at") def.at = undefined;
			def.nextFire = undefined;
		}
		if (origin === "trigger") def.lastTrigger = { at: now, run: def.runs };
		def.pendingFire = { run: def.runs, slot, claimedAt: now, origin };
		def.updatedAt = now;
		persistTasks();
		return true;
	};
	const fireSettled = (
		def: TaskDef,
		ok: boolean,
		reason: string,
	): void => {
		const slot = def.pendingFire?.slot ?? def.lastSlot ?? Date.now();
		def.pendingFire = undefined;
		if (!ok) def.lastSkipped = { slot, at: Date.now(), reason };
		def.updatedAt = Date.now();
		persistTasks();
	};

	// ---------------------------------------------------------------------------
	// THE CORE — every surface below this line is an adapter over `api`.
	// ---------------------------------------------------------------------------
	const api: FleetApi = {
		agents: {
			list(filter) {
				let rows = snapshot(filter?.under ?? ROOT_ROOM);
				if (filter?.status) rows = rows.filter((r) => r.status === filter.status);
				if (filter?.mode) rows = rows.filter((r) => r.mode === filter.mode);
				if (filter?.agentId) rows = rows.filter((r) => r.agentId === filter.agentId);
				return rows;
			},

			get(sessionId, under) {
				const e = resolve(sessionId);
				if (!e) return null;
				// 404 semantics: a room you can't see doesn't exist
				if (under && !visible(under, e.room)) return null;
				return info(e);
			},

			kill(sessionId, under) {
				const e = resolve(sessionId);
				if (!e) return { ok: false, sessionId };
				if (under && !visible(under, e.room)) return { ok: false, sessionId };
				if (e.origin === "mirrored") {
					// authority stays home — the remote daemon decides if it may die
					e.forward?.({ op: "kill", sessionId: e.sessionId });
					return { ok: true, sessionId: e.sessionId };
				}
				// terminate signal to the one loop, then the socket drops.
				// The process itself is untouched — wild or forked, killing a
				// process is processes.stop's job, never the agent door's.
				if (e.conn) {
					send(e.conn, { op: "control", action: "stop" });
					e.conn.ws.close();
					e.status = "offline";
					e.conn = undefined;
					e.lastSeen = Date.now();
				}
				return { ok: true, sessionId: e.sessionId };
			},
		},

		processes: {
			list() {
				return [...processes.values()];
			},

			get(name) {
				return processes.get(name) ?? null;
			},

			async start(name, startOpts = {}) {
				let def = processes.get(name);
				if (!def) {
					if (startOpts.file === undefined && startOpts.from === undefined) return null;
					const now = Date.now();
					def = {
						name,
						file: startOpts.file,
						from: startOpts.from,
						autorestart: startOpts.autorestart ?? false,
						status: "stopped",
						starts: 0,
						createdAt: now,
						updatedAt: now,
					};
					processes.set(name, def);
				} else {
					if (startOpts.file !== undefined) def.file = startOpts.file;
					if (startOpts.from !== undefined) def.from = startOpts.from;
					if (startOpts.autorestart !== undefined) def.autorestart = startOpts.autorestart;
				}
				const target = resolveAgentFile(def.file, def.from);
				if (!target) return null;
				def.status = "running";
				def.starts++;
				def.updatedAt = Date.now();
				persistProcesses();
				const label = `proc:${name}`;
				const r = await forkLabeled(name, label, target.path, target.env, startOpts.prompt, def.autorestart);
				def.pid = r.pid;
				def.updatedAt = Date.now();
				persistProcesses();
				return { name, sessionId: r.sessionId, pid: r.pid };
			},

			save(name, saveOpts = {}) {
				let def = processes.get(name);
				const now = Date.now();
				if (!def) {
					def = {
						name,
						file: saveOpts.file,
						from: saveOpts.from,
						autorestart: saveOpts.autorestart ?? false,
						status: "stopped",
						starts: 0,
						createdAt: now,
						updatedAt: now,
					};
					processes.set(name, def);
				} else {
					if (saveOpts.file !== undefined) def.file = saveOpts.file;
					if (saveOpts.from !== undefined) def.from = saveOpts.from;
					if (saveOpts.autorestart !== undefined) def.autorestart = saveOpts.autorestart;
					def.updatedAt = now;
				}
				persistProcesses();
				return { ...def };
			},

			stop(name) {
				const def = processes.get(name);
				if (!def) return { ok: false, name };
				// murder the label — the agent socket is untouched (it drops itself)
				supervisor.killSync(`proc:${name}`);
				def.status = "stopped";
				def.pid = undefined;
				def.updatedAt = Date.now();
				persistProcesses();
				return { ok: true, name };
			},

			remove(name) {
				const def = processes.get(name);
				if (!def) return { ok: false, name };
				supervisor.killSync(`proc:${name}`);
				processes.delete(name);
				persistProcesses();
				return { ok: true, name };
			},

			setAutorestart(name, autorestart) {
				const def = processes.get(name);
				if (!def) return { ok: false, name };
				def.autorestart = autorestart;
				def.updatedAt = Date.now();
				persistProcesses();
				return { ok: true, name };
			},

			async restart(name, restartOpts = {}) {
				const def = processes.get(name);
				if (!def) return { ok: false, name };
				const target = resolveAgentFile(def.file, def.from);
				if (!target) return { ok: false, name };
				const label = `proc:${name}`;
				await supervisor.kill(label);
				supervisor.killSync(label);
				const r = await forkLabeled(name, label, target.path, target.env, restartOpts.prompt, def.autorestart);
				def.status = "running";
				def.pid = r.pid;
				def.starts++;
				def.updatedAt = Date.now();
				persistProcesses();
				return { ok: true, name, sessionId: r.sessionId, pid: r.pid };
			},
		},

		tasks: {
			list() {
				return [...tasks.values()];
			},

			get(name) {
				return tasks.get(name) ?? null;
			},

			define(opts) {
				const { name, fire } = opts;
				if (!name) return null;
				if (fire !== "every" && fire !== "at" && fire !== "manual") return null;
				if (fire === "every" && !(typeof opts.everyMs === "number" && opts.everyMs > 0)) return null;
				if (fire === "at" && typeof opts.at !== "number") return null;
				const now = Date.now();
				const prev = tasks.get(name);
				const def: TaskDef = {
					name,
					file: opts.file ?? prev?.file,
					from: opts.from ?? prev?.from,
					fire,
					everyMs: fire === "every" ? opts.everyMs : undefined,
					at: fire === "at" ? opts.at : undefined,
					paused: false,
					runs: prev?.runs ?? 0,
					lastFire: prev?.lastFire,
					lastSlot: prev?.lastSlot,
					lastCatchup: prev?.lastCatchup,
					lastSkipped: prev?.lastSkipped,
					lastTrigger: prev?.lastTrigger,
					lastResult: prev?.lastResult,
					createdAt: prev?.createdAt ?? now,
					updatedAt: now,
				};
				def.nextFire = computeNextFire(def, now);
				tasks.set(name, def);
				persistTasks();
				return { ...def };
			},

			/** Claim a scheduled slot: runs++ + nextFire advanced + persisted
			 *  BEFORE the fork. A crash after this point leaves pendingFire,
			 *  which boot converts into a logged skip — never a silent loss,
			 *  never a refire. */
			async fire(name, fireOpts = {}) {
				const def = tasks.get(name);
				if (!def) return null;
				const target = resolveAgentFile(def.file, def.from);
				if (!target) return null;
				// Manual fires on a paused task are refused — use `trigger`.
				if (def.paused) return null;
				const now = Date.now();
				const slot = def.nextFire ?? def.at ?? now;
				if (!fireClaimed(def, slot, now, "fire")) return null;
				let r: { sessionId: string; pid?: number };
				try {
					const parent = `task:${name}#${def.runs}`;
					r = await forkLabeled(parent, parent, target.path, target.env, fireOpts.prompt);
				} catch {
					fireSettled(def, false, "fire fork failed");
					return null;
				}
				fireSettled(def, true, "");
				return { name, run: def.runs, sessionId: r.sessionId, pid: r.pid };
			},

			/** Paused-immune manual run: claim runs++ + persist BEFORE the fork
			 *  (schedule fields' nextFire/at never move), at-most-once via pendingFire. */
			async trigger(name, triggerOpts = {}) {
				const def = tasks.get(name);
				if (!def) return null;
				const target = resolveAgentFile(def.file, def.from);
				if (!target) return null;
				if (def.pendingFire) return { busy: true, name };
				const now = Date.now();
				// Trigger rides the claim so the fire identity advances uniformly —
				// but the schedule is untouched, so restore the slot math after.
				const keepNext = def.nextFire;
				const keepAt = def.at;
				if (!fireClaimed(def, now, now, "trigger")) return { busy: true, name };
				def.nextFire = keepNext;
				def.at = keepAt;
				persistTasks();
				let r: { sessionId: string; pid?: number };
				try {
					const parent = `task:${name}#${def.runs}`;
					r = await forkLabeled(
						parent,
						parent,
						target.path,
						target.env,
						triggerOpts.context ?? triggerOpts.prompt,
					);
				} catch {
					fireSettled(def, false, "trigger fork failed");
					return null;
				}
				fireSettled(def, true, "");
				return { name, run: def.runs, sessionId: r.sessionId, pid: r.pid };
			},

			pause(name, paused = true) {
				const def = tasks.get(name);
				if (!def) return { ok: false, name };
				def.paused = paused;
				def.updatedAt = Date.now();
				persistTasks();
				return { ok: true, name };
			},

			resume(name) {
				const def = tasks.get(name);
				if (!def) return { ok: false, name };
				def.paused = false;
				def.updatedAt = Date.now();
				persistTasks();
				return { ok: true, name };
			},

			remove(name) {
				if (!tasks.has(name)) return { ok: false, name };
				// in-flight runs keep running — fire-and-die, the daemon forgets only the definition
				tasks.delete(name);
				persistTasks();
				return { ok: true, name };
			},
		},

		history(under) {
			const mount = under ?? ROOT_ROOM;
			return [...history.values()]
				.filter((e) => visible(mount, e.room))
				.map(info);
		},

		templates() {
			return scanTemplates(templatesDir);
		},

		events(sessionId, limit = 100, under) {
			const e = resolve(sessionId);
			if (!e) return null;
			if (under && !visible(under, e.room)) return null;
			return { sessionId, events: e.recent.slice(-Math.max(1, limit)) };
		},

		control(target, action, under) {
			const e = resolve(target);
			if (!e) return null;
			if (under && !visible(under, e.room)) return null;
			if (e.origin === "mirrored") {
				// routed as-is; the REMOTE's tokens decide whether it lands
				e.forward?.({ op: "control", target: e.sessionId, action });
				return { ok: true, target, action };
			}
			if (!e.conn) return null;
			send(e.conn, { op: "control", action });
			// optimistic — the worker's next report corrects us if it disagrees
			e.state = action === "pause" ? "paused" : "idle";
			return { ok: true, target, action };
		},

		input(target, body, under) {
			const e = resolve(target);
			if (!e) return null;
			if (under && !visible(under, e.room)) return null;
			if (e.origin === "mirrored") {
				e.forward?.({ op: "input", target: e.sessionId, body });
				return { ok: true, target };
			}
			if (!e.conn) return null;
			send(e.conn, { op: "input", body });
			return { ok: true, target };
		},
	};

	/** Fire every due `every`/`at` task (unless paused). Durable: each slot is
	 *  claimed (runs++ + nextFire advanced + persisted) BEFORE the fork, so a
	 *  crash can't refire. Late-within-grace fires late; past-grace collapses
	 *  missed `every` slots into ONE catch-up fire with a logged reason;
	 *  past-grace `at` one-shots log a skip instead of forking. Deferred:
	 *  forks land async; count is claimed fires. */
	const tickTasks = (now: number = Date.now()): number => {
		let fired = 0;
		for (const def of tasks.values()) {
			if (def.paused) continue;
			if (def.pendingFire) continue;
			if (def.fire === "every") {
				if (def.nextFire === undefined) {
					def.nextFire = computeNextFire(def, now);
					continue;
				}
				if (now < def.nextFire) continue;
				const grace = taskGraceFor(def.everyMs);
				const lateBy = now - def.nextFire;
				if (lateBy <= grace) {
					const slot = def.nextFire;
					if (!fireClaimed(def, slot, now, "tick")) continue;
					const target = resolveAgentFile(def.file, def.from);
					if (!target) {
						fireSettled(def, false, "tick fork failed: unknown agent file");
						continue;
					}
					const run = def.runs;
					const parent = `task:${def.name}#${run}`;
					forkLabeled(parent, parent, target.path, target.env).then(
						() => fireSettled(def, true, ""),
						() => fireSettled(def, false, "tick fork failed"),
					);
					fired++;
				} else {
					// Past grace: collapse every missed slot since nextFire into
					// ONE fire now (the catch-up), with the miss logged on the def.
					const missed = Math.max(1, Math.floor(lateBy / (def.everyMs ?? lateBy)));
					const slot = now;
					def.lastCatchup = {
						slot,
						missed,
						at: now,
						reason: `${missed} slot${missed === 1 ? "" : "s"} missed (late ${Math.round(lateBy / 1000)}s > grace ${Math.round(grace / 1000)}s) — one catch-up fire`,
					};
					if (!fireClaimed(def, slot, now, "tick")) continue;
					const target = resolveAgentFile(def.file, def.from);
					if (!target) {
						fireSettled(def, false, "tick fork failed: unknown agent file");
						continue;
					}
					const run = def.runs;
					const parent = `task:${def.name}#${run}`;
					forkLabeled(parent, parent, target.path, target.env).then(
						() => fireSettled(def, true, ""),
						() => fireSettled(def, false, "tick fork failed"),
					);
					fired++;
				}
			} else if (def.fire === "at") {
				if (def.at !== undefined && now >= def.at) {
					const dueAt = def.at;
					// `at` slots are punctual one-shots: past-grace they log a
					// skip instead of forking a stale moment (never silent).
					if (now - dueAt > TASK_GRACE_MIN_MS) {
						def.at = undefined;
						def.nextFire = undefined;
						def.lastSkipped = {
							slot: dueAt,
							at: now,
							reason: `at slot missed by ${Math.round((now - dueAt) / 1000)}s past grace — logged skip`,
						};
						def.updatedAt = now;
						persistTasks();
						continue;
					}
					if (!fireClaimed(def, dueAt, now, "tick")) continue;
					const target = resolveAgentFile(def.file, def.from);
					if (!target) {
						fireSettled(def, false, "tick fork failed: unknown agent file");
						continue;
					}
					const run = def.runs;
					const parent = `task:${def.name}#${run}`;
					forkLabeled(parent, parent, target.path, target.env).then(
						() => fireSettled(def, true, ""),
						() => fireSettled(def, false, "tick fork failed"),
					);
					fired++;
				}
			}
		}
		return fired;
	};

	// ---------------------------------------------------------------------------
	// FEDERATION HOST — what a mount (federate.ts) may do to this daemon's state.
	// Mirrors follow the remote's truth: upserted from its registry snapshot,
	// advanced only by its workers' own reports, removed when it forgets them.
	// ---------------------------------------------------------------------------
	const host: FederationHost = {
		swarmName,

		claimMount(name: string): boolean {
			if (!swarmName) return false;
			// your own name is not a valid mount — that way lies a mirror loop
			if (name === swarmName || mountNames.has(name)) return false;
			mountNames.add(name);
			return true;
		},

		releaseMount(name: string): void {
			mountNames.delete(name);
		},

		/** Follow the remote's registry: upsert its workers as mirrors, remove the
		 *  ones it forgot. No transit — the remote's own mirrors are skipped.
		 *  Mirrors live UNDER the root room (global/<mount>/...) so the default
		 *  mount sees them — the global ones see the rooms. */
		syncMount(mount, remote, forward) {
			const roomPrefix = `${ROOT_ROOM}/${mount}/`;
			const desired = remote.filter((w) => w.origin !== "mirrored");
			const keep = new Set<string>();
			const links: { sessionId: string; address: string }[] = [];
			for (const w of desired) {
				const room = `${ROOT_ROOM}/${mount}/${normalizeRoom(w.room) ?? ROOT_ROOM}`;
				const key = addressOf(swarmName, room, w.sessionId);
				keep.add(key);
				links.push({ sessionId: w.sessionId, address: key });
				const existing = registry.get(key);
				if (existing) {
					// identity refresh only — derived state stays folded, never clobbered
					existing.agentId = w.agentId;
					existing.description = w.description;
					existing.mode = w.mode;
					existing.persistent = w.persistent;
					existing.parent = w.parent;
					existing.status = w.status;
					existing.forward = forward;
					existing.lastSeen = Date.now();
				} else {
					registry.set(key, {
						sessionId: w.sessionId,
						agentId: w.agentId,
						description: w.description,
						mode: w.mode,
						persistent: w.persistent,
						parent: w.parent,
						room,
						origin: "mirrored",
						status: w.status,
						stats: freshStats(),
						recent: [],
						lastSeen: Date.now(),
						forward,
					});
					// bare-sessionId index: locals outrank mirrors, always
					if (!bySessionId.has(w.sessionId)) bySessionId.set(w.sessionId, key);
				}
				const now = registry.get(key)!;
				history.set(key, { ...history.get(key), ...now });
			}
			for (const [key, e] of registry) {
				if (
					e.origin === "mirrored" &&
					e.room.startsWith(roomPrefix) &&
					!keep.has(key)
				) {
					// the remote forgot it — we follow its truth, no ghosts
					registry.delete(key);
					if (bySessionId.get(e.sessionId) === key)
						bySessionId.delete(e.sessionId);
				}
			}
			return links;
		},

		/** A mount lost its wire — every mirror under it follows into offline. */
		setMountStatus(mount: string, status: "online" | "offline"): void {
			const roomPrefix = `${ROOT_ROOM}/${mount}/`;
			for (const e of registry.values()) {
				if (e.origin === "mirrored" && e.room.startsWith(roomPrefix)) {
					e.status = status;
					e.lastSeen = Date.now();
				}
			}
		},

		/** A relayed voice from a mirrored worker — folded, never invented. */
		reportEntry(key: string, event: string, payload: unknown): void {
			const e = registry.get(key);
			if (!e) return;
			e.status = "online";
			e.lastSeen = Date.now();
			fold(e, event, payload);
			fanOut(e, event, payload);
		},
	};

	const mountStoppers = new Set<() => void>();

	const federate = (fedOpts: FederateOptions): FederateResult => {
		if (!swarmName) {
			return {
				ok: false,
				error:
					"this daemon is unnamed (hermit) — declare --name to federate",
			};
		}
		const handle = createMount(host, fedOpts);
		mountStoppers.add(() => handle.stop());
		return { ok: true };
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
			case "agents_list":
			case "list":
				if (!hasPerm(conn, frame.op)) break;
				result(conn, frame, frame.op, api.agents.list({ under: conn.room }));
				return;
			case "agents_get":
				if (!hasPerm(conn, "agents_get")) break;
				result(conn, frame, "agents_get", api.agents.get(frame.sessionId, conn.room));
				return;
			case "listen":
				if (!hasPerm(conn, "listen")) break;
				{
					// resolve to the registry ADDRESS — the fan-out speaks addresses
					const e = resolve(frame.sessionId);
					if (e) {
						const key = addressOf(swarmName, e.room, e.sessionId);
						if (frame.on) conn.subscribed.add(key);
						else conn.subscribed.delete(key);
					}
				}
				result(conn, frame, "listen", {
					on: frame.on,
					sessionId: frame.sessionId,
				});
				return;
			case "events":
				if (!hasPerm(conn, "events")) break;
				{
					const r = api.events(frame.sessionId, frame.limit, conn.room);
					if (!r) fail(conn, frame, "events", `unknown worker: ${frame.sessionId}`);
					else result(conn, frame, "events", r);
				}
				return;
			case "history":
				if (!hasPerm(conn, "history")) break;
				result(conn, frame, "history", api.history(conn.room));
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
			case "kill":
				if (!hasPerm(conn, "kill")) break;
				result(conn, frame, "kill", api.agents.kill(frame.sessionId));
				return;
			case "proc_start":
				if (!hasPerm(conn, "proc_start")) break;
				api.processes.start(frame.name, {
					file: frame.file,
					from: frame.from,
					autorestart: frame.autorestart,
					prompt: frame.prompt,
				}).then(
					(r) => {
						if (!r) fail(conn, frame, "proc_start", `unknown template/file: ${frame.from ?? frame.file ?? "(none)"}`);
						else result(conn, frame, "proc_start", r);
					},
					(err) => fail(conn, frame, "proc_start", err instanceof Error ? err.message : String(err)),
				);
				return;
			case "proc_save":
				if (!hasPerm(conn, "proc_save")) break;
				{
					const r = api.processes.save(frame.name, {
						file: frame.file,
						from: frame.from,
						autorestart: frame.autorestart,
					});
					if (!r) fail(conn, frame, "proc_save", `cannot save process: ${frame.name}`);
					else result(conn, frame, "proc_save", r);
				}
				return;
			case "proc_stop":
				if (!hasPerm(conn, "proc_stop")) break;
				result(conn, frame, "proc_stop", api.processes.stop(frame.name));
				return;
			case "proc_remove":
				if (!hasPerm(conn, "proc_remove")) break;
				result(conn, frame, "proc_remove", api.processes.remove(frame.name));
				return;
			case "proc_set_autorestart":
				if (!hasPerm(conn, "proc_set_autorestart")) break;
				result(conn, frame, "proc_set_autorestart", api.processes.setAutorestart(frame.name, frame.autorestart));
				return;
			case "proc_restart":
				if (!hasPerm(conn, "proc_restart")) break;
				api.processes.restart(frame.name, { prompt: frame.prompt }).then(
					(r) => {
						if (!r.ok) fail(conn, frame, "proc_restart", `unknown process / missing agent file: ${frame.name}`);
						else result(conn, frame, "proc_restart", r);
					},
					(err) => fail(conn, frame, "proc_restart", err instanceof Error ? err.message : String(err)),
				);
				return;
			case "proc_list":
				if (!hasPerm(conn, "proc_list")) break;
				result(conn, frame, "proc_list", api.processes.list());
				return;
			case "proc_get":
				if (!hasPerm(conn, "proc_get")) break;
				{
					const r = api.processes.get(frame.name);
					if (!r) fail(conn, frame, "proc_get", `unknown process: ${frame.name}`);
					else result(conn, frame, "proc_get", r);
				}
				return;
			case "task_define":
				if (!hasPerm(conn, "task_define")) break;
				{
					const r = api.tasks.define({
						name: frame.name,
						file: frame.file,
						from: frame.from,
						fire: frame.fire,
						everyMs: frame.everyMs,
						at: frame.at,
					});
					if (!r) fail(conn, frame, "task_define", `bad task definition: ${frame.name}`);
					else result(conn, frame, "task_define", r);
				}
				return;
			case "task_fire":
				if (!hasPerm(conn, "task_fire")) break;
				api.tasks.fire(frame.name, { prompt: frame.prompt }).then(
					(rr) => {
						if (!rr) fail(conn, frame, "task_fire", `unknown task / missing agent file / paused (use trigger): ${frame.name}`);
						else result(conn, frame, "task_fire", rr);
					},
					(err) => fail(conn, frame, "task_fire", err instanceof Error ? err.message : String(err)),
				);
				return;
			case "task_trigger":
				if (!hasPerm(conn, "task_trigger")) break;
				api.tasks.trigger(frame.name, { context: frame.context, prompt: frame.prompt }).then(
					(rr) => {
						if (!rr) fail(conn, frame, "task_trigger", `unknown task / missing agent file: ${frame.name}`);
						else if ("busy" in rr && rr.busy)
							fail(conn, frame, "task_trigger", `task ${frame.name} already firing (at-most-once)`);
						else result(conn, frame, "task_trigger", rr);
					},
					(err) => fail(conn, frame, "task_trigger", err instanceof Error ? err.message : String(err)),
				);
				return;
			case "task_pause":
				if (!hasPerm(conn, "task_pause")) break;
				result(conn, frame, "task_pause", api.tasks.pause(frame.name, frame.paused));
				return;
			case "task_resume":
				if (!hasPerm(conn, "task_resume")) break;
				result(conn, frame, "task_resume", api.tasks.resume(frame.name));
				return;
			case "task_remove":
				if (!hasPerm(conn, "task_remove")) break;
				result(conn, frame, "task_remove", api.tasks.remove(frame.name));
				return;
			case "task_list":
				if (!hasPerm(conn, "task_list")) break;
				result(conn, frame, "task_list", api.tasks.list());
				return;
			case "task_get":
				if (!hasPerm(conn, "task_get")) break;
				{
					const r = api.tasks.get(frame.name);
					if (!r) fail(conn, frame, "task_get", `unknown task: ${frame.name}`);
					else result(conn, frame, "task_get", r);
				}
				return;
			case "broadcast":
				if (!hasPerm(conn, "broadcast")) break;
				{
					// blast radius = caller's mount ∩ explicit room scope ∩ online WORKERS.
					// Agents only — processes/tasks are definitions, not listeners.
					const scope = frame.room
						? (normalizeRoom(frame.room) ?? ROOT_ROOM)
						: ROOT_ROOM;
					const inScope = (e: RegistryEntry): boolean =>
						e.status === "online" &&
						e.mode === "worker" &&
						visible(conn.room, e.room) &&
						visible(scope, e.room);
					const targets = frame.targets
						? frame.targets
								.map((t) => resolve(t))
								.filter((e): e is RegistryEntry => !!e && inScope(e))
								.map((e) => e.sessionId)
						: [...registry.values()]
								.filter(inScope)
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
			migrateLegacyFleet();
			// Boot reconciliation: a crash between claim and fork leaves
			// pendingFire on the def. That slot is NEVER refired and NEVER
			// silent — it lands as a logged skip, and the schedule marches on.
			{
				let dirty = false;
				const now = Date.now();
				for (const def of tasks.values()) {
					if (!def.pendingFire) continue;
					const slot = def.pendingFire.slot;
					const origin = def.pendingFire.origin;
					const run = def.pendingFire.run;
					def.pendingFire = undefined;
					def.lastSkipped = {
						slot,
						at: now,
						reason: `daemon ${origin === "tick" ? "restarted" : origin} mid-fire (run #${run}) — slot claimed before the fork, never confirmed; logged skip, no refire`,
					};
					def.updatedAt = now;
					dirty = true;
				}
				if (dirty) persistTasks();
			}
			for (const def of processes.values()) {
				if (def.status !== "running") continue;
				const target = resolveAgentFile(def.file, def.from);
				if (!target) {
					def.status = "stopped";
					continue;
				}
				try {
					const r = await supervisor.fork(target.path, {
						label: `proc:${def.name}`,
						autorestart: def.autorestart,
						templateEnv: target.env,
						extraEnv: { ...spawnEnv(), SWARM_SPAWN_ID: def.name },
					});
					def.pid = r.pid;
					def.starts++;
				} catch {
					def.status = "stopped";
				}
			}
			persistProcesses();
			// the task clock — fires due `every`/`at` tasks unless paused
			clockTimer = setInterval(() => {
				try {
					tickTasks();
				} catch {
					/* the clock is a courtesy, never a contract */
				}
			}, TASK_TICK_MS);
			clockTimer.unref?.();
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
					room: ROOT_ROOM,
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
						const key = bySessionId.get(conn.sessionId);
						const entry = key ? registry.get(key) : undefined;
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
			name: swarmName,
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
			if (clockTimer) {
				clearInterval(clockTimer);
				clockTimer = undefined;
			}
			for (const stop of mountStoppers) stop();
			mountStoppers.clear();
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
			// clean shutdown: stop every child, then detach from the scoped daemon
			await supervisor.stopAll();
			supervisor.disconnect();
		},

		registry() {
			return snapshot(ROOT_ROOM);
		},

		history() {
			return [...history.values()].map(info);
		},

		templates() {
			return scanTemplates(templatesDir);
		},

		tickTasks(now?: number) {
			return tickTasks(now);
		},

		pokeTask(name, patch) {
			const def = tasks.get(name);
			if (!def) return false;
			Object.assign(def, patch);
			persistTasks();
			return true;
		},

		federate,
	};
}
