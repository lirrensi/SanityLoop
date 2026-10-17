// packages/extras/shell-tool/job-manager.ts — in-process background jobs for the bash tool.
//
// The process manager behind `background: true` + auto-background. ONE instance
// lives in the bash plugin closure (one per agent — owner-scoping is unneeded
// by construction: nobody else can see these jobs).
//
// Shape stolen from OMP's AsyncJobManager, slimmed to our reality:
//   - no ownerId (closure-scoped), no delivery retry (input() never rejects),
//     no watch/consume (no `wait`-tool suppression games in v1).
//   - KEPT: foreground-hidden registration + backgroundJob/releaseForegroundJob
//     (so a fast command never surfaces as a job), capacity cap, bg_N
//     monotonic ids, retention eviction, cancel.
//
// Pure TS — zero agent imports. The settle callback is how the plugin wires
// delivery (input_followup); the manager itself never touches the loop.
export type JobStatus = "running" | "completed" | "failed" | "cancelled";

export interface Job {
  id: string;
  label: string;
  command: string;
  cwd: string;
  status: JobStatus;
  startTime: number;
  endTime?: number;
  /** Settle text — the delivery/completion body (output + status line). */
  resultText?: string;
  /** True when the deadline killed it (vs a plain nonzero exit). */
  timedOut?: boolean;
  /** Nonzero exit code, when it ran to completion and failed. */
  exitCode?: number;
  /** Full-output temp path, when the accumulator spilled. */
  fullOutputPath?: string;
  /** Live pids while running; empty before start / after settle. */
  pids: () => readonly number[];
  /** Hidden from listings until promoted (auto-background foreground wait). */
  foreground?: boolean;
}

/** JSON-safe snapshot — what listings and transient observability carry. */
export interface JobSnapshot {
  id: string;
  label: string;
  status: JobStatus;
  startTime: number;
  endTime?: number;
  timedOut?: boolean;
  exitCode?: number;
}

export interface JobManagerOptions {
  /** Running-job cap. Default 15 (OMP's DEFAULT_MAX_RUNNING_JOBS). */
  maxJobs?: number;
  /** Settled-row retention ms. Default 5 min (OMP's DEFAULT_RETENTION_MS). */
  retentionMs?: number;
  /** Fired once per settle — the plugin's delivery hook. Never for released foreground jobs. */
  onSettle?: (job: Job) => void;
  /** Fired on every row mutation (register/promote/cancel/settle/evict) — the
   * plugin's observability hook (transient publish). Eviction fires on a timer
   * with no plugin involvement, so staleness is only avoidable manager-side. */
  onChange?: () => void;
}

/**
 * What a run resolves with. Plain string = completed with that text (the
 * simple contract — tests and trivial runs). Object = full control: `failed`
 * flips the status, the rest stamps row metadata known only at settle time
 * (a register-time guess would be a lie). Rejection = failed (message is the
 * text), or cancelled when the message is `aborted` / cancel() ran first.
 */
export interface JobOutcome {
  text: string;
  failed?: boolean;
  timedOut?: boolean;
  exitCode?: number;
  fullOutputPath?: string;
}

export interface JobRun {
  /** Settles the row — see JobOutcome. Must reject (not hang) when `cancel` runs. */
  completion: Promise<string | JobOutcome>;
  /** Cooperative kill — must make `completion` reject with an `aborted` error. */
  cancel: () => void;
  pids?: () => readonly number[];
  label?: string;
  cwd?: string;
}

const DEFAULT_MAX_JOBS = 15;
const DEFAULT_RETENTION_MS = 5 * 60 * 1000;

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly cancels = new Map<string, () => void>();
  private readonly evictionTimers = new Map<string, NodeJS.Timeout>();
  private nextAutoId = 1;
  private readonly maxJobs: number;
  private readonly retentionMs: number;
  private readonly onSettle?: (job: Job) => void;
  private readonly onChange?: () => void;
  private disposed = false;

  constructor(options: JobManagerOptions = {}) {
    this.maxJobs = Math.max(1, Math.floor(options.maxJobs ?? DEFAULT_MAX_JOBS));
    this.retentionMs = Math.max(0, Math.floor(options.retentionMs ?? DEFAULT_RETENTION_MS));
    this.onSettle = options.onSettle;
    this.onChange = options.onChange;
  }

  /** True when the running-job count has reached the cap. */
  get atCapacity(): boolean {
    if (this.disposed) return true;
    let running = 0;
    for (const job of this.jobs.values()) {
      if (job.status === "running") running++;
    }
    return running >= this.maxJobs;
  }

  hasRunning(): boolean {
    for (const job of this.jobs.values()) {
      if (job.status === "running") return true;
    }
    return false;
  }

  /**
   * Register a run. `foreground: true` hides the row from listings until
   * backgroundJob() promotes it — a command finishing within the auto-bg wait
   * never surfaces as a job (releaseForegroundJob discards it silently).
   */
  register(run: JobRun, options: { foreground?: boolean } = {}): string {
    if (this.disposed) throw new Error("Job manager is disposed");
    if (this.atCapacity) {
      throw new Error(
        `Background job limit reached (${this.maxJobs}). Wait for running jobs to finish or kill one.`,
      );
    }
    const id = `bg_${this.nextAutoId++}`;
    const job: Job = {
      id,
      label: run.label ?? id,
      command: run.label ?? "",
      cwd: run.cwd ?? "",
      status: "running",
      startTime: Date.now(),
      pids: run.pids ?? (() => []),
      ...(options.foreground ? { foreground: true } : {}),
    };
    this.jobs.set(id, job);
    this.cancels.set(id, run.cancel);
    void run.completion.then(
      (outcome) => {
        if (typeof outcome === "string") {
          this.settle(id, "completed", outcome);
        } else {
          this.settle(id, outcome.failed ? "failed" : "completed", outcome.text, outcome);
        }
      },
      (err) => {
        const message = err instanceof Error ? err.message : String(err);
        const cancelled = job.status === "cancelled" || message === "aborted";
        this.settle(id, cancelled ? "cancelled" : "failed", message);
      },
    );
    this.changed();
    return id;
  }

  /** Promote a foreground-hidden job to a real background job. */
  backgroundJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.foreground = undefined;
    this.changed();
    return true;
  }

  /**
   * Discard a foreground-hidden job whose result the foreground call already
   * returned. If still running (abort path), mark cancelled and kill it —
   * never deliver.
   */
  releaseForegroundJob(id: string): void {
    const job = this.jobs.get(id);
    if (!job?.foreground) return;
    if (job.status === "running") {
      job.status = "cancelled";
      try {
        this.cancels.get(id)?.();
      } catch {
        // kill is best-effort; the settle path discards the row anyway
      }
    }
    this.evict(id);
  }

  /** Cancel a running job — kills the run, records cancelled, never delivers. */
  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return false;
    job.status = "cancelled";
    try {
      this.cancels.get(id)?.();
    } catch {
      // best-effort; settle still records the row
    }
    this.changed();
    return true;
  }

  cancelAll(): void {
    for (const job of this.jobs.values()) {
      if (job.status === "running") this.cancel(job.id);
    }
  }

  get(id: string): Job | undefined {
    const job = this.jobs.get(id);
    return job?.foreground ? undefined : job;
  }

  /** Visible jobs: running first (oldest), then settled (newest). Hidden foreground rows excluded. */
  list(): Job[] {
    const visible = [...this.jobs.values()].filter((j) => !j.foreground);
    const running = visible.filter((j) => j.status === "running").sort((a, b) => a.startTime - b.startTime);
    const settled = visible.filter((j) => j.status !== "running").sort((a, b) => b.startTime - a.startTime);
    return [...running, ...settled];
  }

  snapshot(job: Job): JobSnapshot {
    return {
      id: job.id,
      label: job.label,
      status: job.status,
      startTime: job.startTime,
      ...(job.endTime !== undefined ? { endTime: job.endTime } : {}),
      ...(job.timedOut ? { timedOut: true } : {}),
      ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
    };
  }

  /** Cancel everything, clear timers, drop all rows. The plugin calls this on uninstall/abort. */
  dispose(): void {
    this.disposed = true;
    this.cancelAll();
    for (const timer of this.evictionTimers.values()) clearTimeout(timer);
    this.evictionTimers.clear();
    this.jobs.clear();
    this.cancels.clear();
  }

  private settle(id: string, status: JobStatus, text: string, outcome?: JobOutcome): void {
    const job = this.jobs.get(id);
    if (!job) return; // released/evicted while settling — nothing to record
    this.cancels.delete(id);
    // cancel() marks the row FIRST and kills second — a late completion
    // (the drain resolves failures, never rejects) must not overwrite it.
    if (job.status !== "cancelled") job.status = status;
    job.endTime = Date.now();
    job.resultText = text;
    if (outcome?.timedOut) job.timedOut = true;
    if (outcome?.exitCode !== undefined) job.exitCode = outcome.exitCode;
    if (outcome?.fullOutputPath) job.fullOutputPath = outcome.fullOutputPath;
    // foreground-hidden rows never deliver and never linger: the foreground
    // call owns the result (releaseForegroundJob clears them at return).
    if (job.foreground) return;
    this.scheduleEviction(id);
    this.changed();
    if (job.status === "cancelled") return; // kills never deliver (OMP parity)
    try {
      this.onSettle?.(job);
    } catch (err) {
      console.error(`[sanity] job ${id} settle hook failed:`, err);
    }
  }

  private scheduleEviction(id: string): void {
    const timer = setTimeout(() => this.evict(id), this.retentionMs);
    timer.unref();
    this.evictionTimers.set(id, timer);
  }

  private evict(id: string): boolean {
    clearTimeout(this.evictionTimers.get(id));
    this.evictionTimers.delete(id);
    this.cancels.delete(id);
    const dropped = this.jobs.delete(id);
    if (dropped) this.changed();
    return dropped;
  }

  private changed(): void {
    try {
      this.onChange?.();
    } catch (err) {
      console.error("[sanity] job manager onChange hook failed:", err);
    }
  }
}
