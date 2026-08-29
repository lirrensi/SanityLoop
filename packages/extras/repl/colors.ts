// ============================================================================
// repl/colors.ts — tiny ANSI helper for the REPL micro-TUI
// ============================================================================
// Inline escape codes, no dep. The REPL stays light — chalk is overkill.
// All `style()` calls wrap with the reset code, so chaining is safe.
//
// Markdown rendering uses `marked` for tokenization (proper parser), then walks
// the token tree emitting ANSI-styled output. Supports: headings, paragraphs,
// bold/em, code spans + code blocks, ordered/unordered lists, blockquotes,
// horizontal rules, links. Image tokens collapse to "[image: alt]" (terminal
// images are a full TUI concern — out of scope here).
// ============================================================================

import { marked, type Token } from "marked";

/** ANSI escape codes — the building blocks. */
export const c = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	italic: "\x1b[3m",
	underline: "\x1b[4m",
	// Foreground colors
	black: "\x1b[30m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
	cyan: "\x1b[36m",
	white: "\x1b[37m",
	// Bright variants
	gray: "\x1b[90m",
} as const;

/** Wrap `text` with the given ANSI styles + a reset. */
export function style(
	text: string,
	...styles: (string | false | undefined | null)[]
): string {
	const active = styles.filter(Boolean).join("");
	if (!active) return text;
	return `${active}${text}${c.reset}`;
}

/** Named styles — convenience for the common cases. */
export const s = {
	dim: (t: string) => style(t, c.dim),
	bold: (t: string) => style(t, c.bold),
	italic: (t: string) => style(t, c.italic),
	underline: (t: string) => style(t, c.underline),
	red: (t: string) => style(t, c.red),
	green: (t: string) => style(t, c.green),
	yellow: (t: string) => style(t, c.yellow),
	blue: (t: string) => style(t, c.blue),
	magenta: (t: string) => style(t, c.magenta),
	cyan: (t: string) => style(t, c.cyan),
	gray: (t: string) => style(t, c.gray),
	// combinations
	tool: (t: string) => style(t, c.cyan, c.bold),
	error: (t: string) => style(t, c.red, c.bold),
	success: (t: string) => style(t, c.green),
	warn: (t: string) => style(t, c.yellow),
	stats: (t: string) => style(t, c.gray),
	thinking: (t: string) => style(t, c.dim, c.italic),
};

/** Strip ALL ANSI codes — useful when you need plain text (e.g. width calculations). */
export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Visible width of a string (excluding ANSI codes). */
export function visibleWidth(text: string): number {
	return stripAnsi(text).length;
}

// ============================================================================
// Markdown rendering — marked.lexer → ANSI-styled text
// ============================================================================

/** Render a markdown string to ANSI-colored terminal output. */
export function formatMarkdown(text: string): string {
	const tokens = marked.lexer(text);
	return renderBlock(tokens).trimEnd();
}

/** Walk a block-level token list. */
function renderBlock(tokens: Token[]): string {
	return tokens.map(renderBlockToken).join("");
}

function renderBlockToken(token: Token): string {
	switch (token.type) {
		case "heading": {
			const hashes = "#".repeat((token as { depth: number }).depth);
			return `\n${s.bold(s.cyan(hashes))} ${renderInline((token as { tokens: Token[] }).tokens)}\n`;
		}
		case "paragraph":
			return `${renderInline((token as { tokens: Token[] }).tokens)}\n`;
		case "code":
			// Code block — dim + green, indented
			return `${s.green(
				(token as { text: string }).text
					.split("\n")
					.map((l) => `  ${l}`)
					.join("\n"),
			)}\n`;
		case "blockquote": {
			const inner = renderBlock(
				(token as { tokens: Token[] }).tokens,
			).trimEnd();
			return `${inner
				.split("\n")
				.map((l) => s.italic(s.gray(`│ ${l}`)))
				.join("\n")}\n`;
		}
		case "list": {
			const t = token as { ordered: boolean; items: { tokens: Token[] }[] };
			return `${t.items.map((item, i) => `${s.gray(t.ordered ? `${i + 1}.` : "•")} ${renderBlock(item.tokens).trimEnd()}`).join("\n")}\n`;
		}
		case "hr":
			return `${s.gray("────────────")}\n`;
		case "space":
			return "\n";
		case "table":
			return `${s.dim("[table — terminal tables are a full TUI concern]")}\n`;
		default: {
			// Fallback: render as inline
			const inline = renderInline([token]);
			if (inline) return `${inline}\n`;
			return "";
		}
	}
}

/** Walk an inline-level token list. */
function renderInline(tokens: Token[]): string {
	return tokens.map(renderInlineToken).join("");
}

function renderInlineToken(token: Token): string {
	switch (token.type) {
		case "text":
			return (token as { text: string }).text;
		case "strong":
			return s.bold(renderInline((token as { tokens: Token[] }).tokens));
		case "em":
			return s.italic(renderInline((token as { tokens: Token[] }).tokens));
		case "codespan":
			return s.green(s.dim((token as { text: string }).text));
		case "br":
			return "\n";
		case "link": {
			const t = token as { href: string; tokens: Token[]; text: string };
			return `${s.cyan(s.underline(renderInline(t.tokens)))} ${s.gray(`(${t.href})`)}`;
		}
		case "image": {
			const t = token as { href: string; text?: string };
			return s.gray(`[image: ${t.text || t.href}]`);
		}
		case "del":
			return s.dim(renderInline((token as { tokens: Token[] }).tokens));
		case "escape":
			return (token as { text: string }).text;
		default:
			return "";
	}
}
