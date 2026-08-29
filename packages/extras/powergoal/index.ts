// ============================================================================
// sanity/src/extras/powergoal/index.ts — the goal loop (T-0020, second edition).
// ============================================================================
// Works like the loops engine — land → dwell → kick — but the point is
// DIFFERENT: a goal PERSISTS until someone proves it DONE. Ported from the TUI
// powergoal plugin ("prevents exit until you mark it complete"), upgraded with
// the second step: THE CHECKER.
//
//   agent.install(powerGoal({
//     objective: "make the tests pass",
//     check: ({ report }) => report.includes("all tests passed")
//       ? true                      // confirmed — goal completes ITSELF
//       : "tests still failing",    // not done — reason rides the next kick
//   }));
//
// THE CYCLE:
//   arm → initial kick ("# Started goal") → agent works → LANDING →
//   CHECK: is the goal completed based on the last assistant message (the
//   report)?  yes → complete (no more kicks; quit-on-end sees no work and the
//   process exits gracefully).  no → dwell → "# Pursuing goal" kick (+ the
//   checker's reason, so the model knows what is missing) → repeat.
//
// THE CHECKER is a hard function or an async judge — it receives the report
// and may consult anything (regex, files, another model call). It gates BOTH
// completion doors: the automatic landing check AND the model's manual
// manage_goal(set_status:"complete") request. No checker configured → only
// the tool completes (original plugin semantics).
//
// manage_goal TOOL — set_status:
//   active   — start/restart (goal_text required) — "the only way in"
//   complete — REQUEST completion; passes through the same checker; refusal
//              comes back as the tool answer (what the model sees)
//   blocked  — park the pursuit without deleting it
//
// STATE IS TRUTH: mirror at state[stateKey] — tombstone terminal statuses,
// external flips adopted at every event (flip to completed = human override,
// no checker consulted), externally armable by writing {objective,status:"active"}.
//
// PREVENT-EXIT BY COMPOSITION: kicks are followup inputs injected DURING the
// landing chain, so hasWork stays true through quit-on-end's agentEnd check —
// an active goal keeps the process alive without touching quit logic at all.
// ============================================================================
import { EVENTS } from "@sanityloop/core";
import type { GodObject, Plugin, ToolDefinition } from "@sanityloop/core";
import { InputTypes } from "@sanityloop/inputs";
import type { FollowupInput } from "@sanityloop/inputs";
import { removeFiltersByPrefix } from "@sanityloop/util";
import { randomUUID } from "node:crypto";

// ----------------------------------------------------------------------------
// Options + context types
// ----------------------------------------------------------------------------

/** What the checker receives at every landing. `report` is the last assistant
 * message's text — the model's most recent word on the matter. */
export interface GoalCheckContext {
	objective: string;
	report: string;
	elapsedMs: number;
	fires: number;
	agent: GodObject;
}

/**
 * true               → confirmed complete (goal finishes itself)
 * false / undefined  → not done, keep pursuing
 * string             → not done + reason (rides the next pursuing kick,
 *                      comes back from a refused tool request)
 */
export type GoalCheckResult = boolean | string | null | undefined;

export interface PowerGoalOptions {
	/** Pre-arm the goal at install. Omit = armed later via the manage_goal tool. */
	objective?: string;
	/** Silence before each pursuing kick after a landing. Default 10_000. */
	dwellMs?: number;
	/** Shorter dwell when arming into an already-idle heartbeat. Default 3_000. */
	shortDwellMs?: number;
	/** After this many pursuing kicks, append the manage_goal hint. Default 2. */
	hintAfter?: number;
	/** Pass-through to kick inputs — evaluate `cmd` spans at insertion. Default false. */
	backticksCommand?: boolean;
	/** THE CHECKER — runs at every landing while active, and gates tool completions. */
	check?: (ctx: GoalCheckContext) => GoalCheckResult | Promise<GoalCheckResult>;
	/** HARD abort behavior. Default "stop" (TUI parity: interrupt kills the pursuit). */
	onAbort?: "stop" | "keep";
	/** Where the state mirror lives. Default "powerGoal". */
	stateKey?: string;
	/** Plugin id. Default "powergoal". */
	id?: string;
}

interface GoalStatus {
	objective: string;
	status: "active" | "completed" | "blocked" | "stopped";
	startedAt: number;
	fires: number;
	lastFireAt?: number;
	nextFireAt?: number;
	lastReason?: string;
}

export interface PowerGoalSnapshot extends Omit<GoalStatus, "lastReason"> {
	lastReason?: string;
}

const DEFAULT_DWELL_MS = 10_000;
const DEFAULT_SHORT_DWELL_MS = 3_000;
const DEFAULT_HINT_AFTER = 2;

const GOAL_START_PREFIX = "# Started goal:";
const GOAL_FOLLOWUP_PREFIX = "# Pursuing goal:";
const GOAL_COMPLETION_HINT = "(use 'manage_goal' for completion)";

function fmtElapsed(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	const m = Math.floor(s / 60);
	const h = Math.floor(m / 60);
	if (s < 60) return `${s}s`;
	if (m < 60) return `${m}m`;
	if (m % 60 === 0) return `${h}h`;
	return `${h}h ${m % 60}m`;
}

/** The last assistant text — THE REPORT the checker judges. */
function lastReport(agent: GodObject): string {
	for (let i = agent.messages.length - 1; i >= 0; i--) {
		const m = agent.messages[i];
		if (m.type !== "assistant") continue;
		const parts = m.content as { type: string; content?: string }[] | undefined;
		if (!Array.isArray(parts)) continue;
		return parts
			.filter((p) => p.type === "text" && typeof p.content === "string")
			.map((p) => p.content)
			.join("\n");
	}
	return "";
}

function buildKick(goal: GoalStatus, kind: "initial" | "pursue"): string {
	if (kind === "initial") return `${GOAL_START_PREFIX}\n${goal.objective}`;
	const hint = goal.fires >= DEFAULT_HINT_AFTER ? `\n\n${GOAL_COMPLETION_HINT}` : "";
	const reason = goal.lastReason ? `\n\nchecker: ${goal.lastReason}` : "";
	return `${GOAL_FOLLOWUP_PREFIX}\n${goal.objective}${reason}${hint}`;
}

// ----------------------------------------------------------------------------
// The plugin
// ----------------------------------------------------------------------------

export function powerGoal(opts: PowerGoalOptions = {}): Plugin {
	const pluginId = opts.id ?? "powergoal";
	const stateKey = opts.stateKey ?? "powerGoal";
	const prefix = `${pluginId}/`;
	const check = opts.check;
	const hintAfter = opts.hintAfter ?? DEFAULT_HINT_AFTER;

	let goal: GoalStatus | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;

	/** THE DWELL IS A PARKED AWAIT — not a naked timer. While the pursuit waits
	 * to kick again, the machine is honestly "awaiting": hasWork stays true,
	 * quit-on-end sees pending work and stands down (PREVENT-EXIT), dashboards
	 * render the pause. The timeout ANSWERS the await, then the kick injects. */
	const dwellType = `${pluginId}/dwell`;
	function parkDwell(agent: GodObject, ms: number, onFire: () => void): void {
		clearTimer();
		const id = `${dwellType}-${randomUUID().slice(0, 8)}`;
		agent.pendingAwaits.push({ type: dwellType, id });
		timer = setTimeout(() => {
			timer = undefined;
			const idx = agent.pendingAwaits.findIndex((a) => a.id === id);
			if (idx >= 0) agent.pendingAwaits.splice(idx, 1);
			onFire();
		}, ms);
	}
	function clearDwell(agent: GodObject): void {
		if (timer) clearTimeout(timer);
		timer = undefined;
		const kept = agent.pendingAwaits.filter((a) => a.type !== dwellType);
		agent.pendingAwaits.splice(0, agent.pendingAwaits.length, ...kept);
	}

	function reflect(agent: GodObject): void {
		agent.state[stateKey] = goal ? { ...goal } : undefined;
	}

	function clearTimer(): void {
		if (timer) clearTimeout(timer);
		timer = undefined;
		if (goal && goal.status === "active") goal.nextFireAt = undefined;
	}

	function syncFromState(agent: GodObject): void {
		const snap = agent.state[stateKey] as PowerGoalSnapshot | undefined;
		if (!snap) {
			// externally deleted — drop everything
			clearDwell(agent);
			goal = null;
			return;
		}
		if (!goal || goal.objective !== snap.objective || goal.startedAt !== snap.startedAt) {
			// fresh external arm (or replaced record) — adopt it wholesale
			clearDwell(agent);
			goal = { ...snap };
			return;
		}
		// same record — adopt status transitions (tombstones stay visible)
		if (snap.status !== goal.status) {
			goal.status = snap.status;
			clearDwell(agent);
			if (typeof snap.lastReason === "string") goal.lastReason = snap.lastReason;
		}
	}

	function complete(agent: GodObject, why: string): string {
		clearDwell(agent);
		if (!goal) return "No active goal.";
		const obj = goal.objective;
		const elapsed = fmtElapsed(Date.now() - goal.startedAt);
		goal.status = "completed";
		goal.nextFireAt = undefined;
		reflect(agent);
		agent.setActivity(`goal '${obj}' completed (${why})`);
		return `Goal completed: ${obj}. Elapsed: ${elapsed}. (${why})`;
	}

	function stopAll(agent: GodObject, status: "blocked" | "stopped", why: string): string {
		clearDwell(agent);
		if (!goal) return `No active goal to ${status === "blocked" ? "block" : "stop"}.`;
		goal.status = status;
		goal.nextFireAt = undefined;
		reflect(agent);
		agent.setActivity(`goal '${goal.objective}' ${status} (${why})`);
		return status === "blocked" ? `Goal blocked: ${goal.objective}` : `Goal stopped: ${goal.objective}`;
	}

	function injectKick(agent: GodObject, kind: "initial" | "pursue"): void {
		if (!goal || goal.status !== "active") return;
		const input: FollowupInput = {
			type: InputTypes.followup,
			text: buildKick(goal, kind),
			...(opts.backticksCommand === true ? { backticksCommand: true } : {}),
		};
		goal.fires += kind === "pursue" ? 1 : 0;
		goal.lastFireAt = Date.now();
		reflect(agent);
		agent.setActivity(
			`goal '${goal.objective}' — ${kind === "initial" ? "starting" : `kick #${goal.fires}`}`,
		);
		agent.input(input);
	}

	/** Run THE CHECKER against the last report. Returns refusal reason or null
	 * when confirmed / when there is no checker (tool path completes directly). */
	async function runCheck(
		agent: GodObject,
	): Promise<{ confirmed: boolean; reason?: string }> {
		if (!check || !goal) return { confirmed: true };
		const result = await check({
			objective: goal.objective,
			report: lastReport(agent),
			elapsedMs: Date.now() - goal.startedAt,
			fires: goal.fires,
			agent,
		});
		if (result === true) return { confirmed: true };
		if (typeof result === "string" && result.trim().length > 0) {
			goal.lastReason = result.trim();
			return { confirmed: false, reason: result.trim() };
		}
		goal.lastReason = undefined;
		return { confirmed: false };
	}

	/** Landing: check first (auto-completion), then pursue. */
	async function onLanding(agent: GodObject): Promise<void> {
		syncFromState(agent);
		if (!goal || goal.status !== "active") return;

		const verdict = await runCheck(agent);
		if (verdict.confirmed) {
			complete(agent, "confirmed by checker");
			return;
		}
		reflect(agent); // lastReason now observable

		const dwell = opts.dwellMs ?? DEFAULT_DWELL_MS;
		goal.nextFireAt = Date.now() + dwell;
		parkDwell(agent, dwell, () => {
			if (!goal || goal.status !== "active") return;
			injectKick(agent, "pursue");
		});
		reflect(agent);
	}

	/** Arm immediately when the heartbeat is already alive and silent — otherwise
	 * the first landing starts the cycle (SDK installs usually pre-run). */
	function armNowIfIdle(agent: GodObject, kind: "initial" | "pursue"): void {
		if (!goal || goal.status !== "active") return;
		if (!(agent.ticks > 0 && agent.loopState === "idle" && !agent.inTurn)) return;
		const dwell = opts.shortDwellMs ?? DEFAULT_SHORT_DWELL_MS;
		goal.nextFireAt = Date.now() + dwell;
		parkDwell(agent, dwell, () => {
			if (!goal || goal.status !== "active") return;
			injectKick(agent, kind);
		});
		reflect(agent);
	}

	function arm(agent: GodObject, objective: string, kind: "initial" | "pursue"): string {
		clearDwell(agent);
		goal = { objective, status: "active", startedAt: Date.now(), fires: 0, lastReason: undefined };
		reflect(agent);
		armNowIfIdle(agent, kind);
		return `Goal active: ${objective}`;
	}

	// ---- manage_goal — the model's door ----
	const manageGoalTool: ToolDefinition = {
		name: "manage_goal",
		description:
			"Set, complete, or block the active goal. The only way to exit the goal loop besides satisfying its checker.",
		inputSchema: {
			type: "object",
			properties: {
				set_status: { type: "string", enum: ["active", "complete", "blocked"] },
				goal_text: { type: "string", description: "REQUIRED when set_status is 'active'." },
				note: { type: "string", description: "Optional note (e.g. why you believe the goal is complete)." },
			},
			required: ["set_status"],
		},
		async execute(params, agent) {
			const p = params as { set_status?: string; goal_text?: unknown; note?: unknown };
			const status = p.set_status;

			if (status === "active") {
				const text = typeof p.goal_text === "string" ? p.goal_text.trim() : "";
				if (!text) return { answer: "Error: goal_text is required when setting status to 'active'." };
				syncFromState(agent);
				if (goal?.status === "active") {
					return {
						answer: `Already pursuing: "${goal.objective}" (${fmtElapsed(Date.now() - goal.startedAt)}). Block or complete it first.`,
					};
				}
				const answer = arm(agent, text, "initial");
				return { answer };
			}

			if (status === "complete") {
				syncFromState(agent);
				if (!goal || goal.status !== "active") return { answer: "No active goal to complete." };
				const verdict = await runCheck(agent);
				if (!verdict.confirmed) {
					reflect(agent);
					const reason = verdict.reason ?? "the checker is not satisfied yet";
					return {
						answer: `Goal NOT confirmed — keep working. checker: ${reason}${
							typeof p.note === "string" && p.note.trim() ? ` (your note: "${p.note.trim()}")` : ""
						}`,
					};
				}
				return { answer: complete(agent, typeof p.note === "string" && p.note.trim() ? `via manage_goal: ${p.note.trim()}` : "via manage_goal") };
			}

			if (status === "blocked") {
				syncFromState(agent);
				return { answer: stopAll(agent, "blocked", "via manage_goal") };
			}

			return { answer: "Unknown status." };
		},
	};

	return {
		id: pluginId,
		requires: ["inputs"], // kicks ARE followup inputs
		install(agent) {
			clearTimer();
			goal = null;
			agent.addTool(manageGoalTool);

			if (opts.objective) arm(agent, opts.objective, "initial");

			// ---- LANDING — check, then pursue ----
			agent.addFilter({
				event: EVENTS.stop,
				id: `${prefix}landing`,
				priority: 85,
				fn: async (agent) => {
					await onLanding(agent);
				},
			});

			// ---- ACTIVITY cancels the pending kick ----
			agent.addFilter({
				event: EVENTS.turnStart,
				id: `${prefix}activity`,
				priority: 90,
				fn: async (agent) => {
					syncFromState(agent);
					if (goal?.status === "active" && timer) {
						clearDwell(agent);
						reflect(agent);
					}
				},
			});

			// ---- HARD ABORT — default: interrupt kills the pursuit ----
			agent.addFilter({
				event: EVENTS.beforeAbort,
				id: `${prefix}abort-cleanup`,
				priority: 100,
				fn: async (agent) => {
					if ((opts.onAbort ?? "stop") !== "stop") return;
					syncFromState(agent);
					stopAll(agent, "stopped", "abort");
				},
			});

			agent.addDeclaredCapability({
				id: pluginId,
				description:
					"goal loop — persists until its checker confirms the report or manage_goal completes it",
			});
			agent.addDeclaredInput({
				id: `${pluginId}/kick`,
				schema: null,
				description: "internal — goal kicks inject input_followup ('# Started/Pursuing goal')",
			});
		},

		uninstall(agent) {
			clearDwell(agent);
			goal = null;
			removeFiltersByPrefix(agent, prefix);
			agent.removeTool("manage_goal");
			agent.removeDeclaredCapability(pluginId);
			agent.removeDeclaredInput(`${pluginId}/kick`);
			delete agent.state[stateKey];
		},
	};
}
