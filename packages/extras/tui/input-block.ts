// ============================================================================
// tui/input-block.ts — THE INPUT BOX. Anchor-painted bottom editor, no framework.
// ============================================================================
// The pinned bottom region of the screen: [popup?] [box] [status bar]. All
// rendering is plain ANSI over raw stdout.
//
// PAINTING MODEL — "the anchor": before the region is first painted we SAVE
// the cursor position (DECSC, \x1b7). Every repaint RESTORES that position
// (\x1b8), clears down, and repaints the whole region. Output goes through
// printAbove(), which restores, clears, prints (may scroll), then RE-ANCHORS
// at the new free spot. There is ZERO relative cursor arithmetic anywhere —
// no up-N/down-N to get wrong, no pending-wrap drift, nothing. The physical
// cursor stays hidden; the caret you see is DRAWN (inverse space) at the
// draft's cursor position, so focus never depends on hardware cursor state.
//
// Keys are parsed OUTSIDE (keys.ts, vendored from pi). This file owns editing
// behavior; the REPL intercepts its bound keys (enter / alt+enter / escape /
// ctrl+c) before delegating everything else here.
// ============================================================================

/** One completable item (slash command). */
export interface Suggestion {
	name: string;
	description?: string;
}

export interface InputBlockOptions {
	/** Enter was pressed with no popup eating it. */
	onSubmit: (text: string) => void;
	/** Alt+Enter — queue as followup regardless of loop state. */
	onFollowup: (text: string) => void;
	/** Terminal width source; defaults to process.stdout.columns. */
	width?: () => number;
}

const POPUP_MAX = 6;

const SAVE_CURSOR = "\x1b7";
const RESTORE_CURSOR = "\x1b8";
const CLEAR_DOWN = "\x1b[0J";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

// ---------------------------------------------------------------------------
// width math (approximate but conservative — we never let the terminal wrap)
// ---------------------------------------------------------------------------

/** Rough per-codepoint width: 2 for common wide ranges, else 1. */
function charWidth(cp: number): number {
	if (
		(cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
		(cp >= 0x2e80 && cp <= 0xa4cf) || // CJK Radicals..Yi
		(cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
		(cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
		(cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compatibility Forms
		(cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1f64f) || // emoji blocks (rough)
		(cp >= 0x1f900 && cp <= 0x1f9ff) ||
		(cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+
	)
		return 2;
	return 1;
}

function visibleWidth(text: string): number {
	let w = 0;
	for (const ch of text) w += charWidth(ch.codePointAt(0) ?? 0);
	return w;
}

function truncate(text: string, max: number): string {
	if (visibleWidth(text) <= max) return text;
	const out: string[] = [];
	let w = 0;
	for (const ch of text) {
		const cw = charWidth(ch.codePointAt(0) ?? 0);
		if (w + cw > max - 1) break;
		out.push(ch);
		w += cw;
	}
	return `${out.join("")}…`;
}

/** Truncate an already-styled row to `max` VISIBLE columns (ANSI-aware). */
function truncateStyled(text: string, max: number): string {
	const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
	if (visibleWidth(stripped) <= max) return text;
	let w = 0;
	let result = "";
	for (const m of text.matchAll(/\x1b\[[0-9;]*m|./gsu)) {
		const tok = m[0];
		if (tok.startsWith("\x1b")) {
			result += tok;
			continue;
		}
		const cw = charWidth(tok.codePointAt(0) ?? 0);
		if (w + cw > max - 1) break;
		result += tok;
		w += cw;
	}
	return `${result}\x1b[0m…`;
}

/** Split a logical (plain) line into visual rows fitting `max` columns. */
function wrapLine(line: string, max: number): string[] {
	if (line === "") return [""];
	const rows: string[] = [];
	let cur = "";
	let curW = 0;
	for (const ch of line) {
		const cw = charWidth(ch.codePointAt(0) ?? 0);
		if (curW + cw > max) {
			rows.push(cur);
			cur = "";
			curW = 0;
		}
		cur += ch;
		curW += cw;
	}
	rows.push(cur);
	return rows;
}

// ---------------------------------------------------------------------------
// styles (local — the kit stays dependency-free)
// ---------------------------------------------------------------------------
const dim = (t: string): string => `\x1b[90m${t}\x1b[0m`;
const cyan = (t: string): string => `\x1b[36m${t}\x1b[0m`;
const inverse = (t: string): string => `\x1b[7m${t}\x1b[0m`;

export function createInputBlock(opts: InputBlockOptions) {
	const widthOf = opts.width ?? (() => process.stdout.columns ?? 80);

	// ---- state (the truth; render() projects it) ----
	let lines: string[] = [""];
	let cursorLine = 0;
	let cursorCol = 0; // codepoint index within lines[cursorLine]
	let placeholder = "type a message · / for commands";
	let label = "";
	let barText = "";
	let history: string[] = [];
	let historyIndex: number | null = null; // null = not browsing
	let savedDraft = "";
	let suggestions: Suggestion[] = [];
	let selectedSuggestion = 0;
	let suggestProvider: ((text: string) => Suggestion[]) | undefined;
	let anchored = false; // DECSC anchor held at the region's top row

	const write = (s: string): void => {
		process.stdout.write(s);
	};

	// ---- geometry ----
	function totalWidth(): number {
		// NEVER write into the last column: a row ending flush against the
		// right edge leaves the terminal in pending-wrap state.
		return Math.max(20, Math.min(widthOf() - 2, 118));
	}

	// ---- popup bookkeeping ----
	function refreshSuggestions(): void {
		const text = lines.join("\n");
		if (!suggestProvider || !text.startsWith("/") || /\s/.test(text)) {
			suggestions = [];
			selectedSuggestion = 0;
			return;
		}
		suggestions = suggestProvider(text);
		if (selectedSuggestion >= suggestions.length) selectedSuggestion = 0;
	}

	// ---- mutation primitives ----
	function insertText(text: string): void {
		historyIndex = null;
		const parts = text.split("\n");
		for (let i = 0; i < parts.length; i++) {
			if (i > 0) insertNewline();
			const line = lines[cursorLine] ?? "";
			const arr = Array.from(line);
			lines[cursorLine] = arr.slice(0, cursorCol).join("") + parts[i] + arr.slice(cursorCol).join("");
			cursorCol += Array.from(parts[i]).length;
		}
		refreshSuggestions();
	}

	function insertNewline(): void {
		const line = lines[cursorLine] ?? "";
		const arr = Array.from(line);
		lines.splice(cursorLine, 1, arr.slice(0, cursorCol).join(""), arr.slice(cursorCol).join(""));
		cursorLine += 1;
		cursorCol = 0;
		refreshSuggestions();
	}

	function deleteBackward(): void {
		if (cursorCol > 0) {
			const arr = Array.from(lines[cursorLine] ?? "");
			arr.splice(cursorCol - 1, 1);
			lines[cursorLine] = arr.join("");
			cursorCol -= 1;
		} else if (cursorLine > 0) {
			const cur = lines.splice(cursorLine, 1)[0] ?? "";
			cursorLine -= 1;
			cursorCol = Array.from(lines[cursorLine] ?? "").length;
			lines[cursorLine] += cur;
		}
		refreshSuggestions();
	}

	function deleteForward(): void {
		const arr = Array.from(lines[cursorLine] ?? "");
		if (cursorCol < arr.length) {
			arr.splice(cursorCol, 1);
			lines[cursorLine] = arr.join("");
		} else if (cursorLine < lines.length - 1) {
			const next = lines.splice(cursorLine + 1, 1)[0] ?? "";
			lines[cursorLine] += next;
		}
		refreshSuggestions();
	}

	function deleteToLineStart(): void {
		const arr = Array.from(lines[cursorLine] ?? "");
		lines[cursorLine] = arr.slice(cursorCol).join("");
		cursorCol = 0;
		refreshSuggestions();
	}

	function deleteToLineEnd(): void {
		const arr = Array.from(lines[cursorLine] ?? "");
		lines[cursorLine] = arr.slice(0, cursorCol).join("");
		refreshSuggestions();
	}

	function moveHorizontal(delta: number): void {
		if (delta < 0) {
			if (cursorCol > 0) cursorCol -= 1;
			else if (cursorLine > 0) {
				cursorLine -= 1;
				cursorCol = Array.from(lines[cursorLine] ?? "").length;
			}
		} else {
			const len = Array.from(lines[cursorLine] ?? "").length;
			if (cursorCol < len) cursorCol += 1;
			else if (cursorLine < lines.length - 1) {
				cursorLine += 1;
				cursorCol = 0;
			}
		}
	}

	function moveVertical(delta: number): void {
		cursorLine = Math.max(0, Math.min(lines.length - 1, cursorLine + delta));
		const len = Array.from(lines[cursorLine] ?? "").length;
		cursorCol = Math.min(cursorCol, len);
	}

	function restore(text: string): void {
		lines = text.split("\n");
		cursorLine = lines.length - 1;
		cursorCol = Array.from(lines[cursorLine] ?? "").length;
		refreshSuggestions();
	}

	function historyStep(dir: -1 | 1): void {
		if (suggestions.length > 0) return;
		if (dir === -1) {
			if (cursorLine > 0) return moveVertical(-1);
			if (history.length === 0) return;
			if (historyIndex === null) {
				savedDraft = lines.join("\n");
				historyIndex = history.length - 1;
			} else if (historyIndex > 0) {
				historyIndex -= 1;
			} else return;
		} else {
			if (cursorLine < lines.length - 1) return moveVertical(1);
			if (historyIndex === null) return;
			historyIndex += 1;
			if (historyIndex >= history.length) {
				historyIndex = null;
				restore(savedDraft);
				return;
			}
		}
		restore(history[historyIndex] ?? "");
	}

	// ---- painting: anchor-based, zero cursor math --------------------------

	/**
	 * Jump to the anchor (saving it first if this is the first paint), wipe
	 * the region. After this, the cursor sits exactly at region-top col 0,
	 * ready for a full repaint.
	 */
	function syncAnchor(): void {
		if (anchored) write(RESTORE_CURSOR);
		else {
			write(SAVE_CURSOR);
			anchored = true;
		}
		write("\r");
		write(CLEAR_DOWN);
	}

	return {
		insertText,

		/** Editing-level key handling. Returns true if consumed. */
		handleKey(keyId: string): boolean {
			switch (keyId) {
				case "backspace":
					deleteBackward();
					return true;
				case "delete":
					deleteForward();
					return true;
				case "left":
					moveHorizontal(-1);
					return true;
				case "right":
					moveHorizontal(1);
					return true;
				case "home":
					cursorCol = 0;
					return true;
				case "end":
					cursorCol = Array.from(lines[cursorLine] ?? "").length;
					return true;
				case "ctrl+a":
					cursorCol = 0;
					return true;
				case "ctrl+e":
					cursorCol = Array.from(lines[cursorLine] ?? "").length;
					return true;
				case "ctrl+u":
					deleteToLineStart();
					return true;
				case "ctrl+k":
					deleteToLineEnd();
					return true;
				case "ctrl+j":
				case "shift+enter":
					insertNewline();
					return true;
				case "up":
					if (suggestions.length > 0) {
						this.popupStep(-1);
						return true;
					}
					historyStep(-1);
					return true;
				case "down":
					if (suggestions.length > 0) {
						this.popupStep(1);
						return true;
					}
					historyStep(1);
					return true;
				default:
					return false;
			}
		},

		/** Tab / Enter-with-popup: accept the highlighted suggestion. */
		acceptSuggestion(): boolean {
			const s = suggestions[selectedSuggestion];
			if (!s) return false;
			restore(`${s.name} `);
			return true;
		},

		/** Escape #1: close the popup. True if a popup was open. */
		dismissPopup(): boolean {
			if (suggestions.length === 0) return false;
			suggestions = [];
			return true;
		},

		popupOpen(): boolean {
			return suggestions.length > 0;
		},

		popupStep(delta: number): void {
			if (suggestions.length === 0) return;
			const n = suggestions.length;
			selectedSuggestion = (selectedSuggestion + delta + n) % n;
		},

		getText(): string {
			return lines.join("\n");
		},

		/** Wipe the draft WITHOUT touching history (escape at idle). */
		clearDraft(): void {
			lines = [""];
			cursorLine = 0;
			cursorCol = 0;
			historyIndex = null;
			savedDraft = "";
			refreshSuggestions();
		},

		reset(): void {
			const submitted = lines.join("\n").trim();
			if (submitted) {
				history.push(submitted);
				if (history.length > 200) history.shift();
			}
			this.clearDraft();
		},

		submit(): void {
			const text = lines.join("\n").trim();
			if (!text) return;
			this.reset();
			opts.onSubmit(text);
		},

		submitFollowup(): void {
			const text = lines.join("\n").trim();
			if (!text) return;
			this.reset();
			opts.onFollowup(text);
		},

		setSuggestionsProvider(fn: (text: string) => Suggestion[]): void {
			suggestProvider = fn;
			refreshSuggestions();
		},
		setPlaceholder(p: string): void {
			placeholder = p;
		},
		setLabel(l: string): void {
			label = l;
		},
		setBar(text: string): void {
			barText = text;
		},

		// ---- painting -------------------------------------------------------

		/**
		 * Print agent output above the box: restore anchor, wipe region, write
		 * the output (it may scroll — fine), re-anchor at the new free spot,
		 * repaint. The box always ends up pinned under the newest output.
		 */
		printAbove(text: string): void {
			syncAnchor();
			const body = text.endsWith("\n") ? text : `${text}\n`;
			write(body);
			write(SAVE_CURSOR); // re-anchor BELOW the fresh output
			this.render();
		},

		/**
		 * Repaint the whole region from the anchor. Idempotent by design —
		 * double calls just repaint the same spot twice.
		 */
		render(): void {
			syncAnchor();
			const W = totalWidth();
			const field = W - 6; // usable width between `│ ` and ` │`

			// -- popup rows --
			const popRows: string[] = [];
			if (suggestions.length > 0) {
				const shown = suggestions.slice(0, POPUP_MAX);
				const nameW = shown.reduce((m, s) => Math.max(m, s.name.length), 8);
				for (let i = 0; i < shown.length; i++) {
					const sg = shown[i];
					const name = truncate(sg.name.padEnd(nameW), 24);
					const desc = sg.description ? dim(truncate(sg.description, Math.max(10, field - 28))) : "";
					const row = `  ${i === selectedSuggestion ? inverse(` ${name} `) : ` ${cyan(name)} `} ${desc}`;
					popRows.push(truncateStyled(row, W));
				}
				if (suggestions.length > POPUP_MAX)
					popRows.push(dim(`  … +${suggestions.length - POPUP_MAX} more`));
			}

			// -- content rows with DRAWN caret --
			const stripAnsi = (t: string): string => t.replace(/\x1b\[[0-9;]*m/g, "");
			const isEmptyDraft = lines.length === 1 && lines[0] === "";
			const contentRows: string[] = [];
			for (let li = 0; li < lines.length; li++) {
				const lineText = lines[li] ?? "";
				const wrapped = wrapLine(lineText, field);
				// locate the visual row + offset holding the caret within this line
				let acc = 0;
				let caretWi = wrapped.length - 1;
				let caretOff = Array.from(wrapped[caretWi] ?? "").length;
				for (let wi = 0; wi < wrapped.length; wi++) {
					const rowLen = Array.from(wrapped[wi] ?? "").length;
					if (cursorCol <= acc + rowLen) {
						caretWi = wi;
						caretOff = cursorCol - acc;
						break;
					}
					acc += rowLen;
				}
				const prefix = li === 0 ? cyan("› ") : "  ";
				for (let wi = 0; wi < wrapped.length; wi++) {
					const chars = Array.from(wrapped[wi] ?? "");
					const isCaretRow = li === cursorLine && wi === caretWi;
					let cell: string;
					if (isEmptyDraft) {
						cell = isCaretRow ? `${inverse(" ")}${dim(placeholder)}` : "";
					} else if (isCaretRow) {
						cell = `${chars.slice(0, caretOff).join("")}${inverse(" ")}${chars.slice(caretOff).join("")}`;
					} else {
						cell = chars.join("");
					}
					const pad = " ".repeat(Math.max(0, field - visibleWidth(stripAnsi(cell))));
					contentRows.push(`${prefix}${cell}${pad}`);
				}
			}

			// -- compose --
			const title = label ? ` ${label} ` : "";
			const top = title
				? `╭─${cyan(title)}${"─".repeat(Math.max(1, W - visibleWidth(title) - 3))}╮`
				: `╭${"─".repeat(W - 2)}╮`;
			const bottom = `╰${"─".repeat(W - 2)}╯`;

			const rows = [
				...popRows,
				top,
				...contentRows.map((r) => `│ ${truncateStyled(r, field + 2)} │`),
				bottom,
				truncateStyled(barText, W),
			];
			write(rows.join("\n"));
			// cursor intentionally LEFT at end-of-bar; every entry point into
			// the painter starts from the anchor, so this position is never
			// depended upon.
		},

		/** Erase region and unanchor (shutdown, handoff to plain output). */
		hide(): void {
			syncAnchor();
			anchored = false;
			write(SHOW_CURSOR);
		},

		/** Boot: hide the hardware cursor — the caret is drawn by us. */
		init(): void {
			write(HIDE_CURSOR);
		},

		/** Shutdown companion to init(). */
		showCursor(): void {
			write(SHOW_CURSOR);
		},
	};
}
