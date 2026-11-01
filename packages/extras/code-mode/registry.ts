// ============================================================================
// packages/extras/code-mode/registry.ts — kernel registry + cell runner.
// ============================================================================
// Closure-owned Map<key, Entry>, key = session + cwd + interpreter. LRU 4,
// idle TTL 30 min (idle only — TTL never kills a running cell), monotonic
// generation per key bumped on every kill/replacement.
//
// Cell lifecycle: ACCEPTED → QUEUED → ACTIVE ⇄ WAITING_GUEST → SEALED.
// Two timers: pausable budget + never-paused absolute ceiling. One settle
// latch. Kill ladder in kernel.ts.
//
// Lifecycle mirrors bash exactly: registry in the plugin factory closure,
// published at agent.transient["code.kernels"] (never taped), abort kills
// everything, uninstall disposes.
// ============================================================================

import { randomUUID } from "node:crypto";
import type { ContentBlock, GodObject, ToolType } from "@sanityloop/core";
import { createToolCaller, type ToolCaller } from "./call-tool.ts";
import { buildCatalog, suggestToolName, type Catalog } from "./catalog.ts";
import { CellClock, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from "./clock.ts";
import { formatInvalidToolInput, formatUnknownTool } from "./diagnostics.ts";
import { cancelFrame, execControl, KernelProcess, returnFrame, type KernelSpawnSpec } from "./kernel.ts";
import { CellOutputSink } from "./output.ts";
import type { CodeLanguage, DoneFrame, KernelFrame, ToolCallFrame } from "./protocol.ts";
import { buildStubs, CODE_MODE_BUDGET, type StubSet } from "./stubs.ts";

export type RestartReason = "timeout" | "crash" | "reset" | "evicted" | "ttl" | "abort";

export interface CodeModeOptions {
    maxKernels?: number;
    idleTtlMs?: number;
    sweepMs?: number;
    defaultTimeoutMs?: number;
    absoluteCeilingMs?: number;
    pythonPath?: string;
    nodePath?: string;
    /** Undefined = pure memory (default). Py-only dill sidecar, never taped. */
    persistDir?: string;
    /** Extra tool names blocked from cells (beyond code/delegate/call_tool). */
    blocked?: string[];
    /** Stub allowlist: "all" (default) or explicit names. */
    tools?: "all" | string[];
    exclude?: string[];
    pinned?: string[];
    now?: () => number;
}

export interface CellRequest {
    language: CodeLanguage;
    code: string;
    timeoutMs: number;
    filename?: string;
}

export type CellStatus = "ok" | "error" | "timeout" | "aborted" | "crashed" | "rejected";

export interface CellOutcome {
    status: CellStatus;
    answer: string;
    generation: number;
    kernelRestarted: boolean;
    restartReason?: RestartReason;
    durationMs: number;
    queuedMs: number;
    pausedMs: number;
    calls: number;
    truncated: boolean;
    fullOutputPath?: string;
    language: CodeLanguage;
}

export interface KernelSnapshot {
    key: string;
    interp: CodeLanguage;
    cwd: string;
    generation: number;
    busy: boolean;
    lastUsedAt: number;
    cellsRun: number;
}

interface CellWaiter {
    resolve: (o: CellOutcome) => void;
    req: CellRequest;
    host: GodObject;
    acceptedAt: number;
    clock: CellClock;
    sink: CellOutputSink;
    cellId: string;
    /** Budget consumed by guest calls so far. */
    calls: number;
    pausedMs: number;
    pauseStart: number | undefined;
    settled: boolean;
    budgetTimer: ReturnType<typeof setTimeout> | undefined;
    ceilingTimer: ReturnType<typeof setTimeout> | undefined;
    abortListener: (() => void) | undefined;
    catalog: Catalog;
    stubs: StubSet;
    tools: ToolType[];
    /** Set when this is the first cell on a post-restart kernel. */
    freshReason: RestartReason | undefined;
}

interface Entry {
    key: string;
    interp: CodeLanguage;
    cwd: string;
    sessionId: string;
    kernel: KernelProcess | undefined;
    ready: boolean;
    busy: boolean;
    lastUsedAt: number;
    cellsRun: number;
    queue: CellWaiter[];
    active: CellWaiter | undefined;
}

const TRANSIENT_KEY = "code.kernels";

function makeKey(sessionId: string, cwd: string, interp: CodeLanguage): string {
    return `${sessionId}\0${cwd}\0${interp}`;
}

export class KernelRegistry {
    private readonly entries = new Map<string, Entry>();
    private readonly generations = new Map<string, number>();
    private readonly lastReason = new Map<string, RestartReason>();
    private sweeper: ReturnType<typeof setInterval> | undefined;

    private readonly maxKernels: number;
    private readonly idleTtlMs: number;
    private readonly absoluteCeilingMs: number;
    private readonly pythonPath: string;
    private readonly nodePath: string;
    private readonly now: () => number;

    private readonly opts: CodeModeOptions;

    constructor(opts: CodeModeOptions = {}) {
        this.opts = opts;
        this.maxKernels = Math.max(1, Math.floor(opts.maxKernels ?? 4));
        this.idleTtlMs = Math.max(0, opts.idleTtlMs ?? 1_800_000);
        this.absoluteCeilingMs = opts.absoluteCeilingMs ?? MAX_TIMEOUT_MS;
        this.pythonPath = opts.pythonPath ?? "python3";
        this.nodePath = opts.nodePath ?? process.execPath;
        this.now = opts.now ?? Date.now;
        const sweepMs = Math.max(1000, opts.sweepMs ?? 30_000);
        this.sweeper = setInterval(() => this.sweep(), sweepMs);
        this.sweeper.unref?.();
    }

    snapshots(): KernelSnapshot[] {
        return [...this.entries.values()].map((e) => ({
            key: e.key,
            interp: e.interp,
            cwd: e.cwd,
            generation: this.generations.get(e.key) ?? 1,
            busy: e.busy,
            lastUsedAt: e.lastUsedAt,
            cellsRun: e.cellsRun,
        }));
    }

    /** Run one cell on the session+cwd+language kernel. Creates lazily. */
    runCell(host: GodObject, req: CellRequest): Promise<CellOutcome> {
        const sessionId = host.id;
        const key = makeKey(sessionId, host.cwd, req.language);
        this.sweep();
        let entry = this.entries.get(key);
        const isNewEntry = entry === undefined;
        if (!entry) {
            this.ensureCapacity();
            entry = {
                key,
                interp: req.language,
                cwd: host.cwd,
                sessionId,
                kernel: undefined,
                ready: false,
                busy: false,
                lastUsedAt: this.now(),
                cellsRun: 0,
                queue: [],
                active: undefined,
            };
            this.entries.set(key, entry);
        }
        // Touch (LRU).
        this.entries.delete(key);
        this.entries.set(key, entry);

        const { promise, resolve } = Promise.withResolvers<CellOutcome>();
        const acceptedAt = this.now();
        const clock = new CellClock(req.timeoutMs, acceptedAt, this.now);
        const tools = this.cellTools(host);
        const stubs = buildStubs(tools, { exclude: this.opts.exclude, pinned: this.opts.pinned });
        const catalog = buildCatalog(tools, { pinned: this.opts.pinned });
        const waiter: CellWaiter = {
            resolve,
            req,
            host,
            acceptedAt,
            clock,
            sink: new CellOutputSink(),
            cellId: `c${randomUUID().slice(0, 8)}`,
            calls: 0,
            pausedMs: 0,
            pauseStart: undefined,
            settled: false,
            budgetTimer: undefined,
            ceilingTimer: undefined,
            abortListener: undefined,
            catalog,
            stubs,
            tools,
            // First cell queued on a fresh entry after a restart: the model
            // must hear that prior state is gone (consumed once, below).
            freshReason: isNewEntry && entry.queue.length === 0 ? this.lastReason.get(key) : undefined,
        };
        entry.queue.push(waiter);
        // The ceiling runs from ACCEPT — a jam cannot outlive it.
        waiter.ceilingTimer = setTimeout(() => this.onCeiling(entry!, waiter), this.absoluteCeilingMs);
        waiter.ceilingTimer.unref?.();
        if (host.abortSignal.aborted) {
            this.settle(entry, waiter, "aborted", "abort", "cell aborted before it started");
        } else {
            waiter.abortListener = () => this.onAbort(entry!, waiter);
            host.abortSignal.addEventListener("abort", waiter.abortListener, { once: true });
            this.pump(entry);
        }
        return promise;
    }

    /** Kill + bump generation. Omit interp = both languages for session+cwd. */
    async reset(host: GodObject, interp?: CodeLanguage, reason: RestartReason = "reset"): Promise<void> {
        const keys = [...this.entries.keys()].filter((k) => {
            const e = this.entries.get(k)!;
            return e.sessionId === host.id && e.cwd === host.cwd && (interp === undefined || e.interp === interp);
        });
        await Promise.all(keys.map((k) => this.killEntry(k, reason)));
    }

    async disposeAll(reason: RestartReason = "abort"): Promise<void> {
        if (this.sweeper !== undefined) {
            clearInterval(this.sweeper);
            this.sweeper = undefined;
        }
        await Promise.all([...this.entries.keys()].map((k) => this.killEntry(k, reason)));
    }

    // ---- internals ----------------------------------------------------------

    private cellTools(host: GodObject): ToolType[] {
        const visible = host.visibleTools().filter((t) => t.name !== "code" && !t.name.startsWith("__code"));
        const allow = this.opts.tools ?? "all";
        if (allow === "all") return visible;
        const set = new Set(allow);
        return visible.filter((t) => set.has(t.name));
    }

    private ensureCapacity(): void {
        while (this.entries.size >= this.maxKernels) {
            const victim = this.entries.keys().next().value as string | undefined;
            if (victim === undefined) break;
            void this.killEntry(victim, "evicted");
        }
    }

    private sweep(): void {
        const now = this.now();
        for (const [key, e] of [...this.entries]) {
            if (!e.busy && e.active === undefined && now - e.lastUsedAt >= this.idleTtlMs) {
                void this.killEntry(key, "ttl");
            }
        }
    }

    private async killEntry(key: string, reason: RestartReason): Promise<void> {
        const e = this.entries.get(key);
        if (!e) return;
        this.entries.delete(key);
        this.generations.set(key, (this.generations.get(key) ?? 1) + 1);
        this.lastReason.set(key, reason);
        // Reject the queue + settle the active cell.
        for (const w of e.queue.splice(0)) {
            this.settle(e, w, reason === "reset" ? "aborted" : "rejected", reason, `kernel ${reason} before the cell started`);
        }
        if (e.active) {
            const w = e.active;
            e.active = undefined;
            e.busy = false;
            this.settle(e, w, reason === "reset" ? "aborted" : "timeout", reason, `kernel ${reason} during the cell`);
        }
        const kernel = e.kernel;
        e.kernel = undefined;
        e.ready = false;
        if (kernel?.alive === true) {
            if (reason === "ttl" || reason === "evicted" || reason === "reset") {
                await kernel.shutdown();
            } else {
                await kernel.kill();
            }
        }
    }

    private pump(entry: Entry): void {
        if (entry.busy || entry.active !== undefined) return;
        const waiter = entry.queue.shift();
        if (!waiter || waiter.settled) {
            if (waiter === undefined) return;
            this.pump(entry);
            return;
        }
        entry.busy = true;
        entry.active = waiter;
        void this.drive(entry, waiter);
    }

    private async drive(entry: Entry, w: CellWaiter): Promise<void> {
        const generation = this.generations.get(entry.key) ?? 1;
        // Spawn lazily. Events route by frame id through entry.active —
        // NEVER a closure over this cell's waiter (the kernel outlives cells).
        // Exit/protocol handlers are guarded by kernel identity: a stale
        // exit from the previous kernel must not settle the next cell.
        if (!entry.kernel || !entry.ready) {
            const kernel = new KernelProcess(this.spawnSpec(entry), {
                onFrame: (frame) => { if (entry.kernel === kernel) this.onFrame(entry, frame); },
                onStderr: (chunk) => { if (entry.kernel === kernel) entry.active?.sink.appendRaw(chunk); },
                onExit: () => { if (entry.kernel === kernel) this.onExit(entry); },
                onProtocolError: (message) => { if (entry.kernel === kernel) this.onProtocolError(entry, message); },
            });
            entry.kernel = kernel;
            entry.ready = false;
            const started = await kernel.start();
            if (w.settled) return; // ceiling/abort fired during spawn
            if (!started || !entry.ready) {
                entry.kernel = undefined;
                entry.ready = false;
                this.generations.set(entry.key, generation + 1);
                this.lastReason.set(entry.key, "crash");
                this.settle(entry, w, "crashed", "crash", "kernel failed to start (no ready frame within 15 s)");
                return;
            }
        }
        if (w.settled) return;
        // Fire the exec.
        const kernel = entry.kernel!;
        const timeout_s = Math.max(1, Math.round(w.req.timeoutMs / 1000));
        const ok = kernel.sendControl(execControl(w.cellId, w.req.code, {
            cwd: entry.cwd,
            timeout_s,
            budget: CODE_MODE_BUDGET,
            tools: w.tools.map((t) => t.name),
            ...(w.req.filename !== undefined ? { filename: w.req.filename } : {}),
        }));
        if (!ok) {
            this.settle(entry, w, "crashed", "crash", "kernel pipe broken before exec");
            return;
        }
        // Arm the budget timer (pausable).
        this.armBudget(entry, w);
    }

    private spawnSpec(entry: Entry): KernelSpawnSpec {
        const runnerDir = new URL("./runner/", import.meta.url);
        if (entry.interp === "py") {
            const env: Record<string, string> = {};
            if (this.opts.persistDir !== undefined) env.SL_PERSIST_DIR = this.opts.persistDir;
            return {
                argv: [this.pythonPath, "-u", new URL("py-runner.py", runnerDir).pathname],
                cwd: entry.cwd,
                env,
            };
        }
        const flag = (process as unknown as { allowedNodeEnvironmentFlags?: Set<string> }).allowedNodeEnvironmentFlags;
        const strip = flag?.has("--experimental-strip-types") === true ? ["--experimental-strip-types"] : [];
        return {
            argv: [this.nodePath, ...strip, new URL("js-runner.mjs", runnerDir).pathname],
            cwd: entry.cwd,
        };
    }

    private armBudget(entry: Entry, w: CellWaiter): void {
        this.clearBudget(w);
        const remaining = Math.min(w.clock.remaining(), this.absoluteCeilingMs - (this.now() - w.acceptedAt));
        if (remaining <= 0) {
            this.onBudget(entry, w);
            return;
        }
        w.budgetTimer = setTimeout(() => this.onBudget(entry, w), remaining);
        w.budgetTimer.unref?.();
    }

    private clearBudget(w: CellWaiter): void {
        if (w.budgetTimer !== undefined) {
            clearTimeout(w.budgetTimer);
            w.budgetTimer = undefined;
        }
    }

    private pauseClock(w: CellWaiter): void {
        if (w.pauseStart === undefined) {
            w.pauseStart = this.now();
            w.clock.pause();
            this.clearBudget(w);
        }
    }

    private resumeClock(entry: Entry, w: CellWaiter): void {
        if (w.pauseStart !== undefined) {
            w.pausedMs += this.now() - w.pauseStart;
            w.pauseStart = undefined;
            w.clock.resume();
            if (!w.settled) this.armBudget(entry, w);
        }
    }

    // ---- frame handling -----------------------------------------------------

    private onFrame(entry: Entry, frame: KernelFrame): void {
        if (frame.t === "status" && frame.id === null && frame.phase === "ready") {
            entry.ready = true;
            entry.kernel?.noteReady();
            return;
        }
        const w = entry.active;
        const id = frameId(frame);
        if (!w || w.settled || id !== w.cellId) return;
        switch (frame.t) {
            case "status":
                if (frame.phase === "timeout-pause") this.pauseClock(w);
                else if (frame.phase === "timeout-resume") this.resumeClock(entry, w);
                return;
            case "stdout":
            case "stderr":
                w.sink.append(frame.data);
                return;
            case "result":
                w.sink.setValue(frame.truncated ? `${frame.repr}…` : frame.repr);
                return;
            case "tool-call":
                void this.onToolCall(entry, w, frame);
                return;
            case "done":
                void this.onDone(entry, w, frame);
                return;
        }
    }

    private async onToolCall(entry: Entry, w: CellWaiter, frame: ToolCallFrame): Promise<void> {
        const kernel = entry.kernel;
        const answer = async (ok: boolean, text: string, errorMessage?: string): Promise<void> => {
            kernel?.sendReturn(returnFrame(frame.callId, ok, text, CODE_MODE_BUDGET - w.calls, errorMessage));
        };
        // Budget is counted BEFORE the gate: request 51 never touches it.
        w.calls += 1;
        if (w.calls > CODE_MODE_BUDGET) {
            await answer(false, `cell exceeded its ${CODE_MODE_BUDGET} tool-call budget — split the work across cells`, "budget_exhausted");
            return;
        }
        this.pauseClock(w);
        try {
            const caller: ToolCaller = createToolCaller(w.host);
            // Unknown tool → kernel-style diagnostic (suggestion included).
            const shape = w.stubs.byName.get(frame.name);
            if (shape === undefined && !w.host.tools.some((t) => t.name === frame.name)) {
                const suggestion = suggestToolName(w.catalog, frame.name);
                await answer(false, formatUnknownTool(frame.name, suggestion), "unknown_tool");
                return;
            }
            const args = (typeof frame.args === "object" && frame.args !== null && !Array.isArray(frame.args)
                ? frame.args
                : {}) as Record<string, unknown>;
            const outcome = await caller(frame.name, args, {
                id: `${w.cellId}_${frame.callId}`,
                blocked: this.opts.blocked,
                signal: w.host.abortSignal,
            });
            if (outcome.result.errorMessage === "invalid_arguments") {
                const errors = (outcome.result.stored as { errors?: unknown } | undefined)?.errors;
                const list = Array.isArray(errors) ? errors.filter((e): e is string => typeof e === "string") : [];
                const signature = w.stubs.signatures[frame.name] ?? `${frame.name}(...)`;
                const hostAnswer = flattenAnswer(outcome.result.answer);
                await answer(false, formatInvalidToolInput(frame.name, signature, hostAnswer, list, shape), "invalid_arguments");
                return;
            }
            if (outcome.result.error === true) {
                await answer(false, flattenAnswer(outcome.result.answer), outcome.result.errorMessage ?? "tool_failed");
                return;
            }
            await answer(true, flattenAnswer(outcome.result.answer));
        } finally {
            this.resumeClock(entry, w);
        }
    }

    private async onDone(entry: Entry, w: CellWaiter, frame: DoneFrame): Promise<void> {
        if (frame.error) {
            const err = frame.error;
            w.sink.append(`${err.ename}: ${err.evalue}\n${err.traceback.join("\n")}\n`);
        }
        this.settle(entry, w, frame.ok ? "ok" : frame.cancelled ? "aborted" : "error");
    }

    private onExit(entry: Entry): void {
        const w = entry.active;
        entry.ready = false;
        entry.kernel = undefined;
        if (!w || w.settled) return; // idle death: corpse cleared, next cell respawns
        // No `done` + process exit = lost.
        this.generations.set(entry.key, (this.generations.get(entry.key) ?? 1) + 1);
        this.lastReason.set(entry.key, "crash");
        this.settle(entry, w, "crashed", "crash", "kernel exited without a done frame");
    }

    private onProtocolError(entry: Entry, message: string): void {
        const w = entry.active;
        if (!w || w.settled) return;
        void entry.kernel?.kill();
        entry.kernel = undefined;
        entry.ready = false;
        this.generations.set(entry.key, (this.generations.get(entry.key) ?? 1) + 1);
        this.lastReason.set(entry.key, "crash");
        this.settle(entry, w, "crashed", "crash", `kernel protocol error: ${message}`);
    }

    private onBudget(entry: Entry, w: CellWaiter): void {
        if (w.settled) return;
        void entry.kernel?.kill();
        entry.kernel = undefined;
        entry.ready = false;
        this.generations.set(entry.key, (this.generations.get(entry.key) ?? 1) + 1);
        this.lastReason.set(entry.key, "timeout");
        this.settle(entry, w, "timeout", "timeout", `cell budget exhausted (${Math.round(w.req.timeoutMs / 1000)}s of cell work)`);
    }

    private onCeiling(entry: Entry, w: CellWaiter): void {
        if (w.settled) return;
        void entry.kernel?.kill();
        entry.kernel = undefined;
        entry.ready = false;
        this.generations.set(entry.key, (this.generations.get(entry.key) ?? 1) + 1);
        this.lastReason.set(entry.key, "timeout");
        this.settle(entry, w, "timeout", "timeout", "absolute cell ceiling reached");
    }

    private onAbort(entry: Entry, w: CellWaiter): void {
        if (w.settled) return;
        entry.kernel?.sendReturn(cancelFrame(w.cellId, "user"));
        void entry.kernel?.kill();
        entry.kernel = undefined;
        entry.ready = false;
        this.generations.set(entry.key, (this.generations.get(entry.key) ?? 1) + 1);
        this.lastReason.set(entry.key, "abort");
        this.settle(entry, w, "aborted", "abort", "cell aborted");
    }

    private settle(entry: Entry, w: CellWaiter, status: CellStatus, restartReason?: RestartReason, note?: string): void {
        if (w.settled) return;
        w.settled = true;
        this.clearBudget(w);
        if (w.ceilingTimer !== undefined) {
            clearTimeout(w.ceilingTimer);
            w.ceilingTimer = undefined;
        }
        if (w.abortListener !== undefined) {
            w.host.abortSignal.removeEventListener("abort", w.abortListener);
            w.abortListener = undefined;
        }
        if (w.pauseStart !== undefined) {
            w.pausedMs += this.now() - w.pauseStart;
            w.pauseStart = undefined;
        }
        if (entry.active === w) {
            entry.active = undefined;
            entry.busy = false;
            entry.lastUsedAt = this.now();
            entry.cellsRun += 1;
        }
        const generation = this.generations.get(entry.key) ?? 1;
        const fresh = w.freshReason;
        w.freshReason = undefined;
        const effectiveReason = restartReason ?? fresh;
        const kernelRestarted = effectiveReason !== undefined;
        void w.sink.seal().then((out) => {
            let answer = out.text;
            if (note !== undefined && status !== "ok") answer = `${answer}\n\n[code-mode] ${note}.`;
            if (kernelRestarted && effectiveReason !== undefined) {
                answer += `\n[code-mode] kernel restarted (${effectiveReason}) — prior variables, imports and definitions are gone.`;
            }
            if (w.pausedMs >= 1000) {
                answer += `\n[cell budget ${Math.round(w.req.timeoutMs / 1000)}s; ${Math.round(w.clock.activeMs / 1000)}s cell work, ${Math.round(w.pausedMs / 1000)}s host work (not charged)]`;
            }
            w.resolve({
                status,
                answer,
                generation,
                kernelRestarted,
                ...(effectiveReason !== undefined ? { restartReason: effectiveReason } : {}),
                durationMs: Math.round(w.clock.activeMs),
                queuedMs: 0,
                pausedMs: Math.round(w.pausedMs),
                calls: w.calls,
                truncated: out.truncated,
                ...(out.fullOutputPath !== undefined ? { fullOutputPath: out.fullOutputPath } : {}),
                language: w.req.language,
            });
            this.pump(entry);
        });
    }
}
/** Every frame except kernel-level status carries the cell id. */
function frameId(frame: KernelFrame): string | null {
    return frame.id;
}

/** Flatten a ToolResult answer for the wire: text blocks joined, non-text
 * blocks become [image omitted] (raw stays host-side). */
function flattenAnswer(answer: string | ContentBlock[]): string {
    if (typeof answer === "string") return answer;
    const parts: string[] = [];
    for (const b of answer) {
        if (b.type === "text") parts.push(b.content);
        else parts.push(`[${b.type} omitted]`);
    }
    return parts.join("\n");
}

export { TRANSIENT_KEY };
