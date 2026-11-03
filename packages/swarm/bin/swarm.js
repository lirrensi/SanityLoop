#!/usr/bin/env node
// packages/swarm/bin/swarm.js — the installed launcher.
// Installed layout (dist + bin, NO src — Node refuses to type-strip files
// under node_modules): exec the compiled dist CLI directly, no flags.
// Source checkout (bin + src, no dist yet): fall back to cli.ts with the
// strip-types flags the repo uses everywhere.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const distCli = path.join(here, "..", "dist", "server", "cli.mjs");
const srcCli = path.join(here, "..", "src", "server", "cli.ts");
let argv;
if (existsSync(distCli)) {
  argv = [distCli, ...process.argv.slice(2)];
} else if (existsSync(srcCli)) {
  argv = [
    "--experimental-strip-types",
    "--experimental-transform-types",
    srcCli,
    ...process.argv.slice(2),
  ];
} else {
  console.error(`[swarm] cli not found (looked for ${distCli} and ${srcCli})`);
  process.exit(1);
}
const result = spawnSync(process.execPath, argv, { stdio: "inherit" });
process.exit(result.status ?? 1);
