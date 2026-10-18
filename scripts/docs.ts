// scripts/docs.ts — documentation invariants. Exit 1 on any violation.
//
//   npm run docs:check            structural errors fail; coverage gaps warn
//   npm run docs:check -- --strict   warnings fail too (the target state)
//   npm run docs:check -- --json     machine output
//
// What it guards (docs/ontology.md is the source of truth):
//   - every doc has frontmatter with a node_type registered in the ontology
//   - every folder in docs/ has an INDEX.md
//   - every link (frontmatter `links:` and body markdown) resolves
//   - no orphan docs — every doc is linked from some INDEX.md
//   - coverage: every published extra + every core truth file is anchored
//     in the docs (warnings until the tree is clean, then run --strict)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOCS = join(ROOT, "docs");
const args = process.argv.slice(2);
const jsonOnly = args.includes("--json");
const strict = args.includes("--strict");

type Level = "error" | "warn";
interface Finding { level: Level; file: string; msg: string }
const findings: Finding[] = [];
const report = (level: Level, file: string, msg: string): void => { findings.push({ level, file: rel(file), msg }); };
const err = (file: string, msg: string): void => report("error", file, msg);
const warn = (file: string, msg: string): void => report("warn", file, msg);

const rel = (p: string): string => relative(ROOT, p).split(sep).join("/");

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (name.startsWith(".")) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else out.push(p);
    }
    return out;
}

interface Frontmatter { nodeType?: string; links: Array<{ type: string; target: string }>; }
const LINK_RE = /^\s{2}([a-z_]+):\s*\[(.*)\]\s*$/;

function parseFrontmatter(text: string, file: string): Frontmatter | undefined {
    const lines = text.split(/\r?\n/);
    if (lines[0]?.trim() !== "---") return undefined;
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (end < 0) { err(file, "frontmatter opened but never closed"); return undefined; }
    const fm: Frontmatter = { links: [] };
    for (let i = 1; i < end; i++) {
        const line = lines[i];
        const nt = /^node_type:\s*(\S+)\s*$/.exec(line);
        if (nt) fm.nodeType = nt[1];
        const lk = LINK_RE.exec(line);
        if (lk) {
            for (const raw of lk[2].split(",")) {
                const target = raw.trim().replace(/^["']|["']$/g, "");
                if (target !== "") fm.links.push({ type: lk[1], target });
            }
        }
    }
    return fm;
}

/** Resolve a doc/code link to an absolute path, or undefined when it is external/anchor-only. */
function resolveLink(fromFile: string, target: string): string | undefined {
    if (/^(https?:|mailto:|tel:|#)/.test(target)) return undefined;
    const clean = target.split("#")[0].split("?")[0].trim();
    if (clean === "") return undefined;
    if (clean.startsWith("/")) {
        const isDoc = /\.(md|markdown)$/.test(clean);
        return isDoc ? join(DOCS, clean) : join(ROOT, clean);
    }
    return resolve(dirname(fromFile), clean);
}

const BODY_LINK_RE = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** Code fences and inline code hold examples, not links. */
function stripCode(text: string): string {
    return text
        .replace(/```[\s\S]*?```/g, "")
        .replace(/~~~[\s\S]*?~~~/g, "")
        .replace(/`[^`\n]*`/g, "");
}

function bodyLinks(text: string): string[] {
    const out: string[] = [];
    for (const m of stripCode(text).matchAll(BODY_LINK_RE)) out.push(m[1]);
    return out;
}

// ── the doc tree ────────────────────────────────────────────────────────────
const docsFiles = walk(DOCS).filter((p) => p.endsWith(".md"));
const nodeTypes = new Set<string>(["index"]);
for (const line of readFileSync(join(DOCS, "ontology.md"), "utf8").split(/\r?\n/)) {
    const m = /^\|\s*`([a-z-]+)`\s*\|/.exec(line);
    if (m) nodeTypes.add(m[1]);
}

const docDirs = new Set<string>([DOCS]);
for (const f of docsFiles) docDirs.add(dirname(f));

const indexTargets = new Set<string>();
let docCount = 0;

for (const file of docsFiles) {
    const text = readFileSync(file, "utf8");
    const fm = parseFrontmatter(text, file);
    if (!fm) { err(file, "missing frontmatter (--- node_type: ... ---)"); continue; }
    if (!fm.nodeType) err(file, "frontmatter has no node_type");
    else if (!nodeTypes.has(fm.nodeType)) err(file, `unknown node_type "${fm.nodeType}" (not in docs/ontology.md)`);

    const targets = [...fm.links.map((l) => l.target), ...bodyLinks(text)];
    const isIndex = file.endsWith("INDEX.md");
    for (const target of targets) {
        const abs = resolveLink(file, target);
        if (abs === undefined) continue;
        if (!existsSync(abs)) { err(file, `broken link: ${target}`); continue; }
        const relDoc = rel(abs);
        if (isIndex && relDoc.startsWith("docs/") && relDoc.endsWith(".md")) indexTargets.add(relDoc);
    }

    if (!file.endsWith("INDEX.md")) docCount++;
}

// ── I1: every folder with docs has an INDEX.md ─────────────────────────────
for (const dir of docDirs) {
    const hasMd = docsFiles.some((f) => dirname(f) === dir);
    if (hasMd && !existsSync(join(dir, "INDEX.md"))) err(join(dir, "INDEX.md"), "folder has docs but no INDEX.md");
}

// ── I4: no orphans — every doc is linked from an INDEX.md ──────────────────
for (const file of docsFiles) {
    if (file.endsWith("INDEX.md")) continue;
    if (rel(file) === "docs/INDEX.md") continue;
    if (!indexTargets.has(rel(file))) err(file, "orphan: not linked from any INDEX.md");
}

// ── the front door: README links must resolve too ──────────────────────────
const readme = join(ROOT, "README.md");
if (existsSync(readme)) {
    for (const target of bodyLinks(readFileSync(readme, "utf8"))) {
        const abs = resolveLink(readme, target);
        if (abs !== undefined && !existsSync(abs)) err(readme, `broken link: ${target}`);
    }
}

// ── coverage: published extras must be catalogued ──────────────────────────
const catalog = readFileSync(join(DOCS, "reference", "extensions.md"), "utf8");
const extrasDir = join(ROOT, "packages", "extras");
for (const name of readdirSync(extrasDir)) {
    const dir = join(extrasDir, name);
    if (!statSync(dir).isDirectory() || name.startsWith(".")) continue;
    if (!existsSync(join(dir, "package.json"))) continue;
    if (!catalog.includes(`@sanityloop/${name}`) && !catalog.includes(`packages/extras/${name}`)) {
        warn(join(DOCS, "reference", "extensions.md"), `coverage: package "${name}" has no catalog entry`);
    }
}

// ── coverage: every core truth file is anchored in some doc ────────────────
const coreDir = join(ROOT, "packages", "core", "src", "core", "v1");
if (existsSync(coreDir)) {
    const all = [...readFileSyncAllLinks()].join("\n");
    for (const name of readdirSync(coreDir).filter((n) => n.endsWith(".ts"))) {
        const anchor = `packages/core/src/core/v1/${name}`;
        if (!all.includes(anchor)) warn(coreDir, `coverage: ${anchor} is not linked from any doc`);
    }
}
function readFileSyncAllLinks(): Set<string> {
    const links = new Set<string>();
    for (const file of docsFiles) {
        const text = readFileSync(file, "utf8");
        const fm = parseFrontmatter(text, file);
        if (fm) for (const l of fm.links) links.add(l.target);
        for (const t of bodyLinks(text)) links.add(t);
    }
    return links;
}

// ── report ─────────────────────────────────────────────────────────────────
const errors = findings.filter((f) => f.level === "error");
const warns = findings.filter((f) => f.level === "warn");
const failed = errors.length > 0 || (strict && warns.length > 0);

if (jsonOnly) {
    console.log(JSON.stringify({ docs: docCount, errors, warnings: warns, strict, failed }, null, 2));
} else {
    for (const f of findings) console.log(`${f.level === "error" ? "✖" : "⚠"} ${f.file}: ${f.msg}`);
    console.log("──────────────────────────────────────────────");
    console.log(
        failed
            ? `✖ DOCS RED — ${errors.length} error(s), ${warns.length} warning(s) across ${docCount} docs${strict && warns.length > 0 && errors.length === 0 ? " (--strict)" : ""}`
            : `✔ DOCS GREEN — ${docCount} docs, ${warns.length} warning(s)`,
    );
}
process.exit(failed ? 1 : 0);
