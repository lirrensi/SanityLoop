// ============================================================================
// packages/test-kit/test/gated-model.test.ts — GatedModel self-test.
// ============================================================================
// Gate-then-release against a REAL Agent (the observer live): the turn parks
// at the gate on kick, the script stays untouched, release() lets it through.
// That the suite passes with the observer active IS the closure-rule proof —
// a field-held gate promise would detonate here, not in a unit mock.
// Mirrors the loops e2e "intent vs reality" case
// (test/e2e/loops-engine.test.ts) that motivated this fixture — the inline
// closure gate, now reusable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "@sanityloop/core";
import { GatedModel, assistantTurn, kick, seedUserMessage } from "@sanityloop/test-kit/core";
import { awaitLanded, waitUntil } from "@sanityloop/test-kit";

test("gate blocks the turn until release() opens it", async () => {
    const model = new GatedModel([() => assistantTurn("finally")]);
    const agent = new Agent({ model, agentId: "gated-model-test" });

    seedUserMessage(agent, "start");
    kick(agent);
    await waitUntil(() => model.waiting > 0, { what: "turn to park at the gate" });

    assert.equal(model.calls.length, 0, "script untouched while gated — nothing ran yet");
    assert.ok(
        !agent.messages.some((m) => m.type === "assistant"),
        "no reply committed while the gate holds",
    );

    model.release();
    await awaitLanded(agent);

    assert.equal(agent.messages.at(-1)?.type, "assistant", "the released turn landed");
    assert.equal(model.waiting, 0, "nobody left parked");
});

test("release() banks a permit when idle; releaseAll() opens permanently", async () => {
    const model = new GatedModel([() => assistantTurn("one"), () => assistantTurn("two")]);
    model.release(); // nobody waiting — banked for the next call
    const agent = new Agent({ model, agentId: "gated-model-banked" });

    seedUserMessage(agent, "first");
    kick(agent);
    await awaitLanded(agent); // sailed through on the banked permit — else this times out

    seedUserMessage(agent, "second");
    kick(agent);
    await waitUntil(() => model.waiting > 0, { what: "second turn to park at the gate" });

    model.releaseAll();
    await awaitLanded(agent);

    assert.equal(agent.messages.at(-1)?.type, "assistant", "the second turn landed after releaseAll");
    assert.equal(model.waiting, 0, "gate left nobody parked");
});
