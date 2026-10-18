// ============================================================================
// sanity/src/extras/loop-control/index.ts — the OPTIONAL guardrail extension
// ============================================================================
// Everything the base loop deliberately does NOT do. The base loop stays light
// and forces NO defaults; this is the single optional plugin you install when
// you want the "keep the job going" safety net. With a strong model you install
// none of it. It doubles as a TEMPLATE — copy this file and mutate for your own
// guard conditions.
//
//   agent.install(loopControl({
//     doomLoop: { enabled: true,  threshold: 3, reaction: "nudge" },
//     maxTurns: { enabled: true,  cap: 200,     announceLast: true },
//   }));
//
// FOUR guards today, all error-gated / honest:
//
//   A. DOOM-LOOP DETECTION — repeated tool calls that KEEP FAILING.
//      The discriminator is `content.error === true`, NOT "same call". A monitor /
//      poll / sleep loop that SUCCEEDS is legit and never trips; a single success
//      resets the counter. Only consecutive erroring calls count. Tools must set
//      `error: true` on failure (bash already does: exit!=0 → error; aborted
//      excluded). Reaction is configurable:
//        - "nudge"  — inject a message telling the model to stop and re-read, then
//          keep going. (default — we expect mostly autonomous runs)
//        - "ask"    — park the loop awaiting; a human (or channel input) decides
//          continue/stop. Escalation after N nudges: stop, or ask.
//
//   B. MAX-TURNS BUDGET — a hard cap on model round-trips (cycles), codex/opencode
//      style: the model is TOLD a last turn is coming ("isLastStep"), then the loop
//      stops at the cap. Never a silent crash — always a committed wrap-up.
//
//   C. MAX-STEPS BUDGET — a harder cap on machine STEPS (provider round-trips +
//      committed tool results). Stops at the cap with a committed wrap-up. This is
//      the "the model just keeps calling tools forever" net.
//
//   D. MAX-CONSECUTIVE-TOOLS — the model keeps calling tools WITHOUT producing an
//      assistant answer. After `cap` consecutive tool results it nudges (default)
//      or stops. Resets whenever an answer lands.
//
// Detection counter per tool lives in plugin closure (hot path, no patch storm);
// the ACTIONS taken (nudges, asks, stops, budget state) are surfaced on
// `state[STATE_KEY]` so a UI can watch them. Counts/actions reset on uninstall.
// ============================================================================
import { randomUUID } from "node:crypto";
import { EVENTS } from "@sanityloop/core";
import type {
	GodObject,
	Message,
	Plugin,
	ToolResultContent,
} from "@sanityloop/core";
import { removeFiltersByPrefix } from "@sanityloop/util";

// ----------------------------------------------------------------------------
// Options
// ----------------------------------------------------------------------------

export interface DoomLoopOptions {
	/** Master switch — OFF by default. Enable to guard against repeated failing calls. */
	enabled?: boolean;
	/** Consecutive erroring calls of the same key before the guard trips. Default 3. */
	threshold?: number;
	/** What to do when it trips: "nudge" (auto-inject, keep going) or "ask" (park + human). Default "nudge". */
	reaction?: "nudge" | "ask";
	/** What counts as "the same call": the tool name, or the tool + its arguments. Default "tool". */
	keyOn?: "tool" | "tool+args";
	/** After this many nudges on a key without a success, escalate. Default 2. */
	maxNudges?: number;
	/** Where to escalate to: "stop" the run, or "ask" a human. Default "stop". */
	escalateTo?: "stop" | "ask";
	/** Optional: only guard these tool names. Omit = guard all tools. */
	toolNames?: string[];
	/**
	 * The adapter for the "ask" reaction — HOW to reach a human. Omit = the loop
	 * just parks awaiting (pure state) and the answer must arrive via
	 * `agent.input({ type: "loop-control-doom-answer", ref, decision })` from any
	 * channel (TUI / REST / supervisor / another agent). Receives the stuck tool
	 * + failure count, must resolve with "continue" | "stop".
	 */
	ask?: (info: {
		tool: string;
		count: number;
		key: string;
	}) => Promise<"continue" | "stop">;
}

export interface MaxTurnsOptions {
	/** Master switch — OFF by default. */
	enabled?: boolean;
	/** Hard cap on model round-trips (cycles). Default 200. */
	cap?: number;
	/** Tell the model a last turn is coming (codex/opencode `isLastStep`). Default true. */
	announceLast?: boolean;
	/** Optional text pushed on the final budget-exhausted stop. */
	finalMessage?: string;
}

export interface MaxStepsOptions {
	/** Master switch — OFF by default. */
	enabled?: boolean;
	/** Hard cap on machine STEPS (provider round-trips + committed tool results).
	 * Default 0 = unlimited (only meaningful once `enabled`). Default cap 200. */
	cap?: number;
	/** Tell the model a last step is coming. Default true. */
	announceLast?: boolean;
	/** Optional text pushed on the final budget-exhausted stop. */
	finalMessage?: string;
	/** TRUE = a HARD stop at the cap: `agent.abort()` — the turn dies, the
	 * worker freezes (terminal). The loop CANNOT resume, because gentle stop()
	 * can't freeze a mid-turn machine (unanswered tool results stay owed work).
	 * Default false = gentle: push finalMessage + stop(); a cooperative model
	 * concludes, a runaway one keeps going. */
	abort?: boolean;
}

export interface MaxConsecutiveToolsOptions {
	/** Master switch — OFF by default. */
	enabled?: boolean;
	/** Consecutive committed tool results (no assistant answer between them)
	 * before it trips. Default 10. */
	cap?: number;
	/** What to do when it trips: "nudge" (push a message, reset, keep going) or
	 * "stop". Default "nudge". */
	reaction?: "nudge" | "stop";
	/** TRUE = the "stop" reaction becomes a HARD stop (`agent.abort()`) — the
	 * tool chain is frozen dead. Default false = gentle stop() + message. */
	abort?: boolean;
	/** The pushed message on nudge/stop. */
	message?: string;
}

export interface SpinGuardOptions {
	/** Master switch — OFF by default. */
	enabled?: boolean;
	/** Consecutive DISCARDED cycles (a cycle that committed NOTHING — e.g. a
	 * filter calls endCycle() every time) before it trips. Default 5. Timers /
	 * watchers that COMMIT results never trip this — a committed cycle fires
	 * cycleEnd and resets the counter. */
	threshold?: number;
	/** "nudge" (push a message, reset, keep going) or "stop". Default "nudge". */
	reaction?: "nudge" | "stop";
	/** TRUE = hard stop via abort. Default false. */
	abort?: boolean;
	/** The pushed message on nudge/stop. */
	message?: string;
}

export interface RetryBackoffOptions {
	/** Base delay in ms. Default 500. */
	baseMs?: number;
	/** Exponential factor. Default 2. */
	factor?: number;
	/** Add ±50% jitter. Default true. */
	jitter?: boolean;
	/** Single-sleep ceiling in ms. Default 10_000. */
	maxMs?: number;
}

export interface RetryOptions {
	/** Master switch — OFF by default. */
	enabled?: boolean;
	/** Tool name globs to retry (`"fetch_*"`, `"*"`). Default ["*"]. */
	tools?: string[];
	/** Total attempts per call (1 = no retry). Default 3. */
	attempts?: number;
	/** Backoff between attempts. */
	backoff?: RetryBackoffOptions;
	/** Which error results are worth another attempt. Default: transient-only
	 * (errorMessage matches /timeout|429|5\d\d|ECONN|ENOTFOUND|temporar/i, or an
	 * `invalid_arguments` NEVER retries — bad args are the model's job). */
	retryOn?: (info: { name: string; parameters: Record<string, unknown>; answer: string; errorMessage?: string }) => boolean;
	/** Last resort: substitute a typed result so the turn continues instead of
	 * committing the final error. Omit = the final error commits honestly. */
	fallback?: (info: { name: string; parameters: Record<string, unknown>; answer: string; errorMessage?: string; attempts: number }) => { answer: string; error?: boolean; errorMessage?: string };
}

export interface LoopControlOptions {
	doomLoop?: DoomLoopOptions;
	maxTurns?: MaxTurnsOptions;
	/** Total-step budget — provider round-trips + committed tool results. */
	maxSteps?: MaxStepsOptions;
	/** Consecutive-tool guard — the model keeps calling tools without answering. */
	maxConsecutiveTools?: MaxConsecutiveToolsOptions;
	/** Spin guard — a filter that discards cycle after cycle (committing
	 * nothing) means the loop is stuck at 100Hz. Counts consecutive
	 * `cycleDiscarded` events; resets on any committed cycle. */
	spinGuard?: SpinGuardOptions;
	/** Tool-call retry — re-invoke erroring tools at the afterTool patch point
	 * (before commit) with backoff. Transient-only by default. */
	retry?: RetryOptions;
	/** Where loop-control activity lives in session state. Default "loopControl". */
	stateKey?: string;
}

/** The state key this plugin owns (session state — observable, resumable). */
export const LOOP_CONTROL_STATE_KEY = "loopControl";

const DEFAULT_DOOM: Required<Omit<DoomLoopOptions, "ask" | "toolNames">> & {
	ask?: DoomLoopOptions["ask"];
	toolNames?: string[];
} = {
	enabled: false,
	threshold: 3,
	reaction: "nudge",
	keyOn: "tool",
	maxNudges: 2,
	escalateTo: "stop",
	ask: undefined,
	toolNames: undefined,
};

const DEFAULT_MAX_TURNS: Required<MaxTurnsOptions> = {
	enabled: false,
	cap: 200,
	announceLast: true,
	finalMessage: "**Budget exhausted.** Stopping here.",
};

const DEFAULT_MAX_STEPS: Required<MaxStepsOptions> = {
	enabled: false,
	cap: 200,
	announceLast: true,
	finalMessage: "**Step budget exhausted.** Stopping here.",
	abort: false,
};

const DEFAULT_MAX_CONSECUTIVE_TOOLS: Required<MaxConsecutiveToolsOptions> = {
	enabled: false,
	cap: 10,
	reaction: "nudge",
	abort: false,
	message:
		"**[loop-control]** You have made many consecutive tool calls without producing a final answer. Produce your final answer now, or ask a clarifying question.",
};

const DEFAULT_SPIN_GUARD: Required<SpinGuardOptions> = {
	enabled: false,
	threshold: 5,
	reaction: "nudge",
	abort: false,
	message:
		"**[loop-control]** The loop discarded several cycles without committing anything — a filter may be stuck in a veto loop. Investigate before continuing.",
};

const TRANSIENT_RE = /timeout|429|5\d\d|ECONN|ENOTFOUND|EAI_AGAIN|temporar|rate.limit|overloaded|unavailable/i;

/** Default retry predicate: transient-only, never invalid_arguments. */
export function defaultRetryOn(info: { errorMessage?: string; answer: string }): boolean {
	if (info.errorMessage === "invalid_arguments") return false;
	return TRANSIENT_RE.test(`${info.errorMessage ?? ""} ${info.answer}`);
}

/** `*` = anything (glob-ish, single-pattern). Case-sensitive tool names. */
function toolGlobMatch(pattern: string, name: string): boolean {
	if (pattern === "*") return true;
	const re = pattern.split("*").map((s) => s.replace(/[.+^${}()|[\]\\?]/g, "\\$&")).join(".*");
	return new RegExp(`^${re}$`).test(name);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

const NUDGE_TEXT = (tool: string, count: number) =>
	`**[loop-control]** You have called \`${tool}\` ${count} times in a row and each call returned an error. ` +
	`Stop and re-read the last tool result before calling again — the arguments or the approach are wrong. ` +
	`Do NOT repeat the same call until you have changed something.`;

const LAST_TURN_TEXT =
	"**[loop-control]** Budget notice: this is your last turn. Wrap up now — commit any pending work (files, session state) and give your final answer.";

const LAST_STEP_TEXT =
	"**[loop-control]** Budget notice: this is your last step. Wrap up now — commit any pending work and give your final answer.";

/** Stable stringify — key order independent, so equivalent args hash the same. */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const keys = Object.keys(value as Record<string, unknown>).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

/** Build the counter key for a tool result, per `keyOn`. */
function doomKey(
	keyOn: "tool" | "tool+args",
	tool: string,
	turn: Record<string, unknown> | undefined,
	agent: GodObject,
): string {
	if (keyOn === "tool") return `tool|${tool}`;
	// tool+args — find the matching call's parameters through the history
	const callId = turn?.toolCallId as string | undefined;
	if (typeof callId === "string") {
		for (const m of [...agent.messages].reverse()) {
			if (m.type !== "toolCall") continue;
			const stored = (
				m.content as
					| { stored?: { id?: string; parameters?: unknown }[] }
					| undefined
			)?.stored;
			const call = stored?.find((c) => c.id === callId);
			if (call) return `args|${tool}|${stableStringify(call.parameters)}`;
		}
	}
	return `args|${tool}|`;
}

/** Push a `user` message into the history so the model sees it next turn. */
function pushUser(agent: GodObject, text: string): void {
	const msg: Message = {
		id: `loop-control-${randomUUID().slice(0, 8)}`,
		enabled: true,
		type: "user",
		content: [{ type: "text", content: text }],
	};
	agent.messages.push(msg);
}

/** Reflect an action on the observable state — a UI can watch this. */
function record(
	agent: GodObject,
	stateKey: string,
	patch: Record<string, unknown>,
): void {
	const cur =
		(agent.state[stateKey] as Record<string, unknown> | undefined) ?? {};
	agent.state[stateKey] = { ...cur, ...patch };
}

// ----------------------------------------------------------------------------
// The plugin
// ----------------------------------------------------------------------------

export function loopControl(opts: LoopControlOptions = {}): Plugin {
	const stateKey = opts.stateKey ?? LOOP_CONTROL_STATE_KEY;
	const doom = { ...DEFAULT_DOOM, ...(opts.doomLoop ?? {}) };
	const maxTurns = { ...DEFAULT_MAX_TURNS, ...(opts.maxTurns ?? {}) };
	const maxSteps = { ...DEFAULT_MAX_STEPS, ...(opts.maxSteps ?? {}) };
	const maxConsTools = { ...DEFAULT_MAX_CONSECUTIVE_TOOLS, ...(opts.maxConsecutiveTools ?? {}) };
	const spinGuard = { ...DEFAULT_SPIN_GUARD, ...(opts.spinGuard ?? {}) };
	const retryCfg = opts.retry ?? {};
	const retryEnabled = retryCfg.enabled === true;
	const retryTools = retryCfg.tools ?? ["*"];
	const retryAttempts = Math.max(1, Math.floor(retryCfg.attempts ?? 3));
	const retryBackoff = {
		baseMs: retryCfg.backoff?.baseMs ?? 500,
		factor: retryCfg.backoff?.factor ?? 2,
		jitter: retryCfg.backoff?.jitter ?? true,
		maxMs: retryCfg.backoff?.maxMs ?? 10_000,
	};
	const retryOn = retryCfg.retryOn ?? defaultRetryOn;

	// the hot counters — plugin closure (fast, no patch storm)
	const counts = new Map<string, number>(); // key → consecutive error count
	const nudges = new Map<string, number>(); // key → nudges sent (resets on success)
	const crossed = new Set<string>(); // keys that hit threshold this cycle
	// max-turns bookkeeping
	let turnCount = 0;
	let announcedLast = false;
	let stoppedBudget = false;
	// max-steps + consecutive-tools bookkeeping
	let stepCount = 0;
	let announcedLastStep = false;
	let stoppedStepBudget = false;
	let consecutiveTools = 0;
	// spin-guard counter — consecutive discarded cycles
	let spinCount = 0;

	/** Decide what to do for a key that crossed the doom threshold this cycle. */
	function handleDoom(
		agent: GodObject,
		key: string,
	): void {
		const tool = key.split("|")[1];
		const count = counts.get(key) ?? 0;
		const nudged = nudges.get(key) ?? 0;

		if (nudged >= doom.maxNudges) {
			// repeated nudges ignored → escalate
			if (doom.escalateTo === "ask") {
				askDoom(agent, key, tool, count);
			} else {
				counts.set(key, 0);
				nudges.set(key, 0);
				pushUser(
					agent,
					`**[loop-control]** Giving up: \`${tool}\` failed ${count} times in a row with errors and ignored the warnings. Stopping.`,
				);
				record(agent, stateKey, {
					lastAction: "stop",
					tool,
					count,
					at: Date.now(),
				});
				agent.stop();
			}
			return;
		}

		if (doom.reaction === "ask") {
			askDoom(agent, key, tool, count);
			return;
		}

		// nudge
		nudges.set(key, nudged + 1);
		pushUser(agent, NUDGE_TEXT(tool, count));
		record(agent, stateKey, {
			lastAction: "nudge",
			tool,
			count,
			at: Date.now(),
		});
	}

	/** Park the loop awaiting; the human (or channel input) decides continue/stop. */
	function askDoom(
		agent: GodObject,
		key: string,
		tool: string,
		count: number,
	): void {
		const id = `loop-control-doom-${randomUUID().slice(0, 8)}`;
		agent.pendingAwaits.push({
			type: "loop-control/doom",
			id,
			schema: { key, tool, count },
		});
		record(agent, stateKey, {
			lastAction: "ask",
			tool,
			count,
			ref: id,
			at: Date.now(),
		});
	}

	return {
		id: "loop-control",
		install(agent) {
			// ---- RETRY: re-invoke erroring tools at the afterTool patch point
			// (BEFORE commit — the push waits for this filter). Same tool, same
			// params, exponential backoff; the rewritten result commits as if the
			// final attempt were the only one (attempts stamped in stored).
			// Crashes between attempts are safe: nothing commits until we return.
			agent.addFilter({
				event: EVENTS.afterTool,
				id: "loop-control/retry",
				priority: 50,
				fn: async (agent, payload) => {
					if (!retryEnabled) return;
					if (payload === undefined || typeof payload !== "object") return;
					if (!("call" in payload) || !("result" in payload)) return;
					const call = payload.call;
					const result = payload.result;
					if (typeof call !== "object" || call === null || !("name" in call)) return;
					if (typeof result !== "object" || result === null || !("answer" in result)) return;
					const name = call.name;
					if (typeof name !== "string") return;
					if (!retryTools.some((g) => toolGlobMatch(g, name))) return;
					const res = result as { answer: string; error?: boolean; errorMessage?: string; stored?: unknown };
					if (res.error !== true) return; // success commits untouched
					const params =
						"parameters" in call && typeof call.parameters === "object" && call.parameters !== null
							? (call.parameters as Record<string, unknown>)
							: {};
					const info = { name, parameters: params, answer: res.answer, errorMessage: res.errorMessage };
					if (!retryOn(info)) return; // permanent — the model's job
					const tool = agent.tools.find((t) => t.name === name);
					if (!tool || tool.disabled) return; // gone/disabled mid-flight — commit honestly
					let answer = res.answer;
					let errorMessage = res.errorMessage;
					let succeeded = false;
					let attemptsMade = 1; // the original execution already happened
					for (let n = 2; n <= retryAttempts; n++) {
						const wait = Math.min(
							retryBackoff.maxMs,
							retryBackoff.baseMs * retryBackoff.factor ** (n - 2),
						) * (retryBackoff.jitter ? 0.5 + Math.random() / 2 : 1);
						await new Promise((r) => setTimeout(r, wait));
						if (agent.abortSignal.aborted) return; // abort wins — commit the original error
						attemptsMade = n;
						try {
							const raw = await tool.execute(params, agent);
							answer = raw.answer;
							if (raw.error === true) {
								errorMessage = raw.errorMessage;
								if (!retryOn({ name, parameters: params, answer, errorMessage })) break;
							} else {
								succeeded = true;
								errorMessage = undefined;
								res.stored = raw.stored;
								break;
							}
						} catch (err) {
							const message = err instanceof Error ? err.message : String(err);
							answer = `Tool ${name} failed: ${message}`;
							errorMessage = message;
							if (!retryOn({ name, parameters: params, answer, errorMessage })) break;
						}
					}
					if (succeeded) {
						res.answer = answer;
						res.error = undefined;
						res.errorMessage = undefined;
						if (typeof res.stored === "object" && res.stored !== null) {
							(res.stored as Record<string, unknown>).attempts = attemptsMade;
						}
					} else if (retryCfg.fallback) {
						const fb = retryCfg.fallback({ ...info, answer, errorMessage, attempts: attemptsMade });
						res.answer = fb.answer;
						res.error = fb.error;
						res.errorMessage = fb.errorMessage;
					} else {
						res.answer = answer;
						res.errorMessage = errorMessage;
					}
					record(agent, stateKey, {
						lastAction: succeeded ? "retry-recovered" : "retry-exhausted",
						tool: name,
						attempts: attemptsMade,
						at: Date.now(),
					});
				},
			});

			agent.addFilter({
				event: EVENTS.toolEnd,
				id: "loop-control/doom/count",
				priority: 200,
				fn: async (agent) => {
					if (!doom.enabled) return;
					const turn = agent.currentTurn as
						| (Record<string, unknown> & { content?: ToolResultContent | null })
						| undefined;
					const tool = turn?.toolName as string | undefined;
					if (!tool || !turn?.content) return;
					if (doom.toolNames && !doom.toolNames.includes(tool)) return;
					const err = turn.content.error === true;
					const key = doomKey(doom.keyOn, tool, turn, agent);
					if (err) {
						const c = (counts.get(key) ?? 0) + 1;
						counts.set(key, c);
						if (c >= doom.threshold) crossed.add(key);
					} else {
						counts.set(key, 0); // a success resets the failure counter
						nudges.set(key, 0);
					}
				},
			});

			// ---- DOOM-LOOP: act at cycleEnd (once per model round-trip, batch-atomic) ----
			// ---- MAX-TURNS: count cycles + announce last + stop at cap ----
			// ---- MAX-STEPS: each provider round-trip is one step ----
			// ---- MAX-CONSECUTIVE-TOOLS: an assistant answer resets the chain ----
			agent.addFilter({
				event: EVENTS.cycleEnd,
				id: "loop-control/cycle",
				priority: 0,
				fn: async (agent) => {
					// doom
					if (doom.enabled) {
						const keys = [...crossed];
						crossed.clear();
						for (const key of keys) handleDoom(agent, key);
					}

					// max-turns
					if (maxTurns.enabled) {
						turnCount++;
						if (
							maxTurns.announceLast &&
							!announcedLast &&
							turnCount === maxTurns.cap - 1
						) {
							announcedLast = true;
							pushUser(agent, LAST_TURN_TEXT);
						}
						if (!stoppedBudget && turnCount >= maxTurns.cap) {
							stoppedBudget = true;
							pushUser(agent, maxTurns.finalMessage);
							record(agent, stateKey, {
								lastAction: "max-turns",
								count: turnCount,
								at: Date.now(),
							});
							agent.stop();
						}
					}

					// max-steps — a provider round-trip is a step
					if (maxSteps.enabled) {
						stepCount++;
						if (
							maxSteps.announceLast &&
							!announcedLastStep &&
							stepCount === maxSteps.cap - 1
						) {
							announcedLastStep = true;
							pushUser(agent, LAST_STEP_TEXT);
						}
						if (stepCount >= maxSteps.cap) {
							if (maxSteps.abort) {
								if (!stoppedStepBudget) {
									stoppedStepBudget = true;
									agent.abort(maxSteps.finalMessage);
								}
								return;
							}
							if (!stoppedStepBudget) {
								stoppedStepBudget = true;
								pushUser(agent, maxSteps.finalMessage);
								record(agent, stateKey, {
									lastAction: "max-steps",
									count: stepCount,
									at: Date.now(),
								});
							}
							agent.stop();
						}
					}

					// max-consecutive-tools — an assistant answer breaks the chain
					if (maxConsTools.enabled) {
						const last = agent.messages.at(-1);
						if (last && last.type !== "toolResult") consecutiveTools = 0;
					}
				},
			});

			// ---- MAX-STEPS + MAX-CONSECUTIVE-TOOLS: each committed tool result is a step ----
			agent.addFilter({
				event: EVENTS.toolEnd,
				id: "loop-control/step/tool",
				priority: 150,
				fn: async (agent) => {
					if (maxSteps.enabled) {
						stepCount++;
						if (
							maxSteps.announceLast &&
							!announcedLastStep &&
							stepCount === maxSteps.cap - 1
						) {
							announcedLastStep = true;
							pushUser(agent, LAST_STEP_TEXT);
						}
						if (stepCount >= maxSteps.cap) {
							if (maxSteps.abort) {
								// HARD STOP — the turn dies, the worker freezes. Abort is
								// idempotent + terminal; nothing can silently resume.
								if (!stoppedStepBudget) {
									stoppedStepBudget = true;
									agent.abort(maxSteps.finalMessage);
								}
								return;
							}
							if (!stoppedStepBudget) {
								stoppedStepBudget = true;
								pushUser(agent, maxSteps.finalMessage);
								record(agent, stateKey, {
									lastAction: "max-steps",
									count: stepCount,
									at: Date.now(),
								});
							}
							agent.stop(); // gentle — re-requested every step while over cap
						}
					}
					if (maxConsTools.enabled) {
						consecutiveTools++;
						if (consecutiveTools >= maxConsTools.cap) {
							if (maxConsTools.reaction === "stop") {
								consecutiveTools = 0;
								pushUser(agent, maxConsTools.message);
								record(agent, stateKey, {
									lastAction: "max-consecutive-tools",
									count: maxConsTools.cap,
									at: Date.now(),
								});
								if (maxConsTools.abort) agent.abort(maxConsTools.message);
								else agent.stop();
							} else {
								consecutiveTools = 0; // a nudge resets the chain — fresh chances
								pushUser(agent, maxConsTools.message);
								record(agent, stateKey, {
									lastAction: "consecutive-tools-nudge",
									count: maxConsTools.cap,
									at: Date.now(),
								});
							}
						}
					}
				},
			});

			// ---- SPIN-GUARD: consecutive DISCARDED cycles (a stuck veto filter) ----
			agent.addFilter({
				event: EVENTS.cycleDiscarded,
				id: "loop-control/spin/count",
				priority: 100,
				fn: async (agent) => {
					if (!spinGuard.enabled) return;
					spinCount++;
					if (spinCount >= spinGuard.threshold) {
						spinCount = 0; // reset after reacting — fresh chances
						pushUser(agent, spinGuard.message);
						record(agent, stateKey, {
							lastAction: "spin-guard",
							count: spinGuard.threshold,
							at: Date.now(),
						});
						if (spinGuard.abort) agent.abort(spinGuard.message);
						else if (spinGuard.reaction === "stop") agent.stop();
					}
				},
			});

			// ---- SPIN-GUARD reset: ANY committed cycle is progress (timers included) ----
			agent.addFilter({
				event: EVENTS.cycleEnd,
				id: "loop-control/spin/reset",
				priority: 100,
				fn: async () => {
					spinCount = 0;
				},
			});

			// ---- DOOM-LOOP "ask": renderer on the park (optional) ----
			if (doom.reaction === "ask" && doom.ask) {
				const ask = doom.ask;
				let askInFlight = false;
				agent.addFilter({
					event: EVENTS.stop,
					id: "loop-control/doom/ask",
					priority: 50,
					fn: async (agent) => {
						if (agent.loopState !== "awaiting" || askInFlight) return;
						const awaits = agent.pendingAwaits.filter(
						(a) => a.type === "loop-control/doom",
						);
						if (awaits.length === 0) return;
						askInFlight = true;
						void (async () => {
							try {
								for (const a of awaits) {
									const schema = a.schema as {
										key: string;
										tool: string;
										count: number;
									};
									const decision = await ask({
										tool: schema.tool,
										count: schema.count,
										key: schema.key,
									});
									agent.input({
										type: "loop-control-doom-answer",
										ref: a.id,
										decision: decision === "continue" ? "continue" : "stop",
									});
								}
							} finally {
								askInFlight = false;
							}
						})();
					},
				});
			}

			// ---- DOOM-LOOP "ask": resolver — an answer pops the await and resumes/stops ----
			agent.addFilter({
				event: EVENTS.inputReceived,
				id: "loop-control/doom/answer",
				priority: 100,
				fn: async (agent) => {
					const input = agent.currentInput as
						| { type?: string; ref?: string; decision?: "continue" | "stop" }
						| undefined;
					if (
						input?.type !== "loop-control-doom-answer" ||
						typeof input.ref !== "string"
					)
						return;
					const idx = agent.pendingAwaits.findIndex((a) => a.id === input.ref);
					if (idx < 0) return;
					const schema = agent.pendingAwaits[idx].schema as { key?: string };
					agent.pendingAwaits.splice(idx, 1);
					if (schema.key) {
						counts.set(schema.key, 0); // fresh chances whether continue or stop
						nudges.set(schema.key, 0);
					}
					if (input.decision === "stop") agent.stop();
				},
			});

			// ---- CLEANUP: on hard abort, drop parked doom awaits — no hang ----
			agent.addFilter({
				event: EVENTS.beforeAbort,
				id: "loop-control/doom/cleanup",
				priority: 100,
				fn: async (agent) => {
					const kept = agent.pendingAwaits.filter(
						(a) => a.type !== "loop-control/doom",
					);
					agent.pendingAwaits.splice(0, agent.pendingAwaits.length, ...kept);
				},
			});

			agent.addDeclaredCapability({
				id: "loop-control",
				description: "doom-loop detection + max-turns budget (optional guardrails)",
			});
		},

		uninstall(agent) {
			counts.clear();
			nudges.clear();
			crossed.clear();
			announcedLast = false;
			stoppedBudget = false;
			turnCount = 0;
			announcedLastStep = false;
			stoppedStepBudget = false;
			stepCount = 0;
			consecutiveTools = 0;
			spinCount = 0;
			removeFiltersByPrefix(agent, "loop-control/");
			agent.removeDeclaredCapability("loop-control");
			delete agent.state[stateKey];
		},
	};
}

// a convenience default — OFF, ready to `.install(loopControl())` and tune
export const loopControlGuard: Plugin = loopControl();
