// ============================================================================
// sanity/src/extras/loop-control/hardened-model.ts — the bulletproof wrapper.
// ============================================================================
// A ModelContract decorator that NEVER lets a provider failure reach fail().
// providerStep() only calls fail() when callNextTurn THROWS — a wrapper that
// retries, rotates fallbacks, and synthesizes an honest failure message on
// exhaustion means provider errors never hit the morgue. Classification is
// user config (classify), never hardcoded taxonomy.
//
// Installed by loopControl({ harden }) — swaps agent.model at install,
// restores at uninstall. Usable standalone too: new HardenedModel(primary).
//
// what it owns per callNextTurn:
//   - attempts loop over [primary, ...fallbacks] (chain walk)
//   - per-attempt wall timeout (hung fetch) + stream stall watchdogs
//     (first-token + idle-between-deltas) via a wrapped streamSink
//   - classify verdicts: "retry" (same model) / "fallback" (next model) /
//     "stop" (give up now). Abort signals ALWAYS rethrow — never swallow
//     the loop's own kill signal.
//   - exhaustion: synthesize an honest assistant message (default) or throw
//     the last error (onExhausted: "throw" = today's behavior).
//
// LIMIT: adapters without abortCall (stubs, third-party) can't truly cancel —
// timeouts/stalls abandon the orphan and recover the turn anyway. Adapters
// that honor the handle (SimpleModel, PiAdapterModel) cancel for real.
import { randomUUID } from "node:crypto";
import { emptyStats } from "@sanityloop/core";
import type {
  GodObject,
  MessageStats,
  ModelContract,
  ModelPrices,
  StreamEvent,
  StreamSink,
  TurnResult,
} from "@sanityloop/core";

/** Per-failure verdict — the caller's taxonomy, not ours. */
export type HardenVerdict = "retry" | "fallback" | "stop";

export interface HardenStallOptions {
  /** No first delta within this long → stall. Omit = no first-token watchdog. */
  firstTokenMs?: number;
  /** No delta for this long mid-stream → stall. Omit = no idle watchdog. */
  idleMs?: number;
}

export interface HardenOptions {
  /** Master switch — OFF by default. */
  enabled?: boolean;
  /** Fallback models, tried in order after the primary exhausts. Default []. */
  fallback?: ModelContract[];
  /** Tries per model in the chain. Default 1 (chain walk only — the adapter
   * already retried inside each attempt). Infinity = retry this model
   * forever (vicious mode; abort still interrupts). */
  attempts?: number;
  /** Wall-clock per attempt in ms — hung fetch or slow stream. Omit = none.
   * Firing abandons the attempt (orphan documented above), verdict "retry". */
  attemptTimeoutMs?: number;
  /** Stream stall watchdogs. Omit = none. Firing abandons the attempt. */
  stall?: HardenStallOptions;
  /** Backoff between attempts in ms (base * 2^(n-1), ±50% jitter, no
   * ceiling — attempts are few). Default 500. */
  backoffMs?: number;
  /** Classify a failed attempt. Default: aborted → throw; else "retry".
   * "fallback" skips the model's remaining attempts; "stop" gives up now. */
  classify?: (err: unknown) => HardenVerdict;
  /** What exhaustion does: "synthesize" (default) returns an honest assistant
   * message so the turn lands; "throw" rethrows the last error (fail() path). */
  onExhausted?: "synthesize" | "throw";
}

/** Default classify: the loop's kill signal always escapes, rest retries. */
export function defaultClassify(err: unknown): HardenVerdict {
  if (err instanceof Error && err.name === "AbortError") return "stop";
  return "retry";
}

/** Stall error — stamped so classify() can tell it apart. */
export class StallError extends Error {
  override name = "StallError";
  stall: "first-token" | "idle" | "timeout";
  constructor(stall: "first-token" | "idle" | "timeout", ms: number) {
    super(`[hardened-model] provider stalled (${stall} after ${ms}ms)`);
    this.stall = stall;
  }
}

interface AttemptCtx extends GodObject {
  streamSink?: StreamSink;
}

/** Timestamping sink — records first/idle delta times for the watchdogs. */
function watchSink(inner: StreamSink | undefined, seen: { firstAt?: number; lastAt: number }): StreamSink {
  return {
    emit(ev: StreamEvent): void {
      const now = Date.now();
      if (seen.firstAt === undefined && ev.type !== "streamStarted") seen.firstAt = now;
      seen.lastAt = now;
      inner?.emit(ev);
    },
  };
}

/**
 * Race the attempt against timeout + stall watchdogs. On fire: abort the
 * attempt via the adapter handle (true cancellation — no orphan) and reject
 * with StallError. Adapters without abortCall degrade to abandon (the race
 * still recovers the turn). Resolves with the TurnResult. Timers cleared.
 */
async function raceAttempt(
  model: ModelContract,
  run: () => Promise<TurnResult>,
  seen: { firstAt?: number; lastAt: number },
  opts: { attemptTimeoutMs?: number; firstTokenMs?: number; idleMs?: number },
): Promise<TurnResult> {
  const kill = (stall: "timeout" | "first-token" | "idle", ms: number): StallError => {
    model.abortCall?.(undefined, `harden ${stall} after ${ms}ms`);
    return new StallError(stall, ms);
  };
  const timers: ReturnType<typeof setTimeout>[] = [];
  try {
    return await new Promise<TurnResult>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        for (const t of timers) clearTimeout(t);
        fn();
      };
      if (opts.attemptTimeoutMs !== undefined) {
        const ms = opts.attemptTimeoutMs;
        timers.push(setTimeout(() => done(() => reject(kill("timeout", ms))), ms));
      }
      const armStall = (): void => {
        if (settled) return;
        const now = Date.now();
        if (opts.firstTokenMs !== undefined && seen.firstAt === undefined) {
          const elapsed = now - seen.lastAt;
          if (elapsed >= opts.firstTokenMs) return done(() => reject(kill("first-token", opts.firstTokenMs!)));
          timers.push(setTimeout(armStall, Math.min(opts.firstTokenMs - elapsed, 100)));
          return;
        }
        if (opts.idleMs !== undefined) {
          const idleFor = now - seen.lastAt;
          if (idleFor >= opts.idleMs) return done(() => reject(kill("idle", opts.idleMs!)));
          timers.push(setTimeout(armStall, Math.min(opts.idleMs - idleFor, 100)));
          return;
        }
      };
      if (opts.firstTokenMs !== undefined || opts.idleMs !== undefined) {
        timers.push(setTimeout(armStall, 0));
      }
      run().then(
        (r) => done(() => resolve(r)),
        (e: unknown) => done(() => reject(e)),
      );
    });
  } finally {
    for (const t of timers) clearTimeout(t);
  }
}

function backoffSleep(n: number, baseMs: number, signal: AbortSignal | undefined): Promise<void> {
  const ms = baseMs * 2 ** (n - 1) * (0.5 + Math.random() / 2);
  if (signal?.aborted) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  if (signal !== undefined) {
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  }
  return promise;
}

/** Honest exhaustion message — the turn lands WITH the failure, not IN it. */
function synthesizeExhausted(lastErr: unknown, attemptsMade: number, modelsTried: string[]): TurnResult {
  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
  const stats: MessageStats = emptyStats();
  return {
    message: {
      id: `hardened-${randomUUID().slice(0, 8)}`,
      enabled: true,
      type: "assistant",
      content: [{
        type: "text",
        content: `**[loop-control]** Provider call failed after ${attemptsMade} attempt(s) across ${modelsTried.length} model(s) (${modelsTried.join(", ")}). Last error: ${detail}. Stopping — no further provider calls will be made this turn.`,
      }],
    },
    stats,
    stopReason: "error",
  };
}

/** The bulletproof decorator — see module header. */
export class HardenedModel implements ModelContract {
  /** The wrapped primary — install stands it back on uninstall. */
  readonly primary: ModelContract;
  readonly fallbacks: ModelContract[];
  readonly attempts: number;
  readonly attemptTimeoutMs?: number;
  readonly stall?: HardenStallOptions;
  readonly backoffMs: number;
  readonly classify: (err: unknown) => HardenVerdict;
  readonly onExhausted: "synthesize" | "throw";
  [key: string]: unknown;

  // ---- ModelContract transparency: reads/writes hit the primary ----
  get api(): string { return this.primary.api; }
  set api(v: string) { this.primary.api = v; }
  get modelId(): string { return this.primary.modelId; }
  set modelId(v: string) { this.primary.modelId = v; }
  get apiKey(): string | undefined { return this.primary.apiKey; }
  set apiKey(v: string | undefined) { this.primary.apiKey = v; }
  get baseUrl(): string | undefined { return this.primary.baseUrl; }
  set baseUrl(v: string | undefined) { this.primary.baseUrl = v; }
  get stream(): boolean { return this.primary.stream; }
  set stream(v: boolean) { this.primary.stream = v; }
  get maxContext(): number | undefined { return this.primary.maxContext; }
  set maxContext(v: number | undefined) { this.primary.maxContext = v; }
  get prices(): ModelPrices | undefined { return this.primary.prices; }
  set prices(v: ModelPrices | undefined) { this.primary.prices = v; }
  get temperature(): number | undefined { return this.primary.temperature; }
  set temperature(v: number | undefined) { this.primary.temperature = v; }
  get maxOutputTokens(): number | undefined { return this.primary.maxOutputTokens; }
  set maxOutputTokens(v: number | undefined) { this.primary.maxOutputTokens = v; }
  get presetId(): string | undefined { return this.primary.presetId; }
  set presetId(v: string | undefined) { this.primary.presetId = v; }
  /** Abort passes through to whichever chain member is in flight. */
  abortCall(id?: string, reason?: unknown): boolean {
    for (const m of [this.primary, ...this.fallbacks]) {
      if (m.abortCall?.(id, reason)) return true;
    }
    return false;
  }
  get inFlightCalls(): readonly string[] {
    return [this.primary, ...this.fallbacks].flatMap((m) => m.inFlightCalls ?? []);
  }

  constructor(primary: ModelContract, opts: Omit<HardenOptions, "enabled"> = {}) {
    this.primary = primary;
    this.fallbacks = opts.fallback ?? [];
    this.attempts = opts.attempts ?? 1;
    this.attemptTimeoutMs = opts.attemptTimeoutMs;
    this.stall = opts.stall;
    this.backoffMs = opts.backoffMs ?? 500;
    this.classify = opts.classify ?? defaultClassify;
    this.onExhausted = opts.onExhausted ?? "synthesize";
  }

  async callNextTurn(ctx: GodObject): Promise<TurnResult> {
    const chain = [this.primary, ...this.fallbacks];
    const modelsTried: string[] = [];
    let attemptsMade = 0;
    let lastErr: unknown;
    chainWalk:
    for (const model of chain) {
      modelsTried.push(model.modelId);
      const maxAttempts = this.attempts === Infinity ? Infinity : Math.max(1, Math.floor(this.attempts));
      for (let n = 1; n <= maxAttempts; n++) {
        attemptsMade++;
        if (n > 1) await backoffSleep(n - 1, this.backoffMs, ctx.abortSignal);
        if (ctx.abortSignal?.aborted) throw lastErr ?? new Error("[hardened-model] aborted before attempt");
        const seen = { firstAt: undefined as number | undefined, lastAt: Date.now() };
        const attemptCtx = ctx as AttemptCtx;
        const prevSink = attemptCtx.streamSink;
        attemptCtx.streamSink = watchSink(prevSink, seen);
        try {
          return await raceAttempt(model, () => model.callNextTurn(ctx), seen, {
            attemptTimeoutMs: this.attemptTimeoutMs,
            firstTokenMs: this.stall?.firstTokenMs,
            idleMs: this.stall?.idleMs,
          });
        } catch (err) {
          lastErr = err;
          if (ctx.abortSignal?.aborted) throw err; // the loop's kill escapes
          if (err instanceof Error && err.name === "AbortError") throw err;
          const verdict = this.classify(err);
          if (verdict === "stop") break chainWalk;
          if (verdict === "fallback") break;
          // "retry" — next attempt, or next model when attempts exhaust
        } finally {
          attemptCtx.streamSink = prevSink;
        }
      }
    }
    if (this.onExhausted === "throw") throw lastErr;
    return synthesizeExhausted(lastErr, attemptsMade, modelsTried);
  }
}
