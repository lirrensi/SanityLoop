// ============================================================================
// packages/extras/base-storage/search.ts — THIS storage's own session search.
// ============================================================================
// Every storage provider ships its own search tool, its own way. This one:
//   - the ROOT is inherited from where storage was initialized (the same folder
//     you store sessions under) — never a per-call argument
//   - enumerates session dirs, replays each tape with OUR restore, scans with
//     OUR projection
// No shared engine, no cross-package contract: base-storage owns reading its
// own tapes. Same courtesy hit shape as the base session-search tool only
// because consistency helps the model — a choice, not a contract.
// ============================================================================
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Tool } from "@sanityloop/core";
import type { JsonSchema, Message, ToolType } from "@sanityloop/core";
import { JsonlLog } from "./jsonl.ts";
import { restoreFromTape } from "./contract.ts";

export interface SessionsSearchOptions {
	/**
	 * The sessions ROOT — the same folder you initialized your storage with
	 * ("where you store the stuff"). Inherited at tool creation; the search
	 * CALL never takes a directory.
	 */
	root: string;
	/** Tool name the model sees. Default "search_sessions". */
	name?: string;
	/** Max hits returned. Default 10. */
	limit?: number;
}

export interface SessionSearchHit {
	sessionId: string;
	messageId: string;
	role: string;
	excerpt: string;
	ts?: number;
	/** true = enabled in that session's own history; false = archived by its compactions. */
	active: boolean;
}

/** This storage's own granular projection — every part of a message searchable. */
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

function excerpt(text: string, idx: number, len: number, pad = 60): string {
	const from = Math.max(0, idx - pad);
	const to = Math.min(text.length, idx + len + pad);
	return `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`;
}

/**
 * THIS storage's search tool: search every persisted session under the root —
 * full transcripts, archived messages included, hits labeled with sessionId.
 *
 *   tools: [ ..., createSessionsSearchTool({ root: "sessions" }) ]   // same root storage was initialized with
 *
 * Absent root / unreadable sessions degrade per-session and are reported in
 * the coverage line — the tool never throws.
 */
export function createSessionsSearchTool(
	opts: SessionsSearchOptions,
): ToolType {
	const limitDefault = opts.limit ?? 10;
	const inputSchema: JsonSchema = {
		type: "object",
		properties: {
			query: {
				type: "string",
				description:
					"Text to find. CASE-INSENSITIVE substring over every persisted session's full transcript (text, tool names/args, answers, errors).",
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
		name: opts.name ?? "search_sessions",
		description:
			"Search PERSISTED sessions on disk — every session under this storage's root, full transcripts including archived messages. " +
			"Hits are labeled with sessionId. Use when the fact may live in a PAST or DIFFERENT session, not the current one.",
		inputSchema,
		execute: async (
			rawParams,
		): Promise<{
			answer: string;
			error?: boolean;
			errorMessage?: string;
			stored?: unknown;
		}> => {
			const params = (rawParams ?? {}) as { query?: unknown; limit?: unknown };
			if (typeof params.query !== "string" || params.query.length === 0) {
				return {
					answer: 'search_sessions: missing required string parameter "query".',
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

			// the root is INHERITED — enumerate what's under it, this storage's own way
			let sessionIds: string[] = [];
			try {
				sessionIds = readdirSync(opts.root).filter((name) =>
					statSync(join(opts.root, name)).isDirectory(),
				);
			} catch {
				sessionIds = [];
			}

			const hits: SessionSearchHit[] = [];
			let scannedMessages = 0;
			let unreadable = 0;
			for (const id of sessionIds) {
				const log = new JsonlLog({ dir: join(opts.root, id) });
				let restored;
				try {
					restored = await restoreFromTape(log);
				} catch {
					unreadable++;
					continue;
				}
				if (!restored) continue; // no tape (or torn) — not a session
				const messages = restored.data.messages ?? [];
				scannedMessages += messages.length;
				for (const m of messages) {
					const text = project(m);
					const idx = text.toLowerCase().indexOf(q);
					if (idx === -1) continue;
					hits.push({
						sessionId: id,
						messageId: m.id,
						role: m.type,
						excerpt: excerpt(text, idx, query.length),
						ts: m.committedAt,
						active: m.enabled !== false,
					});
				}
			}

			hits.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
			const topHits = hits.slice(0, limit);
			const archived = hits.filter((h) => !h.active).length;

			const coverage = `searched ${sessionIds.length} session(s) (${scannedMessages} messages${unreadable > 0 ? `, ${unreadable} unreadable` : ""})`;
			if (hits.length === 0) {
				return {
					answer: `No hits for "${query}" in persisted sessions. ${coverage}.`,
					stored: { hits: [], total: 0, coverage },
				};
			}
			const lines = topHits
				.map(
					(h, i) =>
						`${i + 1}. [${h.sessionId} · ${h.role}${h.active ? "" : ", archived"}] ${h.excerpt}`,
				)
				.join("\n");
			const more =
				hits.length > topHits.length
					? `\n…and ${hits.length - topHits.length} more (see stored.hits).`
					: "";
			return {
				answer: `${hits.length} hit(s) for "${query}"${archived > 0 ? ` (${archived} archived)` : ""}. ${coverage}.\n${lines}${more}`,
				stored: { hits: topHits, total: hits.length, coverage },
			};
		},
	});
}
