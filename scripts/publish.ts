// ============================================================================
// scripts/publish.ts - the TWO-package publish gate:
//
//   @sanityloop/core     the loop, zero deps
//   @sanityloop/extras   the shelf (staged + verified by scripts/bundle.ts)
//
// Flow (verify FIRST, publish LAST):
//   1. bundle    - stage .publish/pkgs/{core,extras} (rewrites + exports map)
//   2. GATE      - tsc the staged shelf with ONLY @sanityloop/core resolvable;
//                  any leftover bare @sanityloop/* import fails the gate
//   3. pack+check- pack both dirs as tarballs, verify entries present
//   4. publish   - core first, then extras (dependency order)
//
//   node scripts/publish.ts --dry-run   <- pack + verify, publish NOTHING
//   node scripts/publish.ts             <- the real thing
//   node scripts/publish.ts --otp CODE  <- pass a one-time password through
//
// Command construction: static tokens + allowlisted args only. Every
// interpolated path is validated against the repo root (safePath) before it
// reaches execSync.
// ============================================================================
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const ONLY = (() => {
	const idx = args.indexOf("--only");
	return idx >= 0 ? new Set((args[idx + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) : new Set(["core", "extras"]);
})();
const OTP = (() => {
  const idx = args.indexOf("--otp");
  return idx >= 0 ? args[idx + 1] : undefined;
})();
const STAGE = join(ROOT, ".publish", "pkgs");
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc");
const BUNDLE_SCRIPT = join(ROOT, "scripts", "bundle.ts");
const NODE_CMD = "node --experimental-strip-types --experimental-transform-types";

/** Allowlist guard: paths passed to a shell must live under the repo root. */
function safePath(p: string): string {
  const rooted = join(ROOT, p.startsWith(ROOT) ? p.slice(ROOT.length).replace(/^[\\/]+/, "") : p);
  if (!rooted.startsWith(ROOT)) throw new Error(`refusing path outside repo: ${p}`);
  return rooted;
}

/** Build a shell command: static tokens + allowlisted, JSON-quoted args. */
function sh(tokens: readonly string[], quoted: readonly string[] = []): string {
  return [...tokens, ...quoted.map((p) => JSON.stringify(safePath(p)))].join(" ");
}

function run(cmd: string): void {
  try {
    execSync(cmd, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] });
  } catch (err) {
    throw new Error(`command failed: ${cmd}\n${err instanceof Error ? err.message : String(err)}`);
  }
}

function readJson(dir: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`bad package.json in ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function verifyPkgJson(dir: string, name: string): void {
  const j = readJson(dir);
  const problems: string[] = [];
  for (const field of ["name", "version", "description", "license", "engines", "type", "exports", "files"]) {
    if (!j[field]) problems.push(`missing "${field}"`);
  }
  if (j.name !== name) problems.push(`name mismatch (${String(j.name)} != ${name})`);
  const nodeRange = (j.engines as Record<string, unknown> | undefined)?.node;
  if (typeof nodeRange !== "string" || !nodeRange.startsWith(">=")) problems.push("engines.node must be >= something");
  if (problems.length > 0) throw new Error(`${name}: ${problems.join("; ")}`);
}

/** npm pack --json --dry-run, tolerant of npm 10 (array) and npm 12 (object) shapes. */
function packAndCheck(dir: string, name: string): void {
  let out = "";
  try {
    out = execSync(sh(["npm", "pack", "--json", "--dry-run"], [dir]), {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(`npm pack failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let paths: string[] = [];
  try {
    const parsed = JSON.parse(out) as
      | Array<{ files?: Array<{ path: string }> }>
      | Record<string, { files?: Array<{ path: string }> } | undefined>;
    if (Array.isArray(parsed)) {
      paths = parsed[0]?.files?.map((f) => f.path) ?? [];
    } else {
      const first = Object.values(parsed)[0];
      paths = first?.files?.map((f) => f.path) ?? [];
    }
  } catch {
    paths = out
      .split("\n")
      .filter((l) => l.startsWith("npm notice"))
      .map((l) => l.replace(/^npm notice\s*/, ""))
      .filter((l) => /\.(ts|json|md)$/.test(l));
  }
  if (paths.length === 0) throw new Error(`${name}: pack produced no files`);
  const j = readJson(dir);
  const walkEntries = (v: unknown, at: string): void => {
    if (typeof v === "string") {
      const rel = v.replace(/^\.\//, "");
      if (!paths.includes(rel)) throw new Error(`${name}: exports["${at}"] -> "${v}" missing from tarball`);
    } else if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) walkEntries(child, `${at}["${k}"]`);
    }
  };
  walkEntries(j.exports, ".");
  console.log(`  [pack] ${name.padEnd(22)} ${paths.length} files  entry ok`);
}

function main(): void {
	if (![...ONLY].every((name) => name === "core" || name === "extras")) {
		throw new Error(`--only accepts core, extras; received ${[...ONLY].join(", ")}`);
	}
	if (ONLY.size === 0) throw new Error("--only selected no packages");
	const wantsCore = ONLY.has("core");
	const wantsExtras = ONLY.has("extras");

  // 1. bundle
  console.log("bundle: staging .publish/pkgs ...");
	run(sh(["node", "--experimental-strip-types", "--experimental-transform-types", BUNDLE_SCRIPT, "--clean"]));

  // 2. GATE - staged shelf, only core resolvable
  const gateTsconfig = join(STAGE, "extras", "tsconfig.json");
  if (!existsSync(gateTsconfig)) throw new Error("gate tsconfig missing - did bundle.ts run?");
	if (wantsExtras) {
		console.log("gate: staged shelf typecheck (only @sanityloop/core external)...");
		run(sh(["node", TSC, "-p"], [gateTsconfig]));
		console.log("gate: PASS");
	}

  // 3. verify + pack-check
	if (wantsCore) verifyPkgJson(join(STAGE, "core"), "@sanityloop/core");
	if (wantsExtras) verifyPkgJson(join(STAGE, "extras"), "@sanityloop/extras");
	console.log(`verify: ${[...ONLY].join(" + ")} pass\n`);
	if (wantsCore) packAndCheck(join(STAGE, "core"), "@sanityloop/core");
	if (wantsExtras) packAndCheck(join(STAGE, "extras"), "@sanityloop/extras");

  if (DRY_RUN) {
    console.log("\ndry-run complete - nothing published. Remove --dry-run to publish.");
    return;
  }

	// 4. publish, dependency order: core first, then the shelf
  const publishDir = (dir: string): void => {
    const otpArg = OTP ? ["--otp", OTP] : [];
    console.log(`\n→ publishing ${dir}`);
    run(sh(["npm", "publish", "--access", "public", ...otpArg], [dir]));
    console.log("  ✓ published");
  };
	if (wantsCore) publishDir(join(STAGE, "core"));
	if (wantsExtras) publishDir(join(STAGE, "extras"));
  console.log("\nall published.");
}

main();
