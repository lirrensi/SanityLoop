// ============================================================================
// sanity/src/packages/swarm/src/server/supervisor.ts — the muscle, child_process edition.
// node:child_process owns fork/kill/backoff directly; our processes.json/tasks.json
// stays the only memory. Exit facts flow back through the daemon's onExit hook,
// shaped exactly like the old spawner deaths (code/signal/at/stderrTail).
//
// One supervisor per daemon. Children are spawned detached:false so the daemon
// owns them for its lifetime; callers may pipe stdio through provided streams.
// ============================================================================
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { warnBareAgentDir } from "./templates.ts";

/** What the daemon remembers about a forked child's death — enough to diagnose. */
export interface ExitFacts {
	code: number | null;
	signal: string | null;
	at: number;
	/** Last ~2KB of the child's stderr (still forwarded to the daemon's own). */
	stderrTail?: string;
}

/** One fork — the label is the daemon's backlink (SWARM_SPAWN_ID). */
export interface ForkResult {
	/** Fresh random session tag (SWARM_SESSION_ID) — the join key for queuePrompt. */
	sessionId: string;
	pid?: number;
}

/** Restart policy: true = always, "on-failure" = only nonzero exit/signal. */
export type RestartPolicy = boolean | "always" | "on-failure";

export interface SpawnStreams {
	stdout?: Writable;
	stderr?: Writable;
}

export type SpawnSpec =
	& {
		/** The daemon's backlink (stamped as SWARM_SPAWN_ID when absent). */
		label: string;
		autorestart?: RestartPolicy;
		templateEnv?: Record<string, string>;
		extraEnv?: Record<string, string>;
	}
	& (
		| { file: string; cmd?: never; args?: never; cwd?: never }
		| { file?: never; cmd: string; args?: string[]; cwd?: string }
	);

export interface SupervisorOptions {
	/** The swarm home — stamped as SWARM_HOME on every child. */
	homeDir: string;
	/** Fires when a label exits as a FINAL death (no restart, or the crash-loop
	 *  give-up). Supervisor-owned restarts never reach this hook. */
	onExit?: (label: string, facts: ExitFacts) => void;
	/** Fires when the supervisor restarts a label itself (autorestart backoff).
	 *  The new life owns the label — the daemon should count it (starts++). */
	onRestart?: (label: string) => void;
}

/** How much child stderr we keep — enough to name the crash, too small to matter. */
const STDERR_TAIL_MAX = 2048;

/** Backoff floor for autorestart (exp: 200ms → 30s ceiling). */
const BACKOFF_BASE_MS = 200;
const BACKOFF_MAX_MS = 30_000;

/** Crash-loop guard: this many deaths inside the window stops the label. */
const CRASH_LOOP_DEATHS = 5;
const CRASH_LOOP_WINDOW_MS = 60_000;

/** Default SIGTERM grace before SIGKILL. */
const DEFAULT_KILL_GRACE_MS = 5000;

interface LiveChild {
	proc: ChildProcess;
	sessionId: string;
	spec: SpawnSpec;
	streams?: SpawnStreams;
	deaths: number[];
	restarts: number;
	stopping: boolean;
	backoffMs: number;
	restartTimer?: NodeJS.Timeout;
	stderrTail: string;
}

function policyOf(spec: SpawnSpec): "none" | "always" | "on-failure" {
	if (spec.autorestart === true || spec.autorestart === "always") return "always";
	if (spec.autorestart === "on-failure") return "on-failure";
	return "none";
}

function shouldRestart(policy: "none" | "always" | "on-failure", facts: ExitFacts): boolean {
	if (policy === "always") return true;
	if (policy === "on-failure") return facts.code !== 0 || facts.signal !== null;
	return false;
}

function buildEnv(homeDir: string, sessionId: string, label: string, spec: SpawnSpec): Record<string, string> {
	const env: Record<string, string> = {
		...(spec.templateEnv ?? {}),
		...(spec.extraEnv ?? {}),
		SWARM_SESSION_ID: sessionId,
	};
	// The daemon stamps the parent backlink via extraEnv; fall back to the
	// label only when it doesn't. Spawn id is untouchable from here on.
	if (!env.SWARM_SPAWN_ID) env.SWARM_SPAWN_ID = label;
	if (!env.SWARM_HOME) env.SWARM_HOME = homeDir;
	return env;
}

export class Supervisor {
	private readonly homeDir: string;
	private readonly onExit?: (label: string, facts: ExitFacts) => void;
	private readonly onRestart?: (label: string) => void;
	private live = new Map<string, LiveChild>();
	private dead = new Map<string, ExitFacts>();

	constructor(opts: SupervisorOptions) {
		this.homeDir = opts.homeDir;
		this.onExit = opts.onExit;
		this.onRestart = opts.onRestart;
	}

	/** Fork an agent file or command. THE one fork path — process start AND
	 *  task fire share it. `autorestart` decides the restart policy. */
	fork(spec: SpawnSpec, streams?: SpawnStreams): ForkResult {
		const label = spec.label;
		// Kill-then-start under a reused label: drop the stale life FIRST so
		// every fork prepares the CURRENT spec, then clear the old death.
		this.dropLive(label);
		this.dead.delete(label);
		const sessionId = `swarm-${randomUUID().slice(0, 8)}`;
		if (spec.file) warnBareAgentDir(spec.file, this.homeDir);
		const entry: LiveChild = {
			proc: null as unknown as ChildProcess,
			sessionId,
			spec,
			streams,
			deaths: [],
			restarts: 0,
			stopping: false,
			backoffMs: BACKOFF_BASE_MS,
			stderrTail: "",
		};
		this.live.set(label, entry);
		this.birth(label, entry, sessionId, false);
		return { sessionId, pid: entry.proc.pid };
	}

	private birth(label: string, entry: LiveChild, sessionId: string, isRestart: boolean): void {
		const { spec, streams } = entry;
		const env = buildEnv(this.homeDir, sessionId, label, spec);
		const child = spec.file
			? spawn(process.execPath, ["--experimental-strip-types", "--experimental-transform-types", spec.file], {
				env: { ...process.env, ...env },
				stdio: ["ignore", "pipe", "pipe"],
				detached: false,
				shell: false,
			})
			: spawn(spec.cmd as string, spec.args ?? [], {
				env: { ...process.env, ...env },
				cwd: spec.cwd,
				stdio: ["ignore", "pipe", "pipe"],
				detached: false,
				shell: false,
			});
		entry.proc = child;
		entry.stderrTail = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			try {
				streams?.stdout?.write(chunk);
			} catch {
				/* caller-owned stream — never crash the supervisor */
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			entry.stderrTail = (entry.stderrTail + chunk.toString()).slice(-STDERR_TAIL_MAX);
			try {
				streams?.stderr?.write(chunk);
			} catch {
				/* caller-owned stream — never crash the supervisor */
			}
		});
		child.on("exit", (code, signal) => this.onChildExit(label, code, signal));
		if (isRestart) this.onRestart?.(label);
	}
	private onChildExit(label: string, code: number | null, signal: string | null): void {
		const entry = this.live.get(label);
		if (!entry) return;
		const facts: ExitFacts = { code, signal, at: Date.now() };
		if (entry.stderrTail) facts.stderrTail = entry.stderrTail;
		if (entry.stopping) {
			// Intentional stop: record the death (for lastExit), fire no hooks,
			// never restart.
			this.dead.set(label, facts);
			return;
		}
		const policy = policyOf(entry.spec);
		if (!shouldRestart(policy, facts)) {
			this.live.delete(label);
			this.dead.set(label, facts);
			this.onExit?.(label, facts);
			return;
		}
		const now = Date.now();
		entry.deaths = [...entry.deaths, now].filter((t) => now - t < CRASH_LOOP_WINDOW_MS);
		if (entry.deaths.length >= CRASH_LOOP_DEATHS) {
			this.live.delete(label);
			this.dead.set(label, facts);
			this.onExit?.(label, facts);
			return;
		}
		// Supervisor-owned restart with exponential backoff (200ms → 30s).
		const delay = entry.backoffMs;
		entry.backoffMs = Math.min(entry.backoffMs * 2, BACKOFF_MAX_MS);
		entry.restarts += 1;
		entry.restartTimer = setTimeout(() => {
			entry.restartTimer = undefined;
			if (!this.live.get(label) || entry.stopping) return;
			this.birth(label, entry, entry.sessionId, true);
		}, delay);
		entry.restartTimer.unref?.();
	}

	/** Stop a label: SIGTERM, wait the grace, then SIGKILL. True when something was there. */
	async stop(label: string, graceMs = DEFAULT_KILL_GRACE_MS): Promise<boolean> {
		const entry = this.live.get(label);
		if (!entry) return false;
		entry.stopping = true;
		if (entry.restartTimer) {
			clearTimeout(entry.restartTimer);
			entry.restartTimer = undefined;
		}
		const proc = entry.proc;
		// NOTE: entry stays in the live map until its `exit` lands so
		// onChildExit records the intentional-stop death in `dead`.
		try {
			proc.kill("SIGTERM");
		} catch {
			return true;
		}
		const { promise: exitedP, resolve: exitedResolve } = Promise.withResolvers<boolean>();
		if (proc.exitCode !== null || proc.signalCode !== null) {
			exitedResolve(true);
		} else {
			const timer = setTimeout(() => exitedResolve(false), graceMs);
			timer.unref?.();
			proc.once("exit", () => {
				clearTimeout(timer);
				exitedResolve(true);
			});
		}
		const exited = await exitedP;
		if (!exited) {
			try {
				proc.kill("SIGKILL");
			} catch {
				/* already gone */
			}
			// SIGKILL always lands — wait for the exit so the death is recorded.
			const { promise: killedP, resolve: killedResolve } = Promise.withResolvers<void>();
			if (proc.exitCode !== null || proc.signalCode !== null) killedResolve();
			else proc.once("exit", () => killedResolve());
			await killedP;
		}
		this.live.delete(label);
		return true;
	}

	/** Alias of stop — the polite-then-force kill path. */
	kill(label: string, graceMs = DEFAULT_KILL_GRACE_MS): Promise<boolean> {
		return this.stop(label, graceMs);
	}

	/** Drop a label's bookkeeping (dead facts included). The child, if any, is stopped first. */
	async forget(label: string): Promise<void> {
		await this.stop(label);
		this.dead.delete(label);
	}

	/** Stop every live child. */
	async stopAll(graceMs = DEFAULT_KILL_GRACE_MS): Promise<void> {
		await Promise.all([...this.live.keys()].map((label) => this.stop(label, graceMs)));
	}

	/** Sync pid lookup from the live map. */
	pidOf(label: string): number | undefined {
		return this.live.get(label)?.proc.pid;
	}

	/** The last final death for a label, if any. */
	lastExit(label: string): ExitFacts | undefined {
		return this.dead.get(label);
	}

	/** No-op kept for API compat — there is no scoped daemon to disconnect from. */
	disconnect(): void {
		return;
	}

	/** No-op kept for API compat — children die via stopAll; nothing else to kill. */
	killDaemon(): void {
		return;
	}

	private dropLive(label: string): void {
		const entry = this.live.get(label);
		if (!entry) return;
		entry.stopping = true;
		if (entry.restartTimer) {
			clearTimeout(entry.restartTimer);
			entry.restartTimer = undefined;
		}
		this.live.delete(label);
		try {
			entry.proc.kill("SIGKILL");
		} catch {
			/* already gone */
		}
	}
}

/** Pid-file path for the home lock. */
export function homeLockPath(homeDir: string): string {
	return join(homeDir, "daemon.lock");
}

/** Claim the home for this daemon — a second daemon on the same home refuses. */
export function acquireHomeLock(homeDir: string): void {
	const path = homeLockPath(homeDir);
	try {
		const raw = readFileSync(path, "utf8").trim();
		const pid = Number(raw);
		if (raw && Number.isFinite(pid) && pid > 0) {
			let alive = false;
			try {
				process.kill(pid, 0);
				alive = true;
			} catch {
				alive = false;
			}
			if (alive) throw new Error(`[swarm] home already owned by pid ${pid} (${path})`);
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
			if (err instanceof Error && err.message.startsWith("[swarm] home already owned")) throw err;
		}
		if (err instanceof Error && err.message.startsWith("[swarm] home already owned")) throw err;
	}
	writeFileSync(path, String(process.pid), "utf8");
}

/** Release the home lock (best-effort; only our own pid's file). */
export function releaseHomeLock(homeDir: string): void {
	const path = homeLockPath(homeDir);
	try {
		if (!existsSync(path)) return;
		const raw = readFileSync(path, "utf8").trim();
		if (raw && raw !== String(process.pid)) return;
		rmSync(path, { force: true });
	} catch {
		/* best-effort */
	}
}
