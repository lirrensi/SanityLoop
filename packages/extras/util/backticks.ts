// sanity/src/extras/util/backticks.ts — shell-command substitution for input texts.
// ============================================================================
// Ported verbatim-in-spirit from the TUI interval/chonoloop plugins: a message
// may embed `cmd` spans; each span runs through execSync and is REPLACED by its
// captured output at EVALUATION time. Never implicit — callers opt in per
// input (`backticksCommand: true`) or per call site.
//
// THE RULES (identical to the plugins):
//   - empty span      → removed
//   - empty output    → "(no output)"
//   - failing command → "(error: <first line>)" — never throws, never drops
//   - hard timeout    → default 5 minutes per command
//
// WHO CALLS THIS: extras/inputs expands at INSERTION moment (the instant a
// queued input becomes a real history message) — never at receipt, so a loop
// armed 50 minutes ago reads the world as-it-is-now, not as-it-was.
import { execSync } from "node:child_process";

export interface ExpandBackticksOptions {
	/** Per-command hard ceiling in ms. Default 300_000 (the plugins' rule). */
	timeoutMs?: number;
}

const DEFAULT_BACKTICK_TIMEOUT_MS = 300_000;

/**
 * Replace every `cmd` span in `text` with the command's captured stdout.
 * Synchronous by design (parity with the TUI plugins): the caller's filter
 * blocks while the command runs, bounded by `timeoutMs`.
 */
export function expandBackticks(text: string, options: ExpandBackticksOptions = {}): string {
	const timeoutMs = options.timeoutMs ?? DEFAULT_BACKTICK_TIMEOUT_MS;
	return text.replace(/`([^`]+)`/g, (_match: string, cmd: string) => {
		const c = cmd.trim();
		if (!c) return "";
		try {
			const out = (
				execSync(c, {
					encoding: "utf-8",
					timeout: timeoutMs,
					windowsHide: true,
					stdio: ["pipe", "pipe", "pipe"],
				}) as string
			).trim();
			return out || "(no output)";
		} catch (e) {
			const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
			return `(error: ${msg})`;
		}
	});
}
