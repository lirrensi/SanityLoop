// ============================================================================
// packages/extras/session-search/index.ts — the base session-search tool.
// ============================================================================
// THE basic extension: search THIS session's full transcript — however long
// it is, compactions included. Hits are tagged active/archived so the answer
// is honest about what the model can currently see vs what's archived.
//
// Every plugin that owns other searchable data ships its OWN tool (its own
// way): base-storage → the tape scanner (dir inherited from where storage was
// initialized, no dir param), swarm → remote peer search. Nothing is shared
// except `Tool.define`. This file is the pattern to copy.
// ============================================================================
import { Tool } from "@sanityloop/core";
import type { JsonSchema, Message, ToolType } from "@sanityloop/core";

export interface SearchHistoryOptions {
	/** Tool name the model sees. Default "search_history". */
	name?: string;
	/** Max hits returned. Default 10. */
	limit?: number;
}

export interface SearchHit {
	sessionId: string;
	messageId: string;
	role: string;
	excerpt: string;
	ts?: number;
	/** true = currently in the model's context; false = archived by compaction/clear. */
	active: boolean;
}

/** The per-message granular projection — every part of a message is searchable:
 *  text parts, tool names/args, answers, error tails. Own to this plugin. */
function project(m: Message): string {
	const c = m.content as unknown;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c
			.map((part) => {
				const p = part as { type?: string; content?: unknown; text?: unknown };
				if (p.type === "text") {
					if (typeof p.content === "string") return p.content;
					if (typeof p.text === "string") return p.text;
				}
				return "";
			})
			.filter((s) => s.length > 0)
			.join(" ");
	}
	if (c && typeof c === "object") {
		const o = c as Record<string, unknown>;
		const parts: string[] = [];
		for (const k of ["answer", "errorMessage"] as const) {
			const v = o[k];
			if (typeof v === "string" && v.length > 0) parts.push(v);
		}
		const stored = o.stored;
		if (Array.isArray(stored)) {
			for (const s of stored as Array<Record<string, unknown>>) {
				const name = typeof s.name === "string" ? s.name : "";
				const raw = s.parameters;
				const args =
					typeof raw === "string"
						? raw
						: raw === undefined
							? ""
							: JSON.stringify(raw);
				if (name) parts.push(`${name}(${args})`);
			}
		}
		return parts.join(" | ");
	}
	return String(c ?? "");
}

/** A window around the match — the model gets context, not a wall of text. */
function excerpt(text: string, idx: number, len: number, pad = 60): string {
	const from = Math.max(0, idx - pad);
	const to = Math.min(text.length, idx + len + pad);
	return `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`;
}

/**
 * The always-on tool: search THIS session's full transcript.
 *
 *   agent.install/search_history({ query: "docker", limit: 5 })
 *
 * Returns hits, newest first, each with an excerpt + active/archived tag;
 * archived hits are in the history but NOT in the current context.
 */
export function createSearchHistory(opts: SearchHistoryOptions = {}): ToolType {
	const limitDefault = opts.limit ?? 10;
	const inputSchema: JsonSchema = {
		type: "object",
		properties: {
			query: {
				type: "string",
				description:
					"Text to find. CASE-INSENSITIVE substring over the whole transcript (text, tool names/args, answers, errors — every part of every message).",
			},
			limit: {
				type: "integer",
				minimum: 1,
				description: `Max hits. Default ${limitDefault}.`,
			},
		},
		required: ["query"],
	};

	return Tool.define({
		name: opts.name ?? "search_history",
		description:
			"Search THIS session's FULL transcript — every message, compactions and cleared messages included. " +
			"Hits are tagged active (in current context) or archived (in history only). Use for 'did we discuss X', 'what did I decide about Y', 'find the tool call that...'.",
		inputSchema,
		execute: async (
			rawParams,
			agent,
		): Promise<{
			answer: string;
			error?: boolean;
			errorMessage?: string;
			stored?: unknown;
		}> => {
			const params = (rawParams ?? {}) as { query?: unknown; limit?: unknown };
			if (typeof params.query !== "string" || params.query.length === 0) {
				return {
					answer: 'search_history: missing required string parameter "query".',
					error: true,
					errorMessage: "missing query",
				};
			}
			const query = params.query;
			const limit =
				typeof params.limit === "number" && params.limit > 0
					? Math.floor(params.limit)
					: limitDefault;
			const q = query.toLowerCase();

			const messages = agent.messages;
			const hits: SearchHit[] = [];
			for (const m of messages) {
				const text = project(m);
				const idx = text.toLowerCase().indexOf(q);
				if (idx === -1) continue;
				hits.push({
					sessionId: agent.id,
					messageId: m.id,
					role: m.type,
					excerpt: excerpt(text, idx, query.length),
					ts: m.committedAt,
					active: m.enabled !== false,
				});
			}
			hits.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
			const topHits = hits.slice(0, limit);
			const archived = hits.filter((h) => !h.active).length;

			const coverage = `searched ${messages.length} messages (${messages.length - archived} active, ${archived} archived)`;
			if (hits.length === 0) {
				return {
					answer: `No hits for "${query}". ${coverage}.`,
					stored: { hits: [], coverage },
				};
			}
			const lines = topHits
				.map(
					(h, i) =>
						`${i + 1}. [${h.role}${h.active ? "" : ", archived"}] ${h.excerpt}`,
				)
				.join("\n");
			const more =
				hits.length > topHits.length
					? `\n…and ${hits.length - topHits.length} more (see stored.hits).`
					: "";
			return {
				answer: `${hits.length} hit(s) for "${query}". ${coverage}.\n${lines}${more}`,
				stored: { hits: topHits, total: hits.length, coverage },
			};
		},
	});
}
