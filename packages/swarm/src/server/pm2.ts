// ============================================================================
// sanity/src/packages/swarm/src/server/pm2.ts — the muscle, PM2 edition.
// Embedded PM2 (programmatic API, `pm2_home` scoped under the swarm home)
// owns fork/kill/restart/backoff; our processes.json/tasks.json stays the only
// memory — PM2 boots WITHOUT resurrect (we delete/ignore any dump and submit
// desired state ourselves). Exit facts flow back through the daemon's onExit
// hook, shaped exactly like the old spawner deaths (code/signal/at/stderrTail).
//
// One supervisor per daemon. Connect is scoped per instance via `new
// (require('pm2').custom)({ pm2_home })` — never the shared singleton, so the
// outer system PM2 and sibling test daemons never see our children.
// ============================================================================
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { warnBareAgentDir } from "./templates.ts";

/** What the daemon remembers about a forked child's death — enough to diagnose. */
export interface ExitFacts {
	code: number | null;
	signal: string | null;
	at: number;
	/** Last ~2KB of the child's stderr (still forwarded to the daemon's own). */
	stderrTail?: string;
}

export interface SupervisorOptions {
	/** The swarm home — PM2_HOME becomes `<home>/pm2` (scoped, never shared). */
	homeDir: string;
	/** Fires when a label exits as a FINAL death (autorestart=false, or the
	 *  overlimit give-up). PM2-owned restarts never reach this hook. */
	onExit?: (label: string, facts: ExitFacts) => void;
	/** Fires when PM2 restarts a label itself (autorestart backoff). The new
	 *  life owns the label — the daemon should count it (starts++) and persist. */
	onRestart?: (label: string) => void;
}

/** One fork — the label is the daemon's backlink (SWARM_SPAWN_ID). */
export interface ForkResult {
	/** Fresh random session tag (SWARM_SESSION_ID) — the join key for queuePrompt. */
	sessionId: string;
	pid?: number;
}

/** How much child stderr we keep — enough to name the crash, too small to matter. */
const STDERR_TAIL_MAX = 2048;

/** Steady-state connect timeout — the daemon may already run under this home. */
const CONNECT_TIMEOUT_MS = 20_000;

/** Kill grace before SIGKILL — matches the old SIGTERM semantics (polite first). */
const KILL_TIMEOUT_MS = 1600;

/** Backoff floor for autorestart=true (PM2 exponential restarts). */
const BACKOFF_BASE_MS = 200;

/** Kill-daemon grace — the scoped daemon must release its sockets/pids. */
const KILL_DAEMON_TIMEOUT_MS = 5000;

interface Pm2EventProc {
	name?: string;
	/** God.notify('exit') clones pm2_env; exit_code is set before the emit. */
	exit_code?: number | null;
}

interface Pm2BusPayload {
	event?: string;
	process?: Pm2EventProc;
	/** Emitted timestamp (Utility.getDate = Date.now()). */
	at?: number;
	data?: unknown;
}

type Pm2Bus = {
	on(event: string, cb: (payload: unknown) => void): void;
};

type Pm2Api = {
	connect(cb: (err: Error | null) => void): void;
	disconnect(cb?: () => void): void;
	start(opts: Record<string, unknown>, cb: (err: Error | null, procs?: Pm2Proc[]) => void): void;
	stop(name: string, cb: (err: Error | null, procs?: unknown) => void): void;
	restart(name: string, cb: (err: Error | null, procs?: unknown) => void): void;
	delete(name: string, cb: (err: Error | null, procs?: unknown) => void): void;
	list(cb: (err: Error | null, list?: Pm2Proc[]) => void): void;
	describe(name: string, cb: (err: Error | null, list?: Pm2Proc[]) => void): void;
	launchBus(cb: (err: Error | null, bus?: Pm2Bus) => void): void;
	killDaemon(cb?: (err: Error | null) => void): void;
};

interface Pm2Proc {
	pid?: number;
	name?: string;
	pm_id?: number;
	pm2_env?: {
		name?: string;
		status?: string;
		pm_id?: number | string;
		exit_code?: number | null;
	};
}

/** Load the pm2 module lazily so the import cost lands only on daemon boot.
 *  `custom` (the API class) gives a scoped instance — the default singleton
 *  export would share one daemon connection process-wide (and could attach
 *  sibling test daemons to the same PM2_HOME). */
function loadPm2(): { custom: new (opts: { pm2_home: string }) => Pm2Api } {
	const require = createRequire(import.meta.url);
	return require("pm2") as { custom: new (opts: { pm2_home: string }) => Pm2Api };
}

export class Supervisor {
	private readonly pm2Home: string;
	private readonly homeDir: string;
	private readonly onExit?: (label: string, facts: ExitFacts) => void;
	private readonly onRestart?: (label: string) => void;
	private pm2: Pm2Api | null = null;
	private connected = false;
	private tails = new Map<string, string>();
	private dead = new Map<string, ExitFacts>();
	private stopping = new Set<string>();
	/** The autorestart policy per label (set at fork; PM2 owns the enforcement). */
	private policy = new Map<string, boolean>();

	constructor(opts: SupervisorOptions) {
		this.homeDir = opts.homeDir;
		this.pm2Home = join(opts.homeDir, "pm2");
		this.onExit = opts.onExit;
		this.onRestart = opts.onRestart;
	}

	/** Connect (spawning the scoped daemon when absent), wipe any stale PM2
	 *  memory (dump file = never resurrected — we submit desired state), and
	 *  attach the event bus so exits surface as ExitFacts. Idempotent. */
	async connect(): Promise<void> {
		if (this.connected && this.pm2) return;
		// Stale dump from a previous life: our stores are the only memory —
		// PM2 programmatic never auto-resurrects, but a CLI-driven daemon on
		// the same home could have left one. Remove it so no ghosts return.
		for (const f of ["dump.pm2", "dump.pm2.bak"]) {
			try {
				const p = join(this.pm2Home, f);
				if (existsSync(p)) rmSync(p, { force: true });
			} catch {
				/* best-effort */
			}
		}
		if (!this.pm2) this.pm2 = new (loadPm2().custom)({ pm2_home: this.pm2Home });
		const pm2 = this.pm2;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const timer = setTimeout(() => {
			reject(new Error(`[swarm] pm2 connect timed out (${CONNECT_TIMEOUT_MS}ms, home=${this.pm2Home})`));
		}, CONNECT_TIMEOUT_MS);
		// `unref` so a hung daemon socket can't pin the test runner.
		timer.unref();
		pm2.connect((err) => {
			clearTimeout(timer);
			if (err) reject(err);
			else resolve();
		});
		await promise;
		this.connected = true;
		// Belt-and-suspenders: drop anything the scoped daemon already tracks
		// (a previous daemon incarnation's children) — desired state follows.
		try {
			await this.clearAll();
		} catch {
			/* a fresh home has nothing to clear */
		}
		const { promise: busPromise, resolve: busResolve, reject: busReject } = Promise.withResolvers<void>();
		pm2.launchBus((err, bus) => {
			if (err || !bus) {
				busReject(err ?? new Error("[swarm] pm2 bus unavailable"));
				return;
			}
			bus.on("process:event", (p) => this.onProcessEvent(p));
			bus.on("log:err", (p) => this.onLogErr(p));
			busResolve();
		});
		await busPromise;
	}

	/** Fork an agent file. THE one fork path — process start AND task fire share it.
	 *  `autorestart` decides the PM2 policy: true = restart with backoff, false
	 *  = stay dead and report the death. */
	async fork(
		agentFile: string,
		opts: {
			label: string;
			autorestart?: boolean;
			templateEnv?: Record<string, string>;
			extraEnv?: Record<string, string>;
		},
	): Promise<ForkResult> {
		const pm2 = await this.ready();
		const sessionId = `swarm-${randomUUID().slice(0, 8)}`;
		warnBareAgentDir(agentFile, this.homeDir);
		const env: Record<string, string> = {
			...(opts.templateEnv ?? {}),
			...(opts.extraEnv ?? {}),
			SWARM_SESSION_ID: sessionId,
		};
		// The daemon stamps the parent backlink (process name / task fire id)
		// via extraEnv; fall back to the PM2 label only when it doesn't.
		if (!env.SWARM_SPAWN_ID) env.SWARM_SPAWN_ID = opts.label;
		// Fill the daemon-side vars PM2 would otherwise leave undefined.
		if (!env.SWARM_HOME) env.SWARM_HOME = this.homeDir;
		// Kill-then-start under a reused label: drop the old death first —
		// the new life owns the label (matches the old refork-clears-death).
		this.dead.delete(opts.label);
		this.stopping.delete(opts.label);
		this.tails.delete(opts.label);
		this.policy.set(opts.label, opts.autorestart ?? false);
		const startCall = Promise.withResolvers<Pm2Proc[]>();
		pm2.start(
			{
				script: agentFile,
				name: opts.label,
				exec_mode: "fork",
				instances: 1,
				// PM2 maps .ts → bun by default; our agents are node --strip-types.
				// Pin the interpreter so node_args apply and the fork container
				// is the node one, not the bun one.
				exec_interpreter: "node",
				autorestart: opts.autorestart ?? false,
				// PM2 must report the death NOW (exit event), not park the
				// proc in "waiting restart" behind a delay we never asked for.
				...(opts.autorestart
					? { exp_backoff_restart_delay: BACKOFF_BASE_MS }
					: { restart_delay: 0 }),
				min_uptime: 1000,
				kill_timeout: KILL_TIMEOUT_MS,
				out_file: "NULL",
				err_file: "NULL",
				node_args: ["--experimental-strip-types", "--experimental-transform-types"],
				env,
			},
			(err, list) => {
				if (err) startCall.reject(err);
				else if (!Array.isArray(list)) startCall.resolve([]);
				else startCall.resolve(list.filter((p) => (p.name ?? p.pm2_env?.name) === opts.label));
			},
		);
		const procs = await startCall.promise;
		const first = procs[0];
		const pid = typeof first?.pid === "number" && first.pid > 0 ? first.pid : undefined;
		return { sessionId, pid };
	}

	/** The live pid of a forked label (undefined when not running). */
	async pidOf(label: string): Promise<number | undefined> {
		const pm2 = await this.ready();
		const listCall = Promise.withResolvers<Pm2Proc[]>();
		pm2.describe(label, (err, procs) => {
			if (err || !Array.isArray(procs)) listCall.resolve([]);
			else listCall.resolve(procs.filter((p) => (p.name ?? p.pm2_env?.name) === label));
		});
		const list = await listCall.promise;
		const live = list.find((p) => p.pm2_env?.status === "online");
		return live && typeof live.pid === "number" && live.pid > 0 ? live.pid : undefined;
	}

	/** How this label last died — undefined when never (or reforked since). */
	lastExit(label: string): ExitFacts | undefined {
		return this.dead.get(label);
	}

	/** Murder the child under a label (PM2 stop: SIGINT → SIGKILL via
	 *  kill_timeout; the entry stays listed as stopped, no ghost). True when
	 *  something was there. The label is marked so the intentional death never
	 *  reads as a crash (autorestart stays quiet). */
	async kill(label: string): Promise<boolean> {
		if (!this.connected || !this.pm2) return false;
		const pm2 = this.pm2;
		const knownCall = Promise.withResolvers<boolean>();
		pm2.describe(label, (err, procs) => {
			if (err || !Array.isArray(procs)) knownCall.resolve(false);
			else knownCall.resolve(procs.some((p) => (p.name ?? p.pm2_env?.name) === label));
		});
		if (!(await knownCall.promise)) return false;
		this.stopping.add(label);
		try {
			const stopCall = Promise.withResolvers<void>();
			pm2.stop(label, () => stopCall.resolve());
			await stopCall.promise;
		} finally {
			this.stopping.delete(label);
		}
		return true;
	}

	/** Fire-and-forget stop for paths that can't await (best-effort). The dead
	 *  set updates via the bus; the entry stays listed as stopped. */
	killSync(label: string): boolean {
		if (!this.connected || !this.pm2) return false;
		this.stopping.add(label);
		try {
			this.pm2.stop(label, () => {
				this.stopping.delete(label);
			});
		} catch {
			this.stopping.delete(label);
			return false;
		}
		return true;
	}

	/** Restart a live label in place (PM2 stop→start under the same name).
	 *  Same pm_id, stored spec reused — env/prompt updates can't ride it, so
	 *  the daemon reforks (kill + fork) when the recipe changed. */
	async restart(label: string): Promise<boolean> {
		if (!this.connected || !this.pm2) return false;
		const pm2 = this.pm2;
		const knownCall = Promise.withResolvers<boolean>();
		pm2.describe(label, (err, procs) => {
			if (err || !Array.isArray(procs)) knownCall.resolve(false);
			else knownCall.resolve(procs.some((p) => (p.name ?? p.pm2_env?.name) === label));
		});
		if (!(await knownCall.promise)) return false;
		this.stopping.add(label);
		try {
			const restartCall = Promise.withResolvers<void>();
			pm2.restart(label, () => restartCall.resolve());
			await restartCall.promise;
		} finally {
			this.stopping.delete(label);
		}
		return true;
	}

	/** Stop every tracked child (stopped entries stay listed, never ghosts).
	 *  Used by daemon shutdown — desired state is already persisted. */
	async stopAll(): Promise<void> {
		if (!this.connected || !this.pm2) return;
		const pm2 = this.pm2;
		const listCall = Promise.withResolvers<string[]>();
		pm2.list((err, list) => {
			if (err || !Array.isArray(list)) {
				listCall.resolve([]);
				return;
			}
			const seen: Record<string, true> = {};
			for (const p of list) {
				const n = p.name ?? p.pm2_env?.name;
				if (n) seen[n] = true;
			}
			listCall.resolve(Object.keys(seen));
		});
		const names = await listCall.promise;
		for (const n of names) this.stopping.add(n);
		try {
			for (const n of names) {
				const stopCall = Promise.withResolvers<void>();
				pm2.stop(n, () => stopCall.resolve());
				await stopCall.promise;
			}
		} finally {
			for (const n of names) this.stopping.delete(n);
		}
	}

	/** Detach from the scoped daemon WITHOUT killing it. Tests share one
	 *  process across many daemon lifecycles — the daemon dies, PM2 stays. */
	disconnect(): void {
		if (!this.pm2 || !this.connected) return;
		this.connected = false;
		try {
			this.pm2.disconnect();
		} catch {
			/* already gone */
		}
	}

	/** Kill the scoped PM2 daemon itself (releases its sockets/pids). Used when
	 *  the swarm home is torn down for good. Never touches the outer PM2. */
	async killDaemon(): Promise<void> {
		if (!this.pm2) return;
		this.connected = false;
		const pm2 = this.pm2;
		this.pm2 = null;
		const killCall = Promise.withResolvers<void>();
		let done = false;
		const finish = (): void => {
			if (done) return;
			done = true;
			try {
				pm2.disconnect();
			} catch {
				/* already gone */
			}
			killCall.resolve();
		};
		const timer = setTimeout(finish, KILL_DAEMON_TIMEOUT_MS);
		timer.unref();
		try {
			pm2.killDaemon(() => {
				clearTimeout(timer);
				finish();
			});
		} catch {
			clearTimeout(timer);
			finish();
		}
		await killCall.promise;
	}

	private async ready(): Promise<Pm2Api> {
		if (!this.connected || !this.pm2) await this.connect();
		return this.pm2!;
	}

	private async clearAll(): Promise<void> {
		const pm2 = this.pm2;
		if (!pm2) return;
		const listCall = Promise.withResolvers<string[]>();
		pm2.list((err, list) => {
			if (err || !Array.isArray(list)) {
				listCall.resolve([]);
				return;
			}
			const seen: Record<string, true> = {};
			for (const p of list) {
				const n = p.name ?? p.pm2_env?.name;
				if (n) seen[n] = true;
			}
			listCall.resolve(Object.keys(seen));
		});
		const names = await listCall.promise;
		for (const name of names) {
			const delCall = Promise.withResolvers<void>();
			pm2.delete(name, () => delCall.resolve());
			await delCall.promise;
		}
	}

	private onProcessEvent(payload: unknown): void {
		if (!payload || typeof payload !== "object") return;
		if (!("process" in payload) || !("event" in payload)) return;
		const p = payload as Pm2BusPayload;
		const label = p.process?.name;
		if (!label || typeof label !== "string") return;
		if (p.event === "exit" || p.event === "restart overlimit") {
			// Intentional deaths never read as crashes: kill/stop/restart go
			// through `stopping`.
			if (this.stopping.has(label)) return;
			// PM2-owned restarts never reach here as deaths: when the policy
			// is autorestart=true PM2 restarts the child itself and the new
			// life is reported via `start`/`online` (→ onRestart). Only a
			// label that should stay dead reports its death — except the
			// overlimit give-up, which is final under any policy.
			if (p.event === "exit" && (this.policy.get(label) ?? false)) {
				this.tails.delete(label);
				return;
			}
			const tail = this.tails.get(label);
			this.tails.delete(label);
			const raw = p.process?.exit_code;
			const facts: ExitFacts = {
				code: typeof raw === "number" ? raw : null,
				signal: null,
				at: typeof p.at === "number" ? p.at : Date.now(),
			};
			if (tail) facts.stderrTail = tail;
			this.dead.set(label, facts);
			try {
				this.onExit?.(label, facts);
			} catch {
				/* the hook is a courtesy, never a contract */
			}
		} else if (p.event === "start" || p.event === "online") {
			// PM2 restarted the child itself (autorestart, backoff). The new
			// life supersedes any recorded death — matches refork-clears-death.
			// Only count it when the policy says the label should survive:
			// fork() is the first life, exits with autorestart=false stay dead.
			const firstLife = !this.policy.has(label);
			this.dead.delete(label);
			this.tails.delete(label);
			if (!firstLife && (this.policy.get(label) ?? false)) {
				try {
					this.onRestart?.(label);
				} catch {
					/* the hook is a courtesy, never a contract */
				}
			}
		}
	}

	private onLogErr(payload: unknown): void {
		if (!payload || typeof payload !== "object") return;
		if (!("process" in payload)) return;
		const p = payload as Pm2BusPayload;
		const label = p.process?.name;
		if (!label || typeof label !== "string" || p.data === undefined) return;
		const text = typeof p.data === "string" ? p.data : String(p.data);
		this.tails.set(label, ((this.tails.get(label) ?? "") + text).slice(-STDERR_TAIL_MAX));
	}
}
