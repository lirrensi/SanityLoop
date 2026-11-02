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
//                     listen targets ONE of: agent (sessionId) XOR run (runId)
//                     XOR program (program name) — run/program completions fan
//                     out as events with target = run id (run watcher v1)
//   admin  → server:  everything above + program_*/run_* ops, drop (agent removal),
//                     broadcast
// server → anyone:  welcome, event (relayed streams + run completions), result,
//                   error, pong, closed
//
// ONE API, MANY SURFACES: the daemon's ops are exposed verbatim over WS frames
// (here), REST routes (server/rest.ts) and the CLI (a WS client). input/listen
// stay wire-only where they belong to streams; everything else is entity CRUD:
// agents (who joined), programs (remembered forks + schedules), runs (ledger).
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

/** Terminal run events the daemon emits to run/program watchers — never
 *  reported by workers, only fanned out on settle (target = run id).
 *  completed = exit 0, failed = dirty exit, interrupted = every other
 *  terminal landing (timeout/kill/cancel/boot-interrupt). Runs are global
 *  (no rooms): subscribers are already admin/peer by PERMS on listen, so
 *  fan-out requires nothing extra. WS-only v1: no REST/CLI surface. */
export const RUN_EVENTS = ["runCompleted", "runFailed", "runInterrupted"] as const;

export type SwarmEvent =
	| (typeof STREAM_EVENTS)[number]
	| (typeof LIFECYCLE_EVENTS)[number]
	| (typeof RUN_EVENTS)[number];

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
	/** Agent target — the original voice subscription. */
	sessionId?: string;
	/** Run target — XOR with sessionId/program. Admin/peer only (PERMS). */
	runId?: string;
	/** Program target — all runs of one program. XOR with sessionId/runId. */
	program?: string;
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

/** A program spawn: an agent file, or an arbitrary command. */
export type ProgramSpawnFrame = { file: string } | { cmd: string; args?: string[]; cwd?: string };

/** Restart policy for services (jobs retry via `retries`). */
export interface ProgramRestartFrame {
	policy: "never" | "always" | "on-failure";
	backoffMs?: number;
	maxRestarts?: number;
}

/** When a job fires: `every` interval, `cron` expression, `at` one-shot, `manual` trigger-only. */
export interface ProgramScheduleFrame {
	kind: "every" | "cron" | "at" | "manual";
	everyMs?: number;
	everyMode?: "rate" | "delay";
	anchor?: number;
	expr?: string;
	timezone?: string;
	at?: number;
	startAt?: number;
	stopAt?: number;
	maxRuns?: number;
}

export interface ProgramRetryFrame {
	attempts: number;
	backoffMs: number;
}

/** Shared program fields — program_define sets them, program_patch patches them. */
export interface ProgramFields {
	kind?: "service" | "job";
	spawn?: ProgramSpawnFrame;
	from?: string;
	desired?: "running" | "stopped";
	restart?: ProgramRestartFrame;
	schedule?: ProgramScheduleFrame;
	paused?: boolean;
	overlap?: "skip" | "allow" | "allowN" | "buffer1" | "bufferAll" | "cancel" | "restart";
	allowN?: number;
	timeoutMs?: number;
	catchupWindowMs?: number;
	missPolicy?: "fireOnce" | "skip";
	retries?: ProgramRetryFrame;
	pauseOnFail?: boolean;
	jitterMs?: number;
	stableJitter?: boolean;
	minGapMs?: number;
	onFailTrigger?: string;
	onSuccessTrigger?: string;
	triggerToken?: string;
	promptTimeoutMs?: number;
	killGraceMs?: number;
	keepRuns?: number;
	notes?: string;
}

export interface ProgramDefineFrame extends ProgramFields {
	op: "program_define";
	id?: string;
	name: string;
}

/** Promotion = patch: merge the patch over the def, validate the merged def. */
export interface ProgramPatchFrame {
	op: "program_patch";
	id?: string;
	name: string;
	patch: Partial<ProgramFields>;
}

/** Manual run — forks now, schedule untouched (nextFire/lastSlot never move). */
export interface ProgramLaunchFrame {
	op: "program_launch";
	id?: string;
	name: string;
	context?: string;
	prompt?: string;
	waitMs?: number;
	/** Watchdog path: when it matches the program's triggerToken, program_launch
	 *  is honored without the admin role. REST/CLI honor the same convention. */
	token?: string;
}

/** Forget the definition — in-flight runs finish, labels settle as orphans. */
export interface ProgramRemoveFrame {
	op: "program_remove";
	id?: string;
	name: string;
}

export interface ProgramListFrame {
	op: "program_list";
	id?: string;
	name?: string;
}

export interface ProgramGetFrame {
	op: "program_get";
	id?: string;
	name: string;
}

/** Next-N fire times for a program, without forking. */
export interface ProgramPreviewFrame {
	op: "program_preview";
	id?: string;
	name: string;
	n?: number;
}

/** Concatenated stdout tails across a program's history (newest last). */
export interface ProgramLogsFrame {
	op: "program_logs";
	id?: string;
	name: string;
	tailBytes?: number;
}

/** Always creates a run; waitMs is caller patience, never run lifetime. */
export interface RunExecFrame {
	op: "run_exec";
	id?: string;
	spawn: ProgramSpawnFrame;
	waitMs?: number;
	timeoutMs?: number;
	name?: string;
	context?: string;
}

export interface RunGetFrame {
	op: "run_get";
	id?: string;
	runId: string;
}

export interface RunListFrame {
	op: "run_list";
	id?: string;
	program?: string;
	state?: string;
	limit?: number;
}

export interface RunLogsFrame {
	op: "run_logs";
	id?: string;
	runId: string;
	stream?: "stdout" | "stderr" | "both";
	tailBytes?: number;
	offset?: number;
}

export interface RunWaitFrame {
	op: "run_wait";
	id?: string;
	runId: string;
	match?: string;
	timeoutMs?: number;
}

/** force = SIGKILL now (skip the grace). */
export interface RunKillFrame {
	op: "run_kill";
	id?: string;
	runId: string;
	graceMs?: number;
	force?: boolean;
}

export interface RunSignalFrame {
	op: "run_signal";
	id?: string;
	runId: string;
	signal: string;
}

/** Promote an orphan run into a remembered program. */
export interface RunSaveFrame {
	op: "run_save";
	id?: string;
	runId: string;
	name: string;
	kind?: "service" | "job";
}

export interface RunPruneFrame {
	op: "run_prune";
	id?: string;
	olderThanMs?: number;
	keep?: number;
}

/** Same spawn, new run. */
export interface RunRestartFrame {
	op: "run_restart";
	id?: string;
	runId: string;
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
	| ProgramDefineFrame
	| ProgramPatchFrame
	| ProgramLaunchFrame
	| ProgramRemoveFrame
	| ProgramListFrame
	| ProgramGetFrame
	| ProgramPreviewFrame
	| ProgramLogsFrame
	| RunExecFrame
	| RunGetFrame
	| RunListFrame
	| RunLogsFrame
	| RunWaitFrame
	| RunKillFrame
	| RunSignalFrame
	| RunSaveFrame
	| RunPruneFrame
	| RunRestartFrame
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
