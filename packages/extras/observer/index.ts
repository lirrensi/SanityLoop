// sanity/src/extras/observer.ts — the eyes. A general observer plugin: plug it in,
// it logs everything that's happening. Works on ANY agent, verbosity 1 or 2.
//
//   verbosity 1 — lifecycle headlines: agent/turn/cycle/stop/abort/error, tool
//                 start+end (name), input types. Quiet, the summary of a session.
//   verbosity 2 — everything: + the raw stream (textDelta prints verbatim, like
//                 `tail -f`), tool result answers, provider boundary, message
//                 commits, usage (tokens).
//
// Stream deltas print RAW (no prefix) so the observer doubles as a stream
// viewer; every other line is `[event] detail`. Optional `write` sink for
// redirecting (a file, a socket, a TUI pane) — default is stdout.
//
// EXTRA = optional. Same shape as every other plugin: install / uninstall.
import { EVENTS } from "@sanityloop/core";
import type { EventPayload, GodObject, Plugin } from "@sanityloop/core";
import { formatStatsLine } from "@sanityloop/core";
import {
  LOG_CHANNEL,
  formatLogLine,
  removeFiltersByPrefix,
  toolAnswer,
  toolNames,
} from "@sanityloop/util";
import type { LogEntry } from "@sanityloop/util";

export interface ObserverOptions {
	/** 1 = lifecycle headlines. 2 = + stream + details. Default: 1. */
	verbosity?: 1 | 2;
	/** Output sink. Default: console.log. */
	write?: (line: string) => void;
	/**
	 * Also catch the shared `log` channel (the util/log.ts convention): every
	 * producer's `emitLog` lines print through this observer's sink. Plus, any
	 * DECLARED event under `log/*` (structured log siblings declared before
	 * install) gets its own subscription — producers declare, the observer
	 * discovers, nobody imports anybody. Default: false.
	 */
	logs?: boolean;
}


function messageType(agent: GodObject): string {
	return agent.currentTurn?.type ?? "?";
}

export function createObserverPlugin(opts: ObserverOptions = {}): Plugin {
	const level = opts.verbosity ?? 1;
	const write = opts.write ?? ((line: string) => console.log(line));

	/** [event, minVerbosity, detail] — the whole observation table, data not code. */
	const watches: [string, 1 | 2, (agent: GodObject, event?: EventPayload) => string][] = [
		[EVENTS.agentStart, 1, () => "agent started"],
		[EVENTS.agentEnd, 1, () => "agent ended"],
		[EVENTS.turnStart, 1, () => "turn started"],
		[EVENTS.cycleEnd, 1, () => "cycle ended"],
		[EVENTS.turnEnd, 1, () => "turn ended"],
		[EVENTS.stop, 1, (agent) => `stopped (${agent.loopState})`],
		[EVENTS.abort, 1, () => "aborted"],
		[EVENTS.error, 1, () => "error"],
		[EVENTS.toolStart, 1, (agent) => `tool: ${toolNames(agent, agent.currentTurn)}`],
		[EVENTS.toolEnd, 1, (agent) => `tool done: ${toolNames(agent, agent.currentTurn)}`],
		[
			EVENTS.toolEnd,
			2,
			(agent) => (toolAnswer(agent.currentTurn) ? `→ ${toolAnswer(agent.currentTurn)}` : ""),
		],
		[EVENTS.inputReceived, 1, (agent) => `input: ${agent.currentInput?.type ?? "?"}`],
		[EVENTS.beforeProviderRequest, 2, () => "provider request"],
		[EVENTS.afterProviderResponse, 2, (agent) => `response: ${messageType(agent)}`],
		[
			EVENTS.textDelta,
			2,
			(_ctx, event) => { const sd = (event as any)?.streamDelta; return sd?.type === "textDelta" ? sd.delta : ""; },
		],
		[EVENTS.textEnd, 2, () => "\n"],
		[
			EVENTS.thinkingDelta,
			2,
			(_ctx, event) => { const sd = (event as any)?.streamDelta; return sd?.type === "thinkingDelta" ? sd.delta : ""; },
		],
		[EVENTS.thinkingEnd, 2, () => ""],
		[
			EVENTS.toolcallDelta,
			2,
			(_ctx, event) => { const sd = (event as any)?.streamDelta; return sd?.type === "toolcallDelta" ? sd.delta : ""; },
		],
		[EVENTS.messageAdded, 2, (agent) => `message: ${messageType(agent)}`],
		[
			EVENTS.usage,
			2,
			(agent) => `usage: ${formatStatsLine(agent.stats, { maxContext: agent.model.maxContext })}`,
		],
	];

	return {
		id: "observer",
		install(agent) {
			for (const [event, minLevel, detail] of watches) {
				if (minLevel > level) continue;
				agent.addFilter({
					event,
					id: `observer/${event}${minLevel === 2 && event === EVENTS.toolEnd ? "-result" : ""}`,
					priority: 0,
					fn: async (agent, payload) => {
						const d = detail(agent, payload);
						if (!d) return;
						// STREAM deltas go straight to stdout CONTIGUOUSLY — the text,
						// thinking, and tool JSON assemble live (OpenCode-style, no
						// per-token lines). Lifecycle lines go through `write`.
						if (
							event === EVENTS.textDelta ||
							event === EVENTS.thinkingDelta ||
							event === EVENTS.toolcallDelta ||
							event === EVENTS.textEnd
						) {
							process.stdout.write(d);
						} else {
							write(`[${event}] ${d}`);
						}
					},
				});
			}
			// ---- the log ear: one subscription catches every producer's lines ----
			if (opts.logs) {
				agent.addFilter({
					event: LOG_CHANNEL,
					id: "observer/log",
					priority: 0,
					fn: async (_agent, payload) => {
						write(formatLogLine(payload as unknown as LogEntry));
					},
				});
				// structured siblings — declared promises under "log/*" print as
				// `[log/<name>] {json}`. Declared AFTER this install = not caught;
				// emit on the generic channel instead if you install late.
				for (const d of agent.listDeclaredEvents()) {
					if (!d.id.startsWith("log/")) continue;
					agent.addFilter({
						event: d.id,
						id: `observer/${d.id}`,
						priority: 0,
						fn: async (_agent2, payload) => {
							const { type: _type, ...rest } = payload ?? {};
							write(`[${d.id}] ${JSON.stringify(rest)}`);
						},
					});
				}
			}
			agent.addDeclaredCapability({
				id: "observer",
				description: opts.logs
					? "event observation (lifecycle + stream + shared log channel)"
					: "event observation (lifecycle + stream)",
			});
		},
		uninstall(agent) {
			removeFiltersByPrefix(agent, "observer/");
			agent.removeDeclaredCapability("observer");
		},
	};
}
