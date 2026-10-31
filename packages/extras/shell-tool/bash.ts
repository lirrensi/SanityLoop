// sanity/src/extras/tools/bash.ts — THE bash tool.
//
// A configurable factory: the shell, the default cwd, a command prefix, and a
// spawn hook (command/cwd/env rewriting) are all locked at construction. The
// model calls it with:
//   command     — the shell command string
//   workdir     — where to run it (MSYS `/c/...`, `~`, absolute, or relative)
//   timeout     — seconds, OPTIONAL, no default (commands run to completion);
//                 with background enabled: the WHOLE-RUN deadline, `0` disables
//   description — why it's being run (logged + visible to permission filters)
//   background  — WITH background ENABLED ONLY: true = return bg_N immediately
//
// BACKGROUND (optional, off unless the plugin enables it): explicit
// `background: true` returns a job id immediately; auto-background promotes a
// still-running foreground call after the threshold (stolen from OMP's
// auto-background). Settled jobs deliver via input_followup → a plain user
// message → a new turn. Companions: jobs/job_read/job_kill/job_wait.
// Manager lives in the plugin closure (one per agent); jobs are
// process-lifetime — a crash loses them, restore does not resurrect them.
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
import { Tool, type GodObject, type Plugin, type ToolResult } from "@sanityloop/core";
import { startLocalShell, findCoreutilsBin, resolveShellConfig, type ResolvedShell, type RunningShell } from "./shell.ts";
import { OutputAccumulator, type OutputSnapshot } from "./output-accumulator.ts";
import { JobManager, type Job, type JobSnapshot } from "./job-manager.ts";
import { formatSize } from "@sanityloop/util";
import { InputTypes } from "@sanityloop/inputs";

// ---------------------------------------------------------------------------
// factory options
// ---------------------------------------------------------------------------

export interface BashSpawnContext {
    command: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

export interface BashBackgroundOptions {
  /** Foreground-wait ms before a still-running call auto-backgrounds. Default 60000 (OMP's threshold). */
  autoThresholdMs?: number;
  /** Running-job cap. Default 15. */
  maxJobs?: number;
  /** Settled-row retention ms. Default 5 min. */
  retentionMs?: number;
}

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

  // ---- background (plugin-only: createBashTool IGNORES this — no manager there) ----
  /** Enable background execution (explicit `background: true` + auto-background).
   * ONLY honored by createBashPlugin (the manager lives in the plugin closure).
   * Implies `requires: ["inputs"]` — delivery rides input_followup. */
  background?: BashBackgroundOptions;
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
/** The plugin's live handle — what the template captures for quit-on-end wiring. */
export interface BashPluginView {
  /** True while any background job is running. */
  hasRunningJobs: () => boolean;
  /** Visible job snapshots (running first). JSON-safe. */
  listJobs: () => JobSnapshot[];
}

// ---------------------------------------------------------------------------
// run shapes — one runner, three doors (foreground / explicit bg / auto bg)
// ---------------------------------------------------------------------------

/** Everything a run needs beyond the raw params — resolved once per call. */
interface PreparedRun {
  final: BashSpawnContext;
  output: OutputAccumulator;
  timeoutMs: number | undefined;
  timeoutSec: number | undefined;
  shell: ResolvedShell;
}

/** The settled facts — what formatting + delivery both consume. */
interface RunFacts {
  answer: string;
  failed: boolean;
  timedOut: boolean;
  aborted: boolean;
  exitCode: number | undefined;
  truncated: boolean;
  fullOutputPath: string | undefined;
}

function collectFacts(
  output: OutputAccumulator,
  verdict: { timedOut: boolean; aborted: boolean; exitCode: number | undefined; execError: unknown },
  hardTimeoutSec: number | undefined,
): RunFacts {
  output.finish();
  const snapshot = output.snapshot({ persistIfTruncated: true });
  const answer0 = formatOutput(snapshot, output.getLastLineBytes());
  let answer = answer0;
  if (verdict.execError && !verdict.aborted && !verdict.timedOut) {
    const message = verdict.execError instanceof Error ? verdict.execError.message : String(verdict.execError);
    answer = appendStatus(answer === "(no output)" ? "" : answer, `bash: ${message}`);
  } else if (verdict.aborted) {
    answer = appendStatus(answer, "Command aborted.");
  } else if (verdict.timedOut) {
    answer = appendStatus(
      answer,
      `Command timed out after ${String(hardTimeoutSec)} seconds. Retry with a larger hardTimeout if the command is expected to take longer.`,
    );
  } else if (verdict.exitCode !== 0) {
    answer = appendStatus(answer, `Command exited with code ${verdict.exitCode}.`);
  }
  return {
    answer,
    failed: !verdict.aborted && (!!verdict.execError || verdict.timedOut || (verdict.exitCode ?? 0) !== 0),
    timedOut: verdict.timedOut,
    aborted: verdict.aborted,
    exitCode: verdict.aborted || verdict.timedOut ? undefined : verdict.exitCode,
    truncated: snapshot.truncation.truncated,
    fullOutputPath: snapshot.fullOutputPath,
  };
}

function resultFromFacts(facts: RunFacts, final: BashSpawnContext, description: unknown): ToolResult {
  return {
    answer: facts.answer,
    error: facts.failed || undefined,
    stored: {
      exitCode: facts.exitCode,
      timedOut: facts.timedOut,
      aborted: facts.aborted,
      truncated: facts.truncated,
      fullOutputPath: facts.fullOutputPath,
      cwd: final.cwd,
      ...(description !== undefined && typeof description === "string" ? { description } : {}),
    } satisfies BashToolResult,
  };
}

// ---------------------------------------------------------------------------
// background — the race, the notice, the delivery (OMP-shaped, SanityLoop-fit)
// ---------------------------------------------------------------------------

const DEFAULT_AUTO_THRESHOLD_MS = 60_000;

/** Soft timeout default: none — `timeout` only takes effect when the caller sets it. */
const DEFAULT_HARD_TIMEOUT_MS: number | undefined = undefined;

/**
 * Foreground-wait budget: the auto-background threshold. The soft timeout runs
 * as its own racer (not a cap on this budget): whichever fires first decides
 * what the call returns — "still running" on soft expiry, background notice on
 * threshold. `0` = background immediately. (OMP's resolveAutoBackgroundWaitMs,
 * minus the old timeout-minus-buffer cap that made no sense once timeouts stop killing.)
 */
function resolveAutoBackgroundWaitMs(thresholdMs: number): number {
  if (thresholdMs <= 0) return 0;
  return thresholdMs;
}

type RaceOutcome =
  | { kind: "settled" }
  | { kind: "threshold" }
  | { kind: "aborted" }
  | { kind: "softTimeout" };

/**
 * Race a job's settlement against the auto-background threshold, the SOFT
 * timeout, and the abort signal. The soft timeout NEVER kills — the winner
 * just tells the caller to return "still running" while the job keeps going
 * in the manager. (OMP's raceJobSettlement minus the steering leg — v1 has no
 * peer messaging to yield to.) Timer is cleared on every path — never a leak.
 */
function raceJobSettlement(
  completion: Promise<unknown>,
  waitMs: number,
  softTimeoutMs: number | undefined,
  signal?: AbortSignal,
): Promise<RaceOutcome> {
  if (signal?.aborted) return Promise.resolve({ kind: "aborted" });
  if (softTimeoutMs !== undefined && softTimeoutMs <= 0) return Promise.resolve({ kind: "threshold" });
  if (waitMs <= 0) return Promise.resolve({ kind: "threshold" });
  // no Promise.withResolvers — target is ES2022; executor form is the fit here
  let resolve!: (v: RaceOutcome) => void;
  const promise = new Promise<RaceOutcome>((res) => { resolve = res; });
  const timer = setTimeout(() => resolve({ kind: "threshold" }), waitMs);
  const softTimer =
    softTimeoutMs === undefined ? undefined : setTimeout(() => resolve({ kind: "softTimeout" }), softTimeoutMs);
  const onAbort = (): void => resolve({ kind: "aborted" });
  signal?.addEventListener("abort", onAbort, { once: true });
  void completion.then(
    () => resolve({ kind: "settled" }),
    () => resolve({ kind: "settled" }),
  );
  void promise.finally(() => {
    clearTimeout(timer);
    clearTimeout(softTimer);
    signal?.removeEventListener("abort", onAbort);
  });
  return promise;
}

function formatStillRunningNotice(jobId: string, elapsedSec: number, timeoutSec: number, outputTail: string): string {
  const tail = outputTail && outputTail !== "(no output)" ? `\n\nOutput so far:\n${outputTail}` : "";
  return (
    `Still running as job ${jobId} after ${elapsedSec}s (soft timeout: ${timeoutSec}s) — the command was NOT killed and keeps running. ` +
    `Use \`job_read\` to poll, \`job_send\`/\`job_key\` to write to its stdin, \`job_wait\` to block, or \`job_kill\` to stop it.${tail}`
  );
}

function formatBackgroundNotice(jobId: string, timeoutSec: number | undefined, hardTimeoutSec: number | undefined): string {
  const soft = timeoutSec === undefined ? "(no soft deadline)" : `(soft timeout: still running after ${timeoutSec}s; \`timeout: 0\` disables it)`;
  const hard =
    hardTimeoutSec === undefined
      ? "(no hard deadline — runs until it exits or is killed)"
      : `(hard kill after ${hardTimeoutSec}s in total)`;
  return (
    `Backgrounded as job ${jobId} ${soft} ${hard}; its output arrives as a new message the moment it finishes. ` +
    `Do NOT poll for it (no \`sleep\`, \`ps\`, \`jobs\` loops): every poll is a wasted turn. ` +
    `Do other work, \`job_wait\` if blocked, or end your reply and wait to be woken.`
  );
}

function formatDelivery(job: Job, command: string): string {
  const secs = job.endTime !== undefined ? Math.max(0, Math.round((job.endTime - job.startTime) / 1000)) : 0;
  const head =
    job.status === "completed"
      ? `completed in ${secs}s`
      : job.timedOut
        ? `TIMED OUT after ${secs}s`
        : `FAILED (exit ${job.exitCode ?? "?"}) in ${secs}s`;
  const short = command.length > 120 ? `${command.slice(0, 117)}...` : command;
  const lines = [`[Background job ${job.id} ${head} — \`${short}\`]`, ""];
  if (job.resultText) lines.push(job.resultText);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// companion tools — jobs / job_read / job_kill / job_wait (background only)
// ---------------------------------------------------------------------------

type ManagerOf = () => JobManager | null;

function jobLine(m: JobManager, job: Job): string {
  const dur =
    job.endTime !== undefined
      ? `in ${Math.max(0, Math.round((job.endTime - job.startTime) / 1000))}s`
      : `up ${Math.max(0, Math.round((Date.now() - job.startTime) / 1000))}s`;
  const short = job.label.length > 80 ? `${job.label.slice(0, 77)}...` : job.label;
  return `${job.id} [bash] ${job.status} ${dur} — ${short.replace(/\s+/g, " ")}`;
}

function createJobTools(getManager: ManagerOf) {
  const need = (): JobManager | null => getManager();
  const missing = { answer: "jobs: background is not enabled on this agent", error: true as const, errorMessage: "background disabled" };

  const jobs = Tool.define({
    name: "jobs",
    description: "List background bash jobs (running first, then recent settled).",
    promptSnippet: "List background jobs",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      const m = need();
      if (!m) return missing;
      const list = m.list();
      return { answer: list.length === 0 ? "No background jobs." : list.map((j) => jobLine(m, j)).join("\n") };
    },
  });

  const jobRead = Tool.define({
    name: "job_read",
    description: "Inspect one background job: status + live output tail. Never consumes delivery.",
    promptSnippet: "Inspect a background job",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Job id (bg_N)" } },
      required: ["id"],
    },
    async execute(params) {
      const m = need();
      if (!m) return missing;
      const { id } = params as { id?: unknown };
      if (typeof id !== "string") return { answer: "job_read: `id` is required", error: true, errorMessage: "id required" };
      const job = m.get(id);
      if (!job) return { answer: `job_read: no such job: ${id}`, error: true, errorMessage: "no such job" };
      const lines = [jobLine(m, job)];
      if (job.status === "running" && job.input) {
        const tail = job.input.tail();
        lines.push("", tail && tail !== "(no output)" ? tail : "(still running — no output yet)");
      } else if (job.resultText) lines.push("", job.resultText);
      else if (job.status === "running") lines.push("", "(still running — no output yet)");
      return { answer: lines.join("\n") };
    },
  });

  const jobSend = Tool.define({
    name: "job_send",
    description:
      "Send text to a running background job's stdin (answer an interactive prompt). " +
      "No trailing newline is added — include `\\n` (or use job_key ENTER) to submit a line.",
    promptSnippet: "Send input to a background job",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Job id (bg_N)" },
        text: { type: "string", description: "Text to write to the job's stdin" },
      },
      required: ["id", "text"],
    },
    async execute(params) {
      const m = need();
      if (!m) return missing;
      const { id, text } = params as { id?: unknown; text?: unknown };
      if (typeof id !== "string") return { answer: "job_send: `id` is required", error: true, errorMessage: "id required" };
      if (typeof text !== "string") return { answer: "job_send: `text` is required", error: true, errorMessage: "text required" };
      const job = m.get(id);
      if (!job) return { answer: `job_send: no such job: ${id}`, error: true, errorMessage: "no such job" };
      if (job.status !== "running" || !job.input) return { answer: `job_send: ${id} already ${job.status} — input goes nowhere`, error: true, errorMessage: "job settled" };
      const ok = job.input.write(text);
      if (!ok) return { answer: `job_send: ${id} stdin is closed — the process is not reading input`, error: true, errorMessage: "stdin closed" };
      return { answer: `Sent ${text.length} chars to ${id}.` };
    },
  });

  const jobKey = Tool.define({
    name: "job_key",
    description:
      "Send a special key to a running background job's stdin: ENTER, TAB, ESC, UP, DOWN, LEFT, RIGHT, CTRL_C (interrupts the job), CTRL_D (EOF), or raw text via job_send.",
    promptSnippet: "Send a key to a background job",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Job id (bg_N)" },
        key: {
          type: "string",
          description: "Key name: ENTER, TAB, ESC, UP, DOWN, LEFT, RIGHT, CTRL_C, CTRL_D",
        },
      },
      required: ["id", "key"],
    },
    async execute(params) {
      const m = need();
      if (!m) return missing;
      const { id, key } = params as { id?: unknown; key?: unknown };
      if (typeof id !== "string") return { answer: "job_key: `id` is required", error: true, errorMessage: "id required" };
      if (typeof key !== "string") return { answer: "job_key: `key` is required (ENTER, TAB, ESC, UP, DOWN, LEFT, RIGHT, CTRL_C, CTRL_D)", error: true, errorMessage: "key required" };
      const job = m.get(id);
      if (!job) return { answer: `job_key: no such job: ${id}`, error: true, errorMessage: "no such job" };
      if (job.status !== "running" || !job.input) return { answer: `job_key: ${id} already ${job.status} — input goes nowhere`, error: true, errorMessage: "job settled" };
      const name = key.trim().toUpperCase();
      if (name === "CTRL_C" || name === "C-C" || name === "SIGINT") {
        job.input.interrupt();
        return { answer: `Sent Ctrl-C to ${id}.` };
      }
      const seq: Record<string, string> = {
        ENTER: "\n",
        TAB: "\t",
        ESC: "\x1b",
        UP: "\x1b[A",
        DOWN: "\x1b[B",
        RIGHT: "\x1b[C",
        LEFT: "\x1b[D",
        CTRL_D: "\x04",
      };
      const bytes = seq[name];
      if (bytes === undefined) {
        return { answer: `job_key: unknown key '${key}' — want ENTER, TAB, ESC, UP, DOWN, LEFT, RIGHT, CTRL_C, CTRL_D`, error: true, errorMessage: "unknown key" };
      }
      if (name === "CTRL_D") job.input.end();
      else {
        const ok = job.input.write(bytes);
        if (!ok) return { answer: `job_key: ${id} stdin is closed — the process is not reading input`, error: true, errorMessage: "stdin closed" };
      }
      return { answer: `Sent ${name} to ${id}.` };
    },
  });

  const jobKill = Tool.define({
    name: "job_kill",
    description: "Kill a running background job (process tree). Killed jobs never deliver.",
    promptSnippet: "Kill a background job",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Job id (bg_N)" } },
      required: ["id"],
    },
    async execute(params) {
      const m = need();
      if (!m) return missing;
      const { id } = params as { id?: unknown };
      if (typeof id !== "string") return { answer: "job_kill: `id` is required", error: true, errorMessage: "id required" };
      const job = m.get(id);
      if (!job) return { answer: `job_kill: no such job: ${id}`, error: true, errorMessage: "no such job" };
      if (job.status !== "running") return { answer: `job_kill: ${id} already ${job.status}` };
      m.cancel(id);
      return { answer: `Killed ${id}.` };
    },
  });

  const jobWait = Tool.define({
    name: "job_wait",
    description:
      "Block until at least one running background job settles (or the cap elapses). " +
      "Returns settled snapshots. Only call when truly blocked — completions deliver automatically.",
    promptSnippet: "Wait for background jobs",
    inputSchema: {
      type: "object",
      properties: {
        timeout: { type: "number", description: "Max seconds to wait. Default 300." },
      },
    },
    async execute(params, agent) {
      const m = need();
      if (!m) return missing;
      const { timeout } = params as { timeout?: unknown };
      const capMs =
        typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
          ? Math.round(timeout * 1000)
          : 300_000;
      const running = m.list().filter((j) => j.status === "running");
      if (running.length === 0) {
        const recent = m.list().slice(0, 5);
        return {
          answer: recent.length === 0 ? "Nothing to wait for: no background jobs." : recent.map((j) => jobLine(m, j)).join("\n"),
        };
      }
      // poll the MANAGER (process truth), not the model — bounded, abort-aware
      const deadline = Date.now() + capMs;
      const ids = new Set(running.map((j) => j.id));
      for (;;) {
        if (agent.abortSignal?.aborted) return { answer: "Wait aborted.", error: true, errorMessage: "aborted" };
        const settledNow = [...ids].map((id) => m.get(id)).filter((j) => j && j.status !== "running");
        if (settledNow.length > 0) {
          return { answer: settledNow.map((j) => jobLine(m, j!)).join("\n") };
        }
        if (Date.now() >= deadline) {
          const still = [...ids].map((id) => m.get(id)).filter((j) => j && j.status === "running");
          return { answer: `Wait timed out. Still running:\n${still.map((j) => jobLine(m, j!)).join("\n")}` };
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    },
  });

  return [jobs, jobRead, jobKill, jobWait, jobSend, jobKey];
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
    // background is PLUGIN-only: the manager lives in the plugin closure and
    // delivery needs the installed agent. A bare tool ignores the option —
    // silently, deliberately: the schema simply lacks `background`.
    const background = options.background;

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
            (background
                ? "`timeout` is the SOFT deadline (seconds): at expiry the call returns “still running” with a job id and the job keeps going — poll with `job_read`, write with `job_send`/`job_key`, block with `job_wait`, kill with `job_kill`. `0` disables it. `hardTimeout` is the HARD kill deadline (seconds, off unless set) — the process tree dies when it fires. `background: true` returns a job id immediately; slow calls auto-background and deliver on completion. "
                : "`timeout` is the soft deadline (seconds) — at expiry the call returns “still running” text instead of killing the run; `hardTimeout` kills. No defaults — commands run to completion unless set. ") +
            "`description` should say WHY the command is being run (it is logged and shown for approval).",
        promptSnippet: `Execute a ${shell.label} command`,
        promptGuidelines: [
            "Prefer read/edit/write over shell for file inspection and changes.",
            "Always include a `description` explaining why the command is run.",
            "One command per call — keep the command narrow; don't chain reads and writes that could race other tools.",
            ...(background
                ? [
                    "Long commands: pass `background: true` and keep working — the result arrives as a new message.",
                    "NEVER poll a background job with sleep loops; `job_wait` if truly blocked.",
                ]
                : ["Set `timeout` for commands that might hang (servers, watchers, network calls)."]),
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
                    description: background
                        ? "Soft deadline in seconds: at expiry return “still running” + job id, keep the job alive. Optional; `0` disables it."
                        : "Soft deadline in seconds: at expiry return “still running” instead of killing. Optional — no default.",
                },
                hardTimeout: {
                    type: "number",
                    description: "Hard kill deadline in seconds: the process tree dies when it fires. Optional — off unless set.",
                },
                ...(background
                    ? {
                        background: {
                            type: "boolean",
                            description: "true = return a job id immediately; the result arrives as a new message.",
                        },
                    }
                    : {}),
            },
            required: ["command"],
        },
        async execute(params, agent) {
            const { command, workdir, timeout, hardTimeout, description, background: bgParam } = params as {
                command?: unknown;
                workdir?: unknown;
                timeout?: unknown;
                hardTimeout?: unknown;
                description?: unknown;
                background?: unknown;
            };

            if (typeof command !== "string" || command.trim().length === 0) {
                return { answer: "bash: `command` is required and must be a string", error: true, errorMessage: "command required" };
            }
            const timeoutSec = timeout === undefined ? undefined : timeout;
            const hardTimeoutSec = hardTimeout === undefined ? undefined : hardTimeout;
            if (background) {
                if (timeoutSec !== undefined && (typeof timeoutSec !== "number" || !Number.isFinite(timeoutSec) || timeoutSec < 0)) {
                    return { answer: `bash: invalid timeout '${String(timeout)}' — must be 0 (no deadline) or a positive number of seconds`, error: true, errorMessage: "invalid timeout" };
                }
                if (hardTimeoutSec !== undefined && (typeof hardTimeoutSec !== "number" || !Number.isFinite(hardTimeoutSec) || hardTimeoutSec <= 0)) {
                    return { answer: `bash: invalid hardTimeout '${String(hardTimeout)}' — must be a positive number of seconds`, error: true, errorMessage: "invalid hardTimeout" };
                }
            } else {
                if (timeoutSec !== undefined && (typeof timeoutSec !== "number" || !Number.isFinite(timeoutSec) || timeoutSec <= 0)) {
                    return { answer: `bash: invalid timeout '${String(timeout)}' — must be a positive number of seconds`, error: true, errorMessage: "invalid timeout" };
                }
                if (hardTimeoutSec !== undefined && (typeof hardTimeoutSec !== "number" || !Number.isFinite(hardTimeoutSec) || hardTimeoutSec <= 0)) {
                    return { answer: `bash: invalid hardTimeout '${String(hardTimeout)}' — must be a positive number of seconds`, error: true, errorMessage: "invalid hardTimeout" };
                }
            }
            // the manager arrives via install() — a bare tool never has one
            const manager = (agent.transient["bash.jobs"] as JobManager | undefined) ?? null;
            const bgEnabled = background !== undefined && manager !== null;
            const explicitBg = bgEnabled && bgParam === true;

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
            // SOFT timeout (tool-side race) vs HARD timeout (process kill, shell-side).
            // `timeout` never reaches the shell — at expiry we return "still running"
            // and the job keeps going. Only `hardTimeout` arms the kill timer.
            const softTimeoutMs =
                typeof timeoutSec === "number" && timeoutSec > 0 ? Math.round(timeoutSec * 1000) : undefined;
            const hardTimeoutMs =
                typeof hardTimeoutSec === "number" && hardTimeoutSec > 0
                    ? Math.round(hardTimeoutSec * 1000)
                    : DEFAULT_HARD_TIMEOUT_MS;

            const output = new OutputAccumulator({
                maxLines: options.maxLines,
                maxBytes: options.maxBytes,
                tempFilePrefix: options.tempFilePrefix,
            });
            /** Live output tail for job_read while the job still runs. */
            const liveTail = (): string => {
                try {
                    const snapshot = output.snapshot();
                    return formatOutput(snapshot, output.getLastLineBytes());
                } catch {
                    return "(no output)";
                }
            };
            /** Spawn now; the caller owns the completion (await inline or park in a job). */
            const spawn = (): RunningShell =>
                startLocalShell(final.command, {
                    cwd: final.cwd,
                    env: final.env,
                    timeoutMs: hardTimeoutMs,
                    abortSignal: agent.abortSignal,
                    shell,
                    onData: (data) => output.append(data),
                });
            /** Drain one completion into facts — shared by all three doors. */
            const drain = async (completion: Promise<{ exitCode: number | null }>): Promise<RunFacts> => {
                let timedOut = false;
                let aborted = false;
                let exitCode: number | undefined;
                let execError: unknown;
                try {
                    const result = await completion;
                    exitCode = result.exitCode ?? 0;
                } catch (err) {
                    execError = err;
                    if (agent.abortSignal?.aborted) aborted = true;
                    else if (err instanceof Error && err.message.startsWith("timeout:")) timedOut = true;
                }
                const facts = collectFacts(
                    output,
                    { timedOut, aborted, exitCode, execError },
                    typeof hardTimeoutSec === "number" ? hardTimeoutSec : undefined,
                );
                await output.closeTempFile();
                return facts;
            };
            const toResult = (facts: RunFacts): ToolResult => resultFromFacts(facts, final, description);

            /** Register a live run as a visible job — stdin + live tail wired. */
            const registerLive = (
                m: JobManager,
                running: RunningShell,
                completion: Promise<{ text: string; failed?: boolean; timedOut?: boolean; exitCode?: number; fullOutputPath?: string }>,
                foreground: boolean,
            ): string =>
                m.register(
                    {
                        completion,
                        cancel: () => running.cancel(),
                        pids: () => running.pids(),
                        label: command,
                        cwd: final.cwd,
                        input: {
                            get stdinOpen() {
                                return running.stdinOpen;
                            },
                            write: (text: string) => running.writeStdin(text),
                            end: () => running.endStdin(),
                            interrupt: () => running.interrupt(),
                            tail: liveTail,
                        },
                    },
                    { foreground },
                );
            const bgNotice = (id: string): string =>
                formatBackgroundNotice(
                    id,
                    typeof timeoutSec === "number" && timeoutSec > 0 ? timeoutSec : undefined,
                    typeof hardTimeoutSec === "number" && hardTimeoutSec > 0 ? hardTimeoutSec : undefined,
                );
            const toStored = (id: string): ToolResult => ({
                answer: "",
                stored: { jobId: id, cwd: final.cwd } satisfies { jobId: string; cwd: string } as unknown as BashToolResult,
            });
            /** Soft-timeout answer for a still-alive job: error-as-result, job keeps running. */
            const stillRunning = (id: string, startedAt: number): ToolResult => {
                const elapsedSec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
                const softSec = typeof timeoutSec === "number" && timeoutSec > 0 ? timeoutSec : elapsedSec;
                return {
                    answer: formatStillRunningNotice(id, elapsedSec, softSec, liveTail()),
                    stored: { jobId: id, cwd: final.cwd } satisfies { jobId: string; cwd: string } as unknown as BashToolResult,
                };
            };

            // ---- door 1: explicit background — spawn, register, return the id ----
            // Explicit bg ALWAYS returns immediately: the soft timeout only matters
            // for the auto/foreground race (door 2/3). The hard timeout (shell-side)
            // still kills the tree when it fires — that delivery says TIMED OUT.
            if (explicitBg && manager) {
                if (manager.atCapacity) {
                    return { answer: `bash: job queue is full — wait for a running job or kill one`, error: true, errorMessage: "at capacity" };
                }
                const running = spawn();
                const completion = drain(running.completion).then((facts) => ({
                    text: facts.answer,
                    failed: facts.failed,
                    timedOut: facts.timedOut,
                    exitCode: facts.exitCode,
                    fullOutputPath: facts.fullOutputPath,
                }));
                const id = registerLive(manager, running, completion, false);
                return { answer: bgNotice(id), stored: toStored(id).stored as unknown as BashToolResult };
            }

            // ---- door 2: auto-background — spawn, register hidden, race ----
            if (bgEnabled && manager && !manager.atCapacity) {
                const waitMs = resolveAutoBackgroundWaitMs(background!.autoThresholdMs ?? DEFAULT_AUTO_THRESHOLD_MS);
                const running = spawn();
                const startedAt = Date.now();
                const factsPromise = drain(running.completion);
                // register FIRST so a fast settle still lands on a row the race can read
                const settleBox: { facts?: RunFacts } = {};
                const completion = factsPromise.then((facts) => {
                    settleBox.facts = facts;
                    return {
                        text: facts.answer,
                        failed: facts.failed,
                        timedOut: facts.timedOut,
                        exitCode: facts.exitCode,
                        fullOutputPath: facts.fullOutputPath,
                    };
                });
                const id = registerLive(manager, running, completion, true);
                const race = await raceJobSettlement(factsPromise, waitMs, softTimeoutMs, agent.abortSignal);
                if (race.kind === "aborted") {
                    manager.cancel(id);
                    manager.releaseForegroundJob(id);
                    const facts = settleBox.facts ?? (await factsPromise.catch(() => null)) ?? {
                        answer: "Command aborted.", failed: false, timedOut: false, aborted: true,
                        exitCode: undefined, truncated: false, fullOutputPath: undefined,
                    };
                    return toResult({ ...facts, aborted: true });
                }
                if (race.kind === "settled" && settleBox.facts) {
                    manager.releaseForegroundJob(id);
                    return toResult(settleBox.facts);
                }
                // soft timeout OR threshold elapsed (or settled-but-facts-missing):
                // promote to a visible job and return — NEVER kill. Delivery owns it.
                manager.backgroundJob(id);
                if (race.kind === "softTimeout") return stillRunning(id, startedAt);
                return { answer: bgNotice(id), stored: toStored(id).stored as unknown as BashToolResult };
            }

            // ---- door 3: foreground — spawn, await, return ----
            // Foreground-with-timeout is SOFT when a manager can own the job past
            // this call (bg plugin installed): register hidden, promote on soft
            // expiry, keep alive — the SAME race as door 2 with no auto-threshold.
            // At capacity falls through here too — and a soft timeout at capacity
            // still promotes (capacity counts RUNNING jobs; this one already runs).
            if (softTimeoutMs !== undefined && bgEnabled && manager) {
                const running = spawn();
                const startedAt = Date.now();
                const factsPromise = drain(running.completion);
                const settleBox: { facts?: RunFacts } = {};
                const completion = factsPromise.then((facts) => {
                    settleBox.facts = facts;
                    return {
                        text: facts.answer,
                        failed: facts.failed,
                        timedOut: facts.timedOut,
                        exitCode: facts.exitCode,
                        fullOutputPath: facts.fullOutputPath,
                    };
                });
                const id = registerLive(manager, running, completion, true);
                const race = await raceJobSettlement(factsPromise, Number.POSITIVE_INFINITY, softTimeoutMs, agent.abortSignal);
                if (race.kind === "aborted") {
                    manager.cancel(id);
                    manager.releaseForegroundJob(id);
                    const facts = settleBox.facts ?? (await factsPromise.catch(() => null)) ?? {
                        answer: "Command aborted.", failed: false, timedOut: false, aborted: true,
                        exitCode: undefined, truncated: false, fullOutputPath: undefined,
                    };
                    return toResult({ ...facts, aborted: true });
                }
                if (race.kind === "settled" && settleBox.facts) {
                    manager.releaseForegroundJob(id);
                    return toResult(settleBox.facts);
                }
                manager.backgroundJob(id);
                return stillRunning(id, startedAt);
            }
            if (softTimeoutMs !== undefined && !bgEnabled) {
                // No manager (bare tool): nothing can own the job past this call,
                // so the soft deadline degrades to a bounded wait that still returns
                // "still running" TEXT — error-as-result — but the process is killed
                // on expiry since nobody could poll or feed it afterwards.
                const running = spawn();
                const startedAt = Date.now();
                const won = await Promise.race([
                    running.completion.then((): string => "settled").catch((): string => "settled"),
                    new Promise<string>((resolve) => setTimeout(() => resolve("soft"), softTimeoutMs)),
                ]);
                if (won === "soft") {
                    running.cancel();
                    await drain(running.completion).catch(() => null);
                    const softSec = typeof timeoutSec === "number" && timeoutSec > 0 ? timeoutSec : 0;
                    void startedAt;
                    return {
                        answer:
                            `Still running after ${softSec}s with no job manager to own it — the command was stopped. ` +
                            `Re-run with a larger timeout, or enable background so the job can keep running.`,
                    };
                }
                return toResult(await drain(running.completion));
            }
            const facts = await drain(spawn().completion);
            return toResult(facts);
        },
    });
}

/** The default bash tool — shell resolved from SANITY_SHELL env or platform default. */
export const bashTool = createBashTool();

/**
 * bash as a Plugin — config at construction, batch in/out.
 * install: adds the configured bash tool (+ companions when background is on);
 * uninstall: removes them, kills every running job.
 *
 * Returns the plugin PLUS the live view (`jobs.hasRunningJobs()` — what
 * quit-on-end's `canQuit` wires to). One plugin instance = one agent: the
 * manager is created in the factory (install stays sync, per the contract).
 */
export function createBashPlugin(options: BashToolOptions = {}): Plugin & { jobs: BashPluginView } {
    const bg = options.background;
    // created at install (sync — no async setup, so install-time construction
    // is fine): delivery + publish hooks need the installed agent.
    let manager: JobManager | null = null;
    let abortListener: (() => void) | null = null;

    const jobsView: BashPluginView = {
        hasRunningJobs: () => manager?.hasRunning() ?? false,
        listJobs: () => {
            const m = manager;
            return m ? m.list().map((j) => m.snapshot(j)) : [];
        },
    };

    return {
        id: "bash",
        ...(bg ? { requires: ["inputs"] } : {}),
        jobs: jobsView,
        install(agent) {
            if (bg) {
                manager = new JobManager({
                    maxJobs: bg.maxJobs,
                    retentionMs: bg.retentionMs,
                    onSettle: (job) => {
                        // deliver as followup → user message → new turn.
                        // NO backticksCommand — output passes through, never executes.
                        agent.input({ type: InputTypes.followup, text: formatDelivery(job, job.command || job.label) });
                    },
                    onChange: () => {
                        const m = manager;
                        if (!m) return;
                        agent.transient["bash.jobList"] = m.list().map((j) => m.snapshot(j));
                    },
                });
                // the bash tool + companions find the manager here (transient =
                // observed, NEVER taped to storage — handles must not persist)
                agent.transient["bash.jobs"] = manager;
                agent.transient["bash.jobList"] = [];
                // abort/fail/terminate kills every job — the SIGNAL, not the bus:
                // synchronous dispatch, no priority games, no filter ordering.
                // Kills never deliver (a kill is not a result).
                abortListener = () => manager?.cancelAll();
                agent.abortSignal.addEventListener("abort", abortListener);
                for (const tool of createJobTools(() => manager)) agent.addTool(tool);
                agent.addDeclaredCapability({ id: "bash.jobs", description: "background job inspection (jobs/job_read/job_kill/job_wait/job_send/job_key)" });
            }
            agent.addTool(createBashTool(options));
            agent.addDeclaredCapability({ id: "bash", description: "shell execution" });
        },
        uninstall(agent) {
            if (abortListener) agent.abortSignal.removeEventListener("abort", abortListener);
            abortListener = null;
            manager?.dispose();
            manager = null;
            delete agent.transient["bash.jobs"];
            delete agent.transient["bash.jobList"];
            agent.removeTool("bash");
            agent.removeTool("jobs");
            agent.removeTool("job_read");
            agent.removeTool("job_kill");
            agent.removeTool("job_wait");
            agent.removeTool("job_send");
            agent.removeTool("job_key");
            agent.removeDeclaredCapability("bash");
            agent.removeDeclaredCapability("bash.jobs");
        },
    };
}
