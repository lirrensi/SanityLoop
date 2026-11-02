// ============================================================================
// test/e2e/helpers/spawn.ts — bounded subprocess runner for REAL runs.
// ============================================================================
// Every spawned process gets a hard kill deadline. NO e2e wait is unbounded:
// if a template hangs, the harness kills it, marks timedOut, and the test
// fails with evidence — which is exactly the burn we are here to catch.

import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, derived from this file's location (<root>/test/e2e/helpers). */
export const REPO_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

/** The same runtime flags package.json uses for source-distributed TS. */
export const NODE_FLAGS = [
    "--experimental-strip-types",
    "--experimental-transform-types",
];

/** The swarm operator CLI (also the daemon entrypoint: `serve` IS the daemon). */
export const SWARM_CLI = join(REPO_ROOT, "packages/swarm/src/server/cli.ts");

export interface SpawnResult {
    code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    /** True when the hard deadline fired and we killed the child. */
    timedOut: boolean;
    durationMs: number;
}

export interface RunNodeOptions {
    cwd?: string;
    env?: Record<string, string>;
    /** Hard ceiling in ms. Default 30_000. The child is KILLED at the deadline. */
    timeoutMs?: number;
    /** Extra argv appended after the script path (CLI verbs/flags). */
    cliArgs?: string[];
}

/**
 * Spawn `node <flags> <script> [cliArgs...]` and await its exit — bounded, always.
 * Collects stdout/stderr as they stream; resolves (never rejects) on close,
 * error, or timeout so callers always get evidence to assert against.
 */
export function runNode(scriptPath: string, opts: RunNodeOptions = {}): Promise<SpawnResult> {
    const { cwd = REPO_ROOT, env = {}, timeoutMs = 30_000, cliArgs = [] } = opts;
    const { promise, resolve } = Promise.withResolvers<SpawnResult>();
    const t0 = Date.now();
    const child = spawn(process.execPath, [...NODE_FLAGS, scriptPath, ...cliArgs], {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
    }, timeoutMs);

    const finish = (code: number | null, signal: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
            code,
            signal,
            timedOut,
            durationMs: Date.now() - t0,
            stdout: Buffer.concat(out).toString("utf8"),
            stderr: Buffer.concat(err).toString("utf8"),
        });
    };

    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("close", (code, signal) => finish(code, signal));
    child.on("error", () => finish(null, null));
    return promise;
}

/**
 * Run the swarm CLI as a real child against a live daemon's home:
 * `swarm <args...>` with `--dir <home>` supplied by the caller.
 * The daemon is found via the home's config.json — no port plumbing needed.
 */
export function runCli(args: string[], opts: RunNodeOptions = {}): Promise<SpawnResult> {
    return runNode(SWARM_CLI, { ...opts, cliArgs: args });
}

export interface DaemonExit {
    code: number | null;
    signal: string | null;
}

function waitProcExit(proc: ChildProcess, ms: number): Promise<DaemonExit> {
    if (proc.exitCode !== null || proc.signalCode !== null) {
        return Promise.resolve({ code: proc.exitCode, signal: proc.signalCode });
    }
    const { promise, resolve, reject } = Promise.withResolvers<DaemonExit>();
    const t = setTimeout(() => reject(new Error("timed out waiting for process exit")), ms);
    proc.once("close", (code, signal) => {
        clearTimeout(t);
        resolve({ code, signal });
    });
    return promise;
}

function killProc(proc: ChildProcess, signal: NodeJS.Signals, ms = 10_000): Promise<DaemonExit> {
    try {
        proc.kill(signal);
    } catch {
        /* already gone — waitExit reports it */
    }
    return waitProcExit(proc, ms);
}

export interface DaemonHandle {
    proc: ChildProcess;
    home: string;
    name?: string;
    /** The ACTUAL port (parsed from the daemon's ready line — pass 0 to avoid collisions). */
    port: number;
    url: string;
    /** Accumulated stdout/stderr (boot lines live here: "marked interrupted", lock errors). */
    out: () => string;
    err: () => string;
    waitExit: (ms?: number) => Promise<DaemonExit>;
    kill: (signal?: NodeJS.Signals) => Promise<DaemonExit>;
}

export interface SpawnDaemonOptions {
    home: string;
    /** The daemon's declared swarm name — required for federation. */
    name?: string;
    /** Remote daemon WS urls to mount at boot (`serve --connect` × N). */
    connect?: string[];
    /** Fixed port, or 0 (default) for an ephemeral one parsed from the ready line. */
    port?: number;
    /** How long to wait for the ready line before giving up. Default 20_000. */
    timeoutMs?: number;
}

/**
 * Boot a REAL daemon as a child process (`serve --dir <home>`) and resolve
 * once it prints its ready line. Kill it with handle.kill() (SIGKILL default —
 * the unclean-death path boot reconciliation exists for). A home = a daemon:
 * the unit name derives from the home, each with its own --dir/--port.
 */
export function spawnDaemon(opts: SpawnDaemonOptions): Promise<DaemonHandle> {
    const { home, name, connect = [], port = 0, timeoutMs = 20_000 } = opts;
    const args = [
        "serve",
        "--dir", home,
        "--port", String(port),
        "--addr", "127.0.0.1",
        ...(name ? ["--name", name] : []),
        ...connect.flatMap((u) => ["--connect", u]),
    ];
    const { promise, resolve, reject } = Promise.withResolvers<DaemonHandle>();
    const proc = spawn(process.execPath, [...NODE_FLAGS, SWARM_CLI, ...args], {
        cwd: REPO_ROOT,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });
    let out = "";
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
            proc.kill("SIGKILL");
        } catch {
            /* ignore */
        }
        reject(new Error(`daemon never became ready in ${timeoutMs}ms\nstdout: ${out}\nstderr: ${err}`));
    }, timeoutMs);
    proc.stdout.on("data", (c: Buffer) => {
        out += c.toString("utf8");
        if (settled) return;
        const m = out.match(/daemon on ws:\/\/(\S+):(\d+)/);
        if (m) {
            settled = true;
            clearTimeout(timer);
            const actual = Number(m[2]);
            resolve({
                proc,
                home,
                name,
                port: actual,
                url: `ws://127.0.0.1:${actual}`,
                out: () => out,
                err: () => err,
                waitExit: (ms = 10_000) => waitProcExit(proc, ms),
                kill: (signal: NodeJS.Signals = "SIGKILL") => killProc(proc, signal),
            });
        }
    });
    proc.stderr.on("data", (c: Buffer) => {
        err += c.toString("utf8");
    });
    proc.on("error", (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
    });
    proc.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`daemon exited before ready (code=${code} signal=${signal})\nstdout: ${out}\nstderr: ${err}`));
    });
    return promise;
}
