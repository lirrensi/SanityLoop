// ============================================================================
// packages/extras/code-mode/schema-types.ts — JSON-Schema → type strings.
// ============================================================================
// A small IR (SchemaNode) parses a tool's inputSchema once; pyType/tsType
// render it for stubs, catalog tier T2, and help(). Degrades to `Any`/`any`
// on anything unsupported — never throws, never hangs (depth cap + cycle
// guard). Types are DX only: the host schema wall is the only authority.
// ============================================================================

import type { JsonSchema } from "@sanityloop/core";

interface NodeBase {
    description?: string;
    nullable?: boolean;
}

export type SchemaNode =
    | (NodeBase & { kind: "string"; minLength?: number; maxLength?: number; format?: string })
    | (NodeBase & { kind: "number"; integer: boolean; minimum?: number; maximum?: number })
    | (NodeBase & { kind: "boolean" })
    | (NodeBase & { kind: "null" })
    | (NodeBase & { kind: "literal"; value: string | number | boolean | null })
    | (NodeBase & { kind: "array"; items: SchemaNode; minItems?: number; maxItems?: number })
    | (NodeBase & { kind: "object"; fields: SchemaField[]; additional: boolean | SchemaNode })
    | (NodeBase & { kind: "union"; variants: SchemaNode[] })
    | (NodeBase & { kind: "any" });

export interface SchemaField {
    name: string;
    node: SchemaNode;
    required: boolean;
}

const MAX_DEPTH = 8;

/** Parse a JSON schema into the IR. Never throws. */
export function toNode(schema: JsonSchema | undefined): SchemaNode {
    return walk(schema as Record<string, unknown> | undefined, 0, new WeakSet());
}

function walk(s: Record<string, unknown> | undefined, depth: number, seen: WeakSet<object>): SchemaNode {
    if (s === undefined || s === null || typeof s !== "object" || Array.isArray(s)) return { kind: "any" };
    if (depth > MAX_DEPTH || seen.has(s)) return { kind: "any" };
    seen.add(s);

    const desc = typeof s.description === "string" ? s.description : undefined;
    const base: NodeBase = desc !== undefined ? { description: desc } : {};

    // $ref / const / enum first.
    if (typeof s.$ref === "string") return { ...base, kind: "any" };
    if ("const" in s && isPrimitive(s.const)) return { ...base, kind: "literal", value: s.const };
    if (Array.isArray(s.enum) && s.enum.every(isPrimitive)) {
        if (s.enum.length === 0) return { ...base, kind: "any" };
        if (s.enum.length === 1) return { ...base, kind: "literal", value: s.enum[0] };
        return { ...base, kind: "union", variants: s.enum.map((v) => ({ kind: "literal", value: v }) as SchemaNode) };
    }

    // anyOf / oneOf / allOf.
    const anyOf = s.anyOf ?? s.oneOf;
    if (Array.isArray(anyOf)) {
        const variants = anyOf.map((m) => walk(m as Record<string, unknown>, depth + 1, seen));
        return foldNullable({ ...base, kind: "union", variants });
    }
    if (Array.isArray(s.allOf)) {
        const parts = (s.allOf as unknown[]).filter((m) => typeof m === "object" && m !== null) as Record<string, unknown>[];
        if (parts.length > 0 && parts.every((p) => p.type === "object" || p.properties !== undefined)) {
            const fields: SchemaField[] = [];
            const required = new Set<string>();
            for (const p of parts) {
                const obj = walk({ ...p, type: "object" }, depth + 1, seen);
                if (obj.kind !== "object") continue;
                for (const f of obj.fields) {
                    if (!fields.some((e) => e.name === f.name)) fields.push(f);
                    if (f.required) required.add(f.name);
                }
            }
            for (const f of fields) f.required = required.has(f.name);
            return { ...base, kind: "object", fields, additional: true };
        }
        return { ...base, kind: "any" };
    }

    // type: array → strip null into nullable.
    let type = s.type;
    let nullable = s.nullable === true;
    if (Array.isArray(type)) {
        if (type.includes("null")) nullable = true;
        const rest = type.filter((t) => t !== "null");
        if (rest.length === 0) return { ...base, kind: "null" };
        if (rest.length === 1) type = rest[0];
        else {
            const variants = rest.map((t) => walk({ ...s, type: t }, depth + 1, seen));
            return foldNullable({ ...base, nullable, kind: "union", variants });
        }
    }
    const node = buildTyped(type, s, base, depth, seen);
    if (nullable && node.kind !== "null" && node.kind !== "any") node.nullable = true;
    return node;
}

function buildTyped(
    type: unknown,
    s: Record<string, unknown>,
    base: NodeBase,
    depth: number,
    seen: WeakSet<object>,
): SchemaNode {
    const props = s.properties;
    if (type === "object" || (type === undefined && (typeof props === "object" || s.additionalProperties !== undefined))) {
        const fields: SchemaField[] = [];
        const required = new Set(Array.isArray(s.required) ? (s.required as unknown[]).filter((r): r is string => typeof r === "string") : []);
        if (typeof props === "object" && props !== null && !Array.isArray(props)) {
            for (const [name, sub] of Object.entries(props)) {
                fields.push({ name, node: walk(sub as Record<string, unknown>, depth + 1, seen), required: required.has(name) });
            }
        }
        let additional: boolean | SchemaNode = true;
        if (s.additionalProperties === false) additional = false;
        else if (typeof s.additionalProperties === "object" && s.additionalProperties !== null) {
            additional = walk(s.additionalProperties as Record<string, unknown>, depth + 1, seen);
        }
        return { ...base, kind: "object", fields, additional };
    }
    if (type === "array") {
        const items = typeof s.items === "object" && s.items !== null && !Array.isArray(s.items)
            ? walk(s.items as Record<string, unknown>, depth + 1, seen)
            : ({ kind: "any" }) as SchemaNode;
        const node: SchemaNode = { ...base, kind: "array", items };
        if (typeof s.minItems === "number") (node as { minItems?: number }).minItems = s.minItems;
        if (typeof s.maxItems === "number") (node as { maxItems?: number }).maxItems = s.maxItems;
        return node;
    }
    if (type === "string") {
        const node: SchemaNode = { ...base, kind: "string" };
        if (typeof s.minLength === "number") node.minLength = s.minLength;
        if (typeof s.maxLength === "number") node.maxLength = s.maxLength;
        if (typeof s.format === "string") node.format = s.format;
        return node;
    }
    if (type === "integer" || type === "number") {
        const node: SchemaNode = { ...base, kind: type === "integer" ? "number" : "number", integer: type === "integer" };
        if (typeof s.minimum === "number") node.minimum = s.minimum;
        if (typeof s.maximum === "number") node.maximum = s.maximum;
        return node;
    }
    if (type === "boolean") return { ...base, kind: "boolean" };
    if (type === "null") return { ...base, kind: "null" };
    return { ...base, kind: "any" };
}

function isPrimitive(v: unknown): v is string | number | boolean | null {
    return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function foldNullable(node: SchemaNode): SchemaNode {
    if (node.kind !== "union") return node;
    const rest = node.variants.filter((v) => v.kind !== "null");
    if (rest.length === node.variants.length) return node;
    if (rest.length === 0) return { description: node.description, kind: "null" };
    if (rest.length === 1) {
        rest[0].nullable = true;
        return rest[0];
    }
    return { description: node.description, kind: "union", variants: rest, nullable: true };
}

// ---- Python rendering ------------------------------------------------------

const PY_KEYWORDS = new Set(
    "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case".split(" "),
);

export function isPyKeyword(s: string): boolean {
    return PY_KEYWORDS.has(s);
}

export function pyType(node: SchemaNode): string {
    let out: string;
    switch (node.kind) {
        case "string": out = "str"; break;
        case "number": out = node.integer ? "int" : "float"; break;
        case "boolean": out = "bool"; break;
        case "null": out = "None"; break;
        case "literal": out = `Literal[${JSON.stringify(node.value)}]`; break;
        case "array": out = `list[${pyType(node.items)}]`; break;
        case "object":
            out = node.additional === false || node.additional === true
                ? "dict[str, Any]"
                : `dict[str, ${pyType(node.additional)}]`;
            break;
        case "union": {
            const parts = [...new Set(node.variants.map(pyType))];
            out = parts.length === 1 ? parts[0] : parts.join(" | ");
            break;
        }
        case "any": out = "Any"; break;
    }
    if (node.nullable === true && node.kind !== "null" && node.kind !== "any") out += " | None";
    return out;
}

/** Compact shape string for docstrings: {question?: str, options?: list[...]} */
export function pyShape(node: SchemaNode, depth = 0): string {
    if (depth > 3) return "{...}";
    if (node.kind === "object") {
        const inner = node.fields.map((f) => `${f.name}${f.required ? "" : "?"}: ${pyShape(f.node, depth + 1)}`).join(", ");
        return `{${inner}}`;
    }
    if (node.kind === "array") return `list[${pyShape(node.items, depth + 1)}]`;
    if (node.kind === "union") return node.variants.map((v) => pyShape(v, depth + 1)).join(" | ");
    if (node.kind === "literal") return JSON.stringify(node.value);
    return pyType({ ...node, nullable: false, description: undefined });
}

/** Constraint suffix for docstrings: (int >= 1), (len<=N), one of "a"|"b". */
export function pyConstraint(node: SchemaNode): string | undefined {
    const bits: string[] = [];
    if (node.kind === "number") {
        if (node.minimum !== undefined) bits.push(`>= ${node.minimum}`);
        if (node.maximum !== undefined) bits.push(`<= ${node.maximum}`);
    }
    if (node.kind === "string") {
        if (node.minLength !== undefined) bits.push(`len>=${node.minLength}`);
        if (node.maxLength !== undefined) bits.push(`len<=${node.maxLength}`);
        if (node.format !== undefined) bits.push(node.format);
    }
    if (node.kind === "union" && node.variants.every((v) => v.kind === "literal")) {
        return `one of ${node.variants.map((v) => JSON.stringify((v as { value: unknown }).value)).join(" | ")}`;
    }
    if (bits.length === 0) return undefined;
    const base = node.kind === "number" ? (node.integer ? "int" : "float")
        : node.kind === "string" ? "str"
        : undefined;
    return base !== undefined ? `${base} ${bits.join(", ")}` : bits.join(", ");
}

// ---- TypeScript rendering --------------------------------------------------

/** `param` position uses `any` (wall validates; fake precision forces casts);
 * output position uses `unknown` (callers must narrow). */
export function tsType(node: SchemaNode, position: "param" | "output" = "param"): string {
    let out: string;
    switch (node.kind) {
        case "string": out = "string"; break;
        case "number": out = "number"; break;
        case "boolean": out = "boolean"; break;
        case "null": out = "null"; break;
        case "literal": out = JSON.stringify(node.value) ?? "unknown"; break;
        case "array": {
            const inner = tsType(node.items, position);
            out = node.items.kind === "union" ? `(${inner})[]` : `${inner}[]`;
            break;
        }
        case "object": {
            if (node.fields.length === 0 && node.additional === false) {
                out = "Record<string, never>";
                break;
            }
            const parts = node.fields.map((f) => {
                const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(f.name) ? f.name : JSON.stringify(f.name);
                return `${key}${f.required ? "" : "?"}: ${tsType(f.node, position)}`;
            });
            if (node.additional !== false) parts.push("[k: string]: unknown");
            out = `{ ${parts.join("; ")} }`;
            break;
        }
        case "union": out = [...new Set(node.variants.map((v) => tsType(v, position)))].join(" | "); break;
        case "any": out = position === "param" ? "any" : "unknown"; break;
    }
    if (node.nullable === true && node.kind !== "null" && node.kind !== "any") out += " | null";
    return out;
}
