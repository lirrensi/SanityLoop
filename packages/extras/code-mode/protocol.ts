// ============================================================================
// packages/extras/code-mode/protocol.ts — the host↔kernel wire contract.
// ============================================================================
// Three pipes, one protocol each. Same frames for py and js runners so one
// host parser serves both.
//
//   fd 0  host→kernel  CONTROL  — one JSON object per line: exec | shutdown
//   fd 1  kernel→host  FRAMES   — one JSON object per line:
//                                  status | stdout | stderr | result | tool-call | done
//   fd 3  host→kernel  RETURNS  — one JSON object per line: return | cancel
//   fd 2  kernel→host  crash noise only (raw stderr, never protocol)
//
// Why the extra pipe: the kernel blocks inside a cell waiting for a tool
// result. If that response shared stdin with the next exec frame, host and
// kernel each block reading while the other writes — the classic two-pipe
// mutual deadlock. A third pipe + id-keyed futures makes the return path
// independent of cell state.
//
// Timeouts: the runner arms NO timers. The host is the only clock.
// Kills: POSIX SIGINT group → 5 s → SIGTERM group → 5 s → SIGKILL group.
//        Windows: taskkill /T /F (extra stdio fds are unsupported there;
//        fork()/IPC fallback is out of v1 scope — POSIX/WSL2 is the target).
// ============================================================================

/** The kernel language. "js" cells also accept TS (annotation-stripping). */
export type CodeLanguage = "py" | "js";

// ---- fd 0: control (host → kernel) -----------------------------------------

/** Run one cell. Single-flight per kernel: the host never sends a second
 * exec before the first settles with `done`. */
export interface ExecControl {
    v: 1;
    t: "exec";
    /** Request id — every frame for this cell carries it. */
    id: string;
    /** The cell source. */
    code: string;
    /** Absolute cwd the kernel chdirs to before running. */
    cwd: string;
    /** Env patch over the kernel's boot env (applied per request). */
    env?: Record<string, string>;
    /** Informational: the host owns the clock. Runner must not arm timers. */
    timeout_s: number;
    /** Guest-call budget for this cell (mirrored kernel-side, enforced host-side). */
    budget: number;
    /** Per-cell tool allowlist: visibleTools() minus "code" (and config excludes). */
    tools: string[];
    /** Optional filename for real file tracebacks (py `%load` sets this). */
    filename?: string | null;
}

/** Graceful shutdown: persist (if configured), flush, exit 0. */
export interface ShutdownControl {
    v: 1;
    t: "shutdown";
}

export type HostControl = ExecControl | ShutdownControl;

// ---- fd 1: frames (kernel → host) ------------------------------------------

export type KernelPhase =
    | "ready"
    | "start"
    | "timeout-pause"
    | "timeout-resume"
    | "interrupted"
    | "idle"
    | "loaded"
    | "pip";

/** Lifecycle / clock-control event. `id: null` = kernel-level (ready). */
export interface StatusFrame {
    t: "status";
    id: string | null;
    phase: KernelPhase;
    /** ready only: protocol + runtime facts. */
    protocol?: number;
    runtime?: string;
    pid?: number;
    persist?: boolean;
    /** timeout-pause only: why the clock stopped (e.g. "pip"). */
    reason?: string;
}

/** Streamed program output, coalesced ≤ 8192 bytes, flushed before `done`. */
export interface StdoutFrame {
    t: "stdout";
    id: string;
    data: string;
}

/** Streamed warnings / pip chunks. */
export interface StderrFrame {
    t: "stderr";
    id: string | null;
    data: string;
}

/** The trailing expression value. Emitted immediately before `done`;
 * suppressed when the value is None/undefined. */
export interface ResultFrame {
    t: "result";
    id: string;
    /** Rendered value (repr / util.inspect, capped). */
    repr: string;
    /** Runtime type name ("int", "string", ...). */
    type: string;
    truncated: boolean;
}

/** One guest tool call. Answered exactly once on fd 3, or the cell is cancelled. */
export interface ToolCallFrame {
    t: "tool-call";
    id: string;
    callId: string;
    /** Monotonic per cell, starting at 1. */
    seq: number;
    name: string;
    args: Record<string, unknown>;
}

export interface DoneError {
    ename: string;
    evalue: string;
    /** Traceback lines with runner frames stripped. */
    traceback: string[];
}

/** Terminal frame. Exactly one per exec, always last. */
export interface DoneFrame {
    t: "done";
    id: string;
    ok: boolean;
    /** True when a SIGINT/cancel landed mid-cell (cell may still be ok). */
    cancelled: boolean;
    /** Runner-side; the host owns the clock, so normally false. */
    timed_out: boolean;
    error: DoneError | null;
    /** Guest compute ms, excluding paused (host-work) time. Cross-checked by host. */
    exec_ms: number;
    /** Wall ms from cell start to done. */
    wall_ms: number;
    /** Cell counter for this kernel generation. */
    executions: number;
    budget_left: number;
}

export type KernelFrame =
    | StatusFrame
    | StdoutFrame
    | StderrFrame
    | ResultFrame
    | ToolCallFrame
    | DoneFrame;

// ---- fd 3: returns (host → kernel) ------------------------------------------

/** Answer one tool-call. Only `answer` crosses the wire — `stored` may be
 * non-JSON and is never shipped (types.ts ToolResult contract). */
export interface ReturnFrame {
    v: 1;
    t: "return";
    callId: string;
    ok: boolean;
    answer: string;
    errorMessage?: string;
    budgetLeft: number;
}

/** Abort the cell (timeout / user / shutdown). Raises an uncatchable-by-
 * `except Exception` cancellation inside the cell; pure-CPU still needs SIGINT. */
export interface CancelFrame {
    v: 1;
    t: "cancel";
    id: string;
    callId: null;
    reason: "timeout" | "user" | "shutdown";
}

export type HostReturn = ReturnFrame | CancelFrame;

// ---- validation ------------------------------------------------------------

/** Frame tags the host parser accepts. Unknown `t` = protocol error:
 * kill + respawn, settle as kernel_lost (silently dropping leaves a
 * request unsettled). */
const FRAME_TAGS: Record<string, true> = {
    status: true,
    stdout: true,
    stderr: true,
    result: true,
    "tool-call": true,
    done: true,
};

/** Parse one stdout line into a KernelFrame. Returns an error string for
 * malformed lines (caller decides: protocol error → kill). */
export function parseFrame(line: string): KernelFrame | { protocolError: string } {
    let obj: unknown;
    try {
        obj = JSON.parse(line);
    } catch {
        return { protocolError: `not JSON: ${line.slice(0, 120)}` };
    }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
        return { protocolError: "frame is not an object" };
    }
    const t = (obj as { t?: unknown }).t;
    if (typeof t !== "string" || !FRAME_TAGS[t]) {
        return { protocolError: `unknown frame tag: ${JSON.stringify(t)?.slice(0, 60)}` };
    }
    return obj as KernelFrame;
}

export function isProtocolError(f: KernelFrame | { protocolError: string }): f is { protocolError: string } {
    return typeof (f as { protocolError?: unknown }).protocolError === "string";
}
