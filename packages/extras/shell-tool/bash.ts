// sanity/src/extras/tools/bash.ts — THE bash tool.
//
// A configurable factory: the shell, the default cwd, a command prefix, and a
// spawn hook (command/cwd/env rewriting) are all locked at construction. The
// model calls it with:
//   command     — the shell command string
//   workdir     — where to run it (MSYS `/c/...`, `~`, absolute, or relative)
//   timeout     — seconds, OPTIONAL, no default (commands run to completion)
//   description — why it's being run (logged + visible to permission filters)
//
// Mechanics ported from pi (shell discovery, process-tree kill, tail-truncated
// capture with full output saved to a temp file) blended with the Windows
// pwsh-first preference from the pi custom-bash extension.
//
// One deliberate deviation from pi: nonzero exit / timeout / abort are RETURNED
// as a ToolResult, not thrown — Sanity's loop does error-as-result anyway
// (agent.ts:566), so the model sees the same text, and `stored` keeps the
// structured details (exitCode, truncation, fullOutputPath).
import { homedir } from "node:os";
import { delimiter, isAbsolute, resolve } from "node:path";
import { Tool, type Plugin } from "@sanityloop/core";
import { executeLocalShell, findCoreutilsBin, resolveShellConfig, type ResolvedShell } from "./shell.ts";
import { OutputAccumulator, type OutputSnapshot } from "./output-accumulator.ts";
import { formatSize } from "@sanityloop/util";

// ---------------------------------------------------------------------------
// factory options
// ---------------------------------------------------------------------------

export interface BashSpawnContext {
    command: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

export interface BashToolOptions {
    /** Shell to execute through. Default: SANITY_SHELL env, else platform default
     * (pwsh7 → Git Bash on Windows; $SHELL → /bin/bash → sh on POSIX). */
    shellPath?: string;
    /** Launch a LOGIN shell (-lc instead of -c for bash/zsh/sh). */
    loginShell?: boolean;
    /** Default working directory. Default: the agent's cwd at execute time. */
    cwd?: string;
    /** Command prefix prepended to every command (shell setup, e.g. "set -e"). */
    commandPrefix?: string;
    /** Hook to adjust command, cwd, or env before execution. */
    spawnHook?: BashSpawnHook;
    /** Display truncation limits (tail — the end is what matters). */
    maxLines?: number;
    maxBytes?: number;
    /** Temp file prefix for full-output spill. */
    tempFilePrefix?: string;

    // ---- env policy (codex's shell environment policy, simplified) ----
    /** Start from the parent env (default true). false = empty env + `env`. */
    inheritEnv?: boolean;
    /** Force-set these env vars — always applied last (addEnv). */
    env?: Record<string, string>;
    /** Case-insensitive `*`-glob patterns of env var names to REMOVE from the
     * inherited env (blacklistEnv) — e.g. ["API_KEY", "TOKEN*"] so secrets
     * never reach the shell. Applied before `env`. */
    blacklistEnv?: string[];
}

export interface BashToolResult {
    exitCode: number | undefined;
    timedOut: boolean;
    aborted: boolean;
    truncated: boolean;
    fullOutputPath?: string;
    cwd: string;
    description?: string;
}

// ---------------------------------------------------------------------------
// workdir resolution (ported from the pi custom-bash extension's normalizeCwd)
// ---------------------------------------------------------------------------

/**
 * Normalize a `workdir` argument to an absolute, OS-native path.
 * - git-bash / MSYS style `/c/Users/...` → `C:\Users\...` (Windows only)
 * - `~` / `~/...` → home directory
 * - already-absolute (`C:\...`, `C:/...`, `\\server\...`) → normalized
 * - anything else → resolved against the agent's cwd
 */
function resolveWorkdir(input: string, sessionCwd: string): string {
    const trimmed = input.trim();
    if (trimmed.length === 0) return sessionCwd;

    if (process.platform === "win32") {
        const msys = /^\/[a-zA-Z](?:\/(.*))?$/.exec(trimmed);
        if (msys) {
            const drive = trimmed[1].toUpperCase();
            const rest = (msys[1] ?? "").replace(/\//g, "\\");
            return `${drive}:\\${rest}`;
        }
    }

    if (trimmed === "~") return homedir();
    if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
        return resolve(homedir(), trimmed.slice(2));
    }
    if (isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed)) {
        return resolve(trimmed);
    }
    return resolve(sessionCwd, trimmed);
}

// ---------------------------------------------------------------------------
// env policy builder (codex's exclude/include_only/set → inheritEnv/blacklist/env)
// ---------------------------------------------------------------------------

function globToRegExp(pattern: string): RegExp {
    let re = "";
    for (const ch of pattern) {
        if (ch === "*") re += ".*";
        else if (/[.*+?^${}()|[\]\\]/.test(ch)) re += "\\" + ch;
        else re += ch;
    }
    return new RegExp(`^${re}$`, "i");
}

function buildShellEnv(options: BashToolOptions): NodeJS.ProcessEnv {
    const base: NodeJS.ProcessEnv = options.inheritEnv === false ? {} : { ...process.env };
    if (options.blacklistEnv && options.blacklistEnv.length > 0) {
        const patterns = options.blacklistEnv.map(globToRegExp);
        for (const key of Object.keys(base)) {
            if (patterns.some((re) => re.test(key))) delete base[key];
        }
    }
    if (options.env) Object.assign(base, options.env);
    return base;
}

/** Prepend a dir to PATH (case-insensitive de-dup; keeps the existing key casing). */
function ensureOnPath(env: NodeJS.ProcessEnv, dir: string): void {
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path");
    const existing = pathKey ? env[pathKey] : undefined;
    if (existing && existing.split(delimiter).some((p) => p.toLowerCase() === dir.toLowerCase())) return;
    const merged = [dir, ...(existing ? existing.split(delimiter) : [])].filter(Boolean).join(delimiter);
    if (pathKey) env[pathKey] = merged;
    else env.PATH = merged;
}

// ---------------------------------------------------------------------------
// output formatting (pi's formatOutput + appendStatus)
// ---------------------------------------------------------------------------

function appendStatus(text: string, status: string): string {
    return `${text ? `${text}\n\n` : ""}${status}`;
}

function formatOutput(snapshot: OutputSnapshot, lastLineBytes: number): string {
    const truncation = snapshot.truncation;
    let text = snapshot.content || "(no output)";
    if (truncation.truncated) {
        const startLine = truncation.totalLines - truncation.outputLines + 1;
        const endLine = truncation.totalLines;
        if (truncation.lastLinePartial) {
            const lastLineSize = formatSize(lastLineBytes);
            text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
        } else if (truncation.truncatedBy === "lines") {
            text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
        } else {
            text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(truncation.maxBytes)} limit). Full output: ${snapshot.fullOutputPath}]`;
        }
    }
    return text;
}

// ---------------------------------------------------------------------------
// the tool
// ---------------------------------------------------------------------------

export function createBashTool(options: BashToolOptions = {}) {
    // fail fast at factory time — the model never sees a "shell not found" loop
    const shell: ResolvedShell = resolveShellConfig(options.shellPath, options.loginShell);
    // pwsh launches with -NoProfile → profile-added PATH entries are skipped, so
    // GNU coreutils (grep/sed/cut/...) may not resolve even when they work in the
    // user's interactive shell. Detect once, prepend at execute.
    const coreutilsBin = shell.isPwsh ? findCoreutilsBin() : null;

    const commandDescription =
        `Execute one command in the ${shell.label} shell (${shell.shell}). ` +
        `Write ${shell.syntax}. ` +
        "Do not assume a different shell — the command runs exactly here.";

    return Tool.define({
        name: "bash",
        description:
            `${commandDescription} Runs with the host user's filesystem, process, and network authority. ` +
            "`workdir` sets the working directory for this command only (absolute, `~` for home, git-bash style `/c/...`, or relative to the agent cwd; defaults to the agent cwd). " +
            "Returns combined stdout+stderr. Large output is truncated to the last lines, with the full output saved to a temp file. " +
            "`timeout` is optional (seconds) — no default, commands run to completion unless one is given. " +
            "`description` should say WHY the command is being run (it is logged and shown for approval).",
        promptSnippet: `Execute a ${shell.label} command`,
        promptGuidelines: [
            "Prefer read/edit/write over shell for file inspection and changes.",
            "Always include a `description` explaining why the command is run.",
            "One command per call — keep the command narrow; don't chain reads and writes that could race other tools.",
            "Set `timeout` for commands that might hang (servers, watchers, network calls).",
        ],
        executionMode: "sequential",
        inputSchema: {
            type: "object",
            properties: {
                command: { type: "string", description: "Shell command string to execute" },
                workdir: {
                    type: "string",
                    description: "Working directory for this command (default: the agent cwd)",
                },
                timeout: {
                    type: "number",
                    description: "Timeout in seconds. Optional — no default timeout.",
                },
                description: {
                    type: "string",
                    description: "Why you are running this command (for logging and approval). Optional.",
                },
            },
            required: ["command"],
        },
        async execute(params, agent) {
            const { command, workdir, timeout, description } = params as {
                command?: unknown;
                workdir?: unknown;
                timeout?: unknown;
                description?: unknown;
            };

            if (typeof command !== "string" || command.trim().length === 0) {
                return { answer: "bash: `command` is required and must be a string", error: true, errorMessage: "command required" };
            }
            if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)) {
                return { answer: `bash: invalid timeout '${String(timeout)}' — must be a positive number of seconds`, error: true, errorMessage: "invalid timeout" };
            }

            const sessionCwd = options.cwd ?? (agent.cwd as string | undefined) ?? process.cwd();
            const resolvedCwd =
                typeof workdir === "string" && workdir.trim().length > 0 ? resolveWorkdir(workdir, sessionCwd) : sessionCwd;

            const spawnContext: BashSpawnContext = {
                command: options.commandPrefix ? `${options.commandPrefix}\n${command}` : command,
                cwd: resolvedCwd,
                env: buildShellEnv(options),
            };
            if (coreutilsBin) ensureOnPath(spawnContext.env, coreutilsBin);
            const final = options.spawnHook ? options.spawnHook(spawnContext) : spawnContext;

            const output = new OutputAccumulator({
                maxLines: options.maxLines,
                maxBytes: options.maxBytes,
                tempFilePrefix: options.tempFilePrefix,
            });
            let timedOut = false;
            let aborted = false;
            let exitCode: number | undefined;
            let execError: unknown;

            try {
                const result = await executeLocalShell(final.command, {
                    cwd: final.cwd,
                    env: final.env,
                    timeoutMs: timeout !== undefined ? Math.round(timeout * 1000) : undefined,
                    abortSignal: agent.abortSignal,
                    shell,
                    onData: (data) => output.append(data),
                });
                exitCode = result.exitCode ?? 0;
            } catch (err) {
                execError = err;
                if (agent.abortSignal?.aborted) aborted = true;
                else if (err instanceof Error && err.message.startsWith("timeout:")) timedOut = true;
            }

            output.finish();
            const snapshot = output.snapshot({ persistIfTruncated: true });
            const answer0 = formatOutput(snapshot, output.getLastLineBytes());
            await output.closeTempFile();

            let answer = answer0;
            if (execError && !aborted && !timedOut) {
                const message = execError instanceof Error ? execError.message : String(execError);
                answer = appendStatus(answer === "(no output)" ? "" : answer, `bash: ${message}`);
            } else if (aborted) {
                answer = appendStatus(answer, "Command aborted.");
            } else if (timedOut) {
                answer = appendStatus(answer, `Command timed out after ${String(timeout)} seconds. Retry with a larger timeout if the command is expected to take longer.`);
            } else if (exitCode !== 0) {
                answer = appendStatus(answer, `Command exited with code ${exitCode}.`);
            }

            // the structural signal — aborted is a control stop, not a tool failure
            const failed = !aborted && (!!execError || timedOut || (exitCode ?? 0) !== 0);

            return {
                answer,
                error: failed || undefined,
                stored: {
                    exitCode: aborted || timedOut ? undefined : exitCode,
                    timedOut,
                    aborted,
                    truncated: snapshot.truncation.truncated,
                    fullOutputPath: snapshot.fullOutputPath,
                    cwd: final.cwd,
                    ...(description !== undefined && typeof description === "string" ? { description } : {}),
                } satisfies BashToolResult,
            };
        },
    });
}

/** The default bash tool — shell resolved from SANITY_SHELL env or platform default. */
export const bashTool = createBashTool();

/**
 * bash as a Plugin — config at construction, batch in/out.
 * install: adds the configured bash tool; uninstall: removes it by name.
 */
export function createBashPlugin(options: BashToolOptions = {}): Plugin {
    return {
        id: "bash",
        install(agent) {
            agent.addTool(createBashTool(options));
            agent.addDeclaredCapability({ id: "bash", description: "shell execution" });
        },
        uninstall(agent) {
            agent.removeTool("bash");
            agent.removeDeclaredCapability("bash");
        },
    };
}
