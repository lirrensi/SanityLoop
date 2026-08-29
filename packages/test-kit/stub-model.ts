// ============================================================================
// packages/test-kit/stub-model.ts — the scripted model. Deterministic, keyless.
// ============================================================================
// Subclasses SimpleModel exactly like templates/simple-agent.ts does, but the
// script is a QUEUE of TurnResult FACTORIES (fresh message objects per call —
// the loop stamps committedAt / mutates messages, so sharing one object across
// calls or restores would alias). Stats are FLAT MessageStats, nothing more.

import { SimpleModel } from "@sanityloop/core";
import type { GodObject, MessageStats, ToolCallRecord, TurnResult } from "@sanityloop/core";

/** Fresh FLAT MessageStats — exactly the standard keys, zero extras. */
export function flatStats(overrides: Partial<MessageStats> = {}): MessageStats {
    return {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        ...overrides,
        // cost is replaced wholesale if provided — never partially merged
        ...(overrides.cost ? { cost: { ...{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...overrides.cost } } : {}),
    };
}

let seq = 0;
function rid(): string {
    return `stub-${(++seq).toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

/** An assistant text turn — ends the turn (advances lastResponse). */
export function assistantTurn(text: string, stats?: Partial<MessageStats>): TurnResult {
    return {
        message: {
            id: rid(),
            enabled: true,
            type: "assistant",
            content: [{ type: "text", content: text }],
        },
        stats: flatStats(stats),
        stopReason: "stop",
    };
}

/** A toolCall turn — owes an answer; lastResponse does NOT advance past it. */
export function toolCallTurn(calls: ToolCallRecord[], stats?: Partial<MessageStats>): TurnResult {
    return {
        message: {
            id: rid(),
            enabled: true,
            type: "toolCall",
            content: { answer: "", stored: calls.map((c) => ({ ...c })) },
        },
        stats: flatStats(stats),
        stopReason: "tool_calls",
    };
}

/** Convenience: one call to a named tool with params. */
export function callTo(name: string, parameters: Record<string, unknown>, id?: string): ToolCallRecord {
    return { id: id ?? rid(), type: "function", name, parameters };
}

/**
 * The scripted stub. Pops one factory per provider call; throws loudly when
 * exhausted (a test that consumes more than it scripted has a bug).
 */
export class StubModel extends SimpleModel {
    /** Factories — one per expected provider round-trip. */
    script: Array<() => TurnResult>;
    /** Every context received — callNextTurn gets THE whole agent. */
    calls: GodObject[] = [];

    constructor(script: Array<() => TurnResult>) {
        super({ api: "chat_completions", modelId: "stub-model-001", stream: false });
        this.script = [...script];
    }

    async callNextTurn(ctx: GodObject): Promise<TurnResult> {
        this.calls.push(ctx);
        const next = this.script.shift();
        if (!next) {
            throw new Error(
                `StubModel: script exhausted (call #${this.calls.length}) — test under-scripted its turns`,
            );
        }
        return next();
    }
}
