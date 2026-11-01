// ============================================================================
// packages/extras/code-mode/call-tool.ts — the via:"code" callTool preset.
// ============================================================================
// Thin delegation onto GodObject.callTool: the recursion block runs first
// (pre-gate, host-authoritative), then the core wall does the rest — gate →
// park-wait → preResolved → resolve → schema → toolStart → execute →
// toolEnd. No message is pushed and afterTool is NOT fired.
//
// Recursion block: "code" (cell-in-cell), "delegate" (model-only decision),
// "call_tool" (a dispatcher inside a cell nests budgets and attribution).
// Budget 50 is counted by the cell runner BEFORE this is reached.
// ============================================================================

import type { CallToolOutcome, GodObject, ToolResult } from "@sanityloop/core";

export interface CodeCallerOptions {
    /** Rendezvous key for parked gates. Generated when absent. */
    id?: string;
    /** Blocks cell-in-cell. Default "code". */
    selfName?: string;
    /** Extra names blocked from cells. */
    blocked?: string[];
    /** Cell abort: releases a parked-gate wait. */
    signal?: AbortSignal;
}

export type ToolCaller = (name: string, params: Record<string, unknown>, opts?: CodeCallerOptions) => Promise<CallToolOutcome>;

const ALWAYS_BLOCKED = ["delegate", "call_tool"];

/** Build the nested-call dispatcher for one host agent. */
export function createToolCaller(agent: GodObject): ToolCaller {
    return async (name, params, opts = {}) => {
        const selfName = opts.selfName ?? "code";
        if (name === selfName || ALWAYS_BLOCKED.includes(name) || (opts.blocked ?? []).includes(name)) {
            const call = { id: opts.id ?? `code_${randomSuffix()}`, type: "function" as const, name, parameters: params };
            const result: ToolResult = {
                answer: `blocked: ${name} cannot be called from a code cell`,
                error: true,
                errorMessage: "recursion_blocked",
            };
            return { call, result, gated: false, waitedMs: 0 };
        }
        return agent.callTool(name, params, {
            ...(opts.id !== undefined ? { id: opts.id } : {}),
            via: "code",
            depth: 1,
            ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        });
    };
}

function randomSuffix(): string {
    return Math.random().toString(36).slice(2, 10);
}
