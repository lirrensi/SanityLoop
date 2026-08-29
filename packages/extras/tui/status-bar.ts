// ============================================================================
// tui/status-bar.ts — THE BOTTOM LINE. Pure formatter, zero I/O.
// ============================================================================
// One row of truth under the input box: who am I talking to, how full is my
// head, what is the loop doing, and which keys do what. Drawn from whatever
// the REPL passes in — this file never reads agent state itself.
//
//   qwen3-32b · ctx 12.4k/40k · ▶ running · ↵ send  ⎇↵ followup  esc abort
// ============================================================================

/** Segments the REPL assembles from agent state each frame. */
export interface StatusBarParts {
	/** Model id, e.g. "qwen3-32b". */
	model?: string;
	/** Context usage, e.g. "12.4k/40k" (already abbreviated). */
	context?: string;
	/** Loop state word, e.g. "idle" | "running". */
	state?: string;
	/** Number of queued inputs waiting to be consumed. */
	pending?: number;
	/** Key hint pairs, e.g. [["↵","send"],["alt+↵","followup"],["esc","abort"]]. */
	hints?: [string, string][];
}

/** Color a loop-state word: idle = calm green, running = amber, else plain. */
function stateStyle(state: string): ((t: string) => string) {
	if (state === "idle") return green;
	if (state === "running" || state === "in-turn") return yellow;
	return identity;
}

function identity(t: string): string {
	return t;
}
function green(t: string): string {
	return `\x1b[32m${t}\x1b[0m`;
}
function yellow(t: string): string {
	return `\x1b[33m${t}\x1b[0m`;
}
function cyan(t: string): string {
	return `\x1b[36m${t}\x1b[0m`;
}
function dim(t: string): string {
	return `\x1b[90m${t}\x1b[0m`;
}

/** Render the one-line footer. Always fits one row — caller clips if needed. */
export function formatStatusBar(parts: StatusBarParts): string {
	const segs: string[] = [];
	if (parts.model) segs.push(cyan(parts.model));
	if (parts.context) segs.push(dim(`ctx ${parts.context}`));
	if (parts.state) segs.push(stateStyle(parts.state)(parts.state));
	if (typeof parts.pending === "number" && parts.pending > 0)
		segs.push(yellow(`${parts.pending} queued`));
	let left = segs.join(dim(" · "));
	const hints = parts.hints ?? [];
	if (hints.length > 0) {
		const right = hints.map(([key, label]) => dim(`${key} ${label}`)).join(dim("  "));
		left = left ? `${left}  ${right}` : right;
	}
	return left;
}
