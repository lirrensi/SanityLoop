// ============================================================================
// sanity/src/extras/loops/index.ts — the loops engine (T-0021, second edition).
// ============================================================================
// A PURE SCHEDULER. It owns TIMING and nothing else: when a kick is due it
// injects ONE canonical followup input and gets out of the way — the inputs
// extra does insertion + continuation, the core does the loop. No child_process
// import lives here; dynamic content is `backticksCommand: true` on the input
// (expanded at insertion by extras/inputs, never at arm time).
//
//   agent.install(loops({
//     classic: { everyMs: 30 * 60_000, message: "Continue working autonomously." },
//     chrono:  { forMs: 25 * 60_000, dwellMs: 10_000, message: "keep going" },
//   }));
//
// THE TWO BUILT-INS (ported semantics from the TUI interval/chonoloop plugins):
//
//   CLASSIC — "nudge me if I go quiet". Eternal until stopped/aborted/uninstalled.
//     The countdown runs only in SILENCE: armed at each landing (EVENTS.stop),
//     cancelled by activity (EVENTS.turnStart), re-armed at the next landing.
//     X minutes of silence → one kick. Optional maxFires turns it into an
//     N-shot loop.
//
//   CHRONO — "work this shift, then clock out". Bounded wall-clock budget:
//     deadline = install-time + forMs. After EVERY landing it waits a short
//     dwell and kicks again regardless of silence — forceful, back-to-back —
//     until the budget is exhausted, then it completes itself. Activity only
//     postpones the dwell (cancelled on turnStart, rescheduled at landing);
//     it never extends the deadline.
//
// WHAT THIS IS NOT: not a cron (no wall-clock schedule, no outliving the
// process) — everything here lives INSIDE an already-running agent heartbeat.
//
// STATE IS TRUTH: every record mirrors into `agent.state[stateKey]` as plain
// data (timers never cross that line) — observable via patched, inspectable,
// externally stoppable (flip status → "stopped"; the filters reconcile at the
// next event). The queue holds INTENT (the raw template); history receives
// REALITY (the expanded text) — both stages truthful about themselves.
//
// FUTURE LOOPS (the spec door): the scheduler only knows "arm / cancel /
// fire / complete" over records — new kinds (until-predicate, work-queue,
// backoff) are additive records with their own scheduling policy. Not a cron;
// still inside the process.
// ============================================================================
import { EVENTS } from "@sanityloop/core";
import type { GodObject, Plugin } from "@sanityloop/core";
import { InputTypes } from "@sanityloop/inputs";
import type { FollowupInput } from "@sanityloop/inputs";
import { removeFiltersByPrefix } from "@sanityloop/util";
import { randomUUID } from "node:crypto";

// ----------------------------------------------------------------------------
// Options
// ----------------------------------------------------------------------------

export interface ClassicLoopOptions {
	/** Loop id inside the state mirror. Default "classic". */
	id?: string;
	/** Silence period before a kick — restarts on every activity. Required. */
	everyMs: number;
	/** The text injected as a followup input. */
	message: string;
	/** Pass-through to the input — `cmd` spans evaluated at insertion. Default false. */
	backticksCommand?: boolean;
	/** Fire at most N times, then complete. Omit = eternal. */
	maxFires?: number;
}

export interface ChronoLoopOptions {
	/** Loop id inside the state mirror. Default "chrono". */
	id?: string;
	/** Total wall-clock budget from install — after this, no more kicks, ever. */
	forMs: number;
	/** Grace between a landing and the next forceful kick. Default 10_000. */
	dwellMs?: number;
	/** The text injected as a followup input. */
	message: string;
	/** Pass-through to the input — `cmd` spans evaluated at insertion. Default false. */
	backticksCommand?: boolean;
}

export interface LoopsOptions {
	/** The eternal nudge-on-silence loop. Omit = none. */
	classic?: ClassicLoopOptions;
	/** The bounded shift-work loop. Omit = none. */
	chrono?: ChronoLoopOptions;
	/**
	 * What a HARD abort (beforeAbort) does to running loops.
	 * "stop" (default — TUI-plugin parity: interrupt kills the loop)
	 * or "keep" (loops survive aborts; they re-arm at the next landing).
	 */
	onAbort?: "stop" | "keep";
	/** Where the state mirror lives. Default "loops". */
	stateKey?: string;
	/** Plugin id — install two instances side by side with distinct ids. Default "loops". */
	id?: string;
}

// ----------------------------------------------------------------------------
// Runtime record (closure) + its plain-data snapshot (state)
// ----------------------------------------------------------------------------

type LoopKind = "classic" | "chrono";
type LoopStatus = "armed" | "waiting" | "fired" | "completed" | "stopped";

interface LoopRecord {
	kind: LoopKind;
	status: LoopStatus;
	startedAt: number;
	fires: number;
	nextFireAt?: number;
	deadline?: number; // chrono
	lastFireAt?: number;
	everyMs?: number; // classic
	dwellMs?: number; // chrono
	maxFires?: number; // classic
	timer?: ReturnType<typeof setTimeout>;
	waitId?: string; // the parked await backing the current wait
	message?: string;
	backticksCommand?: boolean;
}

export interface LoopSnapshot {
	kind: LoopKind;
	status: LoopStatus;
	startedAt: number;
	fires: number;
	nextFireAt?: number;
	deadline?: number;
	lastFireAt?: number;
	everyMs?: number;
	dwellMs?: number;
	maxFires?: number;
}

function snapshot(rec: LoopRecord): LoopSnapshot {
	const s: LoopSnapshot = {
		kind: rec.kind,
		status: rec.status,
		startedAt: rec.startedAt,
		fires: rec.fires,
	};
	if (rec.nextFireAt !== undefined) s.nextFireAt = rec.nextFireAt;
	if (rec.deadline !== undefined) s.deadline = rec.deadline;
	if (rec.lastFireAt !== undefined) s.lastFireAt = rec.lastFireAt;
	if (rec.everyMs !== undefined) s.everyMs = rec.everyMs;
	if (rec.dwellMs !== undefined) s.dwellMs = rec.dwellMs;
	if (rec.maxFires !== undefined) s.maxFires = rec.maxFires;
	return s;
}

const DEFAULT_CHRONO_DWELL_MS = 10_000;

// ----------------------------------------------------------------------------
// The plugin
// ----------------------------------------------------------------------------

export function loops(opts: LoopsOptions = {}): Plugin {
	const pluginId = opts.id ?? "loops";
	const stateKey = opts.stateKey ?? "loops";
	const onAbort = opts.onAbort ?? "stop";
	const prefix = `${pluginId}/`;

	// closure-side truth — hot path, timers never enter observed state
	const records = new Map<string, LoopRecord>();

	/** THE WAIT IS A PARKED AWAIT — not a naked timer. While a loop counts down
	 * (classic silence / chrono dwell), the machine is honestly "awaiting":
	 * hasWork stays true, quit-on-end stands down, dashboards render the pause.
	 * The timeout ANSWERS the await, then the fire callback runs. */
	function parkWait(agent: GodObject, rec: LoopRecord, ms: number, onFire: () => void): void {
		const dwellType = `${pluginId}/wait`;
		const id = `${dwellType}-${randomUUID().slice(0, 8)}`;
		rec.waitId = id;
		agent.pendingAwaits.push({ type: dwellType, id });
		rec.timer = setTimeout(() => {
			rec.timer = undefined;
			rec.waitId = undefined;
			const idx = agent.pendingAwaits.findIndex((a) => a.id === id);
			if (idx >= 0) agent.pendingAwaits.splice(idx, 1);
			onFire();
		}, ms);
	}

	function reflect(agent: GodObject): void {
		const mirror: Record<string, LoopSnapshot> = {};
		for (const [id, rec] of records) mirror[id] = snapshot(rec);
		agent.state[stateKey] = mirror;
	}

	function setActivity(agent: GodObject, text: string): void {
		agent.setActivity(text);
	}

	/** Per-record timer cleanup — timer + observable nextFireAt + (when an agent
	 * is given) the record's OWN parked wait. Precise: never touches siblings. */
	function clearTimer(rec: LoopRecord, agent?: GodObject): void {
		if (rec.timer) {
			clearTimeout(rec.timer);
			rec.timer = undefined;
		}
		rec.nextFireAt = undefined;
		if (rec.waitId && agent) {
			const idx = agent.pendingAwaits.findIndex((a) => a.id === rec.waitId);
			if (idx >= 0) agent.pendingAwaits.splice(idx, 1);
			rec.waitId = undefined;
		}
	}

	/** External control door: reconcile with state-side edits. Terminal statuses
	 * are TOMBSTONES — adopted (timers cleared) but kept visible forever; only an
	 * externally DELETED snapshot drops the record. Runs at the top of every
	 * filter — the state stays the boss even though timers are hot. */
	function syncFromState(agent: GodObject): void {
		const mirror = agent.state[stateKey] as Record<string, LoopSnapshot> | undefined;
		if (!mirror) return;
		for (const [id, rec] of [...records]) {
			const snap = mirror[id];
			if (!snap) {
				// externally deleted — leave the registry
				clearTimer(rec, agent);
				records.delete(id);
				continue;
			}
			if (
				(snap.status === "stopped" || snap.status === "completed") &&
				rec.status !== snap.status
			) {
				rec.status = snap.status;
				clearTimer(rec, agent);
			}
		}
		reflect(agent);
	}

	function complete(agent: GodObject, rec: LoopRecord, id: string, why: string): void {
		clearTimer(rec, agent);
		rec.status = "completed";
		reflect(agent);
		setActivity(agent, `loop '${id}' completed (${why}, ${rec.fires} fire${rec.fires === 1 ? "" : "s"})`);
	}

	function stopAll(agent: GodObject, why: string): void {
		for (const [id, rec] of records) {
			clearTimer(rec, agent);
			rec.status = "stopped";
			setActivity(agent, `loop '${id}' stopped (${why})`);
		}
		reflect(agent);
	}

	/** Inject THE kick — one canonical followup input, nothing more. The inputs
	 * extra owns what happens next (insert now if idle, queue if mid-turn). */
	function fire(agent: GodObject, id: string, rec: LoopRecord): void {
		const st = agent.loopState;
		if (st === "terminated" || st === "aborted" || st === "errored") return;
		clearTimer(rec);
		// chrono checks the budget AT THE FIRE MOMENT (plugin parity): a dwell
		// scheduled near the deadline must not kick past it.
		if (rec.kind === "chrono" && (rec.deadline ?? 0) - Date.now() <= 0) {
			complete(agent, rec, id, "budget exhausted");
			return;
		}
		const cfgMessage = rec.message ?? "";
		const input: FollowupInput = {
			type: InputTypes.followup,
			text: cfgMessage,
			...(rec.backticksCommand === true ? { backticksCommand: true } : {}),
		};
		agent.input(input);
		rec.fires += 1;
		rec.lastFireAt = Date.now();
		if (rec.kind === "classic" && rec.maxFires !== undefined && rec.fires >= rec.maxFires) {
			complete(agent, rec, id, `maxFires ${rec.maxFires} reached`);
			return;
		}
		rec.status = "fired"; // next landing re-arms per policy
		reflect(agent);
		setActivity(agent, `loop '${id}' fired (#${rec.fires})`);
	}

	/** Schedule the next kick per policy — called at landings. */
	function scheduleNext(agent: GodObject, id: string, rec: LoopRecord): void {
		if (rec.status === "completed" || rec.status === "stopped") return;
		const now = Date.now();
		clearTimer(rec);

		if (rec.kind === "chrono") {
			const remaining = (rec.deadline ?? now) - now;
			if (remaining <= 0) {
				complete(agent, rec, id, "budget exhausted");
				return;
			}
			const dwell = rec.dwellMs ?? DEFAULT_CHRONO_DWELL_MS;
			rec.status = "waiting";
			rec.nextFireAt = now + dwell;
			parkWait(agent, rec, dwell, () => fire(agent, id, rec));
			reflect(agent);
			return;
		}

		// classic — the silence countdown restarts from NOW
		const every = rec.everyMs ?? 0;
		rec.status = "waiting";
		rec.nextFireAt = now + every;
		parkWait(agent, rec, every, () => fire(agent, id, rec));
		reflect(agent);
	}

	function makeRecords(): Map<string, LoopRecord> {
		const map = new Map<string, LoopRecord>();
		if (opts.classic) {
			const c = opts.classic;
			map.set(c.id ?? "classic", {
				kind: "classic",
				status: "armed",
				startedAt: Date.now(),
				fires: 0,
				everyMs: c.everyMs,
				maxFires: c.maxFires,
				message: c.message,
				backticksCommand: c.backticksCommand === true,
			});
		}
		if (opts.chrono) {
			const ch = opts.chrono;
			map.set(ch.id ?? "chrono", {
				kind: "chrono",
				status: "armed",
				startedAt: Date.now(),
				fires: 0,
				deadline: Date.now() + ch.forMs,
				dwellMs: ch.dwellMs,
				message: ch.message,
				backticksCommand: ch.backticksCommand === true,
			});
		}
		return map;
	}

	return {
		id: pluginId,
		requires: ["inputs"], // the kick IS a followup input — no vocabulary, no loops
		install(agent) {
			records.clear();
			for (const [id, rec] of makeRecords()) records.set(id, rec);

			// ---- CHRONO forcefulness: if the heartbeat is already alive and the
			// agent is idle at install, start the first dwell immediately —
			// otherwise the first landing arms it (SDK installs usually pre-run). ----
			if (agent.ticks > 0 && agent.loopState === "idle" && !agent.inTurn) {
				for (const [id, rec] of records) {
					if (rec.kind === "chrono") scheduleNext(agent, id, rec);
				}
			}
			reflect(agent);

			// ---- LANDING — the universal (re-)arming point for both policies ----
			agent.addFilter({
				event: EVENTS.stop,
				id: `${prefix}landing`,
				priority: 90,
				fn: async (agent) => {
					syncFromState(agent);
					for (const [id, rec] of records) scheduleNext(agent, id, rec);
				},
			});

			// ---- ACTIVITY cancels pending kicks (silence resets; dwell postponed) ----
			agent.addFilter({
				event: EVENTS.turnStart,
				id: `${prefix}activity`,
				priority: 90,
				fn: async (agent) => {
					syncFromState(agent);
					let touched = false;
					for (const rec of records.values()) {
						if (rec.timer) {
							clearTimer(rec, agent);
							rec.status = "fired"; // neutral between kicks; landing re-arms
							touched = true;
						}
					}
					if (touched) reflect(agent);
				},
			});

			// ---- HARD ABORT — default: the interrupt kills the loops (TUI parity) ----
			agent.addFilter({
				event: EVENTS.beforeAbort,
				id: `${prefix}abort-cleanup`,
				priority: 100,
				fn: async (agent) => {
					if (onAbort !== "stop") return;
					stopAll(agent, "abort");
				},
			});

			agent.addDeclaredCapability({
				id: pluginId,
				description:
					"loops engine — classic (nudge on silence, optional maxFires) + chrono (bounded forceful shift); fires canonical followup inputs",
			});
			agent.addDeclaredInput({
				id: `${pluginId}/kick`,
				schema: null,
				description: "internal — a due loop injects input_followup; expansion handled by extras/inputs",
			});
		},

		uninstall(agent) {
			for (const [id, rec] of records) clearTimer(rec, agent);
			records.clear();
			removeFiltersByPrefix(agent, prefix);
			agent.removeDeclaredCapability(pluginId);
			agent.removeDeclaredInput(`${pluginId}/kick`);
			delete agent.state[stateKey];
		},
	};
}
