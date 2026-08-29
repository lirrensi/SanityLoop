// ============================================================================
// sanity/src/extras/agents-md-loader/index.ts — AGENTS.md auto-loading
// ============================================================================
// Behavior inherited from OPENCODE (session/instruction.ts):
//
//   1. START: the base root's AGENTS.md (agent cwd) → ONE system message,
//      before the first provider call. No upward walk. Home/global files are
//      NOT loaded unless you opt in (`home: true`) — opencode's global config
//      files are explicit, never automatic.
//   2. PROGRESSIVE: when the model reads a file, walk UP from that file's
//      folder to the base root (never above), attaching each folder's
//      AGENTS.md that isn't loaded yet — as messages inserted right after
//      the toolResult, in the same cycle (tool-agnostic: the plugin hooks
//      toolEnd, it never touches the read tool).
//   3. DEDUPE: the loaded-set in state (<stateKey>.loaded) holds absolute
//      paths; "loaded" means "already injected". Re-reads never re-inject.
//
// The root's AGENTS.md is loaded at start, so the progressive walk's
// root-level check dedupes against it.
// ============================================================================
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { EVENTS } from "@sanityloop/core";
import type { Filter, Message, Plugin } from "@sanityloop/core";
import {
	injectSystem,
	loadedSet,
	markLoaded,
	pathMessageId,
	readPathFromTurn,
	ruleMessage,
} from "@sanityloop/util";
import { removeFiltersByPrefix } from "@sanityloop/util";

export interface AgentsMdOptions {
	/** File names to look for. Default: ["AGENTS.md"]. */
	files?: string[];
	/** Tool names whose reads trigger progressive loading. Default: ["read"]. */
	readTools?: string[];
	/** Where the loaded-set lives in session state. Default: "agentsMd". */
	stateKey?: string;
	/** Also load the home dir's files (global rules). Default: false. */
	home?: boolean;
	/** The home dir to scan when `home` is on. Default: os.homedir(). */
	homeDir?: string;
}

/** Default loader — AGENTS.md, progressive folder loading, no home. */
export const agentsMdLoader: Plugin = createAgentsMdLoader();

export function createAgentsMdLoader(opts: AgentsMdOptions = {}): Plugin {
	const files = opts.files ?? ["AGENTS.md"];
	const readTools = new Set(opts.readTools ?? ["read"]);
	const stateKey = opts.stateKey ?? "agentsMd";
	const homeEnabled = opts.home ?? false;
	const homeDir = opts.homeDir ?? homedir();

	/** True when `child` is inside (or at) `parent` — path-safe boundary check. */
	function isWithin(child: string, parent: string): boolean {
		const c = resolve(child).toLowerCase();
		const p = resolve(parent).toLowerCase();
		return c === p || c.startsWith(p + sep);
	}

	/** Sync-read the configured files present in one dir. */
	function filesIn(dir: string): { absPath: string; content: string }[] {
		const out: { absPath: string; content: string }[] = [];
		for (const file of files) {
			const absPath = join(dir, file);
			if (!existsSync(absPath)) continue;
			try {
				out.push({ absPath, content: readFileSync(absPath, "utf8") });
			} catch {
				// unreadable — skip
			}
		}
		return out;
	}

	/** The dirs scanned at start: base root, plus home only when opted in. */
	function startDirs(cwd: string): string[] {
		return homeEnabled ? [cwd, homeDir] : [cwd];
	}

	const startFilter: Filter = {
		event: EVENTS.beforeAgentStart,
		id: "agents-md/start",
		priority: 100,
		fn: async (agent) => {
			const found: { absPath: string; content: string }[] = [];
			for (const dir of startDirs(agent.cwd)) {
				for (const f of filesIn(dir)) {
					const loaded = loadedSet(agent, stateKey);
					if (loaded.has(f.absPath)) continue;
					found.push(f);
					markLoaded(agent, stateKey, f.absPath);
				}
			}
			if (found.length > 0) injectSystem(agent, found.map(toMessage));
		},
	};

	function toMessage({
		absPath,
		content,
	}: {
		absPath: string;
		content: string;
	}): Message {
		return ruleMessage(
			pathMessageId("agents-md", absPath),
			`AGENTS.md - ${absPath}`,
			content,
		);
	}

	const traversalFilter: Filter = {
		event: EVENTS.toolEnd,
		id: "agents-md/traversal",
		priority: 100,
		fn: async (agent) => {
			const readPath = readPathFromTurn(agent, agent.currentTurn, readTools);
			if (!readPath) return;

			// walk UP from the read file's folder to the base root (never above)
			const found: { absPath: string; content: string }[] = [];
			let dir = dirname(readPath);
			const loaded = loadedSet(agent, stateKey);
			while (
				isWithin(dir, agent.cwd) &&
				dir.toLowerCase() !== resolve(agent.cwd).toLowerCase()
			) {
				for (const f of filesIn(dir)) {
					if (loaded.has(f.absPath)) continue;
					found.push(f);
					markLoaded(agent, stateKey, f.absPath);
				}
				const parent = dirname(dir);
				if (parent === dir) break;
				dir = parent;
			}
			if (found.length > 0) injectSystem(agent, found.map(toMessage));
		},
	};

	return {
		id: "agents-md",
		install(agent) {
			agent.addFilter(startFilter);
			agent.addFilter(traversalFilter);
			agent.addDeclaredCapability({
				id: "agents-md-loader",
				description: "AGENTS.md loading (root at start + progressive per-folder on read)",
			});
		},
		uninstall(agent) {
			removeFiltersByPrefix(agent, "agents-md/");
			agent.removeDeclaredCapability("agents-md-loader");
		},
	};
}
