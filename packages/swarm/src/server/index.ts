// ============================================================================
// sanity/src/packages/swarm/src/server/index.ts — THE DAEMON. A dumb hypervisor:
//   · WS hub — routes frames by address, fan-outs streams to subscribers. It
//     never interprets a payload, only its shape (the core is type-blind, so is
//     the hub).
//   · ONE API, MANY SURFACES — the ops live in FleetApi (agents/programs/runs
//     namespaces); WS frames, REST routes (rest.ts) and the CLI (a WS client)
//     are thin adapters over the same core.
//   · registry (live agents only) + history (every agent ever seen). Agents are
//     whoever joined — wild (no parent) or forked (parent = run id echoed from
//     SWARM_SPAWN_ID).
//   · PROGRAMS = named remembered definitions (stores.ts is the only memory).
//     Services are remembered forks (desired=running reforks at boot);
//     jobs are fire-and-die schedules (every/cron/at/manual).
//   · RUNS = the ledger (runs.ts). Every fork leaves exactly one run:
//     <home>/runs/<id>/ (meta.json + stdout.log + stderr.log + exit.json).
//   · The supervisor (supervisor.ts) owns fork/kill mechanics ONLY —
//     autorestart is ALWAYS false at its level. The daemon owns restart policy
//     (kill run + new run law): service respawn, job retries, crash-loop guard.
//   · A 1s clock fires due schedules unless paused. Every slot is claimed
//     (counters.runs++ + lastSlot + nextFire + pendingClaim, persisted BEFORE
//     the fork) so a crash can't refire and never silently loses a slot.
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
//   · prompts on (re)start / manual launch are queued and delivered the
//     instant the worker (re)registers — the daemon owns the register moment,
//     so it orchestrates.
// The daemon is NOT an agent. It manages agents; it never thinks.
// ============================================================================
import { createServer, type IncomingMessage, type Server } from "node:http";
import { closeSync, createWriteStream, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Writable } from "node:stream";
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
	ProgramFields,
	ProgramSpawnFrame,
	RecentEvent,
	RegisterFrame,
	SwarmEvent,
	SwarmRole,
	WorkerState,
	WorkerStats,
} from "../protocol.ts";
import {
	Supervisor,
	acquireHomeLock,
	releaseHomeLock,
	type ExitFacts,
	type SpawnSpec,
} from "./supervisor.ts";
import { findTemplate, scanTemplates, type TemplateInfo } from "./templates.ts";
import {
	ensureNodeModulesLink,
	ensureScaffold,
	homeLayout,
	resolveHome,
	writeConfig,
} from "./config.ts";
import {
	catchupWindowFor,
	computeNextFire,
	loadProcesses,
	loadPrograms,
	loadTasks,
	migrateLegacy,
	previewRuns,
	savePrograms,
	validateProgram,
	type ProgramDef,
	type ProgramSpawn,
} from "./stores.ts";
import { RunStore, deriveStatus, type RunRecord, type RunState } from "./runs.ts";
import { handleRest } from "./rest.ts";
import { createMount } from "./federate.ts";
import type { FederationHost } from "./federate.ts";

export interface SwarmServerOptions {
	/** The daemon's home — where config.json, programs.json, runs/,
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
	 *  programs.json is the only memory after that. */
	manifestPath?: string;
	/** Override the programs.json path (tests). */
	programsPath?: string;
	/** Legacy overrides for migration: processes.json/tasks.json are read at
	 *  boot ONLY when programs.json is absent. Kept, never deleted silently. */
	processesPath?: string;
	/** Legacy override for migration (see processesPath). */
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
 *  input/control/drop through this — the remote's tokens decide. */
export type MirrorForward = (frame: Record<string, unknown>) => void;

/** Agents only: whoever joined. No pid, no spawn flag — a program/run
 *  question is a category error here (ask programs/runs, not agents). */
interface RegistryEntry {
	sessionId: string;
	agentId: string;
	description?: string;
	mode: SwarmRole;
	persistent: boolean;
	/** Backlink: run id echoed from SWARM_SPAWN_ID (absent = wild). */
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

/** The program clock period — due schedules fire on this beat. Sub-minute
 *  precision: 1s. NOTE: setInterval drifts under load — the clock is a
 *  courtesy, never a contract; every slot is claimed before the fork so a
 *  late beat fires late (inside the catch-up window) instead of twice. */
const TICK_MS = 1_000;

/** Crash-loop guard: this many dirty deaths inside the window stops the program. */
const CRASH_LOOP_DEATHS = 5;
const CRASH_LOOP_WINDOW_MS = 60_000;

/** Cap for program_logs concatenation — enough to diagnose, too small to matter. */
const PROGRAM_LOGS_MAX = 64 * 1024;

/** Default SIGTERM grace before SIGKILL (when the program sets no killGraceMs). */
const DEFAULT_KILL_GRACE_MS = 5_000;

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
	// drop = server-side removal of ONE agent (close socket + delete entry)
	"drop",
		"program_define",
		"program_patch",
		"program_launch",
		"program_remove",
		"program_list",
		"program_get",
		"program_preview",
		"program_logs",
		"run_exec",
		"run_get",
		"run_list",
		"run_logs",
		"run_wait",
		"run_kill",
		"run_signal",
		"run_save",
		"run_prune",
		"run_restart",
		"broadcast",
	]),
};

// ---------------------------------------------------------------------------
// THE API — one core, many surfaces. WS frames, REST routes and the CLI all
// speak exactly this. Sync by design: prompts for launches and fires are
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
	/** Server-side removal of one agent: send it a drop frame (so the join
	 *  extension tears down without reconnecting), close its socket, delete
	 *  the registry entry. Idempotent: dropping a ghost succeeds silently.
	 *  Wild, owned, already-gone — all the same door. */
	drop(sessionId: string, under?: string): { ok: boolean; sessionId: string };
}

/** One fork's observable truth. No tree/rss/cpu: liveness is best-effort
 *  (process.kill(pid, 0)) and child-process tracking without ps is refused —
 *  deferred, documented, never faked. */
export interface RunView {
	id: string;
	name: string;
	program?: string;
	kind: "service" | "job";
	state: RunState;
	pid?: number;
	cwd?: string;
	spawn: ProgramSpawn;
	trigger: RunRecord["trigger"];
	startedAt: number;
	endedAt?: number;
	uptimeMs: number;
	exit?: RunRecord["exit"];
	logPath: string;
	agents: string[];
	lastEvent?: string;
}

/** A program definition plus its live runs, recent history, and next fires. */
export interface ProgramView {
	def: ProgramDef;
	live: RunView[];
	history: RunRecord[];
	preview: number[];
}

/** A fresh fork: ledger entry + supervisor child. waitMs callers may also get
 *  the settled record (caller patience, never run lifetime). */
export interface LaunchResult {
	runId: string;
	name: string;
	sessionId: string;
	pid?: number;
	settled?: RunRecord;
}

export interface ProgramApi {
	list(): ProgramDef[];
	get(name: string): ProgramView | null;
	/** Create or replace a definition (fire identity recomputed, counters and
	 *  history preserved). Rejects with {error} reasons — never bare null. */
	define(opts: { name: string } & Partial<ProgramFields>): ProgramDef | { error: string[] };
	/** Promotion = patch: merge over the def, validate the merged def. */
	patch(name: string, patch: Partial<ProgramFields>): ProgramDef | { error: string[] } | null;
	/** Manual run — forks now, schedule untouched (nextFire/lastSlot never
	 *  move). At-most-once while a claim for the program is in flight (busy). */
	launch(
		name: string,
		opts?: { context?: string; prompt?: string; waitMs?: number },
	): Promise<LaunchResult | { busy: true; name: string } | { error: string[] } | null>;
	/** Forget the definition — in-flight runs finish, then settle as orphans. */
	remove(name: string): { ok: boolean; name: string };
	/** Next-N fire times without forking. */
	preview(name: string, n?: number): { name: string; fires: number[] } | null;
	/** Concatenated stdout tails across history (newest last, capped). */
	logs(name: string, tailBytes?: number): { name: string; text: string } | null;
}

export interface RunApi {
	/** Always creates a run (orphan — no program). waitMs is caller patience. */
	exec(opts: {
		spawn: ProgramSpawnFrame;
		waitMs?: number;
		timeoutMs?: number;
		name?: string;
		context?: string;
	}): Promise<LaunchResult>;
	get(id: string): RunView | null;
	list(filter?: { program?: string; state?: string; limit?: number }): RunView[];
	logs(
		id: string,
		opts?: { stream?: "stdout" | "stderr" | "both"; tailBytes?: number; offset?: number },
	): { text: string; nextOffset: number } | null;
	/** Resolve when the run turns terminal (or `match` appears). Rejects on timeout. */
	wait(id: string, opts?: { match?: string; timeoutMs?: number }): Promise<RunRecord>;
	/** Graceful stop (SIGTERM, wait grace, SIGKILL). force = SIGKILL now. */
	kill(id: string, opts?: { graceMs?: number; force?: boolean }): { ok: boolean; id: string };
	/** Best-effort signal to the run's pid. Null = unknown run. */
	signal(id: string, signal: string): { ok: boolean; id: string } | null;
	/** Promote an orphan run into a remembered program. */
	save(runId: string, name: string, kind?: "service" | "job"): ProgramDef | { error: string[] } | null;
	prune(olderThanMs?: number, keep?: number): string[];
	/** Same spawn, new run. */
	restart(runId: string): Promise<LaunchResult | null>;
}

export interface FleetApi {
	agents: AgentApi;
	programs: ProgramApi;
	runs: RunApi;
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
	/** Kill the scoped supervisor (releases sockets/pids). The `serve`
	 *  shutdown path calls this after stop(); tests sharing one process
	 *  must NOT call it (they only disconnect). */
	killDaemon(): Promise<void>;
	/** THE core — the same ops REST and the CLI speak. Embed away. */
	api: FleetApi;
	/** Registry snapshot — the observable truth. */
	registry(): AgentInfo[];
	/** History — every agent ever seen (resumable discovery). */
	history(): AgentInfo[];
	templates(): TemplateInfo[];
	/** Fire due schedules now (the 1s clock calls this; tests call it directly). */
	tickPrograms(now?: number, tickMs?: number): number;
	/** Test-only: mutate a program def in place (overdue setup without a
	 *  redefine). The daemon never calls this — only tests forcing nextFire
	 *  into the past. */
	pokeProgram(name: string, patch: Partial<ProgramDef>): boolean;
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
	const programsPath = opts.programsPath ?? join(home, "programs.json");
	const legacyProcessesPath = opts.processesPath ?? layout.processesPath;
	const legacyTasksPath = opts.tasksPath ?? layout.tasksPath;
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

	// ---- the only memory: programs.json, loaded once, written through ----
	let programs = loadPrograms(programsPath);
	const persistPrograms = (): void => savePrograms(programsPath, [...programs.values()]);

	/** The run ledger — every fork leaves exactly one run. */
	const runStore = new RunStore({ home });
	/** Live supervisor children: runId → owning program + label. */
	const liveRuns = new Map<string, { program?: string; label: string }>();
	/** In-flight unconfirmed forks per program (memory-only; the durable
	 *  claim is pendingClaim on the def). */
	const firing = new Set<string>();
	/** Open log streams per live run — ended when the run settles. */
	interface RunStreams {
		stdout: Writable;
		stderr: Writable;
	}
	const streams = new Map<string, RunStreams>();
	/** Per-run timeout timers — cleared when the run settles. */
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	/** Retry/respawn timers — tracked so stop() can cancel them. */
	const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
	/** Dirty-death timestamps per program — the crash-loop guard's memory. */
	const deathLog = new Map<string, number[]>();
	/** Respawn counts per program — enforces restart.maxRestarts. */
	const respawnCount = new Map<string, number>();
	/** Buffered overlap slots per program (buffer1 = max 1, bufferAll = unbounded). */
	const buffered = new Map<string, number[]>();

	/** Tracked one-shot timer: stop() cancels everything pending. */
	const later = (ms: number, fn: () => void): void => {
		const timer = setTimeout(() => {
			pendingTimers.delete(timer);
			fn();
		}, Math.max(0, ms));
		timer.unref?.();
		pendingTimers.add(timer);
	};

	const closeRunStreams = (runId: string): void => {
		const s = streams.get(runId);
		if (!s) return;
		streams.delete(runId);
		for (const st of [s.stdout, s.stderr]) {
			try {
				st.end();
			} catch {
				/* caller-owned bytes — never crash the daemon */
			}
		}
	};
	/** Prompts waiting for a (re)register — the daemon owns that moment. */
	const pendingPrompts = new Map<
		string,
		{ body: Record<string, unknown>; timer: ReturnType<typeof setTimeout> }
	>();
	const queuePrompt = (sessionId: string, prompt: string, timeoutMs = PROMPT_TIMEOUT_MS): void => {
		const timer = setTimeout(
			() => {
				pendingPrompts.delete(sessionId);
				console.warn(
					`[swarm] prompt for ${sessionId} expired after ${timeoutMs}ms — worker never registered (never silent)`,
				);
			},
			timeoutMs,
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
	 *  SWARM_SPAWN_ID (the parent backlink = run id) is stamped per-fork by forkRun. */
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
	// run backlink: a worker forked with SWARM_SPAWN_ID=run:<id> reports home —
	// the run ledger learns its agent best-effort (never breaks register).
	const spawnIdStr = typeof frame.spawnId === "string" ? frame.spawnId : "";
	const backlinkRunId = spawnIdStr.startsWith("run:")
		? spawnIdStr.slice(4)
		: spawnIdStr.startsWith("run-")
			? spawnIdStr
			: "";
	if (backlinkRunId) {
		try {
			runStore.attachAgent(backlinkRunId, frame.sessionId);
		} catch {
			/* ledger torn or unknown run — register still wins */
		}
	}

		send(conn, {
			op: "welcome",
			sessionId: frame.sessionId,
			swarm: swarmName,
			registry: snapshot(conn.room),
		});

		// a queued prompt (launch/exec with context) is delivered the moment
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

	/** Resolve a program spawn to something forkable. `file` wins when given
	 *  (must exist); `cmd` needs no resolution; `from` is a template id/file.
	 *  Null = unknown (the caller 404s). */
	const resolveSpawn = (
		spawn?: ProgramSpawnFrame,
		from?: string,
	): { file?: string; cmd?: string; args?: string[]; cwd?: string; templateEnv?: Record<string, string> } | null => {
		if (spawn && "file" in spawn && typeof spawn.file === "string" && spawn.file) {
			return existsSync(spawn.file) ? { file: spawn.file } : null;
		}
		if (spawn && "cmd" in spawn && typeof spawn.cmd === "string" && spawn.cmd) {
			return { cmd: spawn.cmd, args: spawn.args, cwd: spawn.cwd };
		}
		if (typeof from === "string" && from) {
			const t = findTemplate(templatesDir, from);
			return t ? { file: t.path, templateEnv: t.env } : null;
		}
		return null;
	};

	/** THE one fork path — services, schedules, manual launches and orphan
	 *  execs all fork here. Sync: the ledger entry is registered, streams are
	 *  opened, and the supervisor child is born before this returns. */
	const forkRun = (args: {
		program?: string;
		spawn: { file?: string; cmd?: string; args?: string[]; cwd?: string; templateEnv?: Record<string, string> };
		kind: "service" | "job";
		origin: RunRecord["trigger"]["origin"];
		slot?: number;
		attempt?: number;
		prompt?: string;
		promptTimeoutMs?: number;
		timeoutMs?: number;
	}): { runId: string; name: string; sessionId: string; pid?: number } => {
		const prog = args.program ? programs.get(args.program) : undefined;
		const spawn: ProgramSpawn = args.spawn.file
			? { file: args.spawn.file }
			: { cmd: args.spawn.cmd as string, args: args.spawn.args, cwd: args.spawn.cwd };
		const record = runStore.register({
			program: args.program,
			kind: args.kind,
			spawn,
			trigger: { origin: args.origin, slot: args.slot, attempt: args.attempt ?? 0 },
			cwd: args.spawn.cwd,
		});
		const paths = runStore.streamPaths(record.id);
		const stdout = createWriteStream(paths.stdout, { flags: "a" });
		const stderr = createWriteStream(paths.stderr, { flags: "a" });
		streams.set(record.id, { stdout, stderr });
		const base = {
			label: `run:${record.id}`,
			// NEVER at supervisor level — the daemon owns restart policy
			// (kill run + new run law). Supervisor autorestart never fires.
			autorestart: false as const,
			templateEnv: args.spawn.templateEnv,
			extraEnv: { ...spawnEnv(), SWARM_SPAWN_ID: record.id },
		};
		const spec: SpawnSpec = args.spawn.file
			? { ...base, file: args.spawn.file }
			: { ...base, cmd: args.spawn.cmd as string, args: args.spawn.args, cwd: args.spawn.cwd };
		let forked: { sessionId: string; pid?: number };
		try {
			forked = supervisor.fork(spec, { stdout, stderr });
		} catch (err) {
			closeRunStreams(record.id);
			try {
				runStore.settle(
					record.id,
					{ code: null, signal: null, at: Date.now(), reason: "fork failed" },
					"failed",
				);
			} catch {
				/* ledger torn — never guess */
			}
			throw err;
		}
		if (forked.pid !== undefined) {
			try {
				runStore.setPid(record.id, forked.pid);
			} catch {
				/* ledger torn — the run still lives */
			}
		}
		liveRuns.set(record.id, { program: args.program, label: `run:${record.id}` });
		if (args.prompt) {
			queuePrompt(
				forked.sessionId,
				args.prompt,
				args.promptTimeoutMs ?? prog?.promptTimeoutMs ?? PROMPT_TIMEOUT_MS,
			);
		}
		if (typeof args.timeoutMs === "number" && args.timeoutMs >= 0) {
			const timer = setTimeout(() => onRunTimeout(record.id), args.timeoutMs);
			timer.unref?.();
			timers.set(record.id, timer);
		}
		return { runId: record.id, name: record.name, sessionId: forked.sessionId, pid: forked.pid };
	};

	/** Fork a new run from a program's CURRENT definition (respawn/retry/chain/
	 *  tick/launch all land here). Throws when the spawn is unresolvable. */
	const forkProgramRun = (
		prog: ProgramDef,
		origin: RunRecord["trigger"]["origin"],
		opts?: { slot?: number; attempt?: number; prompt?: string; timeoutMs?: number },
	): { runId: string; name: string; sessionId: string; pid?: number } => {
		const target = resolveSpawn(prog.spawn, prog.from);
		if (!target) throw new Error(`unresolvable spawn for program: ${prog.name}`);
		return forkRun({
			program: prog.name,
			spawn: target,
			kind: prog.kind,
			origin,
			slot: opts?.slot,
			attempt: opts?.attempt,
			prompt: opts?.prompt,
			promptTimeoutMs: prog.promptTimeoutMs,
			timeoutMs: opts?.timeoutMs ?? prog.timeoutMs,
		});
	};

	/** Launch a chained program (onFailTrigger/onSuccessTrigger). Fire-and-
	 *  forget by design: a missing chain target is a warn, never a crash. */
	const chainLaunch = (name: string, via: string): void => {
		const prog = programs.get(name);
		if (!prog) {
			console.warn(`[swarm] chained program ${name} (via ${via}) unknown — logged, never fired`);
			return;
		}
		try {
			forkProgramRun(prog, "trigger");
		} catch (err) {
			console.warn(
				`[swarm] chained program ${name} (via ${via}) fork failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	};

	/** A run outlived its timeoutMs: stop it, settle as timedOut. */
	const onRunTimeout = (runId: string): void => {
		timers.delete(runId);
		const live = liveRuns.get(runId);
		if (!live) return;
		let record: RunRecord;
		try {
			record = runStore.get(runId);
		} catch {
			liveRuns.delete(runId);
			return;
		}
		if (record.exit != null || record.endedAt != null) {
			liveRuns.delete(runId);
			return;
		}
		const prog = live.program ? programs.get(live.program) : undefined;
		if (prog) {
			prog.counters.timeoutKills++;
			prog.updatedAt = Date.now();
			persistPrograms();
		}
		liveRuns.delete(runId);
		closeRunStreams(runId);
		void supervisor.stop(live.label, prog?.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
		try {
			runStore.settle(
				runId,
				{ code: null, signal: "SIGTERM", at: Date.now(), reason: "timeout" },
				"timedOut",
			);
		} catch {
			/* ledger torn — never guess */
		}
	};

	/** What the daemon does when a supervised child dies: settle the run, then
	 *  run the policy engine. Intentional stops (kill/timeout paths) settle
	 *  FIRST and record the death with supervisor.stop (no hook) — so every
	 *  death landing here is natural. Supervisor-level autorestart is always
	 *  false, so this hook fires for every final death; the onRestart hook
	 *  never fires (log? no — it can't). */
	const onChildExit = (label: string, facts: ExitFacts): void => {
		if (!label.startsWith("run:")) return;
		const runId = label.slice("run:".length);
		const live = liveRuns.get(runId);
		liveRuns.delete(runId);
		const timer = timers.get(runId);
		if (timer) {
			clearTimeout(timer);
			timers.delete(runId);
		}
		closeRunStreams(runId);
		let record: RunRecord;
		try {
			record = runStore.get(runId);
		} catch {
			return;
		}
		// A death from an already-settled run (kill/timeout won the race but
		// the supervisor still reported): never poison the ledger.
		if (record.exit != null || record.endedAt != null) return;
		const at = facts.at ?? Date.now();
		const dirty = facts.code !== 0 || facts.signal !== null;
		try {
			record = runStore.settle(
				runId,
				{ code: facts.code, signal: facts.signal, at },
				dirty ? "failed" : "completed",
			);
		} catch {
			return;
		}
		const progName = record.program ?? live?.program;
		const prog = progName ? programs.get(progName) : undefined;
		if (!prog) return; // orphan (program removed mid-flight) — settle only
		const now = Date.now();
		const attempt = record.trigger.attempt ?? 0;

		// NOTE: the schedule already marched at claim time (fireClaimedSlot set
		// nextFire BEFORE the fork). No advance here — that would skip a slot.

		// (b) retries: nonzero exit/signal → NEW run, attempt+1, backoff.
		let rescheduled = false;
		if (dirty && prog.retries && attempt < prog.retries.attempts) {
			const backoff = prog.retries.backoffMs ?? 0;
			console.log(
				`[swarm] run ${runId} (${prog.name}) failed (code ${String(facts.code)} signal ${String(facts.signal)}) — retry attempt ${attempt + 1} in ${backoff}ms`,
			);
			later(backoff, () => {
				const cur = programs.get(prog.name);
				if (!cur) return;
				try {
					forkProgramRun(cur, "restart", { attempt: attempt + 1 });
				} catch (err) {
					console.warn(
						`[swarm] retry for ${cur.name} fork failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			});
			rescheduled = true;
		} else if (!dirty) {
			respawnCount.delete(prog.name);
		}

		// pause-on-fail + chained triggers.
		if (dirty && prog.pauseOnFail) {
			prog.paused = true;
			prog.notes = [prog.notes, `paused on failure of run ${runId} at ${new Date(now).toISOString()}`]
				.filter(Boolean)
				.join("\n");
		}
		if (dirty && prog.onFailTrigger) chainLaunch(prog.onFailTrigger, `${prog.name} failure`);
		if (!dirty && facts.code === 0 && prog.onSuccessTrigger) {
			chainLaunch(prog.onSuccessTrigger, `${prog.name} success`);
		}
		// NOTE: runFailed/runCompleted has no wire fan-out — programs are not
		// registry addresses, so there is no program channel to fan out on.
		// The daemon log above is the listener surface (never silent).

		// (c) restart policy → service respawn (kill run + new run law).
		const policy = prog.restart?.policy ?? "never";
		const wantsRespawn = policy === "always" || (policy === "on-failure" && dirty);
		if (
			wantsRespawn &&
			!rescheduled &&
			(prog.kind === "service" || !prog.schedule || prog.schedule.kind === "manual") &&
			prog.desired === "running"
		) {
			const deaths = [...(deathLog.get(prog.name) ?? []), now].filter(
				(t) => now - t < CRASH_LOOP_WINDOW_MS,
			);
			deathLog.set(prog.name, deaths);
			if (deaths.length >= CRASH_LOOP_DEATHS) {
				prog.desired = "stopped";
				prog.notes = [prog.notes, `crash-loop: ${deaths.length} deaths in 60s — desired=stopped at ${new Date(now).toISOString()}`]
					.filter(Boolean)
					.join("\n");
				console.warn(`[swarm] crash-loop: ${prog.name} stopped after ${deaths.length} deaths in 60s`);
			} else {
				const max = prog.restart?.maxRestarts;
				const count = respawnCount.get(prog.name) ?? 0;
				if (max != null && count >= max) {
					console.warn(`[swarm] ${prog.name} hit restart.maxRestarts=${max} — no respawn`);
				} else {
					respawnCount.set(prog.name, count + 1);
					const backoff = prog.restart?.backoffMs ?? 5_000;
					later(backoff, () => {
						const cur = programs.get(prog.name);
						if (!cur || cur.desired !== "running") return;
						try {
							forkProgramRun(cur, "restart");
						} catch (err) {
							console.warn(
								`[swarm] respawn for ${cur.name} fork failed: ${err instanceof Error ? err.message : String(err)}`,
							);
						}
					});
				}
			}
		}

		// (e) every mutation above lands on disk.
		prog.updatedAt = now;
		persistPrograms();
	};

	const supervisor = new Supervisor({
		homeDir: home,
		onExit: onChildExit,
		// No onRestart: supervisor autorestart is ALWAYS false, so this never
		// fires. Restart policy lives in onChildExit (kill run + new run law).
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

	/** Durable claim — the heart of exactly-once. Bump runs, stamp the slot,
	 *  advance nextFire, set pendingClaim, and PERSIST — all before the fork.
	 *  The caller forks, then clears pendingClaim (+ persists). The claim's
	 *  slot is the fire identity: crashes between claim and fork leave
	 *  pendingClaim for boot to account as a logged skip. */
	const claimSlot = (
		prog: ProgramDef,
		slot: number,
		now: number,
		origin: RunRecord["trigger"]["origin"],
		runId: string,
	): void => {
		prog.counters.runs++;
		prog.lastSlot = slot;
		prog.lastFire = now;
		const draft: ProgramDef = { ...prog };
		const next = computeNextFire(draft, now);
		prog.nextFire = next;
		if (typeof prog.jitterMs === "number" && prog.jitterMs > 0 && next !== undefined) {
			const jitter = prog.stableJitter
				? Math.abs(slot) % Math.floor(prog.jitterMs)
				: Math.floor(Math.random() * prog.jitterMs);
			prog.nextFire = next + jitter;
		}
		prog.pendingClaim = { run: runId, slot, claimedAt: now, origin };
		prog.updatedAt = now;
		persistPrograms();
	};
	const clearClaim = (prog: ProgramDef, ok: boolean, reason: string): void => {
		const slot = prog.pendingClaim?.slot ?? prog.lastSlot ?? Date.now();
		prog.pendingClaim = undefined;
		if (!ok) prog.lastSkip = { slot, at: Date.now(), reason };
		prog.updatedAt = Date.now();
		persistPrograms();
	};

	const viewOf = (record: RunRecord): RunView => {
		const live = liveRuns.has(record.id);
		return {
			id: record.id,
			name: record.name,
			program: record.program,
			kind: record.kind,
			state: deriveStatus(record, live),
			pid: record.pid,
			cwd: record.cwd,
			spawn: record.spawn,
			trigger: record.trigger,
			startedAt: record.startedAt,
			endedAt: record.endedAt,
			uptimeMs: (record.endedAt ?? Date.now()) - record.startedAt,
			exit: record.exit,
			logPath: record.logPath,
			agents: record.agents,
			lastEvent: record.lastEvent,
		};
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

			drop(sessionId, under) {
				const e = resolve(sessionId);
				// idempotent: dropping a ghost succeeds silently
				if (!e) return { ok: true, sessionId };
				if (under && !visible(under, e.room)) return { ok: true, sessionId };
				if (e.origin === "mirrored") {
					// authority stays home — the remote daemon decides; we follow
					// by forgetting our mirror (next sync re-adds it if still live).
					e.forward?.({ op: "drop", sessionId: e.sessionId });
					const key = addressOf(swarmName, e.room, e.sessionId);
					registry.delete(key);
					if (bySessionId.get(e.sessionId) === key) bySessionId.delete(e.sessionId);
					return { ok: true, sessionId: e.sessionId };
				}
				// server-side fact, zero agent cooperation needed: tell it it is
				// dropped (so the join extension tears down without reconnecting),
				// close the socket, delete the entry. Wild or forked — the run
				// itself is untouched; that is runs.kill's job.
				const key = addressOf(swarmName, e.room, e.sessionId);
				if (e.conn) {
					send(e.conn, { op: "drop" });
					e.conn.ws.close();
					e.conn = undefined;
				}
				registry.delete(key);
				if (bySessionId.get(e.sessionId) === key) bySessionId.delete(e.sessionId);
				return { ok: true, sessionId: e.sessionId };
			},
		},

		programs: {
			list() {
				return [...programs.values()];
			},

			get(name) {
				const def = programs.get(name);
				if (!def) return null;
				const live = [...liveRuns.keys()]
					.map((id) => {
						try {
							return viewOf(runStore.get(id));
						} catch {
							return null;
						}
					})
					.filter((v): v is RunView => !!v && v.program === name);
				return {
					def,
					live,
					history: runStore.history(name, def.keepRuns ?? 50),
					preview: previewRuns(def, 3),
				};
			},

			define(opts) {
				const { name } = opts;
				const now = Date.now();
				const prev = programs.get(name);
				const candidate: ProgramDef = {
					name,
					kind: opts.kind ?? prev?.kind ?? (opts.schedule ? "job" : "service"),
					spawn: opts.spawn ?? prev?.spawn ?? (opts.from ? { file: opts.from } : { file: "" }),
					from: opts.from ?? prev?.from,
					desired: opts.desired ?? prev?.desired ?? "stopped",
					restart: opts.restart ?? prev?.restart ?? { policy: "never" },
					schedule: opts.schedule ?? prev?.schedule,
					paused: opts.paused ?? prev?.paused ?? false,
					overlap: opts.overlap ?? prev?.overlap,
					allowN: opts.allowN ?? prev?.allowN,
					timeoutMs: opts.timeoutMs ?? prev?.timeoutMs,
					catchupWindowMs: opts.catchupWindowMs ?? prev?.catchupWindowMs,
					missPolicy: opts.missPolicy ?? prev?.missPolicy,
					retries: opts.retries ?? prev?.retries,
					pauseOnFail: opts.pauseOnFail ?? prev?.pauseOnFail,
					jitterMs: opts.jitterMs ?? prev?.jitterMs,
					stableJitter: opts.stableJitter ?? prev?.stableJitter,
					minGapMs: opts.minGapMs ?? prev?.minGapMs,
					onFailTrigger: opts.onFailTrigger ?? prev?.onFailTrigger,
					onSuccessTrigger: opts.onSuccessTrigger ?? prev?.onSuccessTrigger,
					triggerToken: opts.triggerToken ?? prev?.triggerToken,
					promptTimeoutMs: opts.promptTimeoutMs ?? prev?.promptTimeoutMs,
					killGraceMs: opts.killGraceMs ?? prev?.killGraceMs,
					keepRuns: opts.keepRuns ?? prev?.keepRuns,
					notes: opts.notes ?? prev?.notes,
					counters: prev?.counters ?? {
						runs: 0,
						missedCatchup: 0,
						overlapSkipped: 0,
						bufferDropped: 0,
						timeoutKills: 0,
					},
					// Redefine mid-claim must not drop the in-flight claim:
					// preserve pendingClaim so the fire still settles exactly
					// once (no double-fire window through redefine).
					pendingClaim: prev?.pendingClaim,
					lastSkip: prev?.lastSkip,
					createdAt: prev?.createdAt ?? now,
					updatedAt: now,
				};
				// A program without any spawn source can never fork — reject.
				const hasSpawn =
					(candidate.spawn && "file" in candidate.spawn && !!candidate.spawn.file) ||
					(candidate.spawn && "cmd" in candidate.spawn && !!(candidate.spawn as { cmd?: string }).cmd) ||
					!!candidate.from;
				if (!hasSpawn) return { error: ["spawn must set file or cmd (or from template)"] };
				const v = validateProgram(candidate);
				if (!v.ok) return { error: v.errors };
				candidate.nextFire = computeNextFire(candidate, now);
				programs.set(name, candidate);
				persistPrograms();
				return candidate;
			},

			patch(name, patch) {
				const def = programs.get(name);
				if (!def) return null;
				const merged: ProgramDef = {
					...def,
					...patch,
					name: def.name,
					counters: def.counters,
					createdAt: def.createdAt,
					updatedAt: Date.now(),
				} as ProgramDef;
				const v = validateProgram(merged);
				if (!v.ok) return { error: v.errors };
				if (patch.schedule !== undefined) {
					merged.nextFire = computeNextFire(merged, Date.now());
				}
				programs.set(name, merged);
				persistPrograms();
				return merged;
			},

			async launch(name, launchOpts = {}) {
				const def = programs.get(name);
				if (!def) return null;
				if (firing.has(name)) return { busy: true as const, name };
				firing.add(name);
				try {
					// launch forks now, schedule untouched (no claim to clear —
					// the tick path owns pendingClaim).
					const forked = forkProgramRun(def, "launch", {
						prompt: launchOpts.context ?? launchOpts.prompt,
					});
					if (launchOpts.waitMs !== undefined) {
						try {
							const settled = await runStore.wait(forked.runId, {
								timeoutMs: launchOpts.waitMs,
							});
							return { ...forked, settled };
						} catch {
							return { ...forked };
						}
					}
					return { ...forked };
				} catch {
					return { error: [`unknown program / unresolvable spawn: ${name}`] };
				} finally {
					firing.delete(name);
				}
			},

			remove(name) {
				if (!programs.has(name)) return { ok: false, name };
				// in-flight runs keep running — the daemon forgets only the
				// definition; exits settle as orphans.
				programs.delete(name);
				persistPrograms();
				return { ok: true, name };
			},

			preview(name, n = 3) {
				const def = programs.get(name);
				if (!def) return null;
				return { name, fires: previewRuns(def, n ?? 3) };
			},

			logs(name, tailBytes = PROGRAM_LOGS_MAX) {
				const def = programs.get(name);
				if (!def) return null;
				const cap = Math.max(0, tailBytes ?? PROGRAM_LOGS_MAX);
				// newest first, accumulate to the cap, then emit newest-last.
				const hist = runStore.history(name, def.keepRuns ?? 50);
				const parts: string[] = [];
				let used = 0;
				for (const r of hist) {
					let text = "";
					try {
						const path = runStore.streamPaths(r.id).stdout;
						const size = statSync(path).size;
						const from = Math.max(0, size - Math.max(0, cap - used));
						const fd = openSync(path, "r");
						try {
							const buf = Buffer.alloc(Math.max(0, size - from));
							readSync(fd, buf, 0, buf.length, from);
							text = buf.toString("utf8");
						} finally {
							closeSync(fd);
						}
					} catch {
						text = "";
					}
					if (!text) continue;
					const sep = `--- run ${r.id} (${deriveStatus(r, liveRuns.has(r.id))}) ---\n`;
					const chunk = sep + text;
					if (used + chunk.length > cap && parts.length > 0) break;
					parts.push(chunk);
					used += chunk.length;
					if (used >= cap) break;
				}
				parts.reverse();
				return { name, text: parts.join("\n").slice(-cap) };
			},
		},

		runs: {
			async exec(execOpts) {
				const target = resolveSpawn(execOpts.spawn);
				if (!target) throw new Error("unresolvable spawn: file must exist");
				const forked = forkRun({
					spawn: target,
					kind: "job",
					origin: "exec",
					prompt: execOpts.context,
					timeoutMs: execOpts.timeoutMs,
				});
				if (execOpts.name) {
					// Friendly-name override: rename the ledger entry in place.
					try {
						const rec = runStore.get(forked.runId);
						(rec as { name: string }).name = execOpts.name;
						runStore.setState(forked.runId, rec.state);
					} catch {
						/* ledger torn — the run still lives */
					}
				}
				if (execOpts.waitMs !== undefined) {
					try {
						const settled = await runStore.wait(forked.runId, {
							timeoutMs: execOpts.waitMs,
						});
						return { ...forked, settled };
					} catch {
						return { ...forked };
					}
				}
				return { ...forked };
			},

			get(id) {
				try {
					return viewOf(runStore.get(id));
				} catch {
					return null;
				}
			},

			list(filter) {
				let rows = runStore.snapshot();
				if (filter?.program !== undefined) rows = rows.filter((r) => r.program === filter.program);
				let views = rows.map(viewOf);
				if (filter?.state !== undefined) views = views.filter((v) => v.state === filter.state);
				views.sort((a, b) => b.startedAt - a.startedAt);
				const limit = filter?.limit ?? 100;
				return views.slice(0, Math.max(0, limit));
			},

			logs(id, logOpts) {
				try {
					return runStore.logs(id, {
						stream: logOpts?.stream,
						tailBytes: logOpts?.tailBytes,
						offset: logOpts?.offset,
					});
				} catch {
					return null;
				}
			},

			wait(id, waitOpts) {
				return runStore.wait(id, {
					match: waitOpts?.match,
					timeoutMs: waitOpts?.timeoutMs,
				});
			},

			kill(id, killOpts = {}) {
				let record: RunRecord;
				try {
					record = runStore.get(id);
				} catch {
					return { ok: false, id };
				}
				if (record.exit != null || record.endedAt != null) return { ok: false, id };
				const live = liveRuns.get(id);
				const prog = live?.program ? programs.get(live.program) : undefined;
				const grace = killOpts.force
					? 0
					: (killOpts.graceMs ?? prog?.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
				liveRuns.delete(id);
				const timer = timers.get(id);
				if (timer) {
					clearTimeout(timer);
					timers.delete(id);
				}
				closeRunStreams(id);
				if (live) void supervisor.stop(live.label, grace);
				try {
					runStore.settle(
						id,
						{
							code: null,
							signal: killOpts.force ? "SIGKILL" : "SIGTERM",
							at: Date.now(),
							reason: "killed",
						},
						"cancelled",
					);
				} catch {
					/* ledger torn — never guess */
				}
				return { ok: true, id };
			},

			signal(id, signal) {
				let record: RunRecord;
				try {
					record = runStore.get(id);
				} catch {
					return null;
				}
				if (record.exit != null || record.endedAt != null) return { ok: false, id };
				if (!signal || record.pid == null) return { ok: false, id };
				try {
					process.kill(record.pid, signal as NodeJS.Signals);
				} catch {
					return { ok: false, id };
				}
				return { ok: true, id };
			},

			save(runId, name, kind) {
				let record: RunRecord;
				try {
					record = runStore.get(runId);
				} catch {
					return null;
				}
				if (programs.has(name)) return { error: [`program already exists: ${name}`] };
				const now = Date.now();
				const candidate: ProgramDef = {
					name,
					kind: kind ?? record.kind,
					spawn: record.spawn,
					desired: "stopped",
					restart: { policy: "never" },
					paused: false,
					counters: { runs: 0, missedCatchup: 0, overlapSkipped: 0, bufferDropped: 0, timeoutKills: 0 },
					createdAt: now,
					updatedAt: now,
				};
				const v = validateProgram(candidate);
				if (!v.ok) return { error: v.errors };
				candidate.nextFire = computeNextFire(candidate, now);
				programs.set(name, candidate);
				persistPrograms();
				return candidate;
			},

			prune(olderThanMs, keep) {
				return runStore.prune({ olderThanMs, keep });
			},

			async restart(runId) {
				let record: RunRecord;
				try {
					record = runStore.get(runId);
				} catch {
					return null;
				}
				const prog = record.program ? programs.get(record.program) : undefined;
				try {
					if (prog) return { ...(await forkProgramRun(prog, "restart")) };
					const target = resolveSpawn(record.spawn);
					if (!target) return null;
					return {
						...(await forkRun({
							spawn: target,
							kind: record.kind,
							origin: "restart",
						})),
					};
				} catch {
					return null;
				}
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

	/** Estimate missed slots between a due slot and now (for catch-up
	 *  accounting). `every` divides the gap; `cron`/`at` collapse to one. */
	const estimateMissed = (prog: ProgramDef, slot: number, now: number): number => {
		const s = prog.schedule;
		if (s?.kind === "every" && typeof s.everyMs === "number" && s.everyMs > 0) {
			return Math.max(1, Math.round((now - slot) / s.everyMs));
		}
		return 1;
	};

	/** Fire every due schedule (unless paused). Durable: each slot is claimed
	 *  (runs++ + nextFire advanced + pendingClaim persisted) BEFORE the fork,
	 *  so a crash can't refire. Late-within-window fires late; past-window
	 *  collapses per missPolicy (fireOnce = one catch-up fire, skip = logged
	 *  skip). Deferred: forks land sync (supervisor.fork is sync); stops for
	 *  cancel/restart are initiated async and the old runs settle as cancelled
	 *  immediately — the new run forks regardless. Returns claimed fires. */
	const tickPrograms = (now: number = Date.now(), _tickMs = TICK_MS): number => {
		let fired = 0;
		for (const prog of programs.values()) {
			const s = prog.schedule;
			if (!s || s.kind === "manual" || prog.paused) continue;
			if (typeof s.maxRuns === "number" && prog.counters.runs >= s.maxRuns) continue;
			if (typeof s.stopAt === "number" && now > s.stopAt) continue;
			if (typeof s.startAt === "number" && now < s.startAt) continue;
			if (prog.pendingClaim) continue;

			// Drain buffered slots first: capacity freed since the overlap.
			const liveIds = [...liveRuns.entries()]
				.filter(([, v]) => v.program === prog.name)
				.map(([id]) => id);
			const queued = buffered.get(prog.name) ?? [];
			if (liveIds.length === 0 && queued.length > 0) {
				const slot = queued.shift() as number;
				if (queued.length === 0) buffered.delete(prog.name);
				fireClaimedSlot(prog, slot, now, "tick");
				fired++;
				continue;
			}

			let slot = prog.nextFire ?? computeNextFire(prog, now);
			if (slot === undefined) {
				prog.nextFire = undefined;
				continue;
			}
			if (now < slot) {
				prog.nextFire = slot;
				continue;
			}

			// minGap: the last fire is too recent — hold the slot, don't advance.
			if (typeof prog.minGapMs === "number" && prog.lastFire != null && now - prog.lastFire < prog.minGapMs) {
				continue;
			}

			// catch-up: late within the window fires late; past it collapses.
			const window = catchupWindowFor(prog);
			if (now - slot > window) {
				const missed = estimateMissed(prog, slot, now);
				if ((prog.missPolicy ?? "fireOnce") === "skip") {
					prog.counters.missedCatchup += missed;
					prog.lastSlot = slot;
					prog.lastSkip = {
						slot,
						at: now,
						reason: `${missed} slot${missed === 1 ? "" : "s"} missed (late ${Math.round((now - slot) / 1000)}s > window ${Math.round(window / 1000)}s) — logged skip`,
					};
					prog.nextFire = computeNextFire({ ...prog }, now);
					prog.updatedAt = now;
					persistPrograms();
					continue;
				}
				prog.counters.missedCatchup += Math.max(0, missed - 1);
				slot = now;
			}

			// overlap gate.
			const overlap = prog.overlap ?? "skip";
			if (liveIds.length > 0) {
				if (overlap === "allow") {
					// fork regardless
				} else if (overlap === "allowN") {
					if (liveIds.length >= (prog.allowN ?? 1)) {
						skipOverlapped(prog, slot, now, "allowN room exhausted");
						continue;
					}
				} else if (overlap === "buffer1" || overlap === "bufferAll") {
					const q = buffered.get(prog.name) ?? [];
					if (overlap === "buffer1" && q.length >= 1) {
						prog.counters.bufferDropped++;
						prog.updatedAt = now;
						persistPrograms();
					} else {
						q.push(slot);
						buffered.set(prog.name, q);
					}
					prog.lastSlot = slot;
					prog.nextFire = computeNextFire({ ...prog }, now);
					prog.updatedAt = now;
					persistPrograms();
					continue;
				} else if (overlap === "cancel" || overlap === "restart") {
					const grace = prog.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
					for (const id of liveIds) {
						liveRuns.delete(id);
						const t = timers.get(id);
						if (t) {
							clearTimeout(t);
							timers.delete(id);
						}
						closeRunStreams(id);
						void supervisor.stop(`run:${id}`, grace);
						try {
							runStore.settle(
								id,
								{ code: null, signal: "SIGTERM", at: now, reason: `overlap ${overlap}` },
								"cancelled",
							);
						} catch {
							/* ledger torn — never guess */
						}
					}
					console.log(
						`[swarm] ${prog.name}: overlap ${overlap} — cancelled ${liveIds.length} live run(s), forking regardless`,
					);
				} else {
					// skip (default): count it, advance, never fork.
					skipOverlapped(prog, slot, now, "live run in progress");
					continue;
				}
			}

			if (fireClaimedSlot(prog, slot, now, "tick")) fired++;
		}
		return fired;
	};

	/** Count an overlapped slot without forking (skip gate). */
	const skipOverlapped = (prog: ProgramDef, slot: number, now: number, reason: string): void => {
		prog.counters.overlapSkipped++;
		prog.lastSlot = slot;
		prog.lastSkip = { slot, at: now, reason: `overlap skip — ${reason}` };
		prog.nextFire = computeNextFire({ ...prog }, now);
		prog.updatedAt = now;
		persistPrograms();
	};

	/** Claim a slot (persisted BEFORE the fork), fork, clear the claim.
	 *  A failed fork converts into a logged skip — never silent, never refired. */
	const fireClaimedSlot = (
		prog: ProgramDef,
		slot: number,
		now: number,
		origin: RunRecord["trigger"]["origin"],
	): boolean => {
		const target = resolveSpawn(prog.spawn, prog.from);
		if (!target) {
			prog.counters.runs++;
			prog.lastSlot = slot;
			prog.nextFire = computeNextFire({ ...prog }, now);
			prog.lastSkip = { slot, at: now, reason: "tick fork failed: unresolvable spawn" };
			prog.updatedAt = now;
			persistPrograms();
			return false;
		}
		// Register first (durable ledger entry), then claim, then fork.
		let forked: { runId: string; name: string; sessionId: string; pid?: number };
		try {
			const spawn: ProgramSpawn = target.file
				? { file: target.file }
				: { cmd: target.cmd as string, args: target.args, cwd: target.cwd };
			const record = runStore.register({
				program: prog.name,
				kind: prog.kind,
				spawn,
				trigger: { origin, slot, attempt: 0 },
				cwd: target.cwd,
			});
			claimSlot(prog, slot, now, origin, record.id);
			const paths = runStore.streamPaths(record.id);
			const stdout = createWriteStream(paths.stdout, { flags: "a" });
			const stderr = createWriteStream(paths.stderr, { flags: "a" });
			streams.set(record.id, { stdout, stderr });
			const base = {
				label: `run:${record.id}`,
				autorestart: false as const,
				templateEnv: target.templateEnv,
				extraEnv: { ...spawnEnv(), SWARM_SPAWN_ID: record.id },
			};
			const spec: SpawnSpec = target.file
				? { ...base, file: target.file }
				: { ...base, cmd: target.cmd as string, args: target.args, cwd: target.cwd };
			const r = supervisor.fork(spec, { stdout, stderr });
			if (r.pid !== undefined) {
				try {
					runStore.setPid(record.id, r.pid);
				} catch {
					/* ledger torn — the run still lives */
				}
			}
			liveRuns.set(record.id, { program: prog.name, label: `run:${record.id}` });
			if (typeof prog.timeoutMs === "number" && prog.timeoutMs >= 0) {
				const timer = setTimeout(() => onRunTimeout(record.id), prog.timeoutMs);
				timer.unref?.();
				timers.set(record.id, timer);
			}
			forked = { runId: record.id, name: record.name, sessionId: r.sessionId, pid: r.pid };
		} catch {
			clearClaim(prog, false, "tick fork failed");
			return false;
		}
		clearClaim(prog, true, "");
		void forked;
		return true;
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
			case "drop":
				if (!hasPerm(conn, "drop")) break;
				result(conn, frame, "drop", api.agents.drop(frame.sessionId, conn.room));
				return;
			case "program_define":
				if (!hasPerm(conn, "program_define")) break;
				{
					const r = api.programs.define({ ...frame, name: frame.name });
					if ("error" in r) fail(conn, frame, "program_define", r.error.join("; "));
					else result(conn, frame, "program_define", r);
				}
				return;
			case "program_patch":
				if (!hasPerm(conn, "program_patch")) break;
				{
					const r = api.programs.patch(frame.name, frame.patch);
					if (!r) fail(conn, frame, "program_patch", `unknown program: ${frame.name}`);
					else if ("error" in r) fail(conn, frame, "program_patch", r.error.join("; "));
					else result(conn, frame, "program_patch", r);
				}
				return;
			case "program_launch": {
				// Watchdog path: when the frame token matches the program's
				// triggerToken, program_launch is honored WITHOUT the admin
				// role. REST/CLI honor the same convention (see rest.ts/cli.ts).
				const def = programs.get(frame.name);
				const tokenOk =
					!!def?.triggerToken && !!frame.token && frame.token === def.triggerToken;
				if (!tokenOk && !hasPerm(conn, "program_launch")) break;
				if (!def) {
					fail(conn, frame, "program_launch", `unknown program: ${frame.name}`);
					return;
				}
				api.programs.launch(frame.name, {
					context: frame.context,
					prompt: frame.prompt,
					waitMs: frame.waitMs,
				}).then(
					(r) => {
						if (!r) fail(conn, frame, "program_launch", `unknown program / unresolvable spawn: ${frame.name}`);
						else if ("error" in r) fail(conn, frame, "program_launch", r.error.join("; "));
						else if ("busy" in r && r.busy)
							fail(conn, frame, "program_launch", `program ${frame.name} already firing (at-most-once)`);
						else result(conn, frame, "program_launch", r);
					},
					(err) => fail(conn, frame, "program_launch", err instanceof Error ? err.message : String(err)),
				);
				return;
			}
			case "program_remove":
				if (!hasPerm(conn, "program_remove")) break;
				result(conn, frame, "program_remove", api.programs.remove(frame.name));
				return;
			case "program_list":
				if (!hasPerm(conn, "program_list")) break;
				result(conn, frame, "program_list", api.programs.list());
				return;
			case "program_get":
				if (!hasPerm(conn, "program_get")) break;
				{
					const r = api.programs.get(frame.name);
					if (!r) fail(conn, frame, "program_get", `unknown program: ${frame.name}`);
					else result(conn, frame, "program_get", r);
				}
				return;
			case "program_preview":
				if (!hasPerm(conn, "program_preview")) break;
				{
					const r = api.programs.preview(frame.name, frame.n);
					if (!r) fail(conn, frame, "program_preview", `unknown program: ${frame.name}`);
					else result(conn, frame, "program_preview", r);
				}
				return;
			case "program_logs":
				if (!hasPerm(conn, "program_logs")) break;
				{
					const r = api.programs.logs(frame.name, frame.tailBytes);
					if (!r) fail(conn, frame, "program_logs", `unknown program: ${frame.name}`);
					else result(conn, frame, "program_logs", r);
				}
				return;
			case "run_exec":
				if (!hasPerm(conn, "run_exec")) break;
				if (!frame.spawn || (!("file" in frame.spawn) && !("cmd" in frame.spawn))) {
					fail(conn, frame, "run_exec", "spawn must set file or cmd");
					return;
				}
				api.runs.exec({
					spawn: frame.spawn,
					waitMs: frame.waitMs,
					timeoutMs: frame.timeoutMs,
					name: frame.name,
					context: frame.context,
				}).then(
					(r) => result(conn, frame, "run_exec", r),
					(err) => fail(conn, frame, "run_exec", err instanceof Error ? err.message : String(err)),
				);
				return;
			case "run_get":
				if (!hasPerm(conn, "run_get")) break;
				{
					const r = api.runs.get(frame.runId);
					if (!r) fail(conn, frame, "run_get", `unknown run: ${frame.runId}`);
					else result(conn, frame, "run_get", r);
				}
				return;
			case "run_list":
				if (!hasPerm(conn, "run_list")) break;
				result(
					conn,
					frame,
					"run_list",
					api.runs.list({ program: frame.program, state: frame.state, limit: frame.limit }),
				);
				return;
			case "run_logs":
				if (!hasPerm(conn, "run_logs")) break;
				{
					const r = api.runs.logs(frame.runId, {
						stream: frame.stream,
						tailBytes: frame.tailBytes,
						offset: frame.offset,
					});
					if (!r) fail(conn, frame, "run_logs", `unknown run: ${frame.runId}`);
					else result(conn, frame, "run_logs", r);
				}
				return;
			case "run_wait":
				if (!hasPerm(conn, "run_wait")) break;
				api.runs.wait(frame.runId, { match: frame.match, timeoutMs: frame.timeoutMs }).then(
					(r) => result(conn, frame, "run_wait", r),
					(err) => fail(conn, frame, "run_wait", err instanceof Error ? err.message : String(err)),
				);
				return;
			case "run_kill":
				if (!hasPerm(conn, "run_kill")) break;
				{
					const r = api.runs.kill(frame.runId, { graceMs: frame.graceMs, force: frame.force });
					if (!r.ok) fail(conn, frame, "run_kill", `unknown run or already settled: ${frame.runId}`);
					else result(conn, frame, "run_kill", r);
				}
				return;
			case "run_signal":
				if (!hasPerm(conn, "run_signal")) break;
				{
					const r = api.runs.signal(frame.runId, frame.signal);
					if (!r) fail(conn, frame, "run_signal", `unknown run: ${frame.runId}`);
					else if (!r.ok) fail(conn, frame, "run_signal", `signal failed: ${frame.runId}`);
					else result(conn, frame, "run_signal", r);
				}
				return;
			case "run_save":
				if (!hasPerm(conn, "run_save")) break;
				{
					const r = api.runs.save(frame.runId, frame.name, frame.kind);
					if (!r) fail(conn, frame, "run_save", `unknown run: ${frame.runId}`);
					else if ("error" in r) fail(conn, frame, "run_save", r.error.join("; "));
					else result(conn, frame, "run_save", r);
				}
				return;
			case "run_prune":
				if (!hasPerm(conn, "run_prune")) break;
				result(conn, frame, "run_prune", api.runs.prune(frame.olderThanMs, frame.keep));
				return;
			case "run_restart":
				if (!hasPerm(conn, "run_restart")) break;
				api.runs.restart(frame.runId).then(
					(r) => {
						if (!r) fail(conn, frame, "run_restart", `unknown run / unresolvable spawn: ${frame.runId}`);
						else result(conn, frame, "run_restart", r);
					},
					(err) => fail(conn, frame, "run_restart", err instanceof Error ? err.message : String(err)),
				);
				return;
			case "broadcast":
				if (!hasPerm(conn, "broadcast")) break;
				{
					// blast radius = caller's mount ∩ explicit room scope ∩ online WORKERS.
					// Agents only — programs/runs are definitions/ledger, not listeners.
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
			// The home lock FIRST — a second daemon on the same home refuses.
			acquireHomeLock(home);
			// Migrate processes.json + tasks.json → programs.json ONCE (when
			// programs.json is absent). Legacy files are KEPT — user data is
			// never deleted silently; they just aren't read again.
			if (!existsSync(programsPath)) {
				const legacyProcesses = loadProcesses(legacyProcessesPath);
				const legacyTasks = loadTasks(legacyTasksPath);
				if (legacyProcesses.size > 0 || legacyTasks.size > 0) {
					for (const p of migrateLegacy(legacyProcesses, legacyTasks)) {
						if (!programs.has(p.name)) programs.set(p.name, p);
					}
					persistPrograms();
				}
			}
			// Boot reconciliation: runs left live-but-unclaimed (the daemon
			// died mid-run). Pids don't survive daemon death reliably — nudge
			// the recorded pid best-effort, then mark interrupted + log.
			{
				const now = Date.now();
				for (const r of runStore.snapshot()) {
					const terminal = r.exit != null || r.endedAt != null;
					if (terminal || (r.state !== "starting" && r.state !== "running")) continue;
					if (r.pid != null) {
						try {
							process.kill(r.pid, "SIGTERM");
						} catch {
							/* pid gone or foreign — best-effort only */
						}
					}
					try {
						runStore.setState(r.id, "interrupted");
					} catch {
						/* ledger torn — never guess */
					}
					console.log(`[swarm] boot: run ${r.id} (${r.name}) marked interrupted (daemon died mid-run) — at ${new Date(now).toISOString()}`);
				}
			}
			// A crash between claim and fork leaves pendingClaim on the def.
			// That slot is NEVER refired and NEVER silent — it lands as a
			// logged skip, and the schedule marches on.
			{
				let dirty = false;
				const now = Date.now();
				for (const def of programs.values()) {
					if (!def.pendingClaim) continue;
					const slot = def.pendingClaim.slot;
					const origin = def.pendingClaim.origin;
					def.pendingClaim = undefined;
					def.lastSkip = {
						slot,
						at: now,
						reason: `daemon ${origin} mid-fire — slot claimed before the fork, never confirmed; logged skip, no refire`,
					};
					def.nextFire = computeNextFire({ ...def }, now);
					def.updatedAt = now;
					dirty = true;
				}
				if (dirty) persistPrograms();
			}
			// Resubmit desired=running services (fresh runs, origin boot).
			for (const def of programs.values()) {
				if (def.kind !== "service" || def.desired !== "running" || def.paused) continue;
				try {
					forkProgramRun(def, "boot");
				} catch (err) {
					console.warn(
						`[swarm] boot: service ${def.name} fork failed: ${err instanceof Error ? err.message : String(err)} — desired stays running`,
					);
				}
			}
			persistPrograms();
			// the program clock — fires due schedules unless paused
			clockTimer = setInterval(() => {
				try {
					tickPrograms();
				} catch {
					/* the clock is a courtesy, never a contract */
				}
			}, TICK_MS);
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
			for (const t of pendingTimers) clearTimeout(t);
			pendingTimers.clear();
			for (const t of timers.values()) clearTimeout(t);
			timers.clear();
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
			// clean shutdown: stop every child, then detach from the supervisor.
			// Live runs get settled by the exit events if they land in time;
			// stragglers are marked interrupted at the next boot.
			await supervisor.stopAll();
			supervisor.disconnect();
			releaseHomeLock(home);
		},
		async killDaemon() {
			await supervisor.killDaemon();
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

		tickPrograms(now?: number, tickMs?: number) {
			return tickPrograms(now, tickMs);
		},

		pokeProgram(name, patch) {
			const def = programs.get(name);
			if (!def) return false;
			Object.assign(def, patch);
			persistPrograms();
			return true;
		},

		federate,
	};
}
