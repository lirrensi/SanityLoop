// ============================================================================
// sanity/src/packages/swarm/src/protocol.ts — THE WIRE. One protocol, four clients:
// workers, peers, admins, and the future UI. The daemon is a dumb router: it
// never interprets a frame's payload, only its shape. The core is type-blind,
// and so is the hub — frames carry voices, not memories.
//
//   worker → server:  register, report (stream + lifecycle), ping
//   server → worker:  input, control (the same doors a human REPL would use)
//   peer   → server:  list, get, listen, input, control
//   admin  → server:  everything above + create, kill, restart, broadcast
// server → anyone:  welcome, event (relayed streams), result, error, pong, closed
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
	/** Optional per-role token (when the server has tokens configured). */
	token?: string;
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

export interface ListFrame {
	op: "list";
	id?: string;
}

export interface GetFrame {
	op: "get";
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
	action: "stop" | "abort" | "pause" | "wake";
}

export interface CreateFrame {
	op: "create";
	id?: string;
	/** Template id or file name (matched against the scanned templates). */
	template: string;
	/** Optional explicit sessionId — omit for a fresh one. */
	sessionId?: string;
	/** Optional first input, delivered after the worker registers. */
	prompt?: string;
}

export interface KillFrame {
	op: "kill";
	id?: string;
	sessionId: string;
}

export interface RestartFrame {
	op: "restart";
	id?: string;
	sessionId: string;
	/** Optional prompt delivered after the worker re-registers. */
	prompt?: string;
}

export interface BroadcastFrame {
	op: "broadcast";
	id?: string;
	body: Record<string, unknown>;
	/** Optional subset of sessionIds; omit = every online worker. */
	targets?: string[];
}

export type ClientFrame =
	| RegisterFrame
	| ReportFrame
	| PingFrame
	| ListFrame
	| GetFrame
	| ListenFrame
	| EventsFrame
	| HistoryFrame
	| TemplatesFrame
	| InputFrame
	| ControlFrame
	| CreateFrame
	| KillFrame
	| RestartFrame
	| BroadcastFrame;

// ---------------------------------------------------------------------------
// server → client
// ---------------------------------------------------------------------------

export interface WelcomeFrame {
	op: "welcome";
	sessionId: string;
	/** Registry snapshot at join time. */
	registry: WorkerInfo[];
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
	action: "stop" | "abort" | "pause" | "wake";
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

/** What the registry exposes about a worker. */
export interface WorkerInfo {
	sessionId: string;
	agentId: string;
	description?: string;
	mode: SwarmRole;
	persistent: boolean;
	/** True when the daemon spawned this worker itself (restartable). */
	spawned: boolean;
	status: "online" | "offline";
	/** Derived runtime activity — the "running status". */
	state?: WorkerState;
	/** The last voice the daemon heard from this worker. */
	lastEvent?: SwarmEvent;
	lastEventAt?: number;
	stats?: WorkerStats;
	pid?: number;
	lastSeen: number;
}

/** The control actions a peer/admin may send a worker. */
export const CONTROL_ACTIONS = ["stop", "abort", "pause", "wake"] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

/** Default port the daemon listens on — the well-known local address. */
export const DEFAULT_PORT = 5317;

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
