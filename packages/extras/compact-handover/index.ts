// sanity/src/extras/compact-handover/index.ts - handover compaction.
// Triggered like basic-compaction — threshold (contextUsage >= threshold) OR
// on-demand (`agent.input({ type: requestCompactInput })`) — but instead
// of a silent side-channel summary call it injects a USER message asking the model
// to produce a SESSION HANDOVER: theme, quick description, chronological walk with
// direct quotes + importance marks, final state. The model writes it to a file in
// a temp folder using WHATEVER file-write tool it has (basic-fs-tools write,
// hash-fs-tools replace, bash, ...) - no plugin dependency declared, the model
// adapts. The model's reply (which must contain the file path) then becomes the
// new context: messages are cleared and the handover reply is inserted as the
// summary, exactly like compaction does. The file stays behind for grepping by
// quote/anchor anytime.

// On-demand requests: mid-turn → stop() the loop, the stop-trigger injects the
// handover request at the landing; idle → inject immediately (startHandover).

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENTS } from "@sanityloop/core";
import type { Filter, Message, Plugin } from "@sanityloop/core";
import { normalizeForAlternation } from "@sanityloop/core";
import { removeFiltersByPrefix, requestCompactInput } from "@sanityloop/util";

export interface CompactHandoverOptions {
	/** Fraction of maxContext that triggers the handover. Default: 0.7. */
	threshold?: number;
	/** Non-system messages kept after the handover. Default: 8. */
	keepRecent?: number;
	/** Where handover meta lives in session state. Default: "handover". */
	stateKey?: string;
	/** Temp folder for the handover file. Default: <os tmpdir>/sanity-handovers. */
	dir?: string;
	/** Custom instruction for the handover request. Default: built-in prompt. */
	handoffInstruction?: string;
}

/** Flatten a message to its visible text — same helper as basic-compaction. */
function messageText(m: Message): string {
	const c = m.content;
	if (Array.isArray(c)) {
		return (c as { type?: string; content?: string }[])
			.filter((b) => b.type === "text")
			.map((b) => b.content ?? "")
			.join("");
	}
	if (c && typeof c === "object" && "answer" in c) {
		const face = c as unknown as { answer?: unknown; stored?: unknown };
		const names =
			Array.isArray(face.stored) &&
			(face.stored as { name?: string }[]).length > 0
				? ` [${(face.stored as { name?: string }[]).map((s) => s.name ?? "?").join(", ")}]`
				: "";
		return `${String(face.answer ?? "")}${names}`;
	}
	return "";
}

function defaultInstruction(dir: string): string {
	return (
		"You are asked to produce a SESSION HANDOVER because the conversation has grown past the context budget. " +
		"Write the handover to the file at the path given below using your file-write tool " +
		"(write, replace, or any other tool that can create files). If you have NO file-writing tool, " +
		"write the full handover inline in your reply instead.\n\n" +
		"The handover must contain, in this order:\n" +
		"1. THEME — one line: what this session is about.\n" +
		"2. QUICK DESCRIPTION — 2-4 sentences.\n" +
		"3. CHRONOLOGICAL WALK — each theme/topic in the order it appeared, and for each:\n" +
		"   - QUOTE: the exact text of the message where it started (verbatim, so it can be grepped in the transcript later),\n" +
		"   - NOTES: 2-3 sentences on what happened,\n" +
		'   - IMPORTANCE: mark "important" or "minor" and why it matters for continuing the work.\n' +
		"4. FINAL STATE — files touched, decisions made, open threads, next step.\n\n" +
		`The handover file goes to: ${dir}\n\n` +
		"When done, reply with a short confirmation: the file path and the one-line THEME. " +
		"The reply MUST contain the file path."
	);
}

/**
 * Handover compaction — same trigger as basic-compaction, but the "summary" is a
 * real model turn: a user message asks for the handover, the model writes the file
 * with its own tools, and its reply becomes the compacted context.
 */
export function createCompactHandover(
	opts: CompactHandoverOptions = {},
): Plugin {
	const threshold = opts.threshold ?? 0.7;
	const keepRecent = opts.keepRecent ?? 8;
	const stateKey = opts.stateKey ?? "handover";
	const dir = opts.dir ?? join(tmpdir(), "sanity-handovers");
	const instruction = opts.handoffInstruction ?? defaultInstruction(dir);

	let handoverRequested = false; // request injected, awaiting the model's answer turn
	let requestId = "";
	let requestFile = "";
	let baseSnapshot: Message[] = []; // messages before the request went in

	/** Find the last assistant text message — the model's handover answer. */
	function lastAssistant(list: Message[]): Message | undefined {
		for (let i = list.length - 1; i >= 0; i--) {
			if (list[i].type === "assistant") return list[i];
		}
		return undefined;
	}

	/** The rebuild step — exactly compaction's dance, with the handover as summary. */
	function compactWithHandover(agent: {
		messages: Message[];
		state: Record<string, unknown>;
		wake(): void;
	}): void {
		const handoverMsg = lastAssistant(agent.messages);
		const text =
			(handoverMsg ? messageText(handoverMsg) : "").trim() ||
			"(empty handover)";

		const systemMessages = baseSnapshot.filter((m) => m.type === "system");
		const baseTail = baseSnapshot
			.filter((m) => m.type !== "system" && m.enabled)
			.slice(-keepRecent);
		// real user inputs that arrived DURING the handover turn must survive it
		const newOnes = agent.messages
			.slice(baseSnapshot.length)
			.filter((m) => m.type === "user" && m.id !== requestId);

		// alternation trims — same rules as compaction (summary is user, tail must not
		// start user-user or end assistant-assistant)
		const tail = [...baseTail, ...newOnes];
		while (tail.length > 0 && tail[0].type === "user") tail.shift();
		while (tail.length > 0 && tail[tail.length - 1].type === "assistant")
			tail.pop();
		while (tail.length > 0 && tail[0].type === "toolResult") tail.shift();

		const summaryMsg: Message = {
			id: `handover-summary-${randomUUID().slice(0, 8)}`,
			enabled: true,
			type: "user", // keeps role alternation legal — the next model reply follows
			content: [
				{
					type: "text",
					content: `[Earlier conversation compacted — handover file: ${requestFile}]\n\n${text}`,
				},
			],
		};

		const rebuilt = normalizeForAlternation([
			...systemMessages,
			summaryMsg,
			...tail,
		]);
		agent.messages.splice(0, agent.messages.length, ...rebuilt);
		(agent.state as Record<string, unknown>)[stateKey] = {
			at: Date.now(),
			file: requestFile,
		};
		agent.state.compacting = false;
		handoverRequested = false;
		agent.wake();
	}

	const watcher: Filter = {
		event: EVENTS.afterProviderResponse,
		id: "compact-handover/watcher",
		priority: 100,
		fn: async (agent) => {
			if (agent.state.compacting) return;
			const usage = agent.stats.contextUsage;
			if (typeof usage !== "number" || usage < threshold) return;
			agent.state.compacting = true;
			agent.stop(); // current response commits, loop halts at the landing
		},
	};

	/** Inject the handover request — shared by the stop-trigger and the on-demand input. */
	function startHandover(agent: {
		messages: Message[];
		wake(): void;
	}): void {
		handoverRequested = true;
		baseSnapshot = [...agent.messages];
		requestId = `handover-request-${randomUUID().slice(0, 8)}`;
		requestFile = join(
			dir,
			`handover-${Date.now()}-${randomUUID().slice(0, 6)}.md`,
		);
		mkdirSync(dir, { recursive: true }); // the model writes the file itself; dir just exists
		agent.messages.push({
			id: requestId,
			enabled: true,
			type: "user",
			content: [
				{
					type: "text",
					content: `${instruction}\n\nWrite the handover file to: ${requestFile}`,
				},
			],
		});
		agent.wake(); // the loop starts a fresh turn with the request (tools present)
	}

	const trigger: Filter = {
		event: EVENTS.stop,
		id: "compact-handover/trigger",
		priority: 0,
		fn: async (agent) => {
			if (!agent.state.compacting || handoverRequested) return;
			startHandover(agent);
		},
	};

	const onDemand: Filter = {
		event: EVENTS.inputReceived,
		id: "compact-handover/on-demand",
		priority: 0,
		fn: async (agent) => {
			const input = agent.currentInput;
			if (!input || input.type !== requestCompactInput) return;
			if (agent.state.compacting || handoverRequested) return; // one at a time
			agent.state.compacting = true;
			if (agent.loopState === "running") {
				// mid-turn → current response commits, the loop lands, the trigger
				// injects the handover request at the landing
				agent.stop();
			} else {
				// idle/parked → no landing coming; inject the request right now
				startHandover(agent);
			}
		},
	};

	const catcher: Filter = {
		event: EVENTS.turnEnd,
		id: "compact-handover/catcher",
		priority: 100,
		fn: async (agent) => {
			if (!handoverRequested) return;
			compactWithHandover(agent);
		},
	};

	const cleanup: Filter = {
		event: EVENTS.abort,
		id: "compact-handover/cleanup",
		priority: 0,
		fn: async (agent) => {
			agent.state.compacting = false;
			handoverRequested = false;
		},
	};

	return {
		id: "compact-handover",
		install(agent) {
			agent.addFilter(watcher);
			agent.addFilter(onDemand);
			agent.addFilter(trigger);
			agent.addFilter(catcher);
			agent.addFilter(cleanup);
			agent.addDeclaredCapability({
				id: "compact-handover",
				description: "session handover (theme + quotes + file export)",
			});
		},
		uninstall(agent) {
			removeFiltersByPrefix(agent, "compact-handover/");
			agent.removeDeclaredCapability("compact-handover");
		},
	};
}
