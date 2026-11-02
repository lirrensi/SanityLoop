// ============================================================================
// sanity/src/packages/swarm/src/server/templates.ts — the menu, no muscle.
// Template scan + resolution as a pure module: JSON manifests declaring where
// the agent file lives. No child_process, no supervisor details — the supervisor
// (supervisor.ts) owns every fork; this file only answers "what can we spawn?"
// ============================================================================
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** A discovered template — a JSON MANIFEST declaring where the agent file lives. */
export interface TemplateInfo {
	/** The manifest file name, e.g. "worker.json". */
	file: string;
	/** Absolute path to the AGENT file the manifest points at (resolved + validated). */
	path: string;
	/** `id` from the manifest — the spawn id (fallback: manifest filename). */
	id: string;
	/** `description` from the manifest — shown in the registry. */
	description?: string;
	/** Per-template env, merged into the spawned process (after base, before the daemon's own). */
	env?: Record<string, string>;
}

/** What a template manifest JSON looks like. `mode` is gone — the .ts decides. */
export interface TemplateManifest {
	id?: string;
	description?: string;
	/** REQUIRED — path to the agent file, relative to the manifest or absolute. */
	file?: string;
	env?: Record<string, string>;
}

/** True when some ancestor of dir holds a node_modules (bare imports resolve). */
export function hasNodeModulesUpTree(startDir: string): boolean {
	let dir = startDir;
	for (;;) {
		if (existsSync(join(dir, "node_modules"))) return true;
		const parent = dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
}

/** Parse a template manifest JSON. Returns null when it's not a template (no file). */
export function parseTemplateManifest(path: string): TemplateManifest | null {
	let parsed: TemplateManifest;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8")) as TemplateManifest;
	} catch {
		console.warn(`[swarm] skipping manifest (not valid JSON): ${path}`);
		return null;
	}
	if (typeof parsed.file !== "string" || !parsed.file.trim()) {
		console.warn(`[swarm] skipping manifest (no \`file\` pointer): ${path}`);
		return null;
	}
	return parsed;
}

/** Warn when an agent file can't see any node_modules (bare imports will fail)
 *  and the daemon-home junction can't cover it either. Cheap existsSync walk. */
export function warnBareAgentDir(agentFile: string, homeDir?: string): void {
	if (hasNodeModulesUpTree(dirname(agentFile))) return;
	if (homeDir && existsSync(join(homeDir, "node_modules"))) return;
	console.warn(`[swarm] agent file outside any node_modules tree — bare imports may fail: ${agentFile}`);
}

/** Scan the templates dir for *.json MANIFESTS and resolve their agent-file pointers. */
export function scanTemplates(templatesDir: string): TemplateInfo[] {
	const out: TemplateInfo[] = [];
	if (!existsSync(templatesDir)) return out;
	for (const file of readdirSync(templatesDir)) {
		if (!file.endsWith(".json")) continue;
		const manifestPath = join(templatesDir, file);
		const manifest = parseTemplateManifest(manifestPath);
		if (!manifest) continue;
		const raw = manifest.file!;
		const path = raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw) ? raw : resolve(templatesDir, raw);
		if (!existsSync(path)) {
			console.warn(`[swarm] skipping manifest (agent file missing): ${manifestPath} → ${path}`);
			continue;
		}
		out.push({
			file,
			path,
			id: manifest.id ?? file.replace(/\.json$/, ""),
			description: manifest.description,
			env: manifest.env,
		});
	}
	return out;
}

/** Resolve a template id or manifest file name to a TemplateInfo. */
export function findTemplate(templatesDir: string, name: string): TemplateInfo | undefined {
	const all = scanTemplates(templatesDir);
	return all.find(
		(t) =>
			t.id === name ||
			t.file === name ||
			t.file.replace(/\.json$/, "") === name,
	);
}
