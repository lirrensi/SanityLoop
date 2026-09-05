// ============================================================================
// sanity/src/packages/swarm/src/server/index.ts — THE DAEMON. A dumb hypervisor:
//   · WS hub — routes frames by address, fan-outs streams to subscribers. It
//     never interprets a payload, only its shape (the core is type-blind, so is
//     the hub).
//   · ONE API, MANY SURFACES — the ops live in FleetApi; WS frames, REST routes
//     (rest.ts) and the CLI (a WS client) are thin adapters over the same core.
//   · registry (live) + history (every worker ever seen) — resumable = persistent
//     workers the daemon recognizes; restartable = workers it spawned.
//   · ROOMS — a room is NOT an object, it is a "/"-path prefix on registry
//     entries. ONE visibility rule: an ancestor sees its descendants
//     (startsWith); sideways and upward: invisible. Workers claim where they
//     live; peer/admin mount where they look. The swarm name is STAMPED by the
//     daemon — a worker never claims which swarm it belongs to.
//   · FEDERATION (server/federate.ts) — the daemon dials another daemon as a
//     peer and mirrors its online workers under the remote's declared name as a
//     room subtree. State stays honest (reports are folded, not invented),
//     authority stays home (the remote's tokens decide), and federation does
//     not transit (mirrors of mirrors are never mirrored).
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
import {
	ROOT_ROOM,
	DEFAULT_PORT,
	addressOf,
	normalizeRoom,
	parseFrame,
} from "../protocol.ts";
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
import { createMount } from "./federate.ts";
import type { FederationHost } from "./federate.ts";

export interface SwarmServerOptions {
	/** The daemon's home — where config.json, templates/, sessions/ and fleet.json live.
	 * Default: $SWARM_HOME or ~/.sanity/swarm (the one daemon per system). */
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
	/** Where this worker lives (worker) / the visibility prefix (peer/admin). */
	room: string;
	mode: SwarmRole;
	persistent: boolean;
	/** Subscribed addresses — the fan-out targets this connection listens to. */
	subscribed: Set<string>;
}

/** A mirror's live wire back to the daemon it came from. Mirrors route
 *  input/control/kill/restart through this — the remote's tokens decide. */
export type MirrorForward = (frame: Record<string, unknown>) => void;

interface RegistryEntry {
	sessionId: string;
	agentId: string;
	description?: string;
	mode: SwarmRole;
	persistent: boolean;
	spawned: boolean;
	/** Always set — the room this worker lives in (default "global"). */
	room: string;
	/** "local" | "mirrored" */
	origin: "local" | "mirrored";
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
		/** Visibility scope — only workers under this room subtree. */
		under?: string;
	}): WorkerInfo[];
	get(sessionId: string, under?: string): WorkerInfo | null;
	history(under?: string): WorkerInfo[];
	templates(): TemplateInfo[];
	/** The recent-events ring of one worker (lifecycle payloads only). */
	events(
		sessionId: string,
		limit?: number,
		under?: string,
	): { sessionId: string; events: RecentEvent[] } | null;
	/** Spawn a template worker. Returns null for an unknown template. */
	create(
		template: string,
		opts?: { sessionId?: string; prompt?: string },
	): { sessionId: string; pid?: number } | null;
	kill(sessionId: string, under?: string): { ok: boolean; sessionId: string };
	/** Restart a daemon-spawned worker; optional prompt delivered after re-register. */
	restart(
		sessionId: string,
		opts?: { prompt?: string },
		under?: string,
	): { ok: boolean; sessionId: string };
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
	registry(): WorkerInfo[];
	/** History — every worker ever seen (resumable discovery). */
	history(): WorkerInfo[];
	templates(): TemplateInfo[];
	/** Command the daemon: spawn an admin agent (or any template). */
	spawnTemplate(
		template: string,
		opts?: { sessionId?: string },
	): { sessionId: string; pid?: number } | null;
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
		resurrectOnBoot = false,
	} = opts;
	/** The stamp. Every local address starts with it (when declared). */
	const swarmName = opts.name?.trim() || undefined;

	// the daemon IS a location — resolve its home, scaffold it, derive the defaults
	const home = opts.home ?? resolveHome();
	ensureScaffold(home);
	ensureNodeModulesLink(home);
	const layout = homeLayout(home);
	const templatesDir = opts.templatesDir ?? layout.templatesDir;
	const manifestPath = opts.manifestPath ?? layout.manifestPath;
	const sessionsDir = layout.sessionsDir;

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
	const spawner = new Spawner({
		templatesDir,
		manifestPath,
	});

	/** THE one visibility rule. A room is a path prefix; an ancestor sees its
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
		room: e.room,
		address: addressOf(swarmName, e.room, e.sessionId),
		origin: e.origin,
		state: e.state,
		lastEvent: e.lastEvent,
		lastEventAt: e.lastEventAt,
		stats: e.stats,
		pid: e.pid,
		lastSeen: e.lastSeen,
	});

	const snapshot = (mount: string = ROOT_ROOM): WorkerInfo[] =>
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
			spawned: spawner.isSpawned(frame.sessionId),
			pid: spawner.pidOf(frame.sessionId),
			room,
			origin: "local",
			status: "online",
			stats: freshStats(),
			recent: [],
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

	// ---------------------------------------------------------------------------
	// THE CORE — every surface below this line is an adapter over `api`.
	// ---------------------------------------------------------------------------
	const api: FleetApi = {
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

		history(under) {
			const mount = under ?? ROOT_ROOM;
			return [...history.values()]
				.filter((e) => visible(mount, e.room))
				.map(info);
		},

		templates() {
			return spawner.scanTemplates();
		},

		events(sessionId, limit = 100, under) {
			const e = resolve(sessionId);
			if (!e) return null;
			if (under && !visible(under, e.room)) return null;
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
			const room = ROOT_ROOM;
			const key = localKey(room, spawned.sessionId);
			registry.set(key, {
				sessionId: spawned.sessionId,
				agentId: t.id,
				description: t.description,
				// the manifest's mode is INDICATION only — the .ts decides its real mode at register
				mode: t.mode ?? "worker",
				persistent: true,
				spawned: true,
				room,
				origin: "local",
				pid: spawned.pid,
				status: "offline",
				stats: freshStats(),
				recent: [],
				lastSeen: Date.now(),
			});
			bySessionId.set(spawned.sessionId, key);
			if (createOpts.prompt) queuePrompt(spawned.sessionId, createOpts.prompt);
			return spawned;
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
			const ok = spawner.kill(e.sessionId);
			if (e.conn) {
				e.conn.ws.close();
				e.status = "offline";
				e.conn = undefined;
			}
			return { ok, sessionId: e.sessionId };
		},

		restart(sessionId, restartOpts = {}, under) {
			const e = resolve(sessionId);
			if (!e) return { ok: false, sessionId };
			if (under && !visible(under, e.room)) return { ok: false, sessionId };
			if (e.origin === "mirrored") {
				// the remote restarts it its way; our mirror follows the reports
				e.forward?.({
					op: "restart",
					sessionId: e.sessionId,
					prompt: restartOpts.prompt,
				});
				return { ok: true, sessionId: e.sessionId };
			}
			if (restartOpts.prompt) queuePrompt(e.sessionId, restartOpts.prompt);
			const ok = spawner.restart(e.sessionId);
			if (!ok && restartOpts.prompt) pendingPrompts.delete(e.sessionId);
			return { ok, sessionId: e.sessionId };
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
						spawned: false,
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
			case "list":
				if (!hasPerm(conn, "list")) break;
				result(conn, frame, "list", api.list({ under: conn.room }));
				return;
			case "get":
				if (!hasPerm(conn, "get")) break;
				result(conn, frame, "get", api.get(frame.sessionId, conn.room));
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
					// blast radius = caller's mount ∩ explicit room scope ∩ online
					const scope = frame.room
						? (normalizeRoom(frame.room) ?? ROOT_ROOM)
						: ROOT_ROOM;
					const inScope = (e: RegistryEntry): boolean =>
						e.status === "online" &&
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
		},

		registry() {
			return snapshot(ROOT_ROOM);
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

		federate,
	};
}
