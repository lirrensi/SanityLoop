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
// TWO guards today, both error-gated / honest:
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

export interface LoopControlOptions {
	doomLoop?: DoomLoopOptions;
	maxTurns?: MaxTurnsOptions;
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

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

const NUDGE_TEXT = (tool: string, count: number) =>
	`**[loop-control]** You have called \`${tool}\` ${count} times in a row and each call returned an error. ` +
	`Stop and re-read the last tool result before calling again — the arguments or the approach are wrong. ` +
	`Do NOT repeat the same call until you have changed something.`;

const LAST_TURN_TEXT =
	"**[loop-control]** Budget notice: this is your last turn. Wrap up now — commit any pending work (files, session state) and give your final answer.";

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

	// the hot counters — plugin closure (fast, no patch storm)
	const counts = new Map<string, number>(); // key → consecutive error count
	const nudges = new Map<string, number>(); // key → nudges sent (resets on success)
	const crossed = new Set<string>(); // keys that hit threshold this cycle
	// max-turns bookkeeping
	let turnCount = 0;
	let announcedLast = false;
	let stoppedBudget = false;

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
			// ---- DOOM-LOOP: count consecutive erroring calls at toolEnd ----
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
			removeFiltersByPrefix(agent, "loop-control/");
			agent.removeDeclaredCapability("loop-control");
			delete agent.state[stateKey];
		},
	};
}

// a convenience default — OFF, ready to `.install(loopControl())` and tune
export const loopControlGuard: Plugin = loopControl();
