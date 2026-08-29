// ============================================================================
// test/e2e/loops-engine.test.ts — the loops engine, driven for real.
// ============================================================================
// In-process (no subprocess): the FULL chain runs — core heartbeat + inputs
// extra + loops extra + scripted model. Every wait is bounded; every timer is
// ms-scale. Proven here:
//   1. classic fires on silence, expands backticks at insertion, maxFires ends it
//   2. INTENT vs REALITY — a followup queued mid-turn stores the raw template,
//      history receives the expanded text evaluated at insertion moment
//   3. chrono kicks forcefully back-to-back, respects its budget, self-completes
//   4. hard abort stops loops by default (TUI parity)

import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, SimpleModel } from "@sanityloop/core";
import type { GodObject, TurnResult } from "@sanityloop/core";
import { createDefaultInputs, InputTypes } from "@sanityloop/inputs";
import type { FollowupInput } from "@sanityloop/inputs";
import { loops } from "@sanityloop/loops";
import { assistantTurn, seedUserMessage, kick } from "@sanityloop/test-kit/core";
import { sleep, waitUntil, awaitLanded } from "@sanityloop/test-kit";

/** Scripted model that NEVER exhausts loudly — a quiet "(script silent)" when dry,
 * so over-generous scripts can't detonate mid-test. */
class QuietScriptModel extends SimpleModel {
    script: Array<() => TurnResult>;
    constructor(script: Array<() => TurnResult>) {
        super({ api: "chat_completions", modelId: "quiet-stub", stream: false });
        this.script = [...script];
    }
    async callNextTurn(_ctx: GodObject): Promise<TurnResult> {
        const next = this.script.shift();
        if (!next) return assistantTurn("(script silent)");
        return next();
    }
}

function userTexts(agent: GodObject): string[] {
    return agent.messages
        .filter((m) => m.type === "user")
        .map((m) =>
            (m.content as { content?: string }[] | undefined)
                ?.map((c) => c.content ?? "")
                .join("") ?? "",
        )
        .filter((t) => t.length > 0);
}

test("classic: silence kick with insertion-time expansion, maxFires completes", async () => {
    const script = [
        () => assistantTurn("initial"),
        () => assistantTurn("kick one"),
        () => assistantTurn("kick two"),
    ];
    const agent = new Agent({ model: new QuietScriptModel(script) });
    agent.install(createDefaultInputs());
    agent.install(
        loops({
            classic: {
                everyMs: 120,
                message: "tick `node -p \"1+41\"`",
                backticksCommand: true,
                maxFires: 2,
            },
        }),
    );

    seedUserMessage(agent, "start");
    kick(agent);

    await waitUntil(() => {
        const mirror = (agent.state.loops ?? {}) as Record<string, { status?: string }>;
        return mirror.classic?.status === "completed";
    }, { what: "classic loop to complete via maxFires" });
    await awaitLanded(agent);

    const kicks = userTexts(agent).filter((t) => t.startsWith("tick "));
    assert.equal(kicks.length, 2, `expected exactly 2 kicks, got ${kicks.length}: ${JSON.stringify(kicks)}`);
    for (const t of kicks) assert.ok(t.includes("42"), `backtick never expanded: "${t}"`);
});

test("intent vs reality: queued mid-turn input stays RAW, history gets fresh expansion", async () => {
    // The gate lives in a CLOSURE, not on a model field: the agent's observer
    // proxies everything reachable from it — awaiting a proxied promise is a
    // TypeError ("incompatible receiver"). Closure vars never cross that line.
    let openGate!: () => void;
    const gate = new Promise<void>((res) => {
        openGate = res;
    });
    const gated = new (class extends SimpleModel {
        async callNextTurn(_ctx: GodObject): Promise<TurnResult> {
            await gate;
            return assistantTurn("finally"); // fresh object per call — no aliasing
        }
    })({ api: "chat_completions", modelId: "gated-stub", stream: false });

    const agent = new Agent({ model: gated });
    agent.install(createDefaultInputs());

    seedUserMessage(agent, "start");
    kick(agent);
    await waitUntil(() => agent.inTurn, { what: "turn to start" });

    const receiptAt = Date.now();
    const followup: FollowupInput = {
        type: InputTypes.followup,
        text: "now: `node -p \"Date.now()\"`",
        backticksCommand: true,
    };
    agent.input(followup);
    await sleep(30); // let the input drain into the pending queue

    // INTENT — the observable queue holds the raw template, untouched
    const queue = (agent.state.inputFollowUp ?? []) as FollowupInput[];
    assert.equal(queue.length, 1, "followup never queued mid-turn");
    assert.equal(queue[0].text, 'now: `node -p "Date.now()"`', "queue must store intent verbatim");

    openGate();
    await awaitLanded(agent);

    // REALITY — history received the expanded text, evaluated AFTER receipt
    const landed = userTexts(agent).find((t) => t.startsWith("now: "));
    assert.ok(landed, "expanded followup never entered history");
    const evaluatedAt = Number(landed!.slice("now: ".length));
    assert.ok(
        Number.isFinite(evaluatedAt) && evaluatedAt > receiptAt + 20,
        `expansion was not at insertion moment (receipt=${receiptAt}, evaluated=${evaluatedAt})`,
    );
    assert.equal(
        (agent.state.inputFollowUp as unknown[]).length,
        0,
        "queue must drain after landing",
    );
});

test("chrono: forceful back-to-back kicks, budget respected, self-completes", async () => {
    const script = Array.from({ length: 30 }, (_, i) => () => assistantTurn(`shift turn ${i}`));
    const agent = new Agent({ model: new QuietScriptModel(script) });
    agent.install(createDefaultInputs());
    agent.install(loops({ chrono: { forMs: 900, dwellMs: 60, message: "keep going" } }));

    seedUserMessage(agent, "start");
    kick(agent);

    await waitUntil(() => {
        const mirror = (agent.state.loops ?? {}) as Record<string, { status?: string }>;
        return mirror.chrono?.status === "completed";
    }, { what: "chrono to exhaust its budget and complete" });
    await awaitLanded(agent);

    const mirror = agent.state.loops as Record<
        string,
        { fires: number; deadline: number; lastFireAt?: number }
    >;
    assert.ok(mirror.chrono.fires >= 3, `forceful shift expected >=3 kicks, got ${mirror.chrono.fires}`);
    assert.ok(
        (mirror.chrono.lastFireAt ?? 0) <= mirror.chrono.deadline + 250,
        `kick fired past deadline: last=${mirror.chrono.lastFireAt} deadline=${mirror.chrono.deadline}`,
    );
    const shifts = userTexts(agent).filter((t) => t === "keep going");
    assert.equal(shifts.length, mirror.chrono.fires, "history kicks must match the fire count");
});

test("hard abort stops loops by default (TUI parity)", async () => {
    const script = [() => assistantTurn("only")];
    const agent = new Agent({ model: new QuietScriptModel(script) });
    agent.install(createDefaultInputs());
    agent.install(loops({ classic: { everyMs: 60_000, message: "never" } }));

    seedUserMessage(agent, "start");
    kick(agent);
    // NOTE: the countdown is a PARKED AWAIT — the machine is honestly
    // "awaiting" during the silence, not idle. Watch state, not loopState.
    await waitUntil(() => {
        const m = (agent.state.loops ?? {}) as Record<string, { status?: string; nextFireAt?: number }>;
        return m.classic?.status === "waiting" && !!m.classic?.nextFireAt;
    }, { what: "classic countdown to arm after landing" });
    assert.ok(agent.pendingAwaits.length > 0, "countdown must be a parked await");

    agent.abort();
    await sleep(50);

    const after = agent.state.loops as Record<string, { status?: string; nextFireAt?: number }>;
    assert.equal(after.classic.status, "stopped", "abort must stop loops");
    assert.equal(after.classic.nextFireAt, undefined, "pending kick must be cancelled");
    assert.equal(
        agent.pendingAwaits.filter((a) => String(a.type).startsWith("loops/")).length,
        0,
        "parked dwells must be stripped on abort",
    );
});
