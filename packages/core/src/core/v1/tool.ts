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
function define(def: {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  executionMode?: "sequential" | "parallel";
  /** NON-DESTRUCTIVE off-switch — stays in prompt, execute is a no-op. */
  disabled?: boolean;
  execute(params: unknown, ctx: any): Promise<ToolResult> | ToolResult;
}): ToolType {
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
export type { ToolType, ToolType as ToolContract }; // re-export the type from types.ts
