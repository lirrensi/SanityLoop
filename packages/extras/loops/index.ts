// ============================================================================
// sanity/src/extras/loops/index.ts — the loops engine (T-0021, second edition).
// ============================================================================
// A PURE SCHEDULER. It owns TIMING and nothing else: when a kick is due it
// injects ONE canonical followup input and gets out of the way — the inputs
// extra does insertion + continuation, the core does the loop. No child_process
// import lives here; dynamic content is `backticksCommand: true` on the input
// (expanded at insertion by extras/inputs, never at arm time).
//
//   agent.use(loops({
//     classic: { everyMs: 30 * 60_000, message: "Continue working autonomously." },
//     chrono:  { forMs: 25 * 60_000, dwellMs: 10_000, message: "keep going" },
//     once:    { delayMs: 60_000, message: "One reminder" },
//     cron:    { expression: "0 9 * * *", message: "Daily report." },
//   }));
//
// THE FOUR BUILT-INS:
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
//   ONCE — "poke me one time". A single kick after `delayMs` or at wall-clock
//     `at` (ms epoch or Date) — fire-and-forget inside the process. Arms at
//     install, immune to activity, completes itself on fire. May be an array
//     for several one-shots.
//
//   CRON — "on a schedule". Standard 5-field expression, optional IANA `tz`,
//     optional `maxFires`. Arms at install, re-arms the next slot at every
//     fire (a long turn can't eat a slot — overlap "skip" drops it honestly
//     when the loop is busy, "queue" injects anyway). May be an array.
//     In-process only: slots don't survive a restart (the tape brings state
//     back, not timers) — for durable schedules, drive the agent from a real
//     cron (see runlog's process granularity + file-rpc's cron-safe lobby).
//
// STATE IS TRUTH: every record mirrors into `agent.state[stateKey]` as plain
// data (timers never cross that line) — observable via patched, inspectable,
// externally stoppable (flip status → "stopped"; the filters reconcile at the
// next event). The queue holds INTENT (the raw template); history receives
// REALITY (the expanded text) — both stages truthful about themselves.
//
// FUTURE LOOPS (the spec door): the scheduler only knows "arm / cancel /
// fire / complete" over records — new kinds (until-predicate, work-queue,
// backoff) are additive records with their own scheduling policy.
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

export interface OnceLoopOptions {
	/** Loop id inside the state mirror. Default "once". */
	id?: string;
	/** Fire once after this delay from install. XOR with `at`. */
	delayMs?: number;
	/** Fire once at this wall-clock time (ms epoch or Date). XOR with `delayMs`. */
	at?: number | Date;
	/** The text injected as a followup input. */
	message: string;
	/** Pass-through to the input — `cmd` spans evaluated at insertion. Default false. */
	backticksCommand?: boolean;
}

export interface CronLoopOptions {
	/** Loop id inside the state mirror. Default "cron". */
	id?: string;
	/** Standard 5-field cron expression (`m h dom mon dow`). UTC unless `tz` given. */
	expression: string;
	/** IANA timezone for the expression (e.g. "America/New_York"). Default: local. */
	tz?: string;
	/** Another fire while the previous kick's turn is still running: "skip"
	 * (default — one canonical input per slot) or "queue" (inject anyway; the
	 * inputs extra lines it up behind the running turn). */
	overlap?: "skip" | "queue";
	/** Fire at most N times, then complete. Omit = eternal. */
	maxFires?: number;
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
	/** One-shot: a single kick after a delay or at a wall-clock time. Omit = none. */
	once?: OnceLoopOptions | OnceLoopOptions[];
	/** Wall-clock schedule inside this process. Omit = none. */
	cron?: CronLoopOptions | CronLoopOptions[];
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

type LoopKind = "classic" | "chrono" | "once" | "cron";
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
	maxFires?: number; // classic, cron
	at?: number; // once — absolute fire time
	expression?: string; // cron
	tz?: string; // cron
	overlap?: "skip" | "queue"; // cron
	timer?: NodeJS.Timeout;
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
	at?: number;
	expression?: string;
	tz?: string;
	overlap?: "skip" | "queue";
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
	if (rec.at !== undefined) s.at = rec.at;
	if (rec.expression !== undefined) s.expression = rec.expression;
	if (rec.tz !== undefined) s.tz = rec.tz;
	if (rec.overlap !== undefined) s.overlap = rec.overlap;
	return s;
}

const DEFAULT_CHRONO_DWELL_MS = 10_000;

// ----------------------------------------------------------------------------
// Cron — dependency-free 5-field matcher (`m h dom mon dow`), UTC or IANA tz.
// Fields support `*`, `*/n`, `a-b`, `a-b/n`, `a,b,c`. Dow: 0 and 7 = Sunday.
// Day matching follows cron's OR rule: when BOTH dom and dow are restricted
// (not `*`), a day matches if EITHER matches; otherwise the restricted one
// must match. nextCronFire scans forward minute by minute (cap: 366 days) —
// cheap (one scan per fire), no parser dependency, good enough for in-process.
// ----------------------------------------------------------------------------

interface CronFields {
	minute: number[];
	hour: number[];
	dom: number[];
	month: number[];
	dow: number[];
	domRestricted: boolean;
	dowRestricted: boolean;
}

function parseCronField(field: string, min: number, max: number): number[] {
	const out = new Set<number>();
	for (const part of field.split(",")) {
		const [range, stepStr] = part.split("/");
		const step = stepStr === undefined ? 1 : Number.parseInt(stepStr, 10);
		if (!Number.isInteger(step) || step <= 0) {
			throw new Error(`[sanity] bad cron step in "${field}"`);
		}
		let lo = min;
		let hi = max;
		if (range !== "*" && range !== undefined && range !== "") {
			const dash = range.indexOf("-");
			if (dash >= 0) {
				lo = Number.parseInt(range.slice(0, dash), 10);
				hi = Number.parseInt(range.slice(dash + 1), 10);
			} else {
				lo = Number.parseInt(range, 10);
				hi = lo;
			}
			if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
				throw new Error(`[sanity] bad cron field "${field}" (want ${min}-${max})`);
			}
		}
		for (let v = lo; v <= hi; v += step) out.add(v);
	}
	if (out.size === 0) throw new Error(`[sanity] bad cron field "${field}" (empty)`);
	return [...out].sort((a, b) => a - b);
}

function parseCron(expression: string): CronFields {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) {
		throw new Error(`[sanity] bad cron expression "${expression}" (want 5 fields: m h dom mon dow)`);
	}
	const [minF, hourF, domF, monF, dowF] = fields as [string, string, string, string, string];
	const dow = parseCronField(dowF, 0, 7).map((d) => (d === 7 ? 0 : d));
	return {
		minute: parseCronField(minF, 0, 59),
		hour: parseCronField(hourF, 0, 23),
		dom: parseCronField(domF, 1, 31),
		month: parseCronField(monF, 1, 12),
		dow: [...new Set(dow)].sort((a, b) => a - b),
		domRestricted: domF !== "*",
		dowRestricted: dowF !== "*",
	};
}

const DOW_BY_ABBR: Record<string, number> = {
	Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** Wall-clock parts of `at` in `tz` (or local when tz is undefined). */
function tzParts(at: number, tz: string | undefined): { minute: number; hour: number; dom: number; month: number; dow: number } {
	const d = new Date(at);
	if (tz === undefined) {
		return { minute: d.getMinutes(), hour: d.getHours(), dom: d.getDate(), month: d.getMonth() + 1, dow: d.getDay() };
	}
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		weekday: "short",
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
		hour12: false,
	}).formatToParts(d);
	const get = (type: string): number => {
		const p = parts.find((x) => x.type === type);
		if (p === undefined) throw new Error(`[sanity] bad timezone "${tz}" (no ${type} part)`);
		return Number.parseInt(p.value, 10);
	};
	const weekday = parts.find((x) => x.type === "weekday")?.value ?? "";
	const dow = DOW_BY_ABBR[weekday];
	if (dow === undefined) throw new Error(`[sanity] bad timezone "${tz}" (no weekday)`);
	return { minute: get("minute"), hour: get("hour") % 24, dom: get("day"), month: get("month"), dow };
}

/** Next fire strictly after `fromMs`, or undefined when nothing matches within a year. */
export function nextCronFire(expression: string, fromMs: number, tz?: string): number | undefined {
	const f = parseCron(expression);
	// start at the next whole minute — a cron slot is minute-granular
	let cursor = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
	const limit = fromMs + 366 * 24 * 60 * 60_000;
	while (cursor <= limit) {
		const p = tzParts(cursor, tz);
		const dayOk = f.domRestricted && f.dowRestricted
			? f.dom.includes(p.dom) || f.dow.includes(p.dow)
			: f.domRestricted
				? f.dom.includes(p.dom)
				: f.dowRestricted
					? f.dow.includes(p.dow)
					: true;
		if (dayOk && f.month.includes(p.month) && f.hour.includes(p.hour) && f.minute.includes(p.minute)) {
			return cursor;
		}
		// day-gated skip: when the day can't match, jump to tomorrow 00:00 UTC
		// instead of walking every minute — impossible dates (Feb 30) and
		// sparse schedules resolve in hundreds of steps, not half a million.
		// (UTC midnight can be mid-day in far timezones — harmless: the matcher
		// still evaluates every LOCAL day, just with a coarser stride.)
		if (!dayOk || !f.month.includes(p.month)) {
			const d = new Date(cursor);
			d.setUTCDate(d.getUTCDate() + 1);
			d.setUTCHours(0, 0, 0, 0);
			cursor = d.getTime();
			continue;
		}
		cursor += 60_000;
	}
	return undefined;
}

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
		// cron overlap "skip": a slot whose kick would land on a RUNNING turn is
		// honestly dropped (the loop is busy) — re-arm for the next slot.
		if (rec.kind === "cron" && rec.overlap !== "queue" && agent.inTurn) {
			rec.status = "fired";
			reflect(agent);
			setActivity(agent, `loop '${id}' skipped a slot (turn running)`);
			scheduleNext(agent, id, rec);
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
		if (rec.kind === "once") {
			complete(agent, rec, id, "one-shot fired");
			return;
		}
		if ((rec.kind === "classic" || rec.kind === "cron") && rec.maxFires !== undefined && rec.fires >= rec.maxFires) {
			complete(agent, rec, id, `maxFires ${rec.maxFires} reached`);
			return;
		}
		// cron is wall-clock, not landing-driven: re-arm the NEXT slot now so a
		// long turn can't eat a slot — it skips honestly at the fire moment.
		if (rec.kind === "cron") {
			rec.status = "fired";
			reflect(agent);
			setActivity(agent, `loop '${id}' fired (#${rec.fires})`);
			scheduleNext(agent, id, rec);
			return;
		}
		rec.status = "fired"; // next landing re-arms per policy
		reflect(agent);
		setActivity(agent, `loop '${id}' fired (#${rec.fires})`);
	}

	/** Schedule the next kick per policy — called at landings (and at install
	 * for wall-clock kinds). Idempotent: a record that already waits keeps its
	 * timer — landings must not double-arm a cron slot or a one-shot. */
	function scheduleNext(agent: GodObject, id: string, rec: LoopRecord): void {
		if (rec.status === "completed" || rec.status === "stopped") return;
		const now = Date.now();

		if (rec.kind === "once") {
			if (rec.timer) return; // already counting down — never double-arm
			const at = rec.at ?? now;
			const delay = Math.max(0, at - now);
			rec.status = "waiting";
			rec.nextFireAt = now + delay;
			parkWait(agent, rec, delay, () => fire(agent, id, rec));
			reflect(agent);
			return;
		}

		if (rec.kind === "cron") {
			if (rec.timer) return; // slot already armed — landings don't re-arm
			if (rec.expression === undefined) return;
			if (rec.maxFires !== undefined && rec.fires >= rec.maxFires) {
				complete(agent, rec, id, `maxFires ${rec.maxFires} reached`);
				return;
			}
			const next = nextCronFire(rec.expression, now, rec.tz);
			if (next === undefined) {
				complete(agent, rec, id, "no future slot within a year");
				return;
			}
			rec.status = "waiting";
			rec.nextFireAt = next;
			parkWait(agent, rec, next - now, () => fire(agent, id, rec));
			reflect(agent);
			return;
		}

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
		const onces = opts.once === undefined ? [] : Array.isArray(opts.once) ? opts.once : [opts.once];
		onces.forEach((o, i) => {
			if (o.delayMs === undefined && o.at === undefined) {
				throw new Error("[sanity] loops once needs `delayMs` or `at`");
			}
			if (o.delayMs !== undefined && o.at !== undefined) {
				throw new Error("[sanity] loops once takes `delayMs` XOR `at`, not both");
			}
			const at = o.at === undefined ? Date.now() + o.delayMs! : o.at instanceof Date ? o.at.getTime() : o.at;
			map.set(o.id ?? (onces.length === 1 ? "once" : `once-${i}`), {
				kind: "once",
				status: "armed",
				startedAt: Date.now(),
				fires: 0,
				at,
				message: o.message,
				backticksCommand: o.backticksCommand === true,
			});
		});
		const crons = opts.cron === undefined ? [] : Array.isArray(opts.cron) ? opts.cron : [opts.cron];
		crons.forEach((c, i) => {
			parseCron(c.expression); // fail fast on a bad expression, at install
			map.set(c.id ?? (crons.length === 1 ? "cron" : `cron-${i}`), {
				kind: "cron",
				status: "armed",
				startedAt: Date.now(),
				fires: 0,
				expression: c.expression,
				tz: c.tz,
				overlap: c.overlap ?? "skip",
				maxFires: c.maxFires,
				message: c.message,
				backticksCommand: c.backticksCommand === true,
			});
		});
		return map;
	}

	return {
		id: pluginId,
		requires: ["inputs"], // the kick IS a followup input — no vocabulary, no loops
		install(agent) {
			records.clear();
			for (const [id, rec] of makeRecords()) records.set(id, rec);

			// ---- WALL-CLOCK kinds arm at install, not at the first landing: a
			// one-shot / cron slot is due whether or not the agent ever landed. ----
			for (const [id, rec] of records) {
				if (rec.kind === "once" || rec.kind === "cron") scheduleNext(agent, id, rec);
			}

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

			// ---- ACTIVITY cancels pending kicks — but ONLY for landing-driven
			// kinds (classic silence resets; chrono dwell postponed). Wall-clock
			// kinds are immune: activity must not eat a one-shot or a cron slot
			// (overlap "skip" handles the busy-turn case honestly at fire time). ----
			agent.addFilter({
				event: EVENTS.turnStart,
				id: `${prefix}activity`,
				priority: 90,
				fn: async (agent) => {
					syncFromState(agent);
					let touched = false;
					for (const rec of records.values()) {
						if (rec.timer && (rec.kind === "classic" || rec.kind === "chrono")) {
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
					"loops engine — classic (nudge on silence) + chrono (bounded shift) + once (one-shot) + cron (wall-clock schedule); fires canonical followup inputs",
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
