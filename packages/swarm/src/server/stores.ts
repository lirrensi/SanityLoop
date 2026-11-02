// ============================================================================
// sanity/src/packages/swarm/src/server/stores.ts — the daemon's memory.
// Definition files are the ONLY memory: programs.json (unified program defs:
// services = remembered forks, jobs = fire-and-die schedules). Every mutating
// op writes through immediately; writes are atomic (tmp + rename). A torn file
// starts clean with a warning — the daemon never guesses, it just forgets.
//
// v2: ProcessDef/TaskDef stores are legacy readers only. Phase 2 migrates
// processes.json + tasks.json → programs.json via migrateLegacy(), keeping
// counters/runs history.
// ============================================================================
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Cron } from "croner";

// ---------------------------------------------------------------------------
// v2 program model
// ---------------------------------------------------------------------------

/** How to spawn a program: an agent file, or an arbitrary command. */
export type ProgramSpawn = { file: string } | { cmd: string; args?: string[]; cwd?: string };

/** A named remembered fork. `file` = absolute agent path, `from` = template id/file. */
export interface ProcessDef {
	name: string;
	file?: string;
	from?: string;
	autorestart: boolean;
	status: "running" | "stopped";
	pid?: number;
	starts: number;
	lastExit?: { code: number | null; signal: string | null; at: number; stderrTail?: string };
	createdAt: number;
	updatedAt: number;
}

export type TaskFireKind = "every" | "at" | "manual";

/** A named fire-and-die definition. The clock fires `every`/`at` unless paused.
 *  Every slot is accounted for exactly once: `runs` + `lastSlot` are the fire
 *  identity (claimed + persisted BEFORE the fork, so a crash can't refire);
 *  past-grace collapse lands in `lastCatchup`, fire-less accounting in
 *  `lastSkipped`, and a crash between claim and fork leaves `pendingFire`
 *  for boot to convert into a logged skip. */
export interface TaskDef {
	name: string;
	file?: string;
	from?: string;
	fire: TaskFireKind;
	/** Interval ms for `every`. */
	everyMs?: number;
	/** Epoch ms for one-shot `at`. Cleared after it fires. */
	at?: number;
	paused: boolean;
	runs: number;
	lastFire?: number;
	/** The slot timestamp (due time) of the latest scheduled fire. Manual
	 *  fires and triggers stamp the fire time. Part of the fire identity. */
	lastSlot?: number;
	nextFire?: number;
	lastResult?: { at: number; code: number | null; signal: string | null };
	/** Collapsed catch-up accounting: past-grace slots folded into one fire. */
	lastCatchup?: { slot: number; missed: number; at: number; reason: string };
	/** Logged skip: a slot accounted for without a fork (`at` past-grace, or
	 *  a crash between claim and fork). Never silent, never refired. */
	lastSkipped?: { slot: number; at: number; reason: string };
	/** Crash window: claimed (runs bumped, nextFire advanced, persisted) but
	 *  the fork is unconfirmed. Boot converts it into a logged skip. */
	pendingFire?: { run: number; slot: number; claimedAt: number; origin: "tick" | "fire" | "trigger" };
	/** Latest manual `trigger` (paused-immune, schedule untouched). */
	lastTrigger?: { at: number; run: number };
	createdAt: number;
	updatedAt: number;
}

/** Restart policy for services (and jobs that allow retries via `retries`). */
export interface ProgramRestart {
	policy: "never" | "always" | "on-failure";
	backoffMs?: number;
	maxRestarts?: number;
}

export type ScheduleKind = "every" | "cron" | "at" | "manual";
export type EveryMode = "rate" | "delay";
export type OverlapPolicy = "skip" | "allow" | "allowN" | "buffer1" | "bufferAll" | "cancel" | "restart";

/** When a job fires. `every`: interval (`rate` = slot grid from lastSlot,
 *  `delay` = gap from lastFire, `anchor` = phase-offset grid); `cron`: cron
 *  expression; `at`: one-shot epoch ms; `manual`: trigger-only. */
export interface ProgramSchedule {
	kind: ScheduleKind;
	everyMs?: number;
	everyMode?: EveryMode;
	/** Phase anchor (epoch ms) for `every` grids: slots land on anchor + k*everyMs. */
	anchor?: number;
	expr?: string;
	timezone?: string;
	at?: number;
	startAt?: number;
	stopAt?: number;
	maxRuns?: number;
}

/** The unified v2 definition: services (remembered forks) + jobs (schedules).
 *  `runs` + `lastSlot` are the fire identity for jobs (claimed + persisted
 *  BEFORE the fork, so a crash can't refire); every slot is accounted for
 *  exactly once via `counters`. */
export interface ProgramDef {
	name: string;
	kind: "service" | "job";
	spawn: ProgramSpawn;
	from?: string;
	desired: "running" | "stopped";
	restart: ProgramRestart;
	schedule?: ProgramSchedule;
	paused: boolean;
	overlap?: OverlapPolicy;
	allowN?: number;
	timeoutMs?: number;
	catchupWindowMs?: number;
	missPolicy?: "fireOnce" | "skip";
	retries?: { attempts: number; backoffMs: number };
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
	counters: {
		runs: number;
		missedCatchup: number;
		overlapSkipped: number;
		bufferDropped: number;
		timeoutKills: number;
	};
	pendingClaim?: { run: string; slot: number; claimedAt: number; origin: "tick" | "fire" | "trigger" | "launch" | "exec" | "restart" | "boot" };
	/** Logged skip: a slot accounted for without a fork (past-window miss, or
	 *  a crash between claim and fork). Never silent, never refired. */
	lastSkip?: { slot: number; at: number; reason: string };
	lastSlot?: number;
	nextFire?: number;
	lastFire?: number;
	createdAt: number;
	updatedAt: number;
}

/** Lifecycle of one fork. Terminal: completed/failed/timedOut/cancelled;
 *  `dead`/`stale`/`interrupted` mark unsupervised or recovered endings. */
export type RunState =
	| "starting"
	| "running"
	| "stopping"
	| "dead"
	| "completed"
	| "failed"
	| "stale"
	| "interrupted"
	| "timedOut"
	| "cancelled";

/** One fork of a program. `slot` + run identity live here; the program's
 *  `counters.runs`/`lastSlot` are claimed before the fork is confirmed. */
export interface RunRecord {
	id: string;
	name: string;
	program?: string;
	kind: "service" | "job";
	state: RunState;
	pid?: number;
	cwd?: string;
	spawn: ProgramSpawn;
	trigger: {
		origin: "tick" | "fire" | "trigger" | "launch" | "exec" | "restart" | "boot";
		slot?: number;
		attempt: number;
	};
	startedAt: number;
	endedAt?: number;
	exit?: { code: number | null; signal: string | null; at: number; reason?: string };
	logPath: string;
	agents: string[];
	lastEvent?: string;
	matchedPattern?: string;
	matchedStream?: string;
}

// ---------------------------------------------------------------------------
// defaults (named constants — no magic numbers at callsites)
// ---------------------------------------------------------------------------

/** Program names: DNS-ish, ≤64 chars (regex allows 1 + up to 63 more). */
export const PROGRAM_NAME_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/i;
/** Sub-second intervals are rejected (`everyMs` floor). */
export const MIN_EVERY_MS = 1_000;
/** Catch-up grace: min(24h, 10×period), floored at 10s. */
export const CATCHUP_WINDOW_MIN_MS = 10_000;
export const CATCHUP_WINDOW_MAX_MS = 86_400_000;
export const CATCHUP_PERIOD_FACTOR = 10;
export const DEFAULT_EVERY_MODE: EveryMode = "rate";
export const DEFAULT_OVERLAP: OverlapPolicy = "skip";
export const DEFAULT_RESTART_POLICY: ProgramRestart["policy"] = "never";
export const DEFAULT_RESTART_BACKOFF_MS = 5_000;
export const DEFAULT_RETRY_ATTEMPTS = 0;
export const DEFAULT_RETRY_BACKOFF_MS = 5_000;
export const DEFAULT_DESIRED: ProgramDef["desired"] = "stopped";
export const DEFAULT_KILL_GRACE_MS = 5_000;
export const DEFAULT_KEEP_RUNS = 50;
export const PROGRAMS_VERSION = 1;

// ---------------------------------------------------------------------------
// file helpers (shared by v2 + legacy readers)
// ---------------------------------------------------------------------------

const PROCESSES_VERSION = 1;
const TASKS_VERSION = 1;

/** Load a definition file: name → def. Torn/missing → empty (warn on torn). */
function loadFile<T extends { name: string }>(
	path: string,
	key: string,
	version: number,
	kind: string,
): Map<string, T> {
	const out = new Map<string, T>();
	if (!existsSync(path)) return out;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as {
			v: number;
			rows: T[];
		};
		if (parsed.v !== version || !Array.isArray(parsed.rows)) {
			console.warn(`[swarm] skipping ${kind} store (version/shape mismatch): ${path}`);
			return out;
		}
		for (const r of parsed.rows) {
			if (r && typeof r.name === "string" && r.name) out.set(r.name, r);
		}
	} catch {
		console.warn(`[swarm] skipping torn ${kind} store (starting clean): ${path}`);
	}
	return out;
}

/** Atomic write-through: tmp + rename so a crash never tears the memory. */
function saveFile<T>(path: string, version: number, rows: T[]): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify({ v: version, rows }, null, 2) + "\n", "utf8");
		renameSync(tmp, path);
	} catch (err) {
		console.warn(
			`[swarm] store write failed (memory only): ${path} — ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

export function loadPrograms(path: string): Map<string, ProgramDef> {
	return loadFile<ProgramDef>(path, "programs", PROGRAMS_VERSION, "programs");
}

export function savePrograms(path: string, rows: ProgramDef[]): void {
	saveFile(path, PROGRAMS_VERSION, rows);
}

/** @deprecated Legacy reader for migration only — use loadPrograms. */
export function loadProcesses(path: string): Map<string, ProcessDef> {
	return loadFile<ProcessDef>(path, "processes", PROCESSES_VERSION, "processes");
}

/** @deprecated Legacy reader for migration only — use savePrograms. */
export function saveProcesses(path: string, rows: ProcessDef[]): void {
	saveFile(path, PROCESSES_VERSION, rows);
}

/** @deprecated Legacy reader for migration only — use loadPrograms. */
export function loadTasks(path: string): Map<string, TaskDef> {
	return loadFile<TaskDef>(path, "tasks", TASKS_VERSION, "tasks");
}

/** @deprecated Legacy reader for migration only — use savePrograms. */
export function saveTasks(path: string, rows: TaskDef[]): void {
	saveFile(path, TASKS_VERSION, rows);
}

// ---------------------------------------------------------------------------
// next-fire computation — the clock's only math
// ---------------------------------------------------------------------------

/** Legacy schedule shape (pre-v2 TaskDef clock math). */
export type LegacySchedule = Pick<TaskDef, "fire" | "everyMs" | "at" | "lastFire">;

function legacyNextFire(t: LegacySchedule, now: number): number | undefined {
	if (t.fire === "every" && typeof t.everyMs === "number" && t.everyMs > 0) {
		return (t.lastFire ?? now) + t.everyMs;
	}
	if (t.fire === "at" && typeof t.at === "number") {
		return t.at;
	}
	return undefined;
}

/** Period of a schedule in ms, when one is knowable (`every` interval, or the
 *  gap between the next two `cron` occurrences). Used for grace math. */
function periodFor(schedule: ProgramSchedule | undefined, now: number): number | undefined {
	if (!schedule) return undefined;
	if (schedule.kind === "every" && typeof schedule.everyMs === "number" && schedule.everyMs > 0) {
		return schedule.everyMs;
	}
	if (schedule.kind === "cron" && schedule.expr) {
		try {
			const cron = new Cron(
				schedule.expr,
				schedule.timezone ? { timezone: schedule.timezone } : undefined,
			);
			const first = cron.nextRun(new Date(now));
			const second = first ? cron.nextRun(new Date(first.getTime() + 1)) : null;
			cron.stop();
			if (first && second) return second.getTime() - first.getTime();
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function programNextFire(p: ProgramDef, now: number): number | undefined {
	const s = p.schedule;
	if (!s || s.kind === "manual") return undefined;
	if (typeof s.maxRuns === "number" && p.counters.runs >= s.maxRuns) return undefined;
	if (typeof s.stopAt === "number" && now > s.stopAt) return undefined;
	const base = typeof s.startAt === "number" ? Math.max(now, s.startAt) : now;
	let next: number | undefined;
	switch (s.kind) {
		case "every": {
			if (typeof s.everyMs !== "number" || s.everyMs <= 0) return undefined;
			const mode = s.everyMode ?? DEFAULT_EVERY_MODE;
			if (mode === "delay") {
				next = (p.lastFire ?? base) + s.everyMs;
			} else if (typeof s.anchor === "number") {
				const ref = Math.max(base, p.lastSlot ?? base);
				if (ref <= s.anchor) {
					next = s.anchor;
				} else {
					const k = Math.floor((ref - s.anchor) / s.everyMs) + 1;
					next = s.anchor + k * s.everyMs;
				}
			} else {
				next = (p.lastSlot ?? base) + s.everyMs;
			}
			break;
		}
		case "cron": {
			if (!s.expr) return undefined;
			try {
				const cron = new Cron(s.expr, s.timezone ? { timezone: s.timezone } : undefined);
				const from = new Date(Math.max(base, p.lastSlot ?? base));
				const fire = cron.nextRun(from);
				cron.stop();
				if (!fire) return undefined;
				next = fire.getTime();
			} catch {
				return undefined;
			}
			break;
		}
		case "at": {
			if (typeof s.at !== "number") return undefined;
			if (p.lastFire != null) return undefined; // one-shot spent
			next = s.at;
			break;
		}
		default:
			return undefined;
	}
	if (next === undefined) return undefined;
	if (typeof s.stopAt === "number" && next > s.stopAt) return undefined;
	return next;
}

/** Next-fire computation — the clock's only math. Accepts a v2 ProgramDef;
 *  the legacy TaskDef schedule shape keeps working for pre-migration callers. */
export function computeNextFire(program: ProgramDef, now: number): number | undefined;
export function computeNextFire(t: LegacySchedule, now: number): number | undefined;
export function computeNextFire(t: ProgramDef | LegacySchedule, now: number): number | undefined {
	if ("fire" in t) return legacyNextFire(t, now);
	return programNextFire(t, now);
}

/** Next N fire times for a program, without forking. Advances a throwaway
 *  copy (lastSlot/lastFire) so `every`/`cron` walk forward; `at` yields at
 *  most one entry, `manual` yields none. */
export function previewRuns(program: ProgramDef, n: number): number[] {
	const out: number[] = [];
	if (!Number.isFinite(n) || n <= 0) return out;
	const count = Math.min(Math.floor(n), 1000);
	const draft: ProgramDef = {
		...program,
		schedule: program.schedule ? { ...program.schedule } : undefined,
		counters: { ...program.counters },
	};
	let cursor = Date.now();
	for (let i = 0; i < count; i++) {
		const next = programNextFire(draft, cursor);
		if (next === undefined) break;
		if (out.length > 0 && next <= out[out.length - 1]) break; // non-advancing guard
		out.push(next);
		cursor = next + 1;
		draft.lastSlot = next;
		draft.lastFire = next;
	}
	return out;
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

export interface ProgramValidation {
	ok: boolean;
	errors: string[];
}

function isValidTimezone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

function isValidCron(expr: string, timezone?: string): boolean {
	try {
		const cron = new Cron(expr, timezone ? { timezone } : undefined);
		cron.stop();
		return true;
	} catch {
		return false;
	}
}

/** Validate a program definition (create or update — absent optional fields
 *  are fine, present-but-invalid fields are errors). */
export function validateProgram(input: Partial<ProgramDef> & { allowPast?: boolean }): ProgramValidation {
	const errors: string[] = [];
	if (typeof input.name !== "string" || !PROGRAM_NAME_RE.test(input.name)) {
		errors.push("name must match /^[a-z0-9][a-z0-9-_]{0,63}$/i");
	}
	if (input.kind !== undefined && input.kind !== "service" && input.kind !== "job") {
		errors.push("kind must be 'service' or 'job'");
	}
	if (input.desired !== undefined && input.desired !== "running" && input.desired !== "stopped") {
		errors.push("desired must be 'running' or 'stopped'");
	}
	const spawn = input.spawn as ProgramSpawn | undefined;
	if (spawn !== undefined) {
		const hasFile = "file" in spawn && typeof spawn.file === "string" && spawn.file.length > 0;
		const hasCmd = "cmd" in spawn && typeof spawn.cmd === "string" && spawn.cmd.length > 0;
		if (!hasFile && !hasCmd) errors.push("spawn must set file or cmd");
	}
	if (input.restart !== undefined) {
		const policy = (input.restart as ProgramRestart).policy;
		if (policy !== "never" && policy !== "always" && policy !== "on-failure") {
			errors.push("restart.policy must be 'never', 'always' or 'on-failure'");
		}
	}
	const s = input.schedule as ProgramSchedule | undefined;
	if (s !== undefined) {
		if (s.kind !== "every" && s.kind !== "cron" && s.kind !== "at" && s.kind !== "manual") {
			errors.push("schedule.kind must be 'every', 'cron', 'at' or 'manual'");
		} else if (s.kind === "every") {
			if (typeof s.everyMs !== "number") {
				errors.push("schedule.everyMs is required for 'every' schedules");
			} else if (!(s.everyMs >= MIN_EVERY_MS)) {
				errors.push(`schedule.everyMs must be >= ${MIN_EVERY_MS} (sub-second intervals rejected)`);
			}
			if (s.everyMode !== undefined && s.everyMode !== "rate" && s.everyMode !== "delay") {
				errors.push("schedule.everyMode must be 'rate' or 'delay'");
			}
			if (s.anchor !== undefined && typeof s.anchor !== "number") {
				errors.push("schedule.anchor must be an epoch-ms number");
			}
		} else if (s.kind === "cron") {
			if (typeof s.expr !== "string" || s.expr.length === 0) {
				errors.push("schedule.expr is required for 'cron' schedules");
			} else if (!isValidCron(s.expr, s.timezone)) {
				errors.push("schedule.expr is not a valid cron expression");
			}
			if (s.timezone !== undefined && !isValidTimezone(s.timezone)) {
				errors.push("schedule.timezone is not a valid IANA timezone");
			}
		} else if (s.kind === "at") {
			if (typeof s.at !== "number") {
				errors.push("schedule.at is required for 'at' schedules");
			} else if (s.at <= Date.now() && !input.allowPast) {
				errors.push("schedule.at must be in the future (or pass allowPast)");
			}
		}
		if (s.startAt !== undefined && typeof s.startAt !== "number") {
			errors.push("schedule.startAt must be an epoch-ms number");
		}
		if (s.stopAt !== undefined && typeof s.stopAt !== "number") {
			errors.push("schedule.stopAt must be an epoch-ms number");
		}
		if (
			typeof s.startAt === "number" &&
			typeof s.stopAt === "number" &&
			s.stopAt <= s.startAt
		) {
			errors.push("schedule.stopAt must be after schedule.startAt");
		}
		if (s.maxRuns !== undefined && !(typeof s.maxRuns === "number" && s.maxRuns >= 1)) {
			errors.push("schedule.maxRuns must be >= 1");
		}
	}
	if (
		input.overlap !== undefined &&
		input.overlap !== "skip" &&
		input.overlap !== "allow" &&
		input.overlap !== "allowN" &&
		input.overlap !== "buffer1" &&
		input.overlap !== "bufferAll" &&
		input.overlap !== "cancel" &&
		input.overlap !== "restart"
	) {
		errors.push("overlap must be 'skip', 'allow', 'allowN', 'buffer1', 'bufferAll', 'cancel' or 'restart'");
	}
	if (input.overlap === "allowN" && !(typeof input.allowN === "number" && input.allowN >= 1)) {
		errors.push("overlap 'allowN' requires allowN >= 1");
	}
	for (const [key, value] of [
		["timeoutMs", input.timeoutMs],
		["catchupWindowMs", input.catchupWindowMs],
		["minGapMs", input.minGapMs],
		["jitterMs", input.jitterMs],
		["killGraceMs", input.killGraceMs],
		["promptTimeoutMs", input.promptTimeoutMs],
		["keepRuns", input.keepRuns],
	] as const) {
		if (value !== undefined && !(typeof value === "number" && value >= 0)) {
			errors.push(`${key} must be a non-negative number`);
		}
	}
	if (input.retries !== undefined) {
		if (!(typeof input.retries.attempts === "number" && input.retries.attempts >= 0)) {
			errors.push("retries.attempts must be a non-negative number");
		}
		if (!(typeof input.retries.backoffMs === "number" && input.retries.backoffMs >= 0)) {
			errors.push("retries.backoffMs must be a non-negative number");
		}
	}
	return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// grace math
// ---------------------------------------------------------------------------

/** Late beats stay graceful: half the period, clamped to [120s, 2h]. Inside
 *  grace a missed slot fires late; past grace the missed slots collapse into
 *  ONE catch-up fire with a logged reason (never silent, never a fork storm). */
export const TASK_GRACE_MIN_MS = 120_000;
export const TASK_GRACE_MAX_MS = 7_200_000;
export function taskGraceFor(everyMs?: number): number {
	if (typeof everyMs !== "number" || everyMs <= 0) return TASK_GRACE_MIN_MS;
	return Math.min(TASK_GRACE_MAX_MS, Math.max(TASK_GRACE_MIN_MS, Math.floor(everyMs / 2)));
}

/** Catch-up window for a program: explicit `catchupWindowMs` wins, else
 *  min(24h, 10×period) floored at 10s. No knowable period (`at`/`manual`) →
 *  the 10s floor. Inside the window a missed slot fires late; past it the
 *  missed slots collapse per `missPolicy`. */
export function catchupWindowFor(program: Pick<ProgramDef, "schedule" | "catchupWindowMs">): number {
	if (typeof program.catchupWindowMs === "number" && program.catchupWindowMs >= 0) {
		return program.catchupWindowMs;
	}
	const period = periodFor(program.schedule, Date.now());
	if (typeof period !== "number" || period <= 0) return CATCHUP_WINDOW_MIN_MS;
	return Math.min(
		CATCHUP_WINDOW_MAX_MS,
		Math.max(CATCHUP_WINDOW_MIN_MS, CATCHUP_PERIOD_FACTOR * period),
	);
}

// ---------------------------------------------------------------------------
// legacy migration (Phase 2: processes.json + tasks.json → programs.json)
// ---------------------------------------------------------------------------

function emptyCounters(): ProgramDef["counters"] {
	return { runs: 0, missedCatchup: 0, overlapSkipped: 0, bufferDropped: 0, timeoutKills: 0 };
}

function asArray<T>(m: Map<string, T> | T[]): T[] {
	return m instanceof Map ? [...m.values()] : m;
}

/** Migrate legacy remembered-forks + schedules into unified program defs.
 *  Counters/runs history carry over (`starts`/`runs` → `counters.runs`,
 *  `lastSlot`/`lastFire`/`nextFire` preserved); name collisions get a
 *  numeric suffix so nothing is silently dropped. */
export function migrateLegacy(
	processes: Map<string, ProcessDef> | ProcessDef[],
	tasks: Map<string, TaskDef> | TaskDef[],
): ProgramDef[] {
	const now = Date.now();
	const out: ProgramDef[] = [];
	const used = new Set<string>();
	const claim = (name: string): string => {
		let n = name;
		let i = 2;
		while (used.has(n)) n = `${name}-${i++}`;
		used.add(n);
		return n;
	};
	for (const p of asArray(processes)) {
		out.push({
			name: claim(p.name),
			kind: "service",
			spawn: p.file ? { file: p.file } : { file: p.from ?? p.name },
			from: p.from,
			desired: p.status === "running" ? "running" : "stopped",
			restart: p.autorestart ? { policy: "always" } : { policy: "never" },
			paused: false,
			counters: { ...emptyCounters(), runs: p.starts ?? 0 },
			createdAt: p.createdAt ?? now,
			updatedAt: p.updatedAt ?? now,
		});
	}
	for (const t of asArray(tasks)) {
		const schedule: ProgramSchedule =
			t.fire === "every"
				? { kind: "every", everyMs: t.everyMs }
				: t.fire === "at"
					? { kind: "at", at: t.at }
					: { kind: "manual" };
		out.push({
			name: claim(t.name),
			kind: "job",
			spawn: t.file ? { file: t.file } : { file: t.from ?? t.name },
			from: t.from,
			desired: "stopped",
			restart: { policy: "never" },
			schedule,
			paused: t.paused,
			counters: { ...emptyCounters(), runs: t.runs ?? 0 },
			lastSlot: t.lastSlot,
			nextFire: t.nextFire,
			lastFire: t.lastFire,
			createdAt: t.createdAt ?? now,
			updatedAt: t.updatedAt ?? now,
		});
	}
	return out;
}

/** Remove a legacy file once (fleet.json migration). Best-effort. */
export function removeLegacyFile(path: string): void {
	try {
		if (existsSync(path)) {
			rmSync(path);
			console.log(`[swarm] migrated legacy store, removed: ${path}`);
		}
	} catch {
		/* best-effort */
	}
}

/** Legacy fleet.json recipe shape (Spawner manifest, pre-split). */
export interface LegacyRecipe {
	sessionId: string;
	template: string;
}

export function loadLegacyRecipes(manifestPath: string): LegacyRecipe[] {
	if (!existsSync(manifestPath)) return [];
	try {
		const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			v: number;
			recipes: LegacyRecipe[];
		};
		if (parsed.v !== 1 || !Array.isArray(parsed.recipes)) return [];
		return parsed.recipes.filter((r) => r && typeof r.sessionId === "string");
	} catch {
		console.warn(`[swarm] skipping torn legacy fleet.json (no migration): ${manifestPath}`);
		return [];
	}
}
