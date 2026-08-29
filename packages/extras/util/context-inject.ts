// ============================================================================
// sanity/src/extras/util/context-inject.ts — shared context-injection core
// ============================================================================
// The Lego both context loaders (agents-md-loader, rules-loader) snap onto.
// The contract is the INJECTION semantics:
//
//   - the loaded-set holder lives in session state under the plugin's own key
//     (`state.<stateKey>.loaded`) — dedupe by absolute path, persisted with
//     the session;
//   - injected rules are SYSTEM messages kept contiguous at the top of the
//     history (after the agent's own system prompt), so prompt templates see
//     one clean system block;
//   - markLoaded happens BEFORE the async read resolves, so concurrent
//     triggers (start + read traversal) can never double-inject.
//
// Discovery and conditioning are the plugins' own business (upward walk vs
// rule-dir scan, session-scoped vs file-scoped globs). That's the split.
// ============================================================================
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Message } from "@sanityloop/core";

// ---- upward-walk helpers (both loaders walk the ancestor chain) ----

/** The filesystem root of a path (C:\ on Windows, / on POSIX). */
export function rootOf(p: string): string {
	let cur = resolve(p);
	while (true) {
		const parent = dirname(cur);
		if (parent === cur) return cur;
		cur = parent;
	}
}

/** Walk from `start` up to `stop` (inclusive), nearest first. */
export function ancestorDirs(
	start: string,
	stop: string,
	maxDepth = 32,
): string[] {
	const dirs: string[] = [];
	let current = resolve(start);
	const stopNorm = resolve(stop).toLowerCase();
	let depth = 0;
	while (depth++ < maxDepth) {
		dirs.push(current);
		if (current.toLowerCase() === stopNorm) break;
		const parent = dirname(current);
		if (parent === current) break; // filesystem root
		current = parent;
	}
	return dirs;
}

/** True if the dir contains a VCS marker (.git/.hg) — the repo root. */
export function hasVcsMarker(dir: string): boolean {
	return existsSync(join(dir, ".git")) || existsSync(join(dir, ".hg"));
}

/** The loaded-set holder — created AND persisted into session state. */
export function holderOf(
	agent: { state: Record<string, unknown> },
	stateKey: string,
): { loaded: string[] } {
	let holder = agent.state[stateKey] as { loaded?: string[] } | undefined;
	if (!holder || !Array.isArray(holder.loaded)) {
		holder = { loaded: [] };
		agent.state[stateKey] = holder;
	}
	return holder as { loaded: string[] };
}

export function loadedSet(
	agent: { state: Record<string, unknown> },
	stateKey: string,
): Set<string> {
	return new Set(holderOf(agent, stateKey).loaded);
}

/** Mark BEFORE the async read resolves — concurrent triggers can't double-inject. */
export function markLoaded(
	agent: { state: Record<string, unknown> },
	stateKey: string,
	absPath: string,
): void {
	const loaded = holderOf(agent, stateKey).loaded;
	if (!loaded.includes(absPath)) loaded.push(absPath);
}

/** A system message carrying a rule's content. */
export function ruleMessage(id: string, title: string, body: string): Message {
	return {
		id,
		enabled: true,
		type: "system",
		content: [{ type: "text", content: `# ${title}\n\n${body}` }],
	};
}

/** A stable message id from an absolute path (lowercase, path-safe). */
export function pathMessageId(prefix: string, absPath: string): string {
	return `${prefix}-${absPath.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
}

/** Insert messages after the LAST consecutive system message at the top. */
export function injectSystem(
	agent: { messages: Message[] },
	messages: Message[],
): void {
	if (messages.length === 0) return;
	let i = 0;
	while (i < agent.messages.length && agent.messages[i].type === "system") i++;
	agent.messages.splice(i, 0, ...messages);
}

/**
 * From a toolEnd agent, return the RESOLVED read path if the committed tool was
 * one of `readTools` (matched via the message-level `toolName`, core-stamped).
 * Returns undefined for non-read tools — the shared read-detection both
 * context loaders use (tool-agnostic: works for ANY read tool).
 */
export function readPathFromTurn(
  agent: { messages: Message[] },
  turn: unknown,
  readTools: Set<string>,
): string | undefined {
  const result = turn as
    | { type?: string; content?: { stored?: { path?: string } } | null; toolCallId?: string; toolName?: string }
    | undefined;
  if (!result || result.type !== "toolResult" || typeof result.content?.stored?.path !== "string") return undefined;
  // the record is first-class — the core stamps the tool name on the result
  if (result.toolName && readTools.has(result.toolName)) return resolve(result.content.stored.path);
  // fallback: foreign/legacy results resolve the name via the matching call
  const toolCallId = result.toolCallId;
	const callMsg = agent.messages.find((m) => {
		if (m.type !== "toolCall") return false;
		const stored = (m.content as { stored?: { id?: string; name?: string }[] }).stored ?? [];
		return stored.some((c) => c.id === toolCallId);
	});
	const name = (callMsg ? (callMsg.content as { stored?: { id?: string; name?: string }[] }).stored ?? [] : []).find(
		(c) => c.id === toolCallId,
	)?.name;
	if (!name || !readTools.has(name)) return undefined;
	return resolve(result.content.stored.path);
}
