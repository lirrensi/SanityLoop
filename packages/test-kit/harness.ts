// ============================================================================
// packages/test-kit/harness.ts — thin agent factory + turn drivers.
// ============================================================================
// Everything runs through `agent.input()` + bounded waits. Signals do NOT start
// loops — every test starts the eternal heartbeat (`agent.run()`) explicitly.
// `run()` never returns (the clock), so we never await it; teardown flips the
// abort flag and the suite relies on node:test force-exit at the app layer.

import { Agent } from "@sanityloop/core";
import type { ToolType } from "@sanityloop/core";
import { StubModel } from "./stub-model.ts";
import type { TurnResult } from "@sanityloop/core";
import { awaitLanded } from "./wait.ts";

export interface Harness {
    agent: Agent;
    model: StubModel;
}

export function makeAgent(opts: {
    script: Array<() => TurnResult>;
    tools?: ToolType[];
    agentId?: string;
    cwd?: string;
    description?: string;
    messages?: never;
}): Harness {
    const model = new StubModel(opts.script);
    const agent = new Agent({
        model,
        agentId: opts.agentId ?? "test-agent",
        description: opts.description,
        cwd: opts.cwd,
        tools: opts.tools ?? [],
    });
    return { agent, model };
}

/**
 * Push a REAL user message into history — creates owed response work.
 * Core tests use this directly (the bare core is type-blind: without the
 * inputs extra, `input_followup` is just metadata and creates NO work —
 * and a zero-work signal does nothing at all, as the doctrine demands).
 */
export function seedUserMessage(agent: Agent, text: string): void {
    agent.messages.push({
        id: `user-${crypto.randomUUID().slice(0, 8)}`,
        enabled: true,
        type: "user",
        committedAt: Date.now(),
        content: [{ type: "text", content: text }],
    });
}

/**
 * THE canonical "start work" move under signal-only inputs: signals never
 * start loops, so tests start the eternal heartbeat explicitly (idempotent
 * via the runDriven guard) and kick the standard sync signal.
 * startState:"idle" = born-landed: run() boots empty and arms on the first
 * poke — the sanctioned harness ordering (seed AFTER run is legal here).
 */
export function kick(agent: Agent): void {
    agent.run({ startState: "idle" });
    agent.input({ type: "__test_kick__" });
}

/**
 * Run the eternal heartbeat for the duration of `fn`, then teardown via the
 * abort flag (which leaves the clock ticking but silent — THE LAW).
 * `run()` never resolves; we never await it.
 * startState:"idle" = born-landed — the callback seeds messages after boot.
 */
export async function withDriver<T>(agent: Agent, fn: () => Promise<T>): Promise<T> {
    agent.run({ startState: "idle" });
    try {
        return await fn();
    } finally {
        agent.abort(); // flag flip — ticks now do nothing; heartbeat endures
    }
}
