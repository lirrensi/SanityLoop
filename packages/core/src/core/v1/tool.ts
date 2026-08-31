// ============================================================================
// sanity/src/tool.ts — the boring four blocks, two ways
// ============================================================================
// Tool.define  → plain definition
// Tool.factory → pre-lock runtime params (allowedPaths etc.) at construction
//
// Both return an instance of a tool. execute(params, ctx) — ctx is the ENTIRE
// god object. The tool can look around, read anything, do whatever it wants.
// ============================================================================

import type { JsonSchema, Tool as ToolType, ToolResult } from "./types.ts";

export interface ToolDefinition extends ToolType {}

/** Plain definition — name, description, inputSchema, execute. */
function define(def: ToolDefinition): ToolType {
  return { ...def };
}

/** Factory — pre-lock runtime params that are internal to the tool. */
function factory(opts: {
  /** The tool to wrap, or an inline definition. */
  tool: ToolType;
  /** Runtime params locked at construction. */
  [key: string]: unknown;
}): ToolType {
  // The factory returns a tool whose execute closes over the locked params.
  const { tool: base, ...locked } = opts;

  return {
    ...base,
    execute: async (params, ctx) => {
      // pre-lock: params are merged so the tool sees the locked config too
      return base.execute({ ...locked, ...(params as object) }, ctx);
    },
  };
}

/** The Tool namespace — Tool.define + Tool.factory. */
export const Tool = { define, factory };

const TYPE_CHECKS: Record<string, (v: unknown) => boolean> = {
    string: (v) => typeof v === "string",
    number: (v) => typeof v === "number",
    integer: (v) => typeof v === "number" && Number.isInteger(v),
    boolean: (v) => typeof v === "boolean",
    object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
    array: (v) => Array.isArray(v),
};

/**
 * Lightweight, dependency-free JSON-Schema validation for tool arguments.
 * Returns a list of human-readable problems; empty = valid.
 *
 * ONLY enforces what the schema DECLARES — an empty or absent schema never
 * blocks. Handled: `required`, `properties` type checks (string/number/
 * integer/boolean/object/array), string `minLength`/`maxLength`, numeric
 * `minimum`/`maximum`, `enum`, array `items` type, and
 * `additionalProperties: false`.
 */
export function validateToolArgs(schema: JsonSchema | undefined, params: unknown): string[] {
    const errors: string[] = [];
    if (!schema || typeof schema !== "object") return errors;
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
        errors.push("arguments must be an object");
        return errors;
    }
    const record = params as Record<string, unknown>;
    const props = schema.properties ?? {};

    for (const name of schema.required ?? []) {
        if (!(name in record)) errors.push(`missing required property "${name}"`);
    }
    for (const [name, def] of Object.entries(props)) {
        if (def === null || typeof def !== "object") continue;
        const value = record[name];
        if (value === undefined) continue;
        if (typeof def.type === "string" && TYPE_CHECKS[def.type] && !TYPE_CHECKS[def.type](value)) {
            errors.push(`property "${name}" must be ${def.type}`);
            continue;
        }
        if (def.type === "string" && typeof value === "string") {
            if (typeof def.minLength === "number" && value.length < def.minLength)
                errors.push(`property "${name}" is shorter than minLength ${def.minLength}`);
            if (typeof def.maxLength === "number" && value.length > def.maxLength)
                errors.push(`property "${name}" is longer than maxLength ${def.maxLength}`);
        }
        if ((def.type === "number" || def.type === "integer") && typeof value === "number") {
            if (typeof def.minimum === "number" && value < def.minimum)
                errors.push(`property "${name}" is below minimum ${def.minimum}`);
            if (typeof def.maximum === "number" && value > def.maximum)
                errors.push(`property "${name}" is above maximum ${def.maximum}`);
        }
        if (Array.isArray(def.enum) && !def.enum.some((e) => e === value)) {
            errors.push(
                `property "${name}" must be one of ${def.enum.map((e) => JSON.stringify(e)).join(", ")}`,
            );
        }
        if (def.type === "array" && Array.isArray(value) && def.items && typeof def.items === "object") {
            const itemDef = def.items as JsonSchema;
            if (typeof itemDef.type === "string" && TYPE_CHECKS[itemDef.type]) {
                for (let i = 0; i < value.length; i++) {
                    if (!TYPE_CHECKS[itemDef.type](value[i])) {
                        errors.push(`property "${name}[${i}]" must be ${itemDef.type}`);
                    }
                }
            }
        }
    }
    if (schema.additionalProperties === false) {
        const known = new Set(Object.keys(props));
        for (const k of Object.keys(record)) {
            if (!known.has(k)) errors.push(`unknown property "${k}"`);
        }
    }
    return errors;
}

export type { ToolType, ToolType as ToolContract }; // re-export the type from types.ts
