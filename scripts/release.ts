// ============================================================================
// scripts/release.ts — the ONE-COMMAND release. "go release."
//
//   npm run release              <- next patch (0.2.2 -> 0.2.3)
//   npm run release -- --minor   <- next minor (0.2.2 -> 0.3.0)
//   npm run release -- --major   <- next major (0.2.2 -> 1.0.0)
//   npm run release -- --to 0.3.1<- explicit target
//   npm run release:dry          <- print everything, change nothing
//
// Flow: verify clean tree -> bump @sanityloop/core (extras ships lockstep) ->
// sync lockfile -> commit -> push main -> tag vX.Y.Z -> push tag. The tag push
// triggers .github/workflows/publish.yml which publishes to npm via OIDC.
// No local npm auth needed. You say "go release"; CI does the publishing.
// ============================================================================
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const toIdx = args.indexOf("--to");
const target = toIdx >= 0 ? args[toIdx + 1] : undefined;
const minor = args.includes("--minor");
const major = args.includes("--major");

const CORE_PKG = "packages/core/package.json";

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
const pkg = JSON.parse(readFileSync(CORE_PKG, "utf8")) as { version: string };
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

console.log(`release: @sanityloop/core ${cur} -> ${next} (extras lockstep)`);

// ---- 2. bump core (extras follows via bundle.ts) ----
if (!DRY) {
	pkg.version = next;
	writeFileSync(CORE_PKG, `${JSON.stringify(pkg, null, 2)}\n`);
}
sh("npm install --package-lock-only --ignore-scripts");

// ---- 3. commit + push main ----
sh(`git add ${CORE_PKG} package-lock.json`);
sh(`git commit -m "release: @sanityloop/core ${next} (extras lockstep)"`);
sh("git push origin main");

// ---- 4. tag + push — THE publish trigger ----
sh(`git tag v${next}`);
sh(`git push origin v${next}`);

console.log(`\nDONE — tag v${next} pushed. CI is publishing @sanityloop/core@${next} + @sanityloop/extras@${next}.`);
console.log("watch: gh run list --workflow=publish.yml --limit 1");
if (DRY) console.log("(dry-run — nothing was changed or pushed)");