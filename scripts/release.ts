// ============================================================================
// scripts/release.ts — the ONE-COMMAND release, THREE independent trains.
//
//   npm run release:core           <- bump core (patch), tag core-vX.Y.Z
//   npm run release:extras         <- bump extras (patch), tag extras-vX.Y.Z
//   npm run release:swarm          <- bump swarm (patch), tag swarm-vX.Y.Z
//   npm run release:core -- --minor / --major / --to X.Y.Z
//   npm run release:core -- --dry-run
//
// The three packages are INDEPENDENT. Extras does not ship at core's version:
// it declares a core RANGE (the minimum it supports, packages/extras/shelf.json
// "core", e.g. "^0.3.0") and versions on its own. Swarm versions on its own
// too, declaring its own core range in packages/swarm/package.json. Core is
// bumped ONLY when core itself changed. Never publish a new core because a
// shelf brick or swarm moved.
//
// Flow per train: verify clean tree -> bump the package's version file ->
// (core minor/major: sweep workspace core ranges + shelf.json:core) ->
// (core/swarm: sync lockfile) -> commit -> push main -> tag -> push tag.
// The tag namespaced core-vX.Y.Z / extras-vX.Y.Z / swarm-vX.Y.Z is THE publish
// trigger; .github/workflows/publish.yml validates it against THAT package's
// version and publishes only that package. Tags must be pushed locally — a
// GITHUB_TOKEN push never triggers other workflows.
// ============================================================================
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const toIdx = args.indexOf("--to");
const target = toIdx >= 0 ? args[toIdx + 1] : undefined;
const minor = args.includes("--minor");
const major = args.includes("--major");
const which = args.find((a) => a === "core" || a === "extras" || a === "swarm");

if (which !== "core" && which !== "extras" && which !== "swarm") {
	console.error("usage: release.ts <core|extras|swarm> [--minor|--major|--to X.Y.Z] [--dry-run]");
	process.exit(1);
}

interface Train {
	pkg: string;
	tagPrefix: string;
	syncLock: boolean;
}

const TRAINS: Record<"core" | "extras" | "swarm", Train> = {
	core: { pkg: "packages/core/package.json", tagPrefix: "core-v", syncLock: true },
	extras: { pkg: "packages/extras/shelf.json", tagPrefix: "extras-v", syncLock: false },
	swarm: { pkg: "packages/swarm/package.json", tagPrefix: "swarm-v", syncLock: true },
};

const train = TRAINS[which];

function sh(cmd: string): void {
	console.log(`$ ${cmd}`);
	if (DRY) return;
	execSync(cmd, { cwd: process.cwd(), stdio: "inherit", encoding: "utf8" });
}

// ---- 0. working tree must be clean (zero-brain guarantee: no surprises) ----
const dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim();
if (dirty && !DRY) {
	throw new Error(`working tree not clean — commit or stash first:\n${dirty}`);
}
if (dirty) console.log(`[dry-run] tree is dirty (would refuse):\n${dirty}`);

// ---- 1. resolve the next version ----
const raw = readFileSync(train.pkg, "utf8");
const pkg = JSON.parse(raw) as { version: string };
const cur = pkg.version;
const [maj, min, pat] = cur.split(".").map((n) => parseInt(n, 10));
const next = (() => {
	if (target) {
		if (!/^\d+\.\d+\.\d+$/.test(target)) throw new Error(`bad --to version: ${target}`);
		return target;
	}
	if (major) return `${maj + 1}.0.0`;
	if (minor) return `${maj}.${min + 1}.0`;
	return `${maj}.${min}.${pat + 1}`;
})();
if (next === cur) throw new Error("nothing to release — version unchanged");

console.log(`release: @sanityloop/${which} ${cur} -> ${next}`);

// ---- 2. bump the package's own version file ----
if (!DRY) {
	if (train.pkg.endsWith("package.json")) {
		// preserve the file's existing formatting except the version field
		if (!raw.includes(`"version": "${cur}"`)) {
			throw new Error(`could not locate "version": "${cur}" in ${train.pkg} — bump by hand`);
		}
		writeFileSync(train.pkg, raw.replace(`"version": "${cur}"`, `"version": "${next}"`));
	} else {
		pkg.version = next;
		writeFileSync(train.pkg, `${JSON.stringify(pkg, null, "\t")}\n`);
	}
}

// ---- 2b. core minor/major: sweep workspace ranges + shelf.json:core ----
// A patch keeps every ^x.y.z satisfied; a minor/major orphans them.
// The sweep rewrites ONLY the "@sanityloop/core" range line in workspace
// manifests (byte-preserving elsewhere) and the shelf's published range.
const needsSweep = which === "core" && (minor || major || target);
const swept: string[] = [];
if (needsSweep) {
	const [nmaj, nmin] = next.split(".").map((n) => parseInt(n, 10));
	const want = `^${nmaj}.${nmin}.0`;
	const roots = ["packages", join("packages", "extras")];
	for (const root of roots) {
		for (const dir of readdirSync(root, { withFileTypes: true })) {
			if (!dir.isDirectory()) continue;
			const p = join(root, dir.name, "package.json");
			if (!existsSync(p) || p === train.pkg) continue;
			const src = readFileSync(p, "utf8");
			const hit = src.match(/("@sanityloop\/core":\s*")\^[0-9]+\.[0-9]+\.[0-9]+(")/);
			if (!hit) continue;
			if (!DRY) writeFileSync(p, src.replace(hit[0], `${hit[1]}${want}${hit[2]}`));
			swept.push(p);
		}
	}
	const shelfPath = join("packages", "extras", "shelf.json");
	if (!DRY) {
		const shelf = JSON.parse(readFileSync(shelfPath, "utf8")) as { version: string; core: string };
		shelf.core = want;
		writeFileSync(shelfPath, `${JSON.stringify(shelf, null, "\t")}\n`);
	}
	swept.push(shelfPath);
	console.log(`${DRY ? "[dry-run] would sweep" : "sweep"}: core range -> ${want} in ${swept.length} files`);
}
if (train.syncLock) sh("npm install --package-lock-only --ignore-scripts");

// ---- 3. commit + push main ----
sh(`git add ${train.pkg}${train.syncLock ? " package-lock.json" : ""}${swept.length > 0 ? ` ${swept.join(" ")}` : ""}`);
sh(`git commit -m "release: @sanityloop/${which} ${next}"`);
sh("git push origin main");

// ---- 4. tag + push — THE publish trigger ----
sh(`git tag ${train.tagPrefix}${next}`);
sh(`git push origin ${train.tagPrefix}${next}`);

console.log(`\nDONE — tag ${train.tagPrefix}${next} pushed. CI is publishing @sanityloop/${which}@${next}.`);
console.log("watch: gh run list --workflow=publish.yml --limit 1");
if (DRY) console.log("(dry-run — nothing was changed or pushed)");
