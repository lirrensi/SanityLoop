#!/usr/bin/env node
// packages/swarm/bin/swarm.js — the installed launcher.
// Resolves cli.ts relative to THIS file, so it works from a source checkout
// (packages/swarm/bin → ../src/server/cli.ts) AND from an installed package
// layout (files: src + bin — same relative shape). Execs node with the same
// strip-types flags the repo uses everywhere (repo root `swarm` script,
// supervisor spawns, package test script).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const cli = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"src",
	"server",
	"cli.ts",
);
if (!existsSync(cli)) {
	console.error(`[swarm] cli not found at ${cli}`);
	process.exit(1);
}
const result = spawnSync(
	process.execPath,
	[
		"--experimental-strip-types",
		"--experimental-transform-types",
		cli,
		...process.argv.slice(2),
	],
	{ stdio: "inherit" },
);
process.exit(result.status ?? 1);
