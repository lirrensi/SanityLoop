// ============================================================================
// repl/index.ts — THE REPL AS A PLUGIN. A real TUI session, still a plugin.
// ============================================================================
// The interactive session, packaged whole. Install it and any agent becomes a
// terminal with a REAL input block (bordered multiline editor + slash-command
// autocomplete + status bar), built on @sanityloop/tui:
//
//   agent.install(createReplPlugin({ prompt: "you> " }));  // options optional
//
// STATE IS THE SCREEN: the input box is a projection of draft+cursor+popup
// state; every newline on screen is ours, so redraws are exact ("up N, clear,
// repaint"). Agent output flows through printAbove() — the box lifts, output
// lands in scrollback, the box drops back. You can keep typing mid-turn.
//
// KEYS (the contract):
//   enter      send — steers when a turn is running, else a fresh message;
//              with the popup open it accepts the highlighted suggestion
//   alt+enter  queue as followup (lands after the running turn)
//   escape     dismiss popup → abort running turn → clear draft (that order)
//   ctrl+j / shift+enter   newline inside the draft
//   tab        accept the highlighted slash command
//   ctrl+c     abort while running; twice within 2s while idle quits
//
// SLASH COMMANDS LISTEN TO PLUGINS: everything declared via
// addDeclaredInput() automatically becomes /<id> [text] — with description and
// tab-completion — plus builtins and any opts.commands overrides.
//
// Non-TTY stdin/stdout falls back to plain readline so pipes and e2e harnesses
// keep working untouched.
// ============================================================================
import { createInterface } from "node:readline";
import { EVENTS, formatStatsBlock, formatStatsLine } from "@sanityloop/core";
import type { GodObject, Plugin } from "@sanityloop/core";
import { removeFiltersByPrefix, toolAnswer, toolNames, requestClearInput, requestResetInput } from "@sanityloop/util";
import { agentSnapshot } from "@sanityloop/snapshot";
import {
	createInputBlock,
	decodePrintableKey,
	matchesKey,
	parseKey,
	formatStatusBar,
	type Suggestion,
} from "@sanityloop/tui";
import { s, formatMarkdown } from "./colors.ts";

export interface ReplOptions {
	/** Fallback prompt in non-TTY (pipe) mode. Default: "you> ". */
	prompt?: string;
	/** Custom slash commands: "/name" (or "name") → fn(agent, args). */
	commands?: Record<string, (agent: GodObject, args: string) => void>;
}

/** Inputs that are KEYBOUND — never exposed as slash commands. */
const KEYBOUND_INPUTS = new Set(["steer", "followup", "abort-request", "stop-request"]);

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

export function createReplPlugin(opts: ReplOptions = {}): Plugin {
	return {
		id: "repl",
		install(agent) {
			const tty = process.stdin.isTTY && process.stdout.isTTY && typeof process.stdin.setRawMode === "function";
			if (tty) installTui(agent, opts);
			else installReadline(agent, opts);
		},
		uninstall(agent) {
			removeFiltersByPrefix(agent, "repl/");
			agent.removeDeclaredCapability("repl");
		},
	};
}

// ============================================================================
// shared plumbing
// ============================================================================

interface ReplCommand {
	name: string; // with leading slash
	description: string;
	run: (agent: GodObject, args: string) => void | Promise<void>;
	source: "builtin" | "declared" | "custom";
}

function declaredInputCommands(agent: GodObject): ReplCommand[] {
	const out: ReplCommand[] = [];
	for (const decl of agent.listDeclaredInputs()) {
		const id = decl.id;
		if (KEYBOUND_INPUTS.has(id)) continue;
		out.push({
			name: `/${id}`,
			description: decl.description ?? "declared input",
			run: (_a, args) => {
				agent.input(args ? { type: id, text: args } : { type: id });
			},
			source: "declared",
		});
	}
	return out;
}

function collectCommands(agent: GodObject, opts: ReplOptions): Map<string, ReplCommand> {
	const map = new Map<string, ReplCommand>();
	for (const c of builtinCommands(opts)) if (!map.has(c.name)) map.set(c.name, c);
	for (const c of declaredInputCommands(agent)) if (!map.has(c.name)) map.set(c.name, c);
	if (opts.commands) {
		for (const [raw, fn] of Object.entries(opts.commands)) {
			const name = raw.startsWith("/") ? raw : `/${raw}`;
			map.set(name, { name, description: "custom command", run: fn, source: "custom" });
		}
	}
	return map;
}

/** Execute a "/name args" line. Returns true if a command ran. */
function runSlash(text: string, agent: GodObject, opts: ReplOptions, out: (t: string) => void): boolean {
	const [name, ...rest] = text.trim().split(/\s+/);
	const cmd = collectCommands(agent, opts).get(name.toLowerCase());
	if (!cmd) return false;
	void Promise.resolve(cmd.run(agent, rest.join(" "))).catch((e: unknown) => {
		out(s.error(`✖ ${cmd.name}: ${e instanceof Error ? e.message : String(e)}`));
	});
	return true;
}

// ============================================================================
// TUI MODE
// ============================================================================

function installTui(agent: GodObject, opts: ReplOptions): void {
	// ---- output sink: EVERYTHING goes above the box ----
	const printRaw = (text: string): void => block.printAbove(text);
	emit = printRaw; // builtin commands join the same pipeline

	// ---- the box ----
	const block = createInputBlock({
		onSubmit: (text) => {
			if (text.startsWith("/")) {
				runSlash(text, agent, opts, printRaw);
				block.render();
				return;
			}
			agent.input(agent.inTurn ? { type: "input_steer", text } : { type: "input_followup", text });
			updateBar();
			block.render();
		},
		onFollowup: (text) => {
			if (text.startsWith("/")) {
				runSlash(text, agent, opts, printRaw);
				block.render();
				return;
			}
			agent.input({ type: "input_followup", text });
			updateBar();
			block.render();
		},
	});

	block.setSuggestionsProvider((text): Suggestion[] => {
		const q = text.trim().toLowerCase();
		if (!q) return [];
		return [...collectCommands(agent, opts).values()]
			.filter((c) => c.name.startsWith(q))
			.map((c) => ({ name: c.name, description: c.description }));
	});

	// ---- live stream tally — NOTHING raw is painted during generation. The
	//      status bar carries progress (`● 412ch`); exactly ONE pretty
	//      markdown block lands when the text finishes. No duplication is
	//      possible, and pane scrolling can't corrupt what we never track. ----
	let streaming = false;
	let streamedChars = 0;
	let streamBuf = "";

	function updateBar(): void {
		const busy = agent.loopState === "running" || agent.inTurn;
		const stateLabel = streaming ? `\x1b[36m● ${streamedChars} ch\x1b[0m` : busy ? "working" : agent.loopState;
		block.setBar(
			formatStatusBar({
				model: abbreviate(agent.model.modelId, 28),
				context: ctxUsage(),
				state: stateLabel,
				pending: agent.pendingInputs.sync.length + agent.pendingInputs.async.length,
				hints: [
					["↵", busy ? "steer" : "send"],
					["alt+↵", "followup"],
					["esc", busy ? "abort" : "clear"],
				],
			}),
		);
		if (streaming) block.render(); // keep the tally fresh while generating
	}

	function ctxUsage(): string | undefined {
		try {
			const m = /ctx (\S+)/.exec(formatStatsLine(agent.stats, { maxContext: agent.model.maxContext }));
			return m?.[1];
		} catch {
			return undefined;
		}
	}

	// ---- filters: same event spine as v1, new mouth ----
	agent.addFilter({ event: EVENTS.turnStart, id: "repl/turn", priority: 100, fn: async () => { updateBar(); } });
	agent.addFilter({
		event: EVENTS.beforeProviderRequest,
		id: "repl/thinking",
		priority: 100,
		fn: async () => {
			if (!streaming) {
				streaming = true;
				streamedChars = 0;
				streamBuf = "";
			}
			updateBar();
		},
	});
	agent.addFilter({
		event: EVENTS.textDelta,
		id: "repl/text-delta",
		priority: 100,
		fn: async (_a, event) => {
			const sd = (event as { streamDelta?: { delta: string; type: string } })?.streamDelta;
			if (sd?.type !== "textDelta") return;
			streaming = true;
			streamedChars += sd.delta.length;
			streamBuf += sd.delta;
			updateBar();
		},
	});
	agent.addFilter({
		event: EVENTS.thinkingDelta,
		id: "repl/thinking-delta",
		priority: 100,
		fn: async (_a, event) => {
			const sd = (event as { streamDelta?: { delta: string; type: string } })?.streamDelta;
			if (sd?.type === "thinkingDelta") {
				streamedChars += sd.delta.length; // counted, never painted
				updateBar();
			}
		},
	});
	agent.addFilter({
		event: EVENTS.textEnd,
		id: "repl/text-end",
		priority: 100,
		fn: async () => {
			const md = tryMarkdown(streamBuf);
			streamBuf = "";
			if (md) printRaw(md);
		},
	});
	agent.addFilter({
		event: EVENTS.afterProviderResponse,
		id: "repl/after-provider",
		priority: 100,
		fn: async () => {
			updateBar();
		},
	});
	agent.addFilter({
		event: EVENTS.toolStart,
		id: "repl/tool-start",
		priority: 100,
		fn: async (a) => {
			printRaw(`\n${s.tool(`⚙ ${toolNames(a, a.currentTurn)}`)} ${s.gray("→")}`);
		},
	});
	agent.addFilter({
		event: EVENTS.toolEnd,
		id: "repl/tool-end",
		priority: 100,
		fn: async (a) => {
			const answer = toolAnswer(a.currentTurn);
			if (!answer) return;
			const lines = answer.split("\n");
			const MAX = 40;
			const body = lines.slice(0, MAX).map((l) => `${s.gray("← ")}${l}`);
			if (lines.length > MAX) body.push(s.gray(`  … ${lines.length - MAX} more lines`));
			printRaw(body.join("\n"));
		},
	});
	agent.addFilter({
		event: EVENTS.error,
		id: "repl/error",
		priority: 100,
		fn: async (_a, event) => {
			const msg = (event as { message?: string })?.message ?? "turn failed";
			printRaw(`\n${s.error(`✖ ${msg}`)}`);
			streaming = false;
			updateBar();
		},
	});
	agent.addFilter({
		event: EVENTS.abort,
		id: "repl/abort",
		priority: 100,
		fn: async () => {
			printRaw(`\n${s.warn("(aborted)")}`);
			streaming = false;
			updateBar();
		},
	});
	agent.addFilter({
		event: EVENTS.inputReceived,
		id: "repl/input-feedback",
		priority: -1,
		fn: async (a) => {
			const t = (a.currentInput as { type?: string } | undefined)?.type;
			if (t === "input_steer" && a.inTurn) printRaw(s.gray("↳ steer queued"));
			else if (t === "input_followup" && a.inTurn) printRaw(s.gray("↳ followup queued"));
			else if (t === "input_followup" || t === "input_steer") printRaw(s.gray("↳ sent"));
			updateBar();
		},
	});
	agent.addFilter({
		event: EVENTS.stop,
		id: "repl/auto-stats",
		priority: 1,
		fn: async (a) => {
			if (a.loopState !== "idle") return;
			streaming = false;
			streamBuf = "";
			const last = a.messages.at(-1);
			if (last?.stats) {
				const line = formatStatsBlock(a.stats, { maxContext: a.model.maxContext, lastUsage: last.stats });
				printRaw(`${s.gray("── ")}${line}${s.gray(" ──")}`);
			}
			updateBar();
		},
	});

	// ---- keyboard ----
	let ctrlCArmed = 0;
	let lastChunk = "";
	let lastChunkAt = 0;

	const cleanup = (): void => {
		process.stdout.write("\x1b[?2004l");
		block.showCursor();
		try {
			process.stdin.setRawMode(false);
		} catch {
			/* stdin already detached */
		}
	};

	const routeChunk = (chunk: Buffer): void => {
		let data = chunk.toString("utf8");

		// ConPTY echo-guard: the Windows tmux/ConPTY bridge re-delivers some
		// writes as a second identical chunk milliseconds later. Humans can't
		// repeat an identical chunk inside the window; real terminal echo
		// doesn't exist in raw mode, so duplicates are always the bridge.
		const now = Date.now();
		if (data === lastChunk && now - lastChunkAt < 30) return;
		lastChunk = data;
		lastChunkAt = now;

		// bracketed paste — unwrap and pour into the draft as literal text
		if (data.includes(BRACKETED_PASTE_START) || data.includes(BRACKETED_PASTE_END)) {
			data = data.split(BRACKETED_PASTE_START).join("").split(BRACKETED_PASTE_END).join("");
			if (!data) return;
			block.insertText(data.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
			block.render();
			return;
		}

		// multi-char printable burst without escapes → paste-like insert
		if (data.length > 1 && !data.includes("\x1b")) {
			block.insertText(data.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
			block.render();
			return;
		}

		const keyId = parseKey(data);

		if (keyId === "ctrl+c") {
			if (agent.loopState === "running" || agent.inTurn) {
				printRaw(s.warn("(aborting…)"));
				agent.abort();
				return;
			}
			const now = Date.now();
			if (now - ctrlCArmed < 2000) {
				block.hide();
				cleanup();
				process.exit(0);
			}
			ctrlCArmed = now;
			printRaw(s.gray("(ctrl+c again to exit)"));
			return;
		}
		if (keyId === "escape") {
			if (block.dismissPopup()) return void block.render();
			if (agent.loopState === "running" || agent.inTurn) return void agent.abort();
			if (block.getText()) {
				block.clearDraft();
				block.render();
			}
			return;
		}
		if (keyId === "enter" || keyId === "return") {
			if (block.popupOpen()) {
				block.acceptSuggestion();
				block.render();
				return;
			}
			block.submit();
			return;
		}
		if (matchesKey(data, "alt+enter")) {
			block.submitFollowup();
			return;
		}
		if (keyId === "tab") {
			if (block.popupOpen()) block.acceptSuggestion();
			block.render();
			return;
		}

		if (keyId && block.handleKey(keyId)) return void block.render();

		// Plain printable text (the common case — decodePrintableKey only
		// knows Kitty CSI-u / modifyOtherKeys flavors). Anything without an
		// escape prefix that survived the key routers above is literal text.
		if (!data.includes("\x1b")) {
			const text = [...data].filter((ch) => ch >= " " || ch === "\t").join("");
			if (text) {
				block.insertText(text);
				block.render();
			}
			return;
		}

		const printable = decodePrintableKey(data);
		if (printable) {
			block.insertText(printable);
			block.render();
		}
	};

	process.stdin.on("data", routeChunk);
	process.stdout.on("resize", () => block.render());
	process.on("exit", () => process.stdout.write("\x1b[?2004l"));

	// ---- boot ----
	// Raw mode ON, but the key router waits one tick while a discard listener
	// swallows anything already sitting in the pty — Windows ConPTY replays
	// the shell's echoed command line into freshly-raw stdin, which would
	// otherwise be typed into our draft (or submitted!) as a ghost prompt.
	process.stdin.setRawMode(true);
	block.init(); // hardware cursor off — the box draws its own caret
	const discard = (b: Buffer): void => void b;
	process.stdin.on("data", discard);
	setTimeout(() => {
		process.stdin.off("data", discard);
		process.stdin.on("data", routeChunk);
	}, 60);
	process.stdin.resume();
	process.stdout.write("\x1b[?2004h");
	process.stdout.write("\x1b[?2004h");
	printRaw(
		`${s.bold(s.cyan("sanityloop"))} ${s.gray("· /help commands · ↵ send · alt+↵ followup · esc abort")}`,
	);
	updateBar();
	block.render();

	agent.addDeclaredCapability({
		id: "repl",
		description: "interactive terminal session (TUI input block, dynamic slash commands, streaming)",
	});
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function abbreviate(t: string, max: number): string {
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function tryMarkdown(raw: string): string | null {
	try {
		if (!raw.trim()) return null;
		return formatMarkdown(raw);
	} catch {
		return null;
	}
}

// ============================================================================
// BUILTIN COMMANDS — shared by both modes
// ============================================================================

function builtinCommands(opts: ReplOptions): ReplCommand[] {
	const list: ReplCommand[] = [];
	const add = (
		name: string,
		description: string,
		run: (a: GodObject, args: string) => void | Promise<void>,
	): void => {
		list.push({ name, description, run, source: "builtin" });
	};

	add("/help", "commands, keys, declared inputs", (a) => {
		const lines: string[] = [s.bold("── commands ──")];
		const groups: Record<string, ReplCommand[]> = { builtin: [], declared: [], custom: [] };
		for (const c of collectCommands(a, opts).values()) groups[c.source].push(c);
		for (const c of groups.builtin) lines.push(`  ${s.cyan(c.name.padEnd(18))} ${s.gray(c.description)}`);
		if (groups.declared.length) {
			lines.push("");
			lines.push(s.bold("── from plugins (declared inputs) ──"));
			for (const c of groups.declared)
				lines.push(`  ${s.green(c.name.padEnd(18))} ${s.gray((c.description ?? "").slice(0, 64))}`);
		}
		if (groups.custom.length) {
			lines.push("");
			lines.push(s.bold("── custom ──"));
			for (const c of groups.custom) lines.push(`  ${s.magenta(c.name.padEnd(18))} ${s.gray(c.description)}`);
		}
		lines.push("");
		lines.push(s.bold("── keys ──"));
		lines.push(`  ${s.cyan("enter")}        ${s.gray("send · steers mid-turn · accepts popup")}`);
		lines.push(`  ${s.cyan("alt+enter")}    ${s.gray("queue followup")}`);
		lines.push(`  ${s.cyan("escape")}       ${s.gray("popup → abort → clear draft")}`);
		lines.push(`  ${s.cyan("ctrl+j")}       ${s.gray("newline")}`);
		lines.push(`  ${s.cyan("tab")}          ${s.gray("accept suggestion")}`);
		lines.push(`  ${s.cyan("ctrl+c")}       ${s.gray("abort · twice idle quits")}`);
		emit(lines.join("\n"));
	});
	add("/status", "model, loop state, queues, capabilities", (a) => {
		const snap = agentSnapshot(a);
		const lines = [
			s.bold("── status ──"),
			`  ${s.cyan("model")}     ${snap.model.modelId} ${s.gray(`(${snap.model.api}, ctx=${snap.model.maxContext ?? "?"})`)}`,
			`  ${s.cyan("loop")}      ${snap.loopState} ${s.gray(`/ runState=${snap.runState} inTurn=${snap.inTurn}`)}`,
			`  ${s.cyan("pending")}   ${JSON.stringify(snap.pendingInputs)}`,
			`  ${s.cyan("messages")}  ${snap.messages}`,
			`  ${s.cyan("capabilities")} ${snap.capabilities.map((c) => c.id).join(", ") || s.gray("(none)")}`,
		];
		emit(lines.join("\n"));
	});
	add("/plugins", "installed plugins", (a) => {
		emit([s.bold("── plugins ──"), ...a.plugins.map((p) => `  ${s.green(p.id)}`)].join("\n"));
	});
	add("/tools", "registered tools", (a) => {
		emit(
			[
				s.bold("── tools ──"),
				...a.tools.map(
					(t) => `  ${s.cyan(t.name)}${t.description ? s.gray(` — ${t.description.split("\n")[0]}`) : ""}`,
				),
			].join("\n"),
		);
	});
	add("/model", "current model + provider + api", (a) => {
		const m = a.model;
		emit(
			[
				s.bold("── model ──"),
				`  ${s.cyan("provider")} ${(m as { provider?: string }).provider ?? s.gray("(unknown)")}`,
				`  ${s.cyan("api")}      ${m.api}`,
				`  ${s.cyan("modelId")}  ${m.modelId}`,
				`  ${s.cyan("stream")}   ${String(m.stream)}`,
				`  ${s.cyan("maxContext")} ${m.maxContext ?? s.gray("(unset)")}`,
			].join("\n"),
		);
	});
	add("/caps", "declared capabilities", (a) => {
		const caps = a.listDeclaredCapabilities();
		emit(
			caps.length
				? [
						s.bold("── capabilities ──"),
						...caps.map((c) => `  ${s.green(c.id)} ${s.gray("—")} ${c.description}`),
					].join("\n")
				: `  ${s.gray("(none declared)")}`,
		);
	});
	add("/exit", "quit (alias: /quit)", () => quit());
	add("/quit", "quit", () => quit());

	/** /clear /reset — soft aliases over DECLARED inputs; honest warnings otherwise. */
	add("/clear", "clear context window (inputs plugin)", (a) => {
		if (!a.getDeclaredInput("clear-request")) return emit(s.warn("no inputs plugin declaring `clear-request`."));
		a.input({ type: requestClearInput });
		emit(s.gray("context window cleared (history preserved)."));
	});
	add("/reset", "reset session to start", (a) => {
		if (!a.getDeclaredInput("reset-request")) return emit(s.warn("no inputs plugin declaring `reset-request`."));
		a.input({ type: requestResetInput });
		emit(s.gray("session reset (process alive)."));
	});
	return list;
}

function quit(): void {
	process.stdout.write("\x1b[?2004l\x1b[?25h");
	process.exit(0);
}

/** Output sink for builtin commands. Rebound per-mode before first use. */
let emit: (text: string) => void = (t) => process.stdout.write(`${t}\n`);

// ============================================================================
// READLINE FALLBACK — non-TTY (pipes, e2e). Same semantics, no ANSI box.
// ============================================================================

function installReadline(agent: GodObject, opts: ReplOptions): void {
	const promptText = opts.prompt ?? "you> ";
	emit = (t) => process.stdout.write(`${t}\n`);
	let rl: ReturnType<typeof createInterface> | undefined;
	let open = false;

	const openPrompt = (): void => {
		if (!rl || open) return;
		open = true;
		rl.question(promptText, (line) => {
			open = false;
			const trimmed = line.trim();
			if (!trimmed) return openPrompt();
			if (trimmed.startsWith("/")) {
				if (runSlash(trimmed, agent, opts, emit)) return openPrompt();
				process.stdout.write(`${s.red(`unknown command: ${trimmed}. type /help.`)}\n`);
				return openPrompt();
			}
			agent.input(
				agent.inTurn ? { type: "input_steer", text: trimmed } : { type: "input_followup", text: trimmed },
			);
			openPrompt();
		});
	};

	agent.addFilter({
		event: EVENTS.inputReceived,
		id: "repl/input-feedback",
		priority: -1,
		fn: async (a) => {
			const t = (a.currentInput as { type?: string } | undefined)?.type;
			if (t === "input_steer") process.stdout.write(`${s.gray("↳ steer queued")}\n`);
			else if (t === "input_followup") process.stdout.write(`${s.gray("↳ queued")}\n`);
		},
	});
	agent.addFilter({
		event: EVENTS.textDelta,
		id: "repl/stream",
		priority: 100,
		fn: async (_a, event) => {
			const sd = (event as { streamDelta?: { delta: string; type: string } })?.streamDelta;
			if (sd?.type === "textDelta") process.stdout.write(sd.delta);
		},
	});
	agent.addFilter({
		event: EVENTS.textEnd,
		id: "repl/newline",
		priority: 100,
		fn: async () => {
			process.stdout.write("\n");
		},
	});
	agent.addFilter({
		event: EVENTS.stop,
		id: "repl/session",
		priority: 0,
		fn: async (a) => {
			if (a.loopState === "idle") setTimeout(openPrompt, 10);
		},
	});

	rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
	rl.on("SIGINT", () => {
		if (agent.inTurn) agent.abort();
		else process.exit(0);
	});

	process.stdout.write(
		`${s.bold(s.cyan("sanityloop"))} ${s.gray(`repl (pipe mode) — ${promptText} /help`)}\n`,
	);
	openPrompt();

	agent.addDeclaredCapability({
		id: "repl",
		description: "interactive terminal session (readline fallback)",
	});
}
