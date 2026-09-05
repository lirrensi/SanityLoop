// ============================================================================
// scripts/release.ts — the ONE-COMMAND release, TWO independent trains.
//
//   npm run release:core          <- bump core (0.2.2 -> 0.2.3), tag core-v0.2.3
//   npm run release:extras        <- bump extras (0.2.1 -> 0.2.2), tag extras-v0.2.2
//   npm run release:core -- --minor / --major / --to X.Y.Z
//   npm run release:core -- --dry-run
//
// The two packages are INDEPENDENT. Extras does not ship at core's version:
// it declares a core RANGE (the minimum it supports, packages/extras/shelf.json
// "core": "^0.2.0") and versions on its own. Core is bumped ONLY when core
// itself changed. Never publish a new core because a shelf brick moved.
//
// Flow per train: verify clean tree -> bump the package's version file ->
// (core only: sync lockfile) -> commit -> push main -> tag -> push tag.
// The tag namespaced core-vX.Y.Z / extras-vX.Y.Z is THE publish trigger;
// .github/workflows/publish.yml validates it against THAT package's version
// and publishes only that package. Tags must be pushed locally — a
// GITHUB_TOKEN push never triggers other workflows.
// ============================================================================
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const toIdx = args.indexOf("--to");
const target = toIdx >= 0 ? args[toIdx + 1] : undefined;
const minor = args.includes("--minor");
const major = args.includes("--major");
const which = args.find((a) => a === "core" || a === "extras");

if (which !== "core" && which !== "extras") {
	console.error("usage: release.ts <core|extras> [--minor|--major|--to X.Y.Z] [--dry-run]");
	process.exit(1);
}

interface Train {
	pkg: string;
	tagPrefix: string;
	syncLock: boolean;
}

const TRAINS: Record<"core" | "extras", Train> = {
	core: { pkg: "packages/core/package.json", tagPrefix: "core-v", syncLock: true },
	extras: { pkg: "packages/extras/shelf.json", tagPrefix: "extras-v", syncLock: false },
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
	if (train.tagPrefix === "core-v") {
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
if (train.syncLock) sh("npm install --package-lock-only --ignore-scripts");

// ---- 3. commit + push main ----
sh(`git add ${train.pkg}${train.syncLock ? " package-lock.json" : ""}`);
sh(`git commit -m "release: @sanityloop/${which} ${next}"`);
sh("git push origin main");

// ---- 4. tag + push — THE publish trigger ----
sh(`git tag ${train.tagPrefix}${next}`);
sh(`git push origin ${train.tagPrefix}${next}`);

console.log(`\nDONE — tag ${train.tagPrefix}${next} pushed. CI is publishing @sanityloop/${which}@${next}.`);
console.log("watch: gh run list --workflow=publish.yml --limit 1");
if (DRY) console.log("(dry-run — nothing was changed or pushed)");
