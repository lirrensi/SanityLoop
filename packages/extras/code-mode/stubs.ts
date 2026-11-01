// ============================================================================
// packages/extras/code-mode/stubs.ts — per-cell stub prelude emitters.
// ============================================================================
// buildStubs() takes the live registry and returns the complete prelude
// source for each language. Generated artifacts are STRINGS, never files:
// StubSet.python goes to the kernel prelude; StubSet.typescript documents
// the JS surface (also served via tools.help).
//
// Python optional semantics: OMIT sentinel, not None. _args() drops OMIT;
// an explicit None is sent as JSON null and validated honestly.
// ============================================================================

import type { ToolType } from "@sanityloop/core";
import { toShapes, type ShapeOptions, type ToolShape } from "./shapes.ts";
import { isPyKeyword, pyConstraint, pyShape, pyType, tsType } from "./schema-types.ts";

export const CODE_MODE_BUDGET = 50;
export const PINNED_TOOLS = ["read", "write", "edit", "bash", "glob", "grep"];

export interface StubOptions extends ShapeOptions {
    maxStubs?: number;
    maxDescriptionChars?: number;
}

export interface StubSet {
    shapes: ToolShape[];
    byName: ReadonlyMap<string, ToolShape>;
    byIdent: ReadonlyMap<string, ToolShape>;
    /** Over the stub budget: call-only via tools.call. */
    omitted: ToolShape[];
    /** Complete python prelude source. */
    python: string;
    /** Self-contained per-cell .d.ts (documentation + help()). */
    typescript: string;
    signatures: Record<string, string>;
    fingerprint: string;
    stats: { stubs: number; omitted: number; pyChars: number; tsChars: number };
}

export function buildStubs(tools: ToolType[], opts: StubOptions = {}): StubSet {
    const maxStubs = opts.maxStubs ?? CODE_MODE_BUDGET;
    const pinned = opts.pinned ?? PINNED_TOOLS;
    const all = toShapes(tools, { ...opts, pinned });
    // Pinned first (configured order), then code-unit alphabetical.
    const pinnedSet = new Set(pinned);
    const pinnedShapes = pinned.flatMap((name) => {
        const hit = all.find((s) => s.name === name);
        return hit !== undefined ? [hit] : [];
    });
    const rest = all.filter((s) => !pinnedSet.has(s.name));
    const ordered = [...pinnedShapes, ...rest];
    const stubbed = ordered.slice(0, maxStubs);
    const omitted = ordered.slice(maxStubs);

    const byName = new Map(all.map((s) => [s.name, s]));
    const byIdent = new Map(stubbed.filter((s) => s.ident !== "").map((s) => [s.ident, s]));
    const signatures: Record<string, string> = {};
    for (const s of all) signatures[s.name] = s.signature;

    const python = renderPythonPrelude(stubbed, omitted, maxStubs, opts.maxDescriptionChars ?? 600);
    const typescript = renderTypeScriptDts(stubbed, all);
    return {
        shapes: stubbed,
        byName,
        byIdent,
        omitted,
        python,
        typescript,
        signatures,
        fingerprint: fingerprintStubSet(all, maxStubs, pinned, opts),
        stats: { stubs: stubbed.length, omitted: omitted.length, pyChars: python.length, tsChars: typescript.length },
    };
}

function fingerprintStubSet(all: ToolShape[], maxStubs: number, pinned: string[], opts: StubOptions): string {
    const parts = all.map((s) => JSON.stringify([s.name, s.summary, s.description, s.node, s.disabled, s.hasCustomValidate]));
    const head = JSON.stringify([maxStubs, pinned, opts.exclude ?? [], opts.codeToolName ?? "code"]);
    let h = 0x811c9dc5;
    const str = `${head}\n${parts.join("\n")}`;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
}

// ---- Python ---------------------------------------------------------------

function renderPythonPrelude(stubbed: ToolShape[], omitted: ToolShape[], maxStubs: number, maxDesc: number): string {
    const lines: string[] = [
        "# ==== SanityLoop code-mode stubs — generated per cell, do not edit ====",
        `# cell tools: ${stubbed.length} stubbed, ${omitted.length} omitted (budget ${maxStubs})`,
        "from __future__ import annotations",
        "from typing import Any, Literal",
        "",
        "class _Omit:",
        "    __slots__ = ()",
        "    def __repr__(self) -> str:",
        '        return "OMIT"',
        "",
        "OMIT: Any = _Omit()",
        "",
        "def _args(kwargs: dict[str, Any]) -> dict[str, Any]:",
        '    """Drop omitted optional arguments; explicit None is kept (JSON null)."""',
        "    return {k: v for k, v in kwargs.items() if v is not OMIT}",
        "",
        "def _call(name: str, args: dict[str, Any]) -> Any:",
        '    """Installed by the code-mode kernel; replaced with the real bridge."""',
        '    raise RuntimeError(f"code-mode bridge is not installed (cannot call {name!r})")',
        "",
        "# Kernel-provided local helpers (search/help). Fallbacks keep the prelude importable.",
        "_locals: dict[str, Any] = {",
        '    "search": lambda query, limit=10: [],',
        '    "help": lambda name: f"(no help available for {name!r})",',
        "}",
        "",
        "class _Tools:",
    ];
    for (const s of stubbed) {
        if (s.ident === "") continue; // dunder/internal: catalog + tools.call only
        lines.push(...renderPythonMethod(s, maxDesc));
        lines.push("");
    }
    lines.push(
        "    # ---- local helpers: NOT tool calls, never gated, never budgeted ----",
        "    def search(self, query: str, limit: int = 10) -> list[dict[str, Any]]:",
        '        """Find tools in this cell\'s snapshot by name/description. Local and free."""',
        '        return _locals["search"](query, limit)',
        "",
        "    def help(self, name: str) -> str:",
        '        """Full signature, description, args and guidelines for one tool. Local and free."""',
        '        return _locals["help"](name)',
        "",
        "    def call(self, name: str, args: dict[str, Any] | None = None) -> Any:",
        '        """Call ANY tool by its exact registered name. A real call (gated, budgeted)."""',
        "        return _call(name, args or {})",
        "",
        "tools = _Tools()",
    );
    if (omitted.length > 0) {
        const names = omitted.slice(0, 50).map((s) => s.name);
        const more = omitted.length > 50 ? ` ... (+${omitted.length - 50})` : "";
        lines.push("", `# Not stubbed (budget ${maxStubs}) — reachable via tools.call("name", {...}):`, `#   ${names.join(", ")}${more}`);
    }
    return `${lines.join("\n")}\n`;
}

function renderPythonMethod(s: ToolShape, maxDesc: number): string[] {
    // Explicit params when every wire name is a valid non-keyword identifier;
    // otherwise **kwargs with exact keys documented.
    const explicit = s.fields.length > 0 && s.fields.every((f) => isPyIdent(f.name));
    const params = explicit
        ? s.fields.map((f) => `${f.name}: ${pyType(f.node)}${f.required ? "" : " = OMIT"}`).join(", ")
        : s.fields.length > 0
          ? "**kwargs: Any"
          : "";
    const sig = params.length > 0 ? `(self, ${params}) -> Any:` : "(self) -> Any:";
    const lines = [`    def ${s.ident}${sig}`];
    const doc = renderPythonDocstring(s, maxDesc, explicit);
    for (const dl of doc.split("\n")) lines.push(dl.length > 0 ? `        ${dl}` : "");
    const dictEntries = s.fields.map((f) => `"${f.name}": ${isPyIdent(f.name) ? f.name : `kwargs["${f.name}"]`}`).join(", ");
    const argsExpr = explicit
        ? `_args({${dictEntries}})`
        : s.fields.length > 0
          ? `_args({${s.fields.map((f) => `"${f.name}": kwargs.get("${f.name}", OMIT)`).join(", ")}})`
          : "_args({})";
    lines.push(`        return _call("${s.name}", ${argsExpr})`);
    return lines;
}

function renderPythonDocstring(s: ToolShape, maxDesc: number, explicit: boolean): string {
    const esc = (t: string): string => t.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"').replace(/\r/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
    const parts = [esc(s.summary), ""];
    if (s.description.length > 0 && s.description !== s.summary) {
        let body = esc(s.description);
        if (body.length > maxDesc) {
            const cut = body.slice(0, maxDesc);
            const sp = cut.lastIndexOf(" ");
            body = `${sp > maxDesc * 0.5 ? cut.slice(0, sp) : cut}...`;
        }
        parts.push(body, "");
    }
    if (s.fields.length > 0) {
        parts.push("Args:");
        for (const f of s.fields) {
            const req = f.required ? " [required]" : "";
            const constraint = pyConstraint(f.node);
            const hint = constraint !== undefined ? ` (${constraint})` : "";
            const desc = f.node.description !== undefined ? ` ${esc(f.node.description)}` : "";
            parts.push(`    ${f.name}:${hint}${req}${desc.length > 0 ? `.${desc}` : ""}`);
            if ((f.node.kind === "object" && f.node.fields.length > 0) || f.node.kind === "array") {
                parts.push(`    Each: ${pyShape(f.node)}`);
            }
        }
        if (!explicit) {
            parts.push(`    Accepts (exact keys): ${s.fields.map((f) => f.name).join(", ")}`);
        }
    }
    return `"""${parts.join("\n")}\n"""`;
}

function isPyIdent(name: string): boolean {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false;
    return !isPyKeyword(name);
}

// ---- TypeScript ------------------------------------------------------------

function renderTypeScriptDts(stubbed: ToolShape[], all: ToolShape[]): string {
    const lines = [
        "// ==== SanityLoop code-mode types — cell snapshot, generated, do not edit ====",
        "export interface ToolCallResult {",
        "  answer: string;",
        "  stored?: unknown;",
        "  error?: boolean;",
        "  errorMessage?: string;",
        "}",
        "export interface ToolInfo {",
        "  name: string; ident: string; signature: string; pinned: boolean; stubbed: boolean;",
        "}",
        "export interface CodeModeTools {",
        "  /** Local lookup over the cell snapshot. No bridge, no budget. */",
        "  search(query: string, limit?: number): ToolInfo[];",
        "  /** Full signature + docstring for one tool. Local, free. */",
        "  help(name: string): string;",
        "  /** Call ANY tool by exact registered name (gated, budgeted). */",
        "  call(name: string, args?: Record<string, unknown>): Promise<ToolCallResult>;",
        "}",
    ];
    const stubbedNames = new Set(stubbed.map((s) => s.name));
    for (const s of all) {
        if (s.ident === "") continue;
        if (!stubbedNames.has(s.name)) continue;
        const iface = `${pascal(s.ident)}Args`;
        lines.push(`export interface ${iface} {`);
        if (s.node.kind === "object") {
            for (const f of s.node.fields) {
                const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(f.name) ? f.name : JSON.stringify(f.name);
                const jsdoc = f.node.description !== undefined ? `/** ${f.node.description.replace(/\*\//g, "*\\/")} */ ` : "";
                lines.push(`  ${jsdoc}${key}${f.required ? "" : "?"}: ${tsType(f.node, "param")};`);
            }
            if (s.node.additional !== false) lines.push("  [k: string]: unknown;");
        }
        lines.push("}");
    }
    lines.push("export interface CellTools extends CodeModeTools {");
    for (const s of stubbed) {
        if (s.ident === "") continue;
        const jsdoc = s.summary.replace(/\*\//g, "*\\/");
        const iface = `${pascal(s.ident)}Args`;
        const argsParam = s.required.length > 0 ? `args: ${iface}` : `args?: ${iface}`;
        lines.push(`  /** ${jsdoc} */`);
        lines.push(`  ${s.ident}(${argsParam}): Promise<ToolCallResult>;`);
    }
    lines.push("}", "declare const tools: CellTools;");
    return `${lines.join("\n")}\n`;
}

function pascal(s: string): string {
    const parts = s.split("_").filter((p) => p.length > 0);
    const out = parts.map((p) => p[0]!.toUpperCase() + p.slice(1)).join("");
    return out.length > 0 ? out : "Tool";
}
