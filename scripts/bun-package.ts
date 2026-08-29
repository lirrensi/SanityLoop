#!/usr/bin/env bun
/**
 * Bundle a single-file SanityLoop agent template into a standalone executable
 * using Bun's compiler.
 *
 * IMPORTANT: this script is the *only* place Bun knowledge lives. Your agent
 * source (packages/*, templates/*) stays on standard Node/Web APIs so the same
 * code runs under Node AND Bun with zero per-file changes. Never import `bun:`
 * in agent source — that's what creates the dual-runtime maintenance you don't
 * want. Bun is just the packager here.
 *
 * Usage:
 *   bun run scripts/bun-package.ts <template.ts> <output>
 *
 * Examples:
 *   bun run scripts/bun-package.ts templates/repl-agent.ts dist/repl-agent
 *   bun run scripts/bun-package.ts templates/simple-agent.ts dist/simple-agent
 *
 * On Windows the output gets a `.exe` suffix automatically by Bun; on
 * Linux/macOS it stays extensionless. Just pass the base name you want.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

const [template, output] = process.argv.slice(2);

if (!template || !output) {
	console.error(
		"\nUsage: bun run scripts/bun-package.ts <template.ts> <output>\n" +
			"  e.g. bun run scripts/bun-package.ts templates/repl-agent.ts dist/repl-agent\n",
	);
	process.exit(1);
}

const outDir = dirname(output);
if (outDir && outDir !== "." && outDir !== "\\" && outDir !== "/") {
	mkdirSync(outDir, { recursive: true });
}

console.log(`\n📦 Bundling ${template} → ${output}\n`);

const res = spawnSync(
	"bun",
	["build", template, "--compile", "--outfile", output],
	{ stdio: "inherit" },
);

if (res.status !== 0) {
	console.error(`\n💥 Bun build failed (exit ${res.status ?? "unknown"}).`);
	process.exit(res.status ?? 1);
}

// Bun may have appended .exe on Windows — find the real artifact.
let artifact = output;
try {
	statSync(artifact);
} catch {
	const exe = output + ".exe";
	try {
		statSync(exe);
		artifact = exe;
	} catch {
		console.error(`\n⚠️  Build reported success but no artifact at ${output}`);
		process.exit(1);
	}
}

const sizeMb = statSync(artifact).size / (1024 * 1024);
console.log(
	`\n✅ Done. Standalone executable at: ${artifact} (${sizeMb.toFixed(1)} MB)\n`,
);
