// ============================================================================
// packages/extras/code-mode/clock.ts — the cell clock. Host is the only clock.
// ============================================================================
// Two timers per cell:
//   budget  — pausable. Charged only while guest code runs. Every bridge RPC
//             (tool call, gate wait, sub_await, %pip) pauses it.
//   ceiling — never paused. No cell may outlive it, pauses included.
//
// Pausing is exactly: clear the budget timer on entry, re-arm with
// remaining() on exit. Never a fresh window — a cell must not replenish
// its budget by making calls.
// ============================================================================

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 3_600_000;

/** Timeout params are SECONDS (bash convention). `0`/negatives clamp to the
 * 1 s floor — code cells are always bounded, unlike bash's "0 disables".
 * Returns an error string for non-numbers (error-as-result, never throw). */
export function resolveCellTimeoutMs(raw: unknown): number | { error: string } {
    if (raw === undefined) return DEFAULT_TIMEOUT_MS;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return { error: `code: invalid timeout '${String(raw)}' — must be a number of seconds (1–3600)` };
    }
    return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(raw * 1000)));
}

/** Active-time budget accounting. Accrues while running, freezes while
 * paused. `now` is injectable for tests. */
export class CellClock {
    private consumed = 0;
    private activeStart: number | undefined;
    private depth = 0;
    private readonly budgetMs: number;
    private readonly acceptedAt: number;
    private readonly now: () => number;

    constructor(budgetMs: number, acceptedAt: number, now: () => number = Date.now) {
        this.budgetMs = budgetMs;
        this.acceptedAt = acceptedAt;
        this.now = now;
        this.activeStart = acceptedAt;
    }

    /** Enter a host-work wait (guest RPC in flight). Ref-counted: nested
     * pauses need matching resumes. */
    pause(): void {
        if (++this.depth !== 1) return;
        if (this.activeStart !== undefined) {
            this.consumed += this.now() - this.activeStart;
            this.activeStart = undefined;
        }
    }

    resume(): void {
        if (this.depth === 0) return;
        if (--this.depth > 0) return;
        this.activeStart = this.now();
    }

    /** Budget left, excluding paused time. */
    remaining(): number {
        return Math.max(0, this.budgetMs - this.activeMs);
    }

    /** Wall left until the absolute ceiling (never paused). */
    ceilingRemaining(ceilingMs: number): number {
        return Math.max(0, ceilingMs - (this.now() - this.acceptedAt));
    }

    /** Budget consumed so far (excludes paused time). */
    get activeMs(): number {
        const live = this.activeStart !== undefined ? this.now() - this.activeStart : 0;
        return this.consumed + live;
    }

    get paused(): boolean {
        return this.depth > 0;
    }
}
