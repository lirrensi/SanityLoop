// ============================================================================
// test/e2e/helpers/spawn.ts — bounded subprocess runner for REAL runs.
// ============================================================================
// Every spawned process gets a hard kill deadline. NO e2e wait is unbounded:
// if a template hangs, the harness kills it, marks timedOut, and the test
// fails with evidence — which is exactly the burn we are here to catch.

import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, derived from this file's location (<root>/test/e2e/helpers). */
export const REPO_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

/** The same runtime flags package.json uses for source-distributed TS. */
export const NODE_FLAGS = [
    "--experimental-strip-types",
    "--experimental-transform-types",
];

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
}

/**
 * Spawn `node <flags> <script>` and await its exit — bounded, always.
 * Collects stdout/stderr as they stream; resolves (never rejects) on close,
 * error, or timeout so callers always get evidence to assert against.
 */
export function runNode(scriptPath: string, opts: RunNodeOptions = {}): Promise<SpawnResult> {
    const { cwd = REPO_ROOT, env = {}, timeoutMs = 30_000 } = opts;
    return new Promise((resolve) => {
        const t0 = Date.now();
        const child = spawn(process.execPath, [...NODE_FLAGS, scriptPath], {
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
    });
}
