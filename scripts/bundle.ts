// ============================================================================
// scripts/bundle.ts - stage the publishable trees for the TWO-package model:
//
//   .publish/pkgs/core    <- @sanityloop/core: the loop, zero deps (as-is)
//   .publish/pkgs/extras  <- @sanityloop/extras: the SHELF - every extras
//                             brick bundled under its own subpath export,
//                             zero declared deps, core as the only dependency.
//
// The shelf bundle:
//   - copies each brick folder (minus test/) under extras/<brick>/
//   - rewrites cross-brick imports: "@sanityloop/x" -> "./x/<entry>"
//     (core stays external - extras depends on it)
//   - generates: extras/package.json (exports map), extras/index.ts (catalog),
//     extras/README.md (the shelf table from each brick's description)
//
//   node scripts/bundle.ts              <- ALL bricks
//   node scripts/bundle.ts --only a,b   <- a slice (e.g. small-package test)
//   node scripts/bundle.ts --clean      <- remove .publish before staging
// ============================================================================
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const ONLY = args.includes("--only") ? (args[args.indexOf("--only") + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : null;
const STAGE = join(ROOT, ".publish", "pkgs");

interface Brick {
  dir: string;
  name: string; // "@sanityloop/..."
  short: string; // "base-storage"
  entry: string; // "./index.ts" (from exports["."])
  description: string;
}

function read(p: string): string {
  return readFileSync(p, "utf8");
}

function json<T = Record<string, any>>(p: string): T {
	try {
		return JSON.parse(read(p)) as T;
	} catch (err) {
		throw new Error(`bad JSON in ${p}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function gatherBricks(): Brick[] {
	const out: Brick[] = [];
	const roots = [join(ROOT, "packages"), join(ROOT, "packages", "extras")];
	const seen = new Set<string>();
	for (const root of roots) {
		for (const dir of readdirSync(root, { withFileTypes: true })) {
			if (!dir.isDirectory()) continue;
			const pkgPath = join(root, dir.name, "package.json");
			if (!existsSync(pkgPath)) continue;
			const j = json(pkgPath);
			const name: string = j.name ?? "";
			if (!name.startsWith("@sanityloop/")) continue;
			if (name === "@sanityloop/core" || j.private === true) continue;
			const short = name.replace("@sanityloop/", "");
			if (seen.has(short)) continue;
			seen.add(short);
			if (ONLY && !ONLY.includes(short)) continue;
			const rawEntry = typeof j.exports?.["."] === "string" ? j.exports["."] : j.exports?.["."]?.default;
			const entry = typeof rawEntry === "string" ? rawEntry : "./index.ts";
			out.push({
				dir: join(root, dir.name),
				name,
				short,
				entry,
				description: typeof j.description === "string" ? j.description : "",
			});
		}
	}
	out.sort((a, b) => a.short.localeCompare(b.short));
	return out;
}

function copyBrick(b: Brick, extrasDir: string): void {
  const dest = join(extrasDir, b.short);
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(b.dir, dest, {
    recursive: true,
    filter: (src) => {
      const rel = relative(b.dir, src).replace(/\\/g, "/");
      if (rel === "test" || rel.startsWith("test/")) return false;
      if (rel === "node_modules" || rel.startsWith("node_modules/")) return false;
      if (rel.endsWith("package.json") || rel === "tsconfig.json") return false;
      if (existsSync(src) && src && rel.endsWith(".d.ts")) return false; // none shipped today
      return true;
    },
  });
}

/** Rewrite cross-brick @sanityloop/x imports to bundled relative subpaths.
 * The relative path is computed per FILE: bricks sit at extras/<short>/, so a
 * brick-root file reaches a sibling as ../<short>/<entry> and a deeply nested
 * file needs ../../<short>/... — depth is never assumed.
 */
function rewriteImports(extrasDir: string, walkRoot: string, byShort: Map<string, Brick>): string[] {
	const touched: string[] = [];
	const walk = (d: string): void => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) {
				walk(p);
				continue;
			}
			if (!e.name.endsWith(".ts")) continue;
			const src = read(p);
			const replaced = src.replace(
				/(from\s+|import\s*\(\s*)["']@sanityloop\/([a-z0-9-]+)["']/g,
				(whole, lead: string, short: string) => {
					const target = byShort.get(short);
					if (!target) return whole; // core / unknown -> external (gate rejects later)
					const targetFile = join(extrasDir, short, target.entry.replace(/^\.\//, ""));
					const rel = relative(dirname(p), targetFile).replace(/\\/g, "/");
					const relPath = rel.startsWith(".") ? rel : `./${rel}`;
					return `${lead}"${relPath}"`;
				},
			);
			if (replaced !== src) {
				writeFileSync(p, replaced);
				touched.push(relative(extrasDir, p));
			}
		}
	};
	walk(walkRoot);
	return touched;
}

// The three lazy-optional worlds are NOT declared — their libs load on demand.
const LAZY_HEAVY = new Set([
	"@modelcontextprotocol/client",
	"@modelcontextprotocol/server",
	"@modelcontextprotocol/node",
	"@modelcontextprotocol/client/stdio",
	"@earendil-works/pi-ai",
	"elysia",
	"@elysia/node",
]);

/** Union of the bricks' light external deps (heavy lazy worlds excluded). */
function collectDeps(bricks: Brick[]): Record<string, string> {
	const deps: Record<string, string> = {};
	for (const b of bricks) {
		const j = json(join(b.dir, "package.json"));
		const all = { ...(j.dependencies ?? {}), ...(j.peerDependencies ?? {}) };
		for (const [name, range] of Object.entries(all)) {
			if (name.startsWith("@sanityloop/") || LAZY_HEAVY.has(name)) continue;
			if (!(name in deps)) deps[name] = String(range);
		}
	}
	return deps;
}

function generateExtrasPackage(bricks: Brick[], extrasDir: string): void {
	const exports: Record<string, { default: string }> = {};
	for (const b of bricks) exports[`./${b.short}`] = { default: `./${b.short}/${b.entry.replace(/^\.\//, "")}` };
	exports["."] = { default: "./index.ts" };
	const pkg = {
		name: "@sanityloop/extras",
		version: "0.1.0",
		license: "MIT",
		description: "The shelf - every optional SanityLoop module as a subpath import. Only light libs (~2MB) ride as dependencies; the heavy worlds (mcp, pi-model, http-server) load lazily and declare their own needs.",
		repository: {
			type: "git",
			url: "https://github.com/lirrensi/SanityLoop.git",
		},
		type: "module",
		exports,
		dependencies: collectDeps(bricks),
		engines: { node: ">=22.6" },
		files: ["**/*.ts", "README.md"],
	};
	writeFileSync(join(extrasDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}

function generateCatalog(bricks: Brick[], extrasDir: string): void {
  const lines = [
		"// @sanityloop/extras — the shelf. Import the subpath you want; light libs",
		"// (~2MB total) ride as dependencies, the heavy worlds (mcp, pi-model,",
		"// http-server) load lazily and tell you exactly what to install.",
    "//",
    "// Subpaths (each = one brick from the monorepo):",
    ...bricks.map((b) => `//   ${`./${b.short}`.padEnd(30)} ${b.description}`),
    "",
    "export const SUBPATHS = [",
    ...bricks.map((b) => `\t"./${b.short}",`),
    "];",
    "",
  ];
  writeFileSync(join(extrasDir, "index.ts"), lines.join("\n"));
}

function generateShelfReadme(bricks: Brick[], extrasDir: string): void {
  const rows = bricks.map(
    (b) => `| \`@sanityloop/extras/${b.short}\` | \`${b.entry.replace(/^\.\//, "")}\` | ${b.description} |`,
  );
  const md = [
    "# @sanityloop/extras",
    "",
		"The shelf — every optional SanityLoop module behind one install. Only light libraries (~2MB total) ride as dependencies; **you only ever load what you import**. The three heavy worlds (mcp, pi-model, http-server) stay entirely optional — they load lazily and print the exact `npm i` command if you use them without their library.",
    "",
    "Part of [SanityLoop](https://github.com/lirrensi/SanityLoop) — an agent loop and SDK that does not make you insane.",
    "",
    "## Install",
    "",
    "```sh",
    "npm i @sanityloop/core @sanityloop/extras",
    "```",
    "",
    "## The shelf",
    "",
    "| Subpath | Entry | What it is |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "## Heavy subpaths (lazy, optional)",
    "",
    "These are NOT installed by npm. Import the subpath, use it, and if the library is missing you get a friendly error with the exact command:",
    "",
    "```sh",
    "npm i @modelcontextprotocol/client      # for extras/mcp",
    "npm i @earendil-works/pi-ai             # for extras/pi-model",
    "npm i elysia @elysia/node               # for extras/http-server",
    "```",
    "",
    "## Runtime",
    "",
    "Ships as TypeScript source. Run with **Node ≥ 22.6** (type stripping) or **tsx / bun**.",
    "",
  ];
  writeFileSync(join(extrasDir, "README.md"), md.join("\n"));
}
/** The reproducibility gate: tsc over the staged shelf with ONLY @sanityloop/core
 * resolvable. Any leftover bare @sanityloop/* import (a missed rewrite or a
 * dangling dep) fails the gate. Generated so publish.ts can run it fresh.
 */
function generateGateTsconfig(extrasDir: string): void {
	writeFileSync(
		join(extrasDir, "tsconfig.json"),
		JSON.stringify(
			{
				compilerOptions: {
					target: "ES2022",
					module: "NodeNext",
					moduleResolution: "NodeNext",
					strict: true,
					noEmit: true,
					allowImportingTsExtensions: true,
					erasableSyntaxOnly: true,
					skipLibCheck: true,
					types: ["node"],
					paths: { "@sanityloop/core": ["../../../packages/core/src/index.ts"] },
				},
				include: ["**/*.ts"],
			},
			null,
			2,
		) + "\n",
	);
}

function stageCore(): void {
  const coreDir = join(STAGE, "core");
  if (existsSync(coreDir)) rmSync(coreDir, { recursive: true, force: true });
  mkdirSync(coreDir, { recursive: true });
  cpSync(join(ROOT, "packages", "core", "src"), join(coreDir, "src"), { recursive: true });
  const pkg = json(join(ROOT, "packages", "core", "package.json"));
  writeFileSync(join(coreDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  const readme = join(ROOT, "packages", "core", "README.md");
  if (existsSync(readme)) cpSync(readme, join(coreDir, "README.md"));
}

function main(): void {
  if (args.includes("--clean") && existsSync(join(ROOT, ".publish"))) {
    rmSync(join(ROOT, ".publish"), { recursive: true, force: true });
  }
  const bricks = gatherBricks();
  if (bricks.length === 0) throw new Error("no bricks matched (--only names?)");
  mkdirSync(join(STAGE, "extras"), { recursive: true });

  const byShort = new Map(bricks.map((b) => [b.short, b]));
	for (const b of bricks) copyBrick(b, join(STAGE, "extras"));
	const extrasDir = join(STAGE, "extras");
	const touched: string[] = [];
	for (const b of bricks) {
		const rewrites = rewriteImports(extrasDir, join(extrasDir, b.short), byShort);
		if (rewrites.length > 0) touched.push(`${b.short}: ${rewrites.join(", ")}`);
	}

  generateExtrasPackage(bricks, join(STAGE, "extras"));
  generateCatalog(bricks, join(STAGE, "extras"));
	generateShelfReadme(bricks, join(STAGE, "extras"));
	generateGateTsconfig(join(STAGE, "extras"));
	stageCore();

  console.log(`staged ${bricks.length} bricks -> .publish/pkgs/extras`);
  console.log(`subpaths: ${bricks.map((b) => b.short).join(", ")}`);
  console.log(`cross-brick imports rewritten: ${touched.length}`);
  for (const t of touched) console.log(`  ${t}`);
  console.log(`core staged -> .publish/pkgs/core (${readdirSync(join(STAGE, "core")).join(", ")})`);
}

main();
