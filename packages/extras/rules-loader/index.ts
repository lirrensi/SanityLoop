// ============================================================================
// sanity/src/extras/rules-loader/index.ts — .mdc rule bundles (multi-agent)
// ============================================================================
// The .mdc rule-bundle format (YAML frontmatter: description, globs,
// alwaysApply) is the industry standard now — cursor, coddy, claude, codex
// and agents all use it, under their own rules dir:
//
//   .cursor/rules  .coddy/rules  .claude/rules  .codex/rules  .agents/rules
//   .cursorrules   (legacy single file, always applied)
//
// Behavior follows cursor (cursor.com/docs/rules):
//   - alwaysApply: true  → system at start ("applied to every chat session")
//   - globs              → "auto-attached when a matching file is in context"
//                          = attached when the model READS a matching file
//   - legacy .cursorrules → always applied → system at start
//   - description        → metadata alongside the rule (the "intelligent"
//                          selection layer is a future extra)
//
// User Rules (home) — opt-in via `home: true`, off by default.
//
// Delivery is tool-agnostic and SYNC: the plugin hooks toolEnd, detects the
// read via the shared readPathFromTurn, and inserts the matching rules right
// after the toolResult — same cycle, never touching the read tool. No walking
// above the base root, ever. Dedupe by rule path in state (<stateKey>.loaded).
// ============================================================================
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import picomatch from "picomatch";
import { parse as parseYaml } from "yaml";
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

export interface RulesLoaderOptions {
	/** Directories scanned for *.mdc bundles, under each root. Default: the five agent rule dirs (.cursor/.coddy/.claude/.codex/.agents). */
	ruleDirs?: string[];
	/** Legacy single-file rules (plain markdown, always applied). */
	legacyFiles?: string[];
	/** Tool names whose reads trigger glob matching. Default: ["read"]. */
	readTools?: string[];
	/** Where the loaded-set lives in session state. Default: "rules". */
	stateKey?: string;
	/** Also load the home dir's rules (cursor's User Rules). Default: false. */
	home?: boolean;
	/** The home dir to scan when `home` is on. Default: os.homedir(). */
	homeDir?: string;
}

export interface MdcRule {
	/** Absolute path of the .mdc / legacy file. */
	absPath: string;
	/** Root dir where the rule bundle was found — globs are relative to it. */
	root: string;
	/** Rule name — the file's base name. */
	name: string;
	description?: string;
	globs: string[];
	alwaysApply: boolean;
	body: string;
}

const DEFAULT_RULE_DIRS = [".cursor/rules", ".coddy/rules", ".claude/rules", ".codex/rules", ".agents/rules"];
const DEFAULT_LEGACY = [".cursorrules"];
const DEFAULT_READ_TOOLS = ["read"];

/** Frontmatter `globs` — cursor writes a comma string OR a yaml array. */
function toGlobs(v: unknown): string[] {
	if (typeof v === "string")
		return v
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	if (Array.isArray(v)) return v.flatMap(toGlobs);
	return [];
}

/** Parse `--- yaml ---` frontmatter; body = the rest. No frontmatter = whole file. */
export function parseMdc(content: string): {
	frontmatter: Record<string, unknown>;
	body: string;
} {
	const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!m) return { frontmatter: {}, body: content };
	let fm: unknown;
	try {
		fm = parseYaml(m[1]);
	} catch {
		fm = {};
	}
	return {
		frontmatter:
			fm && typeof fm === "object" ? (fm as Record<string, unknown>) : {},
		body: m[2],
	};
}

/** Glob matcher over the path relative to the rule's root (posix slashes). */
function matcherFor(globs: string[]): (rel: string) => boolean {
	const fns = globs.map((g) => picomatch(g, { dot: true }));
	return (rel: string) => fns.some((fn) => fn(rel));
}

/** Default rules loader — root .cursor/rules + .cursorrules, no home. */
export const rulesLoader: Plugin = createRulesLoader();

export function createRulesLoader(opts: RulesLoaderOptions = {}): Plugin {
	const ruleDirs = opts.ruleDirs ?? DEFAULT_RULE_DIRS;
	const legacyFiles = opts.legacyFiles ?? DEFAULT_LEGACY;
	const readTools = new Set(opts.readTools ?? DEFAULT_READ_TOOLS);
	const stateKey = opts.stateKey ?? "rules";
	const homeEnabled = opts.home ?? false;
	const homeDir = opts.homeDir ?? homedir();

	/** All parsed rules — discovered once at start, matched on reads. */
	let allRules: MdcRule[] = [];

	/** The roots scanned at start: base root, plus home only when opted in. */
	function roots(cwd: string): string[] {
		return homeEnabled ? [cwd, homeDir] : [cwd];
	}

	/** Sync-scan one root dir for .mdc bundles + legacy files. */
	function rulesIn(root: string): MdcRule[] {
		const out: MdcRule[] = [];
		for (const sub of ruleDirs) {
			const dirPath = join(root, sub);
			let entries;
			try {
				entries = readdirSync(dirPath, { withFileTypes: true });
			} catch {
				continue; // no rule dir here
			}
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".mdc"))
					continue;
				const absPath = join(dirPath, entry.name);
				let raw;
				try {
					raw = readFileSync(absPath, "utf8");
				} catch {
					continue;
				}
				const { frontmatter, body } = parseMdc(raw);
				out.push({
					absPath,
					root,
					name: entry.name.replace(/\.mdc$/i, ""),
					description:
						typeof frontmatter.description === "string"
							? frontmatter.description
							: undefined,
					globs: toGlobs(frontmatter.globs),
					alwaysApply: frontmatter.alwaysApply === true,
					body,
				});
			}
		}
		for (const file of legacyFiles) {
			const absPath = join(root, file);
			if (!existsSync(absPath)) continue;
			try {
				out.push({
					absPath,
					root,
					name: file,
					globs: [],
					alwaysApply: true,
					body: readFileSync(absPath, "utf8"),
				});
			} catch {
				// unreadable — skip
			}
		}
		return out;
	}

	function toMessage(rule: MdcRule): Message {
		const desc = rule.description ? `\n> ${rule.description}` : "";
		const scope =
			rule.globs.length > 0 ? ` (globs: ${rule.globs.join(", ")})` : "";
		return ruleMessage(
			pathMessageId("rules", rule.absPath),
			`Rule: ${rule.name} - ${rule.absPath}${scope}`,
			`${desc}\n\n${rule.body}`,
		);
	}

	const startFilter: Filter = {
		event: EVENTS.beforeAgentStart,
		id: "rules/start",
		priority: 100,
		fn: async (agent) => {
			const rules: MdcRule[] = [];
			for (const root of roots(agent.cwd)) rules.push(...rulesIn(root));
			allRules = rules;
			// cursor: alwaysApply → every session. Globs rules stay cached.
			const always = rules.filter((r) => r.alwaysApply);
			for (const r of always) markLoaded(agent, stateKey, r.absPath);
			if (always.length > 0) injectSystem(agent, always.map(toMessage));
		},
	};

	const readFilter: Filter = {
		event: EVENTS.toolEnd,
		id: "rules/read",
		priority: 100,
		fn: async (agent) => {
			const readPath = readPathFromTurn(agent, agent.currentTurn, readTools);
			if (!readPath) return;

			const loaded = loadedSet(agent, stateKey);
			// match relative to the rule's root; if the read escapes that root
			// (home rules vs project files), fall back to the project root
			const relFor = (r: MdcRule) => {
				const rel = relative(r.root, readPath);
				const p = rel.startsWith("..") ? relative(agent.cwd, readPath) : rel;
				return p.split("\\").join("/");
			};
			const hit = allRules.filter(
				(r) =>
					!r.alwaysApply &&
					r.globs.length > 0 &&
					!loaded.has(r.absPath) &&
					matcherFor(r.globs)(relFor(r)),
			);
			if (hit.length > 0) {
				for (const r of hit) markLoaded(agent, stateKey, r.absPath);
				injectSystem(agent, hit.map(toMessage));
			}
		},
	};

	return {
		id: "rules",
		install(agent) {
			agent.addFilter(startFilter);
			agent.addFilter(readFilter);
			agent.addDeclaredCapability({
				id: "rules-loader",
				description: ".mdc rules loading (multi-format dirs, alwaysApply + globs, home opt-in)",
			});
		},
		uninstall(agent) {
			removeFiltersByPrefix(agent, "rules/");
			agent.removeDeclaredCapability("rules-loader");
			allRules = [];
		},
	};
}
