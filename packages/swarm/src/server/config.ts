// ============================================================================
// sanity/src/packages/swarm/src/server/config.ts — the daemon's HOME.
// The daemon IS a location: everything it is lives in one directory.
//
//   ~/.sanity/swarm/              the default home — the one daemon per system
//   ├── config.json               the daemon's declared identity (written at serve)
//   ├── fleet.json                spawn recipes — what it launched (resurrectable)
//   ├── templates/                templates it can spawn (scanned at boot)
//   └── sessions/                 spawned workers' session storage
//
// Isolation = a different directory: `swarm serve --dir /elsewhere --port 6123`
// is a completely separate swarm (own config, own templates, own sessions).
// Resolution order: --dir flag > $SWARM_HOME > the default.
// ============================================================================
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SwarmRole } from "../protocol.ts";

export const CONFIG_VERSION = 1;

/** The default home — one daemon per user per system. */
export const DEFAULT_HOME = join(homedir(), ".sanity", "swarm");

/** Everything the daemon declares about itself — written to config.json at serve. */
export interface SwarmConfig {
	version: typeof CONFIG_VERSION;
	home: string;
	addr: string;
	/** The effective port — after bind (0 = random → the real one lands here). */
	port: number;
	/** Where it scans for spawnable templates. */
	templatesDir: string;
	/** Where SPAWNED workers persist their sessions (passed as SWARM_SESSIONS_DIR). */
	sessionsDir: string;
	/** Where the fleet manifest lives. */
	manifestPath: string;
	/** Per-role tokens — empty/absent = open mode. */
	tokens?: Partial<Record<SwarmRole, string>>;
}

export interface CliArgs {
	get(key: string): string | true | undefined;
}

/** Resolve the home: --dir wins, then $SWARM_HOME, then the default. */
export function resolveHome(args?: CliArgs): string {
	const fromFlag =
		typeof args?.get("dir") === "string"
			? (args.get("dir") as string)
			: undefined;
	return fromFlag ?? process.env.SWARM_HOME ?? DEFAULT_HOME;
}

export function configPath(home: string): string {
	return join(home, "config.json");
}

/** Read the daemon's declared identity — null when absent or torn. */
export function loadConfig(home: string): SwarmConfig | null {
	const path = configPath(home);
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as SwarmConfig;
		if (parsed.version !== CONFIG_VERSION) return null;
		return parsed;
	} catch {
		return null;
	}
}

/** Write the daemon's identity. The home explains itself. */
export function writeConfig(cfg: SwarmConfig): void {
	mkdirSync(cfg.home, { recursive: true });
	writeFileSync(
		configPath(cfg.home),
		JSON.stringify(cfg, null, 2) + "\n",
		"utf8",
	);
}

/** Create the home scaffold (templates/ + sessions/) if missing. */
export function ensureScaffold(home: string): void {
	mkdirSync(join(home, "templates"), { recursive: true });
	mkdirSync(join(home, "sessions"), { recursive: true });
}

/**
 * Walk up from this module to find the project's node_modules (the one holding
 * @sanityloop/core). Spawned workers live UNDER the daemon HOME and rely on ESM
 * bare-specifier resolution, which only walks node_modules ancestors of the
 * worker FILE — so a HOME outside the project tree can't see @sanityloop/*.
 */
export function resolveProjectNodeModules(): string | undefined {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		if (existsSync(join(dir, "node_modules", "@sanityloop", "core"))) {
			return join(dir, "node_modules");
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * Best-effort: drop a node_modules junction/symlink into HOME pointing at the
 * project's node_modules, so spawned worker templates resolve @sanityloop/*
 * regardless of where HOME lives. A junction (not a symlink) needs no admin on
 * Windows; on *nix we use a dir symlink. Fails silently if we can't (then the
 * operator must keep worker templates inside a project that has node_modules).
 */
export function ensureNodeModulesLink(home: string): void {
	const target = resolveProjectNodeModules();
	if (!target) return;
	const link = join(home, "node_modules");
	try {
		if (existsSync(link)) return;
		symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
	} catch {
		/* best-effort */
	}
}

/** The default layout inside a home. */
export function homeLayout(home: string): {
	templatesDir: string;
	sessionsDir: string;
	manifestPath: string;
} {
	return {
		templatesDir: join(home, "templates"),
		sessionsDir: join(home, "sessions"),
		manifestPath: join(home, "fleet.json"),
	};
}
