// ============================================================================
// packages/extras/code-mode/catalog.ts — budgeted tool catalog + sync search.
// ============================================================================
// The prompt gets a CATALOG (2k tokens, one line per tool), never the stubs
// (50 typed stubs ≈ 12-18 KB). Round-robin tiers: no tool gets T1 before
// every tool got T0, none gets T2 before every tool got T1.
//
// search() is pure + synchronous: no bridge, no budget, no agent access.
// Safe inside kernels and inside error paths. Unknown-tool diagnostics
// reuse this same ranking — one rule everywhere.
// ============================================================================

import type { ToolType } from "@sanityloop/core";
import { toShapes, type ShapeOptions, type ToolShape } from "./shapes.ts";

export interface CatalogOptions extends ShapeOptions {
    budgetTokens?: number;
    /** Default 4 (no tokenizer dependency in-repo). Injectable for tests. */
    charsPerToken?: number;
    estimateTokens?: (s: string) => number;
}

export interface CatalogEntry extends ToolShape {
    tierText: [string, string, string];
    /** Lowercased name + summary + description + arg names. */
    haystack: string;
    /** Final tier, -1 = omitted from the prompt (still searchable/callable). */
    rendered: 0 | 1 | 2 | -1;
}

export interface Catalog {
    entries: CatalogEntry[];
    byName: ReadonlyMap<string, CatalogEntry>;
    text: string;
    estTokens: number;
    omitted: CatalogEntry[];
    fingerprint: string;
}

export interface CatalogSearchHit {
    name: string;
    ident: string;
    signature: string;
    text: string;
    rendered: boolean;
}

const HEADER = "## Tool catalog   (pinned first; callable even if only the name is shown)";
const FOOTER = "Local helpers — no tool call, no budget: tools.search(query) · tools.help(name) · tools.call(name, args)";

export function buildCatalog(tools: ToolType[], opts: CatalogOptions = {}): Catalog {
    const budgetTokens = opts.budgetTokens ?? 2000;
    const charsPerToken = opts.charsPerToken ?? 4;
    const estimate = opts.estimateTokens ?? ((s: string) => Math.ceil(s.length / charsPerToken));
    const pinned = opts.pinned ?? [];
    const pinnedSet = new Set(pinned);

    const shapes = toShapes(tools, opts);
    const entries: CatalogEntry[] = shapes.map((s) => ({
        ...s,
        tierText: [tier0(s), tier1(s), tier2(s)],
        haystack: `${s.name} ${s.summary} ${s.description} ${s.fields.map((f) => f.name).join(" ")}`.toLowerCase(),
        rendered: -1 as const,
    }));
    const byName = new Map(entries.map((e) => [e.name, e]));

    const budgetChars = budgetTokens * charsPerToken;
    const pinnedOrder = pinned.flatMap((name) => {
        const hit = byName.get(name);
        return hit !== undefined ? [hit] : [];
    });
    const rest = entries.filter((e) => !pinnedSet.has(e.name));
    const used = { n: HEADER.length + 1 + FOOTER.length + 1 };
    const assign = (e: CatalogEntry, tier: 0 | 1 | 2): void => {
        e.rendered = tier;
        used.n += e.tierText[tier].length + 1;
    };

    // Round -1: pinned at the best tier that fits, in configured order.
    for (const e of pinnedOrder) {
        for (const tier of [2, 1, 0] as const) {
            if (used.n + e.tierText[tier].length + 1 <= budgetChars) {
                assign(e, tier);
                break;
            }
        }
    }
    // Round 0: every other entry gets one line (T0) if it fits.
    for (const e of rest) {
        if (used.n + e.tierText[0].length + 1 <= budgetChars) assign(e, 0);
    }
    // Rounds 1-2: one upgrade step per entry per round.
    for (const tier of [1, 2] as const) {
        let progressed = false;
        for (const e of rest) {
            const cur: 0 | 1 | 2 | -1 = e.rendered;
            if (cur === -1) continue;
            if (cur !== 0 && cur !== 1) continue;
            if (cur >= tier) continue;
            const delta = e.tierText[tier].length - e.tierText[cur].length;
            if (used.n + delta <= budgetChars) {
                used.n += delta;
                e.rendered = tier;
                progressed = true;
            }
        }
        if (!progressed) break;
    }

    const rendered = [...pinnedOrder.filter((e) => e.rendered >= 0), ...rest.filter((e) => e.rendered >= 0)];
    const omitted = entries.filter((e) => e.rendered < 0);
    const lines = rendered.map((e) => e.tierText[e.rendered as 0 | 1 | 2]);
    if (omitted.length > 0) {
        const names = omitted.slice(0, 30).map((e) => e.name);
        const more = omitted.length > 30 ? ` … (+${omitted.length - 30})` : "";
        lines.push(`- (not shown: ${names.join(", ")}${more}) — tools.help("name") for details`);
    }
    const text = `${HEADER}\n${lines.join("\n")}\n${FOOTER}`;
    return {
        entries,
        byName,
        text,
        estTokens: estimate(text),
        omitted,
        fingerprint: fingerprintCatalog(entries, budgetTokens, pinned),
    };
}

function tier0(s: ToolShape): string {
    const call = s.ident !== "" && s.ident === s.name ? s.name : `${s.name} [via tools.call]`;
    const args = [...s.required, ...s.optional.map((o) => `${o}?`)].join(", ");
    return `- ${call}(${args})${s.disabled ? " [disabled]" : ""}`;
}

function tier1(s: ToolShape): string {
    const args = [...s.required, ...s.optional.map((o) => `${o}?`)].join(", ");
    return `- ${s.name}(${args}) — ${s.summary}${s.disabled ? " [disabled]" : ""}`;
}

function tier2(s: ToolShape): string {
    const base = tier1(s);
    const hints = s.fields
        .filter((f) => f.node.kind !== "string" || f.node.minLength !== undefined || f.node.maxLength !== undefined)
        .slice(0, 4)
        .map((f) => {
            const n = f.node;
            if (n.kind === "number") {
                const c = [n.minimum !== undefined ? `>=${n.minimum}` : "", n.maximum !== undefined ? `<=${n.maximum}` : ""].filter((b) => b !== "").join(",");
                return `${f.name}: ${n.integer ? "int" : "num"}${c !== "" ? c : ""}`;
            }
            if (n.kind === "boolean") return `${f.name}: bool`;
            if (n.kind === "array") return `${f.name}: list`;
            if (n.kind === "object") return `${f.name}: {...}`;
            return undefined;
        })
        .filter((h): h is string => h !== undefined);
    if (hints.length === 0) return base;
    const out = `${base} (${hints.join("; ")})`;
    return out.length > 240 ? `${out.slice(0, 237)}...)` : out;
}

function fingerprintCatalog(entries: CatalogEntry[], budgetTokens: number, pinned: string[]): string {
    let h = 0x811c9dc5;
    const str = `${budgetTokens}\n${pinned.join(",")}\n${entries.map((e) => `${e.name}:${e.rendered}`).join("\n")}`;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
}

// ---- sync search ------------------------------------------------------------

export function searchCatalog(catalog: Catalog, query: string, limit = 10): CatalogSearchHit[] {
    const clamped = Math.min(50, Math.max(1, Math.floor(limit) || 10));
    const q = query.trim().toLowerCase();
    if (q === "") {
        // Empty = "what exists?": pinned first, then alphabetical.
        const ordered = [...catalog.entries].sort((a, b) => {
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
            return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
        });
        return ordered.slice(0, clamped).map(toHit);
    }
    const tokens = q.split(/\s+/);
    const scored: Array<{ e: CatalogEntry; score: number }> = [];
    for (const e of catalog.entries) {
        if (!tokens.every((t) => e.haystack.includes(t))) continue;
        scored.push({ e, score: rank(e, q) });
    }
    scored.sort((a, b) => b.score - a.score || (a.e.name < b.e.name ? -1 : 1));
    return scored.slice(0, clamped).map(({ e }) => toHit(e));
}

function rank(e: CatalogEntry, q: string): number {
    const name = e.name.toLowerCase();
    if (name === q) return 1000;
    if (name.startsWith(q)) return 800;
    if (new RegExp(`(^|[-_. ])${escapeRegExp(q)}`).test(name)) return 600;
    if (name.includes(q)) return 400;
    if (e.summary.toLowerCase().includes(q)) return 300;
    return 200;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toHit(e: CatalogEntry): CatalogSearchHit {
    return { name: e.name, ident: e.ident, signature: e.signature, text: e.tierText[2], rendered: e.rendered >= 0 };
}

export function suggestToolName(catalog: Catalog, name: string): string | undefined {
    const q = name.trim().toLowerCase();
    if (q === "") return undefined;
    let best: string | undefined;
    let bestDist = 3;
    for (const e of catalog.entries) {
        const d = levenshtein(q, e.name.toLowerCase());
        if (d < bestDist) {
            bestDist = d;
            best = e.name;
        }
    }
    return bestDist <= 2 ? best : undefined;
}

function levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let diag = prev[0]!;
        prev[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const tmp = prev[j]!;
            prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
            diag = tmp;
        }
    }
    return prev[b.length]!;
}

/** Full signature + description + args for one tool. `help()` output. */
export function helpText(shape: ToolShape, lang: "python" | "typescript"): string {
    const lines = [`${shape.signature} -> ToolCallResult`, shape.description];
    if (shape.fields.length > 0) {
        lines.push("Args:");
        for (const f of shape.fields) {
            const req = f.required ? " [required]" : "";
            const desc = f.node.description !== undefined ? ` — ${f.node.description}` : "";
            lines.push(`  ${f.name}${f.required ? "" : "?"}: ${argType(f.node, lang)}${req}${desc}`);
        }
    }
    return lines.join("\n");
}

function argType(node: ToolShape["fields"][number]["node"], lang: "python" | "typescript"): string {
    // Shallow by design — full precision lives in the stubs.
    switch (node.kind) {
        case "string": return lang === "python" ? "str" : "string";
        case "number": return lang === "python" ? (node.integer ? "int" : "float") : "number";
        case "boolean": return lang === "python" ? "bool" : "boolean";
        case "null": return lang === "python" ? "None" : "null";
        case "literal": return JSON.stringify(node.value);
        case "array": return lang === "python" ? "list" : "array";
        case "object": return lang === "python" ? "dict" : "object";
        case "union": return node.variants.map((v) => argType(v, lang)).join(" | ");
        case "any": return lang === "python" ? "Any" : "any";
    }
}
