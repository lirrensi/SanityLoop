// ============================================================================
// packages/test-kit/wait.ts — bounded polling. NO unbounded waits, ever.
// ============================================================================

export function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

export interface WaitOptions {
    /** Hard ceiling in ms. Default 5000 — every wait in this suite is bounded. */
    timeout?: number;
    /** Poll interval ms. Default 10 (the supervisor's own heartbeat). */
    step?: number;
    /** Human label for the timeout error. */
    what?: string;
}

/**
 * Poll `cond` until truthy or the hard deadline. Throws a diagnostic error on
 * timeout — a hung test is a broken test, so we never wait forever.
 */
export async function waitUntil(
    cond: () => boolean,
    opts: WaitOptions = {},
): Promise<void> {
    const { timeout = 5000, step = 10, what = "condition" } = opts;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (cond()) return;
        await sleep(step);
    }
    throw new Error(`waitUntil: timed out after ${timeout}ms waiting for ${what}`);
}

/**
 * Wait until the loop has FULLY landed: idle, the clock actually beaten since
 * entry, AND nothing owed. (The old SDK driver flipped loopState synchronously
 * on input, masking the pre-turn idle; the eternal heartbeat does not — so a
 * pre-tick sample must never count, and a drain-only tick isn't a landing.)
 */
export function awaitIdle(
    agent: { loopState: string; ticks: number; hasWork: boolean },
    opts: WaitOptions = {},
): Promise<void> {
    const t0 = agent.ticks;
    return waitUntil(() => agent.ticks > t0 && agent.loopState === "idle" && !agent.hasWork, {
        ...opts,
        what: opts.what ?? "agent to land idle (clock advanced, nothing owed)",
    });
}

/** Wait until the loop is parked on pending awaits (BREAKPOINT #2). */
export function awaitAwaiting(agent: { loopState: string }, opts: WaitOptions = {}): Promise<void> {
    return waitUntil(() => agent.loopState === "awaiting", {
        ...opts,
        what: opts.what ?? "agent to park awaiting",
    });
}

/**
 * Wait until a turn has FULLY landed: idle AND nothing owed/queued/parked.
 * CLOCK-AWARE like awaitIdle — the heartbeat must beat after entry before an
 * idle sample counts, so a pre-tick sample can never short-circuit the wait.
 */
export function awaitLanded(
    agent: { loopState: string; ticks: number; hasWork: boolean },
    opts: WaitOptions = {},
): Promise<void> {
    const t0 = agent.ticks;
    return waitUntil(() => agent.ticks > t0 && agent.loopState === "idle" && !agent.hasWork, {
        ...opts,
        what: opts.what ?? "turn to land (idle + no owed work, clock advanced)",
    });
}
