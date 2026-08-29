// ============================================================================
// sanity/src/packages/swarm/src/server/spawner.ts — the hypervisor half.
// The daemon knows how to RUN a worker only when it SPAWNED it: template scan
// gives the recipes, child_process gives the processes, the fleet manifest
// (tiny JSON) lets the daemon resurrect its own fleet after a daemon restart.
// Ad-hoc workers (joined from anywhere) are NOT here — the daemon manages them
// while they're connected, but never claims to restart them.
// ============================================================================
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SwarmRole } from "../protocol.ts";


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
	/** `mode` is INDICATION only — the .ts file itself decides its real mode (mode has effects). */
	mode?: SwarmRole;
	/** Per-template env, merged into the spawned process (after base, before the daemon's own). */
	env?: Record<string, string>;
}

/** What a template manifest JSON looks like. */
export interface TemplateManifest {
	id?: string;
	description?: string;
	/** REQUIRED — path to the agent file, relative to the manifest or absolute. */
	file?: string;
	mode?: string;
	env?: Record<string, string>;
}

/** A spawn recipe — everything needed to resurrect this worker. */
export interface SpawnRecipe {
	sessionId: string;
	template: string;
	args: string[];
	env: Record<string, string>;
	cwd: string;
	createdAt: number;
}

export interface SpawnerOptions {
	templatesDir: string;
	/** The base command for a template: e.g. ["node", "--experimental-strip-types", "--experimental-transform-types"]. */
	spawnCommand?: string[];
	/** Where the fleet manifest lives. Omit = no persistence. */
	manifestPath?: string;
}

const MANIFEST_VERSION = 1;

const VALID_MODES = ["worker", "peer", "admin"] as const;

/** Parse a template manifest JSON. Returns null when it's not a template (no file). */
function parseTemplateManifest(path: string): TemplateManifest | null {
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

export class Spawner {
	private readonly templatesDir: string;
	private readonly spawnCommand: string[];
	private readonly manifestPath?: string;
	private recipes = new Map<string, SpawnRecipe>();
	private children = new Map<string, ChildProcess>();

	constructor(opts: SpawnerOptions) {
		this.templatesDir = opts.templatesDir;
		this.spawnCommand = opts.spawnCommand ?? [
			"node",
			"--experimental-strip-types",
			"--experimental-transform-types",
		];
		this.manifestPath = opts.manifestPath;
		this.loadManifest();
	}

	/** Scan the templates dir for *.json MANIFESTS and resolve their agent-file pointers. */
	scanTemplates(): TemplateInfo[] {
		const out: TemplateInfo[] = [];
		if (!existsSync(this.templatesDir)) return out;
		for (const file of readdirSync(this.templatesDir)) {
			if (!file.endsWith(".json")) continue;
			const manifestPath = join(this.templatesDir, file);
			const manifest = parseTemplateManifest(manifestPath);
			if (!manifest) continue;
			const path = resolve(this.templatesDir, manifest.file!);
			if (!existsSync(path)) {
				console.warn(`[swarm] skipping manifest (agent file missing): ${manifestPath} → ${path}`);
				continue;
			}
			out.push({
				file,
				path,
				id: manifest.id ?? file.replace(/\.json$/, ""),
				description: manifest.description,
				mode: VALID_MODES.includes(manifest.mode as (typeof VALID_MODES)[number]) ? (manifest.mode as SwarmRole) : undefined,
				env: manifest.env,
			});
		}
		return out;
	}

	/** Resolve a template id or manifest file name to a TemplateInfo. */
	findTemplate(name: string): TemplateInfo | undefined {
		const all = this.scanTemplates();
		return all.find(
			(t) =>
				t.id === name ||
				t.file === name ||
				t.file.replace(/\.json$/, "") === name,
		);
	}

	/** Spawn a template worker. Returns the sessionId (fresh or given) + pid. */
	spawn(
		template: TemplateInfo,
		opts: { sessionId?: string; extraEnv?: Record<string, string> } = {},
	): { sessionId: string; pid?: number } {
		const sessionId = opts.sessionId ?? `swarm-${randomUUID().slice(0, 8)}`;
		const env: Record<string, string> = {
			...this.baseEnv(),
			...(template.env ?? {}), // the manifest's per-template config
			SWARM_SESSION_ID: sessionId,
			SWARM_MODE: template.mode ?? "worker", // indication only — the .ts decides its real mode
			...opts.extraEnv, // the daemon's own contract (SWARM_SERVER, sessions dir...) wins
		};
		const child = spawn(
			this.spawnCommand[0],
			[...this.spawnCommand.slice(1), template.path],
			{
				env,
				cwd: process.cwd(),
				stdio: "inherit",
			},
		);
		this.children.set(sessionId, child);
		this.recipes.set(sessionId, {
			sessionId,
			template: template.file,
			args: this.spawnCommand.slice(1),
			env,
			cwd: process.cwd(),
			createdAt: Date.now(),
		});
		this.saveManifest();
		child.on("exit", () => {
			this.children.delete(sessionId);
		});
		return { sessionId, pid: child.pid };
	}

	/** True when the daemon spawned this worker (restartable). */
	isSpawned(sessionId: string): boolean {
		return this.recipes.has(sessionId);
	}

	/** The recipe for a spawned worker — undefined for ad-hoc joins. */
	recipe(sessionId: string): SpawnRecipe | undefined {
		return this.recipes.get(sessionId);
	}

	/** The live pid of a spawned worker (undefined when not running). */
	pidOf(sessionId: string): number | undefined {
		return this.children.get(sessionId)?.pid;
	}

	/** Kill a spawned worker's process. Graceful first (input_stop), then SIGTERM. */
	kill(sessionId: string): boolean {
		const child = this.children.get(sessionId);
		if (!child) {
			// already gone — clean the recipe anyway (the daemon forgets it)
			return this.forget(sessionId);
		}
		try {
			child.kill("SIGTERM");
		} catch {
			/* already dead */
		}
		this.forget(sessionId);
		return true;
	}

	/** Restart a spawned worker: same sessionId, fresh process. */
	restart(sessionId: string): boolean {
		const recipe = this.recipes.get(sessionId);
		if (!recipe) return false;
		const template = this.findTemplate(recipe.template);
		if (!template) return false;
		this.kill(sessionId);
		const { pid } = this.spawn(template, { sessionId, extraEnv: recipe.env });
		return pid !== undefined;
	}

	/** Forget a spawned worker (killed / deleted). */
	forget(sessionId: string): boolean {
		const had = this.recipes.delete(sessionId);
		if (had) this.saveManifest();
		return had;
	}

	/** All known spawn recipes — the daemon's memory of what IT launched. */
	allRecipes(): SpawnRecipe[] {
		return [...this.recipes.values()];
	}

	/** Resurrect the whole fleet (after a daemon restart). */
	resurrectAll(): string[] {
		const spawned: string[] = [];
		for (const recipe of [...this.recipes.values()]) {
			const template = this.findTemplate(recipe.template);
			if (!template) continue;
			const child = spawn(
				this.spawnCommand[0],
				[...recipe.args, template.path],
				{
					env: recipe.env,
					cwd: recipe.cwd,
					stdio: "inherit",
				},
			);
			this.children.set(recipe.sessionId, child);
			child.on("exit", () => this.children.delete(recipe.sessionId));
			spawned.push(recipe.sessionId);
		}
		return spawned;
	}

	/** The env every spawned worker inherits from the daemon (minus swarm-specifics). */
	private baseEnv(): Record<string, string> {
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) {
			if (v !== undefined) env[k] = v;
		}
		return env;
	}

	private loadManifest(): void {
		if (!this.manifestPath || !existsSync(this.manifestPath)) return;
		try {
			const parsed = JSON.parse(readFileSync(this.manifestPath, "utf8")) as {
				v: number;
				recipes: SpawnRecipe[];
			};
			if (parsed.v !== MANIFEST_VERSION) return;
			for (const r of parsed.recipes) this.recipes.set(r.sessionId, r);
		} catch {
			/* torn manifest — start clean */
		}
	}

	private saveManifest(): void {
		if (!this.manifestPath) return;
		try {
			mkdirSync(
				this.manifestPath
					.split(/[\\/]/)
					.slice(0, -1)
					.join(/[\\/]/.test(this.manifestPath) ? "\\" : "/") || ".",
				{ recursive: true },
			);
			writeFileSync(
				this.manifestPath,
				JSON.stringify(
					{ v: MANIFEST_VERSION, recipes: [...this.recipes.values()] },
					null,
					2,
				) + "\n",
				"utf8",
			);
		} catch {
			/* the manifest is a convenience, never a contract */
		}
	}
}
