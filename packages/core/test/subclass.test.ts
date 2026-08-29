// ============================================================================
// tests/core/subclass.test.ts — THE INHERITANCE PROMISE.
// "Import the class, extend it, overwrite some functions — no fork, no side
// repo." Every meaningful machine seam is `protected`: a subclass can override
// a step, a transition, a derivation — and virtual dispatch just works.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "@sanityloop/core";
import type { LoopState } from "@sanityloop/core";
import { StubModel, assistantTurn } from "@sanityloop/test-kit/core";
import { kick } from "@sanityloop/test-kit/core";
import { awaitLanded } from "@sanityloop/test-kit";

test("THE INHERITANCE PROMISE: a subclass can override protected seams", async () => {
    let landings = 0;
    let derivations = 0;
    let lastDerived: LoopState | undefined;

    class MyAgent extends Agent {
        protected override async land(): Promise<void> {
            landings++;
            await super.land();
        }
        protected override deriveLoopState(): void {
            derivations++;
            super.deriveLoopState();
            lastDerived = this.loopState;
        }
    }

    const model = new StubModel([() => assistantTurn("hi")]);
    const agent = new MyAgent({ model, agentId: "subclass-test" });
    agent.messages.push({
        id: "u1", enabled: true, type: "user", committedAt: Date.now(),
        content: [{ type: "text", content: "go" }],
    });
    kick(agent);
    await awaitLanded(agent);

    assert.ok(landings >= 1, "land() override fired through the protected seam");
    assert.ok(derivations >= 2, "deriveLoopState() override fired every beat");
    assert.ok(
        lastDerived === "idle" || lastDerived === "running" || lastDerived === "awaiting",
        `the override observed a real derived state (got ${lastDerived})`,
    );
    assert.equal(agent.messages.at(-1)!.type, "assistant", "the turn ran normally");
});