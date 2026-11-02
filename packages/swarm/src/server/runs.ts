// ============================================================================
// sanity/src/packages/swarm/src/server/runs.ts — the daemon's run ledger.
// Every fork leaves exactly one run: `<home>/runs/<id>/meta.json` (+ stdout.log
// + stderr.log + exit.json). Meta writes are atomic (tmp + rename) so a crash
// never tears the ledger; streams stay separate files, never interleaved.
// NOTE (reconciled): RunRecord/RunState/ProgramSpawn are canonical in
// ./stores.ts and imported here; this module re-exports RunRecord/RunState
// so existing importers keep working.
// The store never inspects processes — pid liveness is passed in by the caller
// (the daemon owns pids live). No TTL timers inside; the caller drives GC via
// prune().
// ============================================================================
import {
	appendFileSync,
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { readHostStartTime, type ProgramSpawn, type RunRecord, type RunState } from "./stores.ts";

export type { RunRecord, RunState } from "./stores.ts";
export type { ProgramSpawn } from "./stores.ts";
export interface RegisterArgs {
	program?: string;
	kind: "service" | "job";
	spawn: ProgramSpawn;
	trigger: RunRecord["trigger"];
	name?: string;
	cwd?: string;
}

export interface StreamPaths {
	stdout: string;
	stderr: string;
}

export type LogStream = "stdout" | "stderr" | "both";

export interface LogsArgs {
	stream?: LogStream;
	tailBytes?: number;
	offset?: number;
}

export interface LogsResult {
	text: string;
	nextOffset: number;
}

export interface WaitArgs {
	match?: string;
	timeoutMs?: number;
}

export interface PruneArgs {
	olderThanMs?: number;
	keep?: number;
}

/**
 * Display status for a record. `live` = the daemon holds the pid now.
 * Rules: exit set → completed/failed by code; endedAt set → completed
 * (failed if the record says so); any non-running persisted state
 * (stopping/dead/stale/interrupted/timedOut/cancelled/completed/failed)
 * is reported as-is; starting is transient → running; live pid → running;
 * dead with no exit → stale; never had a pid → stale.
 */
export function deriveStatus(record: RunRecord, live: boolean): RunState {
	if (record.exit != null) return record.exit.code === 0 ? "completed" : "failed";
	if (record.endedAt != null) return record.state === "failed" ? "failed" : "completed";
	if (record.state !== "starting" && record.state !== "running") return record.state;
	if (record.state === "starting") return "running";
	if (live) return "running";
	if (record.pid == null) return "stale";
	return "stale";
}

/** Word pool for friendly run names (`{word}-{root}`). */
export const FRIENDLY_WORDS = [
	"agile", "amber", "arctic", "astral", "azure", "brisk", "calm", "cedar",
	"clever", "cobalt", "coral", "cosmic", "crisp", "daring", "dawn", "drift",
	"eager", "ember", "fluent", "frost", "garnet", "gentle", "granite", "harbor",
	"hazel", "ivory", "jade", "juniper", "keen", "lilac", "lunar", "maple",
	"meadow", "misty", "mossy", "nimble", "noble", "onyx", "opal", "prairie",
	"quartz", "raven",
] as const;

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=.*/;

function tokenize(cmd: string): string[] {
	const out: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(cmd)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
	return out;
}

function baseOf(token: string): string {
	const b = basename(token);
	return b.replace(/\.(js|mjs|cjs|ts|mts|py|rb|pl|php|sh|bash)$/i, "");
}

function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 14)
		.replace(/-+$/g, "");
}

function rootTokenFor(cmd: string): string {
	const toks = tokenize(cmd.trim());
	let i = 0;
	while (i < toks.length && (ENV_ASSIGN.test(toks[i]) || toks[i] === "env" || toks[i] === "sudo")) i++;
	if (i >= toks.length) return "run";
	const first = baseOf(toks[i]).toLowerCase();
	const rest = toks.slice(i + 1);
	const nextArg = rest.find((t) => !t.startsWith("-"));
	if ((first === "python" || first === "python3") && rest[0] === "-m" && rest[1]) return rest[1].split(".").pop()!;
	if (["node", "bun", "deno", "tsx", "ts-node", "ruby", "perl", "php"].includes(first)) {
		if (nextArg) return baseOf(nextArg);
		return first;
	}
	if (["npm", "yarn", "pnpm"].includes(first)) {
		if ((rest[0] === "run" || rest[0] === "exec") && rest[1]) return baseOf(rest[1]);
		if (rest[0] && !rest[0].startsWith("-")) return baseOf(rest[0]);
		return first;
	}
	if (first === "npx" || first === "bunx") {
		if (nextArg) return baseOf(nextArg);
		return first;
	}
	if (first === "git" || first === "docker" || first === "podman" || first === "kubectl") {
		if (rest[0] && !rest[0].startsWith("-")) return baseOf(rest[0]);
		return first;
	}
	return baseOf(toks[i]);
}

/**
 * Human-greetable run name: `{word}-{slug(root)}`, slug ≤14 chars.
 * Skips env assignments, unwraps interpreter/package/git/docker wrappers.
 * Collisions gain a numeric suffix; the result is added to `taken`.
 */
export function friendlyNameFor(cmd: string, taken: Set<string>): string {
	const root = slugify(rootTokenFor(cmd)) || "run";
	const word = FRIENDLY_WORDS[Math.floor(Math.random() * FRIENDLY_WORDS.length)];
	let candidate = `${word}-${root}`;
	let n = 2;
	while (taken.has(candidate)) candidate = `${word}-${root}-${n++}`;
	taken.add(candidate);
	return candidate;
}

/**
 * One-line label for a spawn spec, for naming/display.
 * file → basename sans ext; cmd → `cmd + args.join(' ')`.
 */
export function spawnLabel(spawn: ProgramSpawn): string {
	if ("file" in spawn) {
		const b = basename(spawn.file);
		return b.replace(/\.[^.]+$/, "") || b;
	}
	return spawn.args?.length ? `${spawn.cmd} ${spawn.args.join(" ")}` : spawn.cmd;
}

function atomicWriteJson(path: string, value: unknown): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(value, null, 2));
	renameSync(tmp, path);
}

function readTail(path: string, start: number, maxBytes: number): { text: string; end: number } {
	if (!existsSync(path)) return { text: "", end: start };
	const fd = openSync(path, "r");
	try {
		const size = fstatSync(fd).size;
		const from = Math.max(0, Math.min(start, size));
		const len = Math.min(maxBytes, size - from);
		if (len <= 0) return { text: "", end: size };
		const buf = Buffer.alloc(len);
		readSync(fd, buf, 0, len, from);
		return { text: buf.toString("utf8"), end: from + len };
	} finally {
		closeSync(fd);
	}
}

function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

type LegacyRunJson = Record<string, unknown>;

/** Normalize a persisted meta.json into the canonical shape. */
function normalize(raw: RunRecord | LegacyRunJson, metaPath: string): RunRecord {
type W = RunRecord & { watchers?: unknown; notified?: unknown };
	const r = raw as W & {
		started_at?: number;
		finished_at?: number;
		sessionId?: string;
		exit?: RunRecord["exit"] | null;
		state?: string;
		spawn?: unknown;
		trigger?: unknown;
		hostStartTime?: unknown;
	};
	if (typeof r.startedAt !== "number" && typeof r.started_at === "number") r.startedAt = r.started_at;
	delete r.started_at;
	if (r.endedAt == null && typeof r.finished_at === "number") r.endedAt = r.finished_at;
	delete r.finished_at;
	if (r.exit === null) delete r.exit;
	if ((r.state as string) === "launching") r.state = "starting";
	if ((r.state as string) === "unknown") r.state = "stale";
	if (typeof r.spawn === "string") r.spawn = { cmd: r.spawn };
	if (typeof r.trigger === "string") {
		r.trigger = { origin: "exec", attempt: 1 };
	}
	if (!Array.isArray(r.agents)) {
		r.agents = typeof r.sessionId === "string" && r.sessionId ? [r.sessionId] : [];
	}
	delete r.sessionId;
	if (typeof r.logPath !== "string" || !r.logPath) r.logPath = dirname(metaPath);
	// hostStartTime passes through only as a finite number; anything else is dropped.
	if (typeof r.hostStartTime !== "number" || !Number.isFinite(r.hostStartTime)) delete r.hostStartTime;
	// run watchers (Hermes session boundary): persist subscribed sessionIds so a
	// reconnect can replay the terminal event exactly once. notified tracks who
	// already got it — completion delivered once. Anything non-string is dropped.
	// (Stored on the ledger meta; typed via a local extension so stores.ts stays
	// the PIDs unit's append-only surface.)
	if (!Array.isArray(r.watchers)) (r as W).watchers = [];
	else (r as W).watchers = (r.watchers as unknown[]).filter((s) => typeof s === "string");
	if (!Array.isArray(r.notified)) (r as W).notified = [];
	else (r as W).notified = (r.notified as unknown[]).filter((s) => typeof s === "string");
	return r as RunRecord;
}
/** Terminal states kept on disk: completed/failed by exit, plus timeout/cancel. */
const TERMINAL: Record<string, true> = { completed: true, failed: true, timedOut: true, cancelled: true };

function isTerminal(record: RunRecord): boolean {
	return record.exit != null || record.endedAt != null || TERMINAL[record.state] === true;
}

export class RunStore {
	private readonly dir: string;
	private readonly keepRuns: number;

	constructor(args: { home: string; keepRuns?: number }) {
		this.dir = join(args.home, "runs");
		this.keepRuns = args.keepRuns ?? 50;
		mkdirSync(this.dir, { recursive: true });
	}

	private metaPath(id: string): string {
		return join(this.dir, id, "meta.json");
	}

	private load(id: string): RunRecord | undefined {
		const path = this.metaPath(id);
		if (!existsSync(path)) return undefined;
		try {
			return normalize(JSON.parse(readFileSync(path, "utf8")) as RunRecord, path);
		} catch {
			return undefined; // torn meta: forget it, never guess
		}
	}

	private save(record: RunRecord): void {
		mkdirSync(join(this.dir, record.id), { recursive: true });
		atomicWriteJson(this.metaPath(record.id), record);
	}

	private mutate(id: string, fn: (r: RunRecord) => void): RunRecord {
		const record = this.load(id);
		if (!record) throw new Error(`unknown run: ${id}`);
		fn(record);
		this.save(record);
		return record;
	}

	/** Create the ledger entry. The caller opens streamPaths() for piping. */
	register(args: RegisterArgs): RunRecord {
		let id = "";
		for (let attempt = 0; attempt < 8; attempt++) {
			const cand = `run-${randomBytes(4).toString("hex")}`;
			if (!existsSync(join(this.dir, cand))) {
				id = cand;
				break;
			}
		}
		if (!id) throw new Error("could not allocate a run id");
		const taken = new Set(this.snapshot().map((r) => r.name));
		const runDir = join(this.dir, id);
		const record: RunRecord = {
			id,
			name: args.name ?? friendlyNameFor(spawnLabel(args.spawn), taken),
			program: args.program,
			kind: args.kind,
			state: "starting",
			cwd: args.cwd ?? ("cwd" in args.spawn ? args.spawn.cwd : undefined),
			spawn: args.spawn,
			trigger: args.trigger,
			startedAt: Date.now(),
			logPath: runDir,
			agents: [],
		};
		mkdirSync(runDir, { recursive: true });
		this.save(record);
		for (const p of Object.values(this.streamPaths(id))) {
			if (!existsSync(p)) appendFileSync(p, "");
		}
		return record;
	}

	streamPaths(id: string): StreamPaths {
		return { stdout: join(this.dir, id, "stdout.log"), stderr: join(this.dir, id, "stderr.log") };
	}

	setPid(id: string, pid: number): RunRecord {
		return this.mutate(id, (r) => {
			r.pid = pid;
			const start = readHostStartTime(pid);
			if (start !== undefined) r.hostStartTime = start;
			else delete r.hostStartTime;
			if (r.state === "starting") r.state = "running";
		});
	}

	setState(id: string, state: RunState): RunRecord {
		return this.mutate(id, (r) => {
			r.state = state;
		});
	}

	attachAgent(id: string, agentId: string): RunRecord {
		return this.mutate(id, (r) => {
			if (!r.agents.includes(agentId)) r.agents.push(agentId);
		});
	}

	/** Subscribe a sessionId to this run's terminal event (persisted; WS-only v1). */
	addWatcher(id: string, sessionId: string): RunRecord {
		return this.mutate(id, (r) => {
			const w = r as RunRecord & { watchers?: string[] };
			if (!Array.isArray(w.watchers)) w.watchers = [];
			if (typeof sessionId === "string" && sessionId && !w.watchers.includes(sessionId)) {
				w.watchers.push(sessionId);
			}
		});
	}

	/** Unsubscribe a sessionId from this run. */
	removeWatcher(id: string, sessionId: string): RunRecord {
		return this.mutate(id, (r) => {
			const w = r as RunRecord & { watchers?: string[] };
			if (Array.isArray(w.watchers)) w.watchers = w.watchers.filter((s) => s !== sessionId);
		});
	}

	/** Mark the terminal event delivered to a sessionId (exactly-once on reconnect). */
	markNotified(id: string, sessionId: string): RunRecord {
		return this.mutate(id, (r) => {
			const w = r as RunRecord & { notified?: string[] };
			if (!Array.isArray(w.notified)) w.notified = [];
			if (typeof sessionId === "string" && sessionId && !w.notified.includes(sessionId)) {
				w.notified.push(sessionId);
			}
		});
	}

	/** Persist a matched-output event (write_job_event equivalent). */
	markMatched(id: string, pattern: string, stream: LogStream): RunRecord {
		return this.mutate(id, (r) => {
			r.matchedPattern = pattern;
			r.matchedStream = stream;
			r.lastEvent = "matched_output";
		});
	}

	/** Close a run: terminal state, exit.json, endedAt, persist. */
	settle(
		id: string,
		exit: { code: number | null; signal: string | null; at: number; reason?: string },
		state?: RunState,
	): RunRecord {
		const record = this.mutate(id, (r) => {
			r.exit = { ...exit };
			r.endedAt = exit.at;
			r.state = state ?? (exit.code === 0 ? "completed" : "failed");
		});
		atomicWriteJson(join(this.dir, id, "exit.json"), record.exit);
		return record;
	}

	get(idOrName: string): RunRecord {
		const direct = this.load(idOrName);
		if (direct) return direct;
		for (const r of this.snapshot()) {
			if (r.name === idOrName) return r;
		}
		throw new Error(`unknown run: ${idOrName}`);
	}

	list(filter?: { program?: string; state?: RunState }): RunRecord[] {
		let rows = this.snapshot();
		if (filter?.program !== undefined) rows = rows.filter((r) => r.program === filter.program);
		if (filter?.state !== undefined) rows = rows.filter((r) => deriveStatus(r, false) === filter.state);
		return rows;
	}

	history(program: string, limit: number): RunRecord[] {
		return this.snapshot()
			.filter((r) => r.program === program)
			.sort((a, b) => b.startedAt - a.startedAt)
			.slice(0, Math.max(0, limit));
	}

	/**
	 * Read appended stream bytes. `offset` resumes a previous `nextOffset`
	 * (cross-call offsets); `tailBytes` caps the read to the last N bytes.
	 * `both` reads each stream with the same offset/tail and concatenates
	 * stdout first; nextOffset is the max end offset.
	 */
	logs(idOrName: string, opts?: LogsArgs): LogsResult {
		const record = this.get(idOrName);
		const paths = this.streamPaths(record.id);
		const stream = opts?.stream ?? "stdout";
		const offset = opts?.offset ?? 0;
		const tail = opts?.tailBytes ?? Number.MAX_SAFE_INTEGER;
		const readOne = (path: string): { text: string; end: number } => {
			if (!existsSync(path)) return { text: "", end: offset };
			let from = offset;
			if (opts?.tailBytes !== undefined && opts.offset === undefined) {
				from = Math.max(0, statSync(path).size - opts.tailBytes);
			}
			return readTail(path, from, tail);
		};
		if (stream === "both") {
			const out = readOne(paths.stdout);
			const err = readOne(paths.stderr);
			return { text: out.text + err.text, nextOffset: Math.max(out.end, err.end) };
		}
		const one = readOne(stream === "stderr" ? paths.stderr : paths.stdout);
		return { text: one.text, nextOffset: one.end };
	}

	/**
	 * Resolve when the run turns terminal, or when `match` appears in either
	 * stream (persists the matched event first). Polls every 200ms; the tail
	 * buffer keeps len(pattern)-1 chars across chunks so split matches land.
	 * Timeout throws with the latest record attached as `snapshot`.
	 */
	async wait(idOrName: string, opts?: WaitArgs): Promise<RunRecord> {
		const deadline = opts?.timeoutMs !== undefined ? Date.now() + opts.timeoutMs : undefined;
		const pattern = opts?.match;
		let outOff = 0;
		let errOff = 0;
		let carry = "";
		for (;;) {
			let record: RunRecord;
			try {
				record = this.get(idOrName);
			} catch {
				if (deadline !== undefined && Date.now() >= deadline) {
					const err = new Error(`wait timed out for unknown run: ${idOrName}`) as Error & {
						snapshot: null;
					};
					err.snapshot = null;
					throw err;
				}
				await delay(200);
				continue;
			}
			if (pattern !== undefined) {
				const out = this.logs(record.id, { stream: "stdout", offset: outOff });
				const errLog = this.logs(record.id, { stream: "stderr", offset: errOff });
				outOff = out.nextOffset;
				errOff = errLog.nextOffset;
				const chunk = carry + out.text + errLog.text;
				if (chunk.includes(pattern)) {
					const stream: LogStream = (carry + out.text).includes(pattern) ? "stdout" : "stderr";
					return this.markMatched(record.id, pattern, stream);
				}
				carry = pattern.length > 1 ? chunk.slice(-(pattern.length - 1)) : "";
			}
			if (isTerminal(record)) return record;
			if (deadline !== undefined && Date.now() >= deadline) {
				const latest = this.get(idOrName);
				const err = new Error(
					`wait timed out after ${opts?.timeoutMs}ms for run ${latest.id} (${latest.name})`,
				) as Error & { snapshot: RunRecord };
				err.snapshot = latest;
				throw err;
			}
			await delay(200);
		}
	}

	/**
	 * Delete terminal runs beyond retention: older than `olderThanMs` OR past
	 * the `keep` count (newest survive). Live runs are never touched.
	 * Returns the deleted ids, newest-first among the deleted.
	 */
	prune(opts?: PruneArgs): string[] {
		const keep = opts?.keep ?? this.keepRuns;
		const now = Date.now();
		const terminal = this.snapshot()
			.filter((r) => isTerminal(r))
			.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
		const deleted: string[] = [];
		terminal.forEach((r, index) => {
			const end = r.endedAt ?? r.startedAt;
			const tooOld = opts?.olderThanMs !== undefined && now - end > opts.olderThanMs;
			if (index >= keep || tooOld) {
				rmSync(join(this.dir, r.id), { recursive: true, force: true });
				deleted.push(r.id);
			}
		});
		return deleted;
	}

	/** Every ledger entry, oldest-first, for boot reconciliation. */
	snapshot(): RunRecord[] {
		let ids: string[] = [];
		try {
			ids = readdirSync(this.dir, { withFileTypes: true })
				.filter((e) => e.isDirectory())
				.map((e) => e.name)
				.sort();
		} catch {
			return [];
		}
		const rows: RunRecord[] = [];
		for (const id of ids) {
			const r = this.load(id);
			if (r) rows.push(r);
		}
		return rows.sort((a, b) => a.startedAt - b.startedAt);
	}
}
