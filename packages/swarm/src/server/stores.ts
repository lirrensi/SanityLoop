// ============================================================================
// sanity/src/packages/swarm/src/server/stores.ts — the daemon's memory.
// Definition files are the ONLY memory: processes.json (named remembered
// forks) + tasks.json (named fire-and-die schedules). Every mutating op
// writes through immediately; writes are atomic (tmp + rename). A torn file
// starts clean with a warning — the daemon never guesses, it just forgets.
// ============================================================================
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

export function loadProcesses(path: string): Map<string, ProcessDef> {
	return loadFile<ProcessDef>(path, "processes", PROCESSES_VERSION, "processes");
}

export function saveProcesses(path: string, rows: ProcessDef[]): void {
	saveFile(path, PROCESSES_VERSION, rows);
}

export function loadTasks(path: string): Map<string, TaskDef> {
	return loadFile<TaskDef>(path, "tasks", TASKS_VERSION, "tasks");
}

export function saveTasks(path: string, rows: TaskDef[]): void {
	saveFile(path, TASKS_VERSION, rows);
}

/** Next-fire computation — the clock's only math. */
export function computeNextFire(t: Pick<TaskDef, "fire" | "everyMs" | "at" | "lastFire">, now: number): number | undefined {
	if (t.fire === "every" && typeof t.everyMs === "number" && t.everyMs > 0) {
		return (t.lastFire ?? now) + t.everyMs;
	}
	if (t.fire === "at" && typeof t.at === "number") {
		return t.at;
	}
	return undefined;
}

/** Late beats stay graceful: half the period, clamped to [120s, 2h]. Inside
 *  grace a missed slot fires late; past grace the missed slots collapse into
 *  ONE catch-up fire with a logged reason (never silent, never a fork storm). */
export const TASK_GRACE_MIN_MS = 120_000;
export const TASK_GRACE_MAX_MS = 7_200_000;
export function taskGraceFor(everyMs?: number): number {
	if (typeof everyMs !== "number" || everyMs <= 0) return TASK_GRACE_MIN_MS;
	return Math.min(TASK_GRACE_MAX_MS, Math.max(TASK_GRACE_MIN_MS, Math.floor(everyMs / 2)));
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

