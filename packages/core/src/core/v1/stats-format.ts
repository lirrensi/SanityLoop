// ============================================================================
// stats-format — human-readable formatting for the stats line
// ============================================================================
// Shared by observer (single line), REPL /status (multi-line), and anyone else
// who wants a quick "what are my stats" view. Pure functions, no side effects.
//
// Two display modes:
//   - line:    one-line summary (↑1.2k/120k ↓340/28k R800 W50 $0.012 ctx 23.4k/200k)
//   - block:   line + last-turn details (last: in 1.2k out 340 ttft 230ms tps 47 dur 1.2s)
//
// Style: Pi compact. Tokens use 1.2k/120k notation; cost uses $0.012; ctx is
// tokens or % depending on whether maxContext is known. Cache + cost are only
// shown when nonzero (don't clutter a fresh session).
// ============================================================================

import type { MessageStats, Stats } from "./types.ts";

/** Compact token count: <1000 raw, <10k "1.2k", <1M "120k", <10M "1.2M". */
export function formatTokens(count: number): string {
	if (!Number.isFinite(count)) return "?";
	if (count < 0) return `-${formatTokens(-count)}`;
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Money: $0.000...$9999. Uses 3 decimals when < 1, 2 above. */
export function formatCost(cost: number): string {
	if (!Number.isFinite(cost)) return "?";
	if (cost < 0) return `-${formatCost(-cost)}`;
	if (cost === 0) return "$0";
	if (cost < 0.001) return `$${cost.toFixed(4)}`;
	if (cost < 1) return `$${cost.toFixed(3)}`;
	if (cost < 1000) return `$${cost.toFixed(2)}`;
	return `$${Math.round(cost)}`;
}

/** Duration in ms: 230ms / 1.2s / 1m 23s. */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "?";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60000);
	const s = Math.round((ms % 60000) / 1000);
	return `${m}m ${s}s`;
}

export interface FormatOptions {
	/** The model's context window — when set, ctx shows "X% / 200k" instead of raw tokens. */
	maxContext?: number;
	/** Include the per-turn last line. Default: true (block mode). */
	includeLast?: boolean;
	/** The last turn's stats — used for the "last:" line. Optional. */
	lastUsage?: MessageStats;
}

/** One-line Pi-style summary. Cache + cost are only shown when nonzero. */
export function formatStatsLine(stats: Pick<Stats, "input" | "output" | "cacheRead" | "cacheWrite" | "cost" | "contextUsage">, opts: Pick<FormatOptions, "maxContext"> = {}): string {
	const parts: string[] = [];
	parts.push(`↑${formatTokens(stats.input)}`);
	parts.push(`↓${formatTokens(stats.output)}`);
	if (stats.cacheRead) parts.push(`R${formatTokens(stats.cacheRead)}`);
	if (stats.cacheWrite) parts.push(`W${formatTokens(stats.cacheWrite)}`);
	if (stats.cost.total) parts.push(formatCost(stats.cost.total));
	if (stats.contextUsage !== undefined && opts.maxContext) {
		const pct = (stats.contextUsage * 100).toFixed(1);
		parts.push(`ctx ${pct}%/${formatTokens(opts.maxContext)}`);
	} else if (stats.contextUsage !== undefined) {
		const pct = (stats.contextUsage * 100).toFixed(1);
		parts.push(`ctx ${pct}%`);
	}
	return parts.join(" ");
}

/** Two-line block: summary + last turn telemetry. */
export function formatStatsBlock(stats: Stats, opts: FormatOptions = {}): string {
	const line = formatStatsLine(stats, opts);
	const includeLast = opts.includeLast ?? true;
	if (!includeLast || !opts.lastUsage) return line;
	const last = opts.lastUsage;
	const lastParts: string[] = [];
	if (typeof last.input === "number") lastParts.push(`in ${formatTokens(last.input)}`);
	if (typeof last.output === "number") lastParts.push(`out ${formatTokens(last.output)}`);
	if (typeof last.ttftMs === "number") lastParts.push(`ttft ${formatDuration(last.ttftMs)}`);
	if (typeof last.tps === "number") lastParts.push(`tps ${last.tps.toFixed(1)}`);
	if (typeof last.durationMs === "number") lastParts.push(`dur ${formatDuration(last.durationMs)}`);
	if (lastParts.length === 0) return line;
	return `${line}\nlast: ${lastParts.join(" ")}`;
}
