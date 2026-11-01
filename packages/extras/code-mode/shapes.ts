// ============================================================================
// packages/extras/code-mode/shapes.ts — one derivation for stubs/catalog/help.
// ============================================================================
// ToolShape freezes the per-cell snapshot (visibleTools() minus "code") into
// everything the guest surface needs: wire name, safe identifier, signature,
// summary, IR node. Nothing re-derives a signature independently.
// ============================================================================

import type { ToolType } from "@sanityloop/core";
import { toNode, type SchemaField, type SchemaNode } from "./schema-types.ts";

export interface ToolShape {
    /** Wire name — ALWAYS used on the bridge. */
    name: string;
    /** py/TS-safe identifier; "" when not representable (call via tools.call). */
    ident: string;
    /** promptSnippet ?? first sentence of description, ≤ 120 chars. */
    summary: string;
    /** Raw description. */
    description: string;
    /** "read(path, offset?, limit?)" — wire arg names. */
    signature: string;
    /** Declared property order. */
    fields: SchemaField[];
    required: string[];
    optional: string[];
    /** Object node for the args schema. */
    node: SchemaNode;
    pinned: boolean;
    disabled: boolean;
    hasCustomValidate: boolean;
}

export interface ShapeOptions {
    codeToolName?: string;
    exclude?: string[];
    pinned?: string[];
}

const RESERVED_IDENTS: Record<string, true> = { call: true, search: true, help: true };

const PY_KEYWORDS: Record<string, true> = (() => {
    const words = "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case".split(" ");
    const out: Record<string, true> = {};
    for (const w of words) out[w] = true;
    return out;
})();

/** Map a raw tool name to a callable identifier. "" = dunder/internal, no stub. */
export function toIdent(raw: string): string {
    let s = raw.replace(/[^A-Za-z0-9_]/g, "_");
    if (s === "") return "tool";
    if (/^[0-9]/.test(s)) s = `_${s}`;
    if (s.startsWith("__")) return "";
    if (RESERVED_IDENTS[s]) s = `${s}_tool`;
    else if (PY_KEYWORDS[s]) s = `${s}_`;
    return s;
}

export function firstSentence(text: string, max = 120): string {
    const oneLine = text.replace(/\s+/g, " ").trim();
    const m = /^(.+?[.!?])(\s|$)/.exec(oneLine);
    const out = (m ? m[1] : oneLine).trim();
    return out.length > max ? `${out.slice(0, max - 3).trimEnd()}...` : out;
}

/** Derive shapes from the live registry. Pure — pass agent.visibleTools(). */
export function toShapes(tools: ToolType[], opts: ShapeOptions = {}): ToolShape[] {
    const codeName = opts.codeToolName ?? "code";
    const exclude = new Set(opts.exclude ?? []);
    const pinned = new Set(opts.pinned ?? []);
    const snapshot = tools
        .filter((t) => t.name !== codeName)
        .filter((t) => !t.name.startsWith("__code"))
        .filter((t) => !exclude.has(t.name));

    // Code-unit sort — locale-independent prompt bytes (never localeCompare).
    const sorted = [...snapshot].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    // Collision resolution after sorting: first keeps the ident, later get _2, _3.
    const usedIdents = new Set<string>();
    const shapes: ToolShape[] = [];
    for (const t of sorted) {
        const node = toNode(t.inputSchema);
        const fields: SchemaField[] = node.kind === "object" ? node.fields : [];
        const required = fields.filter((f) => f.required).map((f) => f.name);
        const optional = fields.filter((f) => !f.required).map((f) => f.name);
        const base = toIdent(t.name);
        let ident = base;
        if (ident !== "") {
            let n = 2;
            while (usedIdents.has(ident)) ident = `${base}_${n++}`;
            usedIdents.add(ident);
        }
        const sigArgs = [...required, ...optional.map((o) => `${o}?`)].join(", ");
        shapes.push({
            name: t.name,
            ident,
            summary: firstSentence(t.promptSnippet ?? t.description ?? t.name),
            description: t.description ?? "",
            signature: `${t.name}(${sigArgs})`,
            fields,
            required,
            optional,
            node,
            pinned: pinned.has(t.name),
            disabled: t.disabled === true,
            hasCustomValidate: t.validate !== undefined,
        });
    }
    return shapes;
}
