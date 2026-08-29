// sanity/src/extras/tools/shell.ts — the execution core behind the bash tool.
//
// Ported from pi's shipped bash backend (packages/coding-agent/src/utils/shell.ts
// + utils/child-process.ts + createLocalBashOperations), with:
//   - Windows prefers PowerShell 7 (pwsh) when present, Git Bash next.
//   - Shell-type-aware args (codex's shell.rs): pwsh → `-NoProfile -Command`,
//     cmd → `/c`, bash/zsh/sh → `-c` (or `-lc` for a login shell).
//   - POSIX honors the user's $SHELL before /bin/bash.
//   - Graceful kill escalation (prime-agent's exec.ts): SIGTERM → grace →
//     hard kill-tree, so processes get to flush state before dying.
// Every shell is overridable — factory `shellPath` beats `SANITY_SHELL` env
// beats the platform default.
//
// No Sanity types here — pure Node. The bash tool wraps this in Tool.define.
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

// ---------------------------------------------------------------------------
// shell discovery
// ---------------------------------------------------------------------------

export interface ResolvedShell {
  shell: string;
  args: string[];
  /** stdin transport — legacy WSL bash.exe only understands stdin commands. */
  commandTransport?: "argv" | "stdin";
  /** True when the shell is PowerShell (the tool description adapts). */
  isPwsh: boolean;
  /** Human-readable name — e.g. "PowerShell (pwsh)", "Git Bash", "zsh". */
  label: string;
  /** What syntax to write — for the tool description, so nobody guesses. */
  syntax: string;
}

type ShellKind = "pwsh" | "cmd" | "bash" | "zsh" | "sh" | "other";

function classifyShell(path: string): ShellKind {
  const base = basename(path).toLowerCase();
  if (base === "pwsh" || base === "pwsh.exe" || base === "powershell" || base === "powershell.exe") return "pwsh";
  if (base === "cmd" || base === "cmd.exe") return "cmd";
  if (base === "bash" || base === "bash.exe") return "bash";
  if (base === "zsh" || base === "zsh.exe") return "zsh";
  if (base === "sh" || base === "sh.exe") return "sh";
  return "other";
}

function isLegacyWslBashPath(p: string): boolean {
  const normalized = p.replace(/\//g, "\\").toLowerCase();
  return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function isPwshKind(kind: ShellKind): boolean {
  return kind === "pwsh";
}

/** Shell-type-aware args (codex's shell.rs semantics). */
function argsFor(kind: ShellKind, loginShell: boolean): string[] {
  switch (kind) {
    case "pwsh":
      // -NoProfile: no profile noise; -Command takes the command as the last arg.
      return ["-NoProfile", "-Command"];
    case "cmd":
      return ["/c"];
    case "bash":
    case "zsh":
    case "sh":
    default:
      return [loginShell ? "-lc" : "-c"];
  }
}

function isGitForWindowsBash(path: string): boolean {
  return /\\Git\\bin\\bash\.exe$/i.test(path.replace(/\//g, "\\"));
}

function shellLabel(kind: ShellKind, path: string): string {
  switch (kind) {
    case "pwsh":
      return "PowerShell (pwsh)";
    case "cmd":
      return "cmd.exe";
    case "bash":
      return isGitForWindowsBash(path) ? "Git Bash" : "bash";
    case "zsh":
      return "zsh";
    case "sh":
      return "sh";
    default:
      return basename(path).replace(/\.exe$/i, "") || path;
  }
}

function syntaxHint(kind: ShellKind): string {
  switch (kind) {
    case "pwsh":
      return "PowerShell syntax (Get-ChildItem, Select-String, Get-Content, Set-Content, pipes with |, etc.)";
    case "cmd":
      return "cmd.exe syntax (dir, findstr, type, set, etc.)";
    case "bash":
    case "zsh":
    case "sh":
      return "POSIX shell syntax (ls, grep, find, sed, awk, pipes, etc.)";
    default:
      return "the shell's native syntax";
  }
}

function toShellConfig(shell: string, loginShell: boolean): ResolvedShell {
  // legacy WSL bash.exe only understands stdin commands — override the args
  if (isLegacyWslBashPath(shell)) {
    return { shell, args: ["-s"], commandTransport: "stdin", isPwsh: false, label: "WSL bash", syntax: "bash syntax" };
  }
  const kind = classifyShell(shell);
  return {
    shell,
    args: argsFor(kind, loginShell),
    isPwsh: isPwshKind(kind),
    label: shellLabel(kind, shell),
    syntax: syntaxHint(kind),
  };
}

/** `where.exe pwsh` / `which pwsh` — synchronous, 5s cap, first existing hit. */
function findOnPath(command: string): string | null {
  const probe = process.platform === "win32" ? "where.exe" : "which";
  try {
    const result = spawnSync(probe, [command], { encoding: "utf8", timeout: 5000, windowsHide: true });
    if (result.status === 0 && result.stdout) {
      const first = String(result.stdout).trim().split(/\r?\n/)[0];
      if (first && existsSync(first)) return first;
    }
  } catch {
    // probe not available — fall through
  }
  return null;
}

/**
 * Verify a pwsh candidate actually runs and reports PS 7.
 * WindowsApps store stubs exist on PATH but aren't real — skip them by
 * checking the version, not just the file. (Same trick as the pi custom-bash
 * extension.)
 */
function isAccessiblePwsh7(p: string): boolean {
  try {
    const result = spawnSync(
      p,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"],
      { encoding: "utf8", timeout: 8000, windowsHide: true },
    );
    return String(result.stdout ?? "").trim() === "7";
  } catch {
    return false;
  }
}

function findPwsh7(): string | null {
  const candidates: string[] = [];
  for (const pf of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
    if (pf) candidates.push(`${pf}\\PowerShell\\7\\pwsh.exe`);
  }
  candidates.push("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  for (const p of candidates) {
    if (existsSync(p) && isAccessiblePwsh7(p)) return p;
  }
  const onPath = findOnPath("pwsh");
  if (onPath) return onPath;
  return null;
}

/**
 * GNU coreutils on Windows (the WinGet package installs to
 * `Program Files\coreutils\bin`). The bash tool launches pwsh with
 * `-NoProfile`, which skips profile-added PATH entries — so the model's
 * POSIX-ish commands (`grep`, `sed`, `cut`, `sort`, ...) may not resolve
 * even when they work in the user's interactive shell. Detected here and
 * prepended to the shell PATH by the tool.
 */
export function findCoreutilsBin(): string | null {
  if (process.platform !== "win32") return null;
  const candidates: string[] = [];
  if (process.env.ProgramFiles) candidates.push(`${process.env.ProgramFiles}\\coreutils\\bin`);
  if (process.env["ProgramFiles(x86)"]) candidates.push(`${process.env["ProgramFiles(x86)"]}\\coreutils\\bin`);
  for (const dir of candidates) {
    if (existsSync(join(dir, "ls.exe")) || existsSync(join(dir, "coreutils.exe"))) return dir;
  }
  return null;
}

/**
 * Resolve the shell for the tool.
 * Order: explicit shellPath > SANITY_SHELL env > platform default.
 * Windows default: pwsh7 (verified) > Git Bash (known locations) > bash on PATH.
 * POSIX default: $SHELL > /bin/bash > bash on PATH > sh.
 * Throws with a helpful message when nothing is found — fail fast at factory
 * time, not on the model's first tool call.
 */
export function resolveShellConfig(shellPath?: string, loginShell = false): ResolvedShell {
  const explicit = shellPath ?? process.env.SANITY_SHELL;
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`Custom shell path not found: ${explicit} — check the path, or set SANITY_SHELL / pass shellPath to createBashTool().`);
    }
    return toShellConfig(explicit, loginShell);
  }

  if (process.platform === "win32") {
    const pwsh = findPwsh7();
    if (pwsh) return toShellConfig(pwsh, false);

    const candidates: string[] = [];
    if (process.env.ProgramFiles) candidates.push(`${process.env.ProgramFiles}\\Git\\bin\\bash.exe`);
    if (process.env["ProgramFiles(x86)"]) candidates.push(`${process.env["ProgramFiles(x86)"]}\\Git\\bin\\bash.exe`);
    for (const p of candidates) {
      if (existsSync(p)) return toShellConfig(p, loginShell);
    }
    const bashOnPath = findOnPath("bash.exe");
    if (bashOnPath) return toShellConfig(bashOnPath, loginShell);

    throw new Error(
      "No shell found. Options:\n" +
        "  1. Install PowerShell 7: https://github.com/PowerShell/PowerShell/releases\n" +
        "  2. Install Git for Windows: https://git-scm.com/download/win\n" +
        "  3. Add bash/pwsh to PATH\n" +
        `  4. Pass shellPath to createBashTool() (searched: ${candidates.join(", ")})`,
    );
  }

  if (process.env.SHELL && existsSync(process.env.SHELL)) return toShellConfig(process.env.SHELL, loginShell);
  if (existsSync("/bin/bash")) return toShellConfig("/bin/bash", loginShell);
  const bashOnPath = findOnPath("bash");
  if (bashOnPath) return toShellConfig(bashOnPath, loginShell);
  return toShellConfig("sh", loginShell);
}

// ---------------------------------------------------------------------------
// process-tree kill (pi's killProcessTree) + graceful escalation (prime-agent)
// ---------------------------------------------------------------------------

export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", detached: true, windowsHide: true });
    } catch {
      // already dead
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already dead
    }
  }
}

const GRACE_KILL_MS = 3000;

/**
 * Graceful kill escalation (prime-agent's exec.ts pattern):
 * SIGTERM the process group first so the process can flush state, then hard
 * kill-tree after the grace window IF it's still alive. Windows has no reliable
 * graceful signal path (Node's SIGTERM = TerminateProcess), so Windows goes
 * straight to the hard tree-kill.
 */
function terminateGracefully(child: ChildProcess, hardKillAfterMs = GRACE_KILL_MS): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    killProcessTree(pid);
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return; // already dead
    }
  }
  const timer = setTimeout(() => {
    // exited cleanly (or by our SIGTERM) → no hard kill needed
    if (child.exitCode === null && child.signalCode === null) {
      killProcessTree(pid);
    }
  }, hardKillAfterMs);
  timer.unref();
}

// ---------------------------------------------------------------------------
// wait (pi's child-process.ts — the grace timer that never hangs)
// ---------------------------------------------------------------------------

const EXIT_STDIO_GRACE_MS = 100;

/**
 * Wait for a child process to terminate without hanging on inherited stdio
 * handles. A short-lived child can `exit` while a detached descendant keeps
 * its stdout/stderr pipe open. We must not resolve on a fixed deadline measured
 * from `exit`, or output written past that deadline is silently lost. Instead,
 * after `exit` we wait for the pipes to fall idle: the grace timer re-arms on
 * every chunk, so an actively-writing descendant keeps us reading, while a
 * quiet inherited handle (e.g. a daemonized descendant that never lets `close`
 * fire) still releases us after the grace elapses.
 */
export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let postExitTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = (): void => {
      if (postExitTimer) {
        clearTimeout(postExitTimer);
        postExitTimer = undefined;
      }
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };

    const finalize = (code: number | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };

    const maybeFinalizeAfterExit = (): void => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) finalize(exitCode);
    };

    const armIdleTimer = (): void => {
      if (postExitTimer) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
    };

    const onData = (): void => {
      // output still arriving after exit — defer finalizing so we don't
      // destroy the stream mid-write and truncate the tail
      if (exited && !settled) armIdleTimer();
    };

    const onStdoutEnd = (): void => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };

    const onStderrEnd = (): void => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };

    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onExit = (code: number | null): void => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) armIdleTimer();
    };

    const onClose = (code: number | null): void => {
      finalize(code);
    };

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

// ---------------------------------------------------------------------------
// sanitize (pi's sanitizeBinaryOutput)
// ---------------------------------------------------------------------------

/**
 * Strip output that wrecks model context or display:
 * control chars (except tab/newline/cr), Unicode Format chars, lone surrogates,
 * undefined code points.
 */
export function sanitizeBinaryOutput(str: string): string {
  return Array.from(str)
    .filter((char) => {
      const code = char.codePointAt(0);
      if (code === undefined) return false;
      if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
      if (code <= 0x1f) return false;
      if (code >= 0xfff9 && code <= 0xfffb) return false;
      return true;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// execute (pi's createLocalBashOperations)
// ---------------------------------------------------------------------------

export interface ShellExecOptions {
  cwd: string;
  /** Each stdout/stderr chunk (Buffer) — the tool feeds this to its accumulator. */
  onData: (data: Buffer) => void;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  shell: ResolvedShell;
}

export interface ShellExecResult {
  exitCode: number | null;
  timedOut: boolean;
}

export class ShellError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ShellError";
    this.code = code;
  }
}

/**
 * Spawn the shell, stream stdout+stderr into onData, kill the process TREE on
 * timeout or abort. Throws `timeout:<ms>` / `aborted` / cwd errors — the tool
 * formats them into the answer.
 */
export async function executeLocalShell(command: string, options: ShellExecOptions): Promise<ShellExecResult> {
  if (options.abortSignal?.aborted) throw new Error("aborted");
  if (!existsSync(options.cwd)) {
    throw new ShellError("cwd_missing", `Working directory does not exist: ${options.cwd}`);
  }

  const shellConfig = options.shell;
  const commandFromStdin = shellConfig.commandTransport === "stdin";
  const child = spawn(
    shellConfig.shell,
    commandFromStdin ? shellConfig.args : [...shellConfig.args, command],
    {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.env ?? process.env,
      stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  if (commandFromStdin) {
    child.stdin?.on("error", () => {});
    child.stdin?.end(command);
  }

  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | undefined;
  const onAbort = (): void => terminateGracefully(child);

  try {
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        terminateGracefully(child);
      }, options.timeoutMs);
    }
    child.stdout?.on("data", (data: Buffer) => options.onData(data));
    child.stderr?.on("data", (data: Buffer) => options.onData(data));
    if (options.abortSignal) {
      if (options.abortSignal.aborted) onAbort();
      else options.abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    const exitCode = await waitForChildProcess(child);
    if (options.abortSignal?.aborted) throw new Error("aborted");
    if (timedOut) throw new Error(`timeout:${options.timeoutMs}`);
    return { exitCode, timedOut: false };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    options.abortSignal?.removeEventListener("abort", onAbort);
  }
}
