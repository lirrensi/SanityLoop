// ============================================================================
// sanity/src/packages/swarm/src/protocol.ts — THE WIRE. One protocol, four clients:
// workers, peers, admins, and the future UI. The daemon is a dumb router: it
// never interprets a frame's payload, only its shape. The core is type-blind,
// and so is the hub — frames carry voices, not memories.
//
//   worker → server:  register, report (stream + lifecycle), ping
//   server → worker:  input, control (the same doors a human REPL would use),
//                     drop (you are gone — teardown, never reconnect)
//   peer   → server:  agents_list, agents_get, listen, input, control
//   admin  → server:  everything above + proc_*/task_* ops, drop (agent removal),
//                     broadcast
// server → anyone:  welcome, event (relayed streams), result, error, pong, closed
//
// ONE API, MANY SURFACES: the daemon's ops are exposed verbatim over WS frames
// (here), REST routes (server/rest.ts) and the CLI (a WS client). input/listen
// stay wire-only where they belong to streams; everything else is entity CRUD.
//
// patched (the god-object delta) is NEVER on the wire — it is the job of the
// worker's own storage. The swarm carries voices, not memories.
//
// ONE API, MANY SURFACES: the daemon's ops are exposed verbatim over WS frames
// (here), REST routes (server/rest.ts) and the CLI (a WS client). input/listen
// stay wire-only where they belong to streams; everything else is fleet CRUD.
//
// patched (the god-object delta) is NEVER on the wire — it is the job of the
// worker's own storage. The swarm carries voices, not memories.
// ============================================================================

/** Stream events a worker reports upward — the live "voices". */
export const STREAM_EVENTS = [
	"streamStarted",
	"textDelta",
	"textEnd",
	"thinkingDelta",
	"thinkingEnd",
	"toolcallDelta",
] as const;

/** Lifecycle events a worker reports — birth, landings, death. */
export const LIFECYCLE_EVENTS = [
	"agentStart",
	"agentSettled",
	"cycleEnd",
	"turnEnd",
	"stop",
	"abort",
	"error",
] as const;

export type SwarmEvent =
	| (typeof STREAM_EVENTS)[number]
	| (typeof LIFECYCLE_EVENTS)[number];

/** The three hats. Enforcement is the server's job (tokens), not tool-absence. */
export type SwarmRole = "worker" | "peer" | "admin";

// ---------------------------------------------------------------------------
// client → server
// ---------------------------------------------------------------------------

/** Optional request id — echoed in the result/error frame. Lets clients do RPC. */
export interface WithReqId {
	id?: string;
}

export interface RegisterFrame {
	op: "register";
	sessionId: string;
	agentId: string;
	description?: string;
	/** The claimed hat. The server validates it against the token. */
	mode: SwarmRole;
	/** Storage enabled → the session can be resumed. The daemon records it. */
	persistent: boolean;
	/** Where the worker lives in the room tree (default "global").
	 *  For peer/admin this is the MOUNT POINT — the visibility prefix
	 *  (an ancestor sees its descendants; sideways and upward: invisible). */
	room?: string;
	/** Optional per-role token (when the server has tokens configured). */
	token?: string;
	/** Backlink: which process/task/spawn forked this agent. Echoed as AgentInfo.parent. */
	spawnId?: string;
}

export interface ReportFrame {
	op: "report";
	event: SwarmEvent;
	payload?: unknown;
}

export interface PingFrame {
	op: "ping";
	t: number;
}

export interface AgentsListFrame {
	op: "agents_list";
	id?: string;
}

/** Compat alias of agents_list — the federation mount's wire (never advertised). */
export interface DispatchListFrame {
	op: "list";
	id?: string;
}

export interface AgentsGetFrame {
	op: "agents_get";
	id?: string;
	sessionId: string;
}


export interface ListenFrame {
	op: "listen";
	id?: string;
	sessionId: string;
	on: boolean;
}

/** The recent-events ring of one worker — the daemon's memory of its voices. */
export interface EventsFrame {
	op: "events";
	id?: string;
	sessionId: string;
	limit?: number;
}

/** Every worker ever seen — resumable discovery. */
export interface HistoryFrame {
	op: "history";
	id?: string;
}

/** Spawnable templates — what the daemon could start. */
export interface TemplatesFrame {
	op: "templates";
	id?: string;
}

/** Send an input to a worker — routed as-is, never interpreted. */
export interface InputFrame {
	op: "input";
	id?: string;
	target: string;
	body: Record<string, unknown>;
}

export interface ControlFrame {
	op: "control";
	id?: string;
	target: string;
	action: "stop" | "abort" | "pause" | "wake" | "shutdown" | "reset";
}

export interface DropFrame {
	op: "drop";
	id?: string;
	/** One agent identified — the daemon closes its socket and forgets it.
	 *  Idempotent: dropping a ghost succeeds silently. */
	sessionId: string;
}

export interface ProcStartFrame {
	op: "proc_start";
	id?: string;
	name: string;
	file?: string;
	from?: string;
	prompt?: string;
	autorestart?: boolean;
}

export interface ProcSaveFrame {
	op: "proc_save";
	id?: string;
	name: string;
	file?: string;
	from?: string;
	autorestart?: boolean;
}

export interface ProcStopFrame {
	op: "proc_stop";
	id?: string;
	name: string;
}

export interface ProcRemoveFrame {
	op: "proc_remove";
	id?: string;
	name: string;
}

export interface ProcSetAutorestartFrame {
	op: "proc_set_autorestart";
	id?: string;
	name: string;
	autorestart: boolean;
}

export interface ProcRestartFrame {
	op: "proc_restart";
	id?: string;
	name: string;
	prompt?: string;
}

export interface ProcListFrame {
	op: "proc_list";
	id?: string;
}

export interface ProcGetFrame {
	op: "proc_get";
	id?: string;
	name: string;
}

export interface TaskDefineFrame {
	op: "task_define";
	id?: string;
	name: string;
	file?: string;
	from?: string;
	fire: "every" | "at" | "manual";
	everyMs?: number;
	at?: number;
}

export interface TaskFireFrame {
	op: "task_fire";
	id?: string;
	name: string;
	prompt?: string;
}
export interface TaskTriggerFrame {
	op: "task_trigger";
	id?: string;
	name: string;
	/** Transient context — delivered as the fork's prompt, never stored on the definition. */
	context?: string;
	prompt?: string;
}

export interface TaskPauseFrame {
	op: "task_pause";
	id?: string;
	name: string;
	paused: boolean;
}

export interface TaskResumeFrame {
	op: "task_resume";
	id?: string;
	name: string;
}

export interface TaskRemoveFrame {
	op: "task_remove";
	id?: string;
	name: string;
}

export interface TaskListFrame {
	op: "task_list";
	id?: string;
}

export interface TaskGetFrame {
	op: "task_get";
	id?: string;
	name: string;
}


export interface BroadcastFrame {
	op: "broadcast";
	id?: string;
	body: Record<string, unknown>;
	/** Optional subset of sessionIds; omit = every online worker. */
	targets?: string[];
	/** Optional blast-radius scope: only workers under this room subtree. */
	room?: string;
}

export type ClientFrame =
	| RegisterFrame
	| ReportFrame
	| PingFrame
	| AgentsListFrame
	| DispatchListFrame
	| AgentsGetFrame
	| ListenFrame
	| EventsFrame
	| HistoryFrame
	| TemplatesFrame
	| InputFrame
	| ControlFrame
	| DropFrame
	| ProcStartFrame
	| ProcSaveFrame
	| ProcStopFrame
	| ProcRemoveFrame
	| ProcSetAutorestartFrame
	| ProcRestartFrame
	| ProcListFrame
	| ProcGetFrame
	| TaskDefineFrame
	| TaskFireFrame
	| TaskTriggerFrame
	| TaskPauseFrame
	| TaskResumeFrame
	| TaskRemoveFrame
	| TaskListFrame
	| TaskGetFrame
	| BroadcastFrame;

// server → client
// ---------------------------------------------------------------------------

export interface WelcomeFrame {
	op: "welcome";
	sessionId: string;
	/** The daemon's declared name — the handshake answer to "who are you?".
	 *  Undefined when the daemon is unnamed (hermit mode — federation refused). */
	swarm?: string;
	/** Registry snapshot at join time. */
	registry: AgentInfo[];
}

/** A relayed stream/lifecycle event from a worker you subscribed to. */
export interface EventFrame {
	op: "event";
	target: string;
	event: SwarmEvent;
	payload?: unknown;
}

/** An input routed TO this worker — call agent.input(body). */
export interface InputToWorkerFrame {
	op: "input";
	body: Record<string, unknown>;
}

/** A control routed TO this worker. */
export interface ControlToWorkerFrame {
	op: "control";
	action: "stop" | "abort" | "pause" | "wake" | "shutdown" | "reset";
}

/** A drop routed TO this worker — teardown, suppress reconnect, stay gone
 *  until a deliberate re-register. Dropped ≠ disconnected: a plain close
 *  retries, a drop never does. */
export interface DropToWorkerFrame {
	op: "drop";
	reason?: string;
}

export interface ResultFrame {
	op: "result";
	reqOp: string;
	/** Echoed request id — RPC correlation. */
	id?: string;
	data?: unknown;
}

export interface ErrorFrame {
	op: "error";
	reqOp: string;
	/** Echoed request id — RPC correlation. */
	id?: string;
	error: string;
}

export interface PongFrame {
	op: "pong";
	t: number;
}

export interface ClosedFrame {
	op: "closed";
	reason: string;
}

export type ServerFrame =
	| WelcomeFrame
	| EventFrame
	| InputToWorkerFrame
	| ControlToWorkerFrame
	| DropToWorkerFrame
	| ResultFrame
	| ErrorFrame
	| PongFrame
	| ClosedFrame;

/** Runtime activity, derived by the daemon from the worker's own lifecycle reports
 *  (plus optimistic updates when a control action is routed). The daemon never
 *  invents it — it only folds what it hears. */
export type WorkerState = "idle" | "busy" | "paused" | "error";

/** Cheap counters the daemon keeps per worker — folded from lifecycle reports. */
export interface WorkerStats {
	cycles: number;
	turns: number;
	errors: number;
}

/** One entry of the per-worker recent-events ring (lifecycle payloads only —
 *  stream deltas are high-frequency noise, the ring keeps their names, not bodies). */
export interface RecentEvent {
	event: SwarmEvent;
	at: number;
	payload?: unknown;
}

/** What the registry exposes about an agent. Agents are whoever joined —
 *  wild (no parent) or spawned (parent = process name / task fire id). */
export interface AgentInfo {
	sessionId: string;
	agentId: string;
	description?: string;
	mode: SwarmRole;
	persistent: boolean;
	/** Backlink: which process/task/spawn forked this agent (absent = wild). */
	parent?: string;
	status: "online" | "offline";
	/** Where in the room tree this agent lives (always set — default "global"). */
	room?: string;
	/** Derived full address: "<swarm>/<room>/<sessionId>" (unnamed daemon: "<room>/<sessionId>").
	 *  Display + resolution — the registry key, never stored as payload truth. */
	address?: string;
	/** "local" = born here. "mirrored" = a federation mirror of a remote worker. */
	origin?: "local" | "mirrored";
	/** Derived runtime activity — the "running status". */
	state?: WorkerState;
	/** The last voice the daemon heard from this agent. */
	lastEvent?: SwarmEvent;
	lastEventAt?: number;
	stats?: WorkerStats;
	lastSeen: number;
}

/** Legacy alias — AgentInfo renamed from WorkerInfo. Kept for the untouched
 *  federation door (federate.ts) until phase 2 reshapes mirrors. */
export type WorkerInfo = AgentInfo;

/** The control actions a peer/admin may send a worker. */
export const CONTROL_ACTIONS = ["stop", "abort", "pause", "wake", "shutdown", "reset"] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

/** Default port the daemon listens on — the well-known local address. */
export const DEFAULT_PORT = 5317;

/** The root room — where every worker lives when it claims nothing. */
export const ROOT_ROOM = "global";

// ---------------------------------------------------------------------------
// ROOM PATHS — one shape, everywhere. A room is a "/"-separated path prefix on
// registry entries; it is NOT an object, there is no create-room op. Visibility
// is a single rule: an ancestor sees its descendants (startsWith), sideways and
// upward: invisible.
// ---------------------------------------------------------------------------

/** Normalize a claimed room path: trim slashes, drop empty/dot segments,
 *  forbid traversal. Null = malformed (the daemon rejects, never guesses). */
export function normalizeRoom(room: unknown): string | null {
	if (room === undefined || room === null || room === "") return ROOT_ROOM;
	if (typeof room !== "string") return null;
	const segs = room
		.split("/")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	if (segs.length === 0) return ROOT_ROOM;
	for (const s of segs) {
		if (s === "." || s === "..") return null; // no climbing the tree
		if (s.includes("\\") || s.includes(" ")) return null; // keep addresses clean
	}
	return segs.join("/");
}

/** The full address of a registry entry — the swarm stamps itself, the worker
 *  never claims its swarm. Unnamed (hermit) daemon: the swarm segment is absent. */
export function addressOf(
	swarm: string | undefined,
	room: string,
	sessionId: string,
): string {
	return swarm
		? `${swarm}/${room}/${sessionId}`
		: `${room}/${sessionId}`;
}

/** Defensive JSON parse for WS text frames. */
export function parseFrame(text: string): ClientFrame | null {
	try {
		const data = JSON.parse(text) as unknown;
		if (typeof data !== "object" || data === null) return null;
		const op = (data as { op?: unknown }).op;
		if (typeof op !== "string" || !op) return null;
		return data as ClientFrame;
	} catch {
		return null;
	}
}
