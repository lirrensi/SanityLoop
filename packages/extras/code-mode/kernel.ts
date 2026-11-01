// ============================================================================
// packages/extras/code-mode/kernel.ts — kernel process host.
// ============================================================================
// One long-lived child per (session, cwd, language). Spawn is lazy (first
// cell), pipes are NDJSON (protocol.ts). Single-flight per kernel: cells
// queue FIFO; the queue is bounded by each cell's own ceiling.
//
// Kill ladder (POSIX): SIGINT group → 5 s → SIGTERM group → 5 s → SIGKILL
// group. Windows: taskkill /T /F. `detached: true` (setsid) so group
// signals never touch the host. Idle shutdown: {"t":"shutdown"} → 1 s →
// SIGTERM → 5 s → SIGKILL.
//
// The host is the only clock: no runner-side timers are trusted.
// ============================================================================

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { killProcessTree } from "@sanityloop/shell-tool";
import {
    isProtocolError,
    parseFrame,
    type CancelFrame,
    type ExecControl,
    type HostControl,
    type HostReturn,
    type KernelFrame,
    type ReturnFrame,
} from "./protocol.ts";

export const BOOT_TIMEOUT_MS = 15_000;
export const SHUTDOWN_GRACE_MS = 1_000;
export const KILL_ESCALATION_MS = 5_000;

/** Spawn env: strict allowlist. A cell can printenv — the host env would
 * hand it the provider API key. */
const SPAWN_ENV_KEYS = [
    "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TEMP", "TMP",
    "SYSTEMROOT", "WINDIR", "PATHEXT", "COMSPEC", "PROGRAMDATA",
    "VIRTUAL_ENV", "PYTHONPATH", "PYTHONHOME", "NODE_PATH", "NODE_OPTIONS",
];

function spawnEnv(extra?: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of SPAWN_ENV_KEYS) {
        const v = process.env[k];
        if (v !== undefined) out[k] = v;
    }
    out.PYTHONUNBUFFERED = "1";
    out.PYTHONDONTWRITEBYTECODE = "1";
    out.NODE_NO_WARNINGS = "1";
    if (extra) for (const [k, v] of Object.entries(extra)) out[k] = v;
    return out;
}

export interface KernelSpawnSpec {
    argv: string[];
    cwd: string;
    /** Extra env for this kernel (e.g. SL_PERSIST_DIR). */
    env?: Record<string, string>;
}

export interface KernelEvents {
    onFrame(frame: KernelFrame): void;
    onStderr(chunk: Buffer): void;
    onExit(code: number | null, signal: string | null): void;
    onProtocolError(message: string): void;
}

/** A live kernel child: framed pipes + kill ladder. The cell runner owns
 * the request/response correlation; this owns the process. */
export class KernelProcess {
    private child: ChildProcess | undefined;
    private stdoutBuf = "";
    private dead = false;
    private readyResolve: ((ready: boolean) => void) | undefined;

    readonly id = randomUUID().slice(0, 8);
    pid: number | undefined;

    private readonly spec: KernelSpawnSpec;
    private readonly events: KernelEvents;

    constructor(spec: KernelSpawnSpec, events: KernelEvents) {
        this.spec = spec;
        this.events = events;
    }

    get alive(): boolean {
        return !this.dead && this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null;
    }

    /** Spawn (idempotent while alive) and wait for the `ready` frame. */
    async start(): Promise<boolean> {
        if (this.alive) return true;
        this.dead = false;
        this.stdoutBuf = "";
        const child = spawn(this.spec.argv[0]!, this.spec.argv.slice(1), {
            cwd: this.spec.cwd,
            env: spawnEnv(this.spec.env),
            stdio: ["pipe", "pipe", "pipe", "pipe"],
            detached: process.platform !== "win32",
            windowsHide: true,
        });
        this.child = child;
        this.pid = child.pid;
        child.on("error", () => {
            // Spawn failure surfaces via exit/close; the ready wait times out.
        });
        child.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk));
        child.stderr!.on("data", (chunk: Buffer) => this.events.onStderr(chunk));
        child.on("exit", (code, signal) => {
            this.dead = true;
            this.readyResolve?.(false);
            this.readyResolve = undefined;
            this.events.onExit(code, signal);
        });
        const { promise, resolve } = Promise.withResolvers<boolean>();
        const timer = setTimeout(() => {
            this.readyResolve = undefined;
            resolve(false);
        }, BOOT_TIMEOUT_MS);
        timer.unref?.();
        this.readyResolve = (ready) => {
            clearTimeout(timer);
            resolve(ready);
        };
        return promise;
    }

    /** Resolve the ready wait when the runner's first frame lands. Called
     * by the cell runner's frame handler — not by this class. */
    noteReady(): void {
        this.readyResolve?.(true);
        this.readyResolve = undefined;
    }

    /** Write one control line (fd 0). False when the pipe is gone. */
    sendControl(frame: HostControl): boolean {
        const child = this.child;
        if (!this.alive || !child?.stdin?.writable) return false;
        try {
            child.stdin.write(`${JSON.stringify(frame)}\n`);
            return true;
        } catch {
            return false;
        }
    }

    /** Write one return/cancel line (fd 3). False when the pipe is gone. */
    sendReturn(frame: HostReturn): boolean {
        const child = this.child;
        const extra = (child?.stdio as unknown[] | undefined)?.[3] as { writable?: boolean; write?: (s: string) => void } | undefined;
        if (!this.alive || extra?.writable !== true || typeof extra.write !== "function") return false;
        try {
            extra.write(`${JSON.stringify(frame)}\n`);
            return true;
        } catch {
            return false;
        }
    }

    /** Graceful shutdown: shutdown frame → grace → SIGTERM → grace → SIGKILL. */
    async shutdown(): Promise<void> {
        if (!this.alive) return;
        this.sendControl({ v: 1, t: "shutdown" });
        if (await this.waitExit(SHUTDOWN_GRACE_MS)) return;
        this.signalGroup("SIGTERM");
        if (await this.waitExit(KILL_ESCALATION_MS)) return;
        this.hardKill();
        await this.waitExit(KILL_ESCALATION_MS);
    }

    /** The kill ladder: SIGINT → 5 s → SIGTERM → 5 s → SIGKILL (group). */
    async kill(): Promise<void> {
        if (!this.alive) return;
        this.signalGroup("SIGINT");
        if (await this.waitExit(KILL_ESCALATION_MS)) return;
        this.signalGroup("SIGTERM");
        if (await this.waitExit(KILL_ESCALATION_MS)) return;
        this.hardKill();
        await this.waitExit(KILL_ESCALATION_MS);
    }

    private signalGroup(sig: "SIGINT" | "SIGTERM"): void {
        const pid = this.pid;
        if (pid === undefined || pid <= 1) return;
        if (process.platform === "win32") {
            this.hardKill();
            return;
        }
        try {
            process.kill(-pid, sig);
        } catch {
            try {
                process.kill(pid, sig);
            } catch {
                // Already gone.
            }
        }
    }

    private hardKill(): void {
        const pid = this.pid;
        if (pid === undefined || pid <= 1) return;
        try {
            killProcessTree(pid);
        } catch {
            // Already gone.
        }
    }

    private waitExit(ms: number): Promise<boolean> {
        if (!this.alive) return Promise.resolve(true);
        const { promise, resolve } = Promise.withResolvers<boolean>();
        const timer = setTimeout(() => {
            cleanup();
            resolve(!this.alive);
        }, ms);
        timer.unref?.();
        const onExit = (): void => {
            cleanup();
            resolve(true);
        };
        const cleanup = (): void => {
            clearTimeout(timer);
            this.child?.off("exit", onExit);
        };
        this.child?.once("exit", onExit);
        return promise;
    }

    private onStdout(chunk: Buffer): void {
        this.stdoutBuf += chunk.toString("utf8");
        for (;;) {
            const nl = this.stdoutBuf.indexOf("\n");
            if (nl < 0) break;
            const line = this.stdoutBuf.slice(0, nl);
            this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
            if (line.trim().length === 0) continue;
            // 1 MiB single-frame cap: larger is a protocol error.
            if (Buffer.byteLength(line, "utf8") > 1024 * 1024) {
                this.events.onProtocolError("frame exceeds 1 MiB");
                return;
            }
            const frame = parseFrame(line);
            if (isProtocolError(frame)) {
                this.events.onProtocolError(frame.protocolError);
                return;
            }
            this.events.onFrame(frame);
        }
    }
}

export function execControl(id: string, code: string, opts: {
    cwd: string;
    env?: Record<string, string>;
    timeout_s: number;
    budget: number;
    tools: string[];
    filename?: string | null;
}): ExecControl {
    return {
        v: 1,
        t: "exec",
        id,
        code,
        cwd: opts.cwd,
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        timeout_s: opts.timeout_s,
        budget: opts.budget,
        tools: opts.tools,
        ...(opts.filename !== undefined ? { filename: opts.filename } : {}),
    };
}

export function returnFrame(callId: string, ok: boolean, answer: string, budgetLeft: number, errorMessage?: string): ReturnFrame {
    return {
        v: 1,
        t: "return",
        callId,
        ok,
        answer,
        ...(errorMessage !== undefined ? { errorMessage } : {}),
        budgetLeft,
    };
}

export function cancelFrame(id: string, reason: CancelFrame["reason"]): CancelFrame {
    return { v: 1, t: "cancel", id, callId: null, reason };
}
