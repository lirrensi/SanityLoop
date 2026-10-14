// ============================================================================
// packages/test-kit/gated-model.ts — the scripted model with a manual gate.
// ============================================================================
// GatedModel is a StubModel (same script queue, same calls log, same loud
// exhaustion on under-scripting) whose provider call parks on a MANUAL gate
// before delegating. Tests decide when a turn may proceed:
//
//   const model = new GatedModel([() => assistantTurn("hi")]);
//   ... seed + kick, wait until model.waiting > 0 (parked), assert, release ...
//
// API:
//   release()    — open the gate for exactly ONE call. With a call parked it
//                  goes through immediately; with nobody waiting the permit is
//                  banked for the next call (the gate re-closes behind it).
//   releaseAll() — open the gate PERMANENTLY. Parked calls go through, the
//                  bank is cleared, future calls never park.
//   waiting      — calls currently parked at the gate (the assertion surface).
//
// THE RULE — the gate promise lives in a CLOSURE, NEVER on a model field.
// The Agent's observer deep-proxies everything reachable from the model, so
// awaiting a field-held promise detonates with
// `TypeError: Method Promise.prototype.then called on incompatible receiver`.
// Closure variables never cross that line: the observer can wrap nothing that
// is awaited. (`waiting` is a plain number field — primitives cross the
// observer untouched, so it is safe to read through `agent.model`.)
// First incarnation: the inline closure-gated model in the "intent vs
// reality" case of test/e2e/loops-engine.test.ts.
//
// HOUSE RULE — the fixture never awaits its own bookkeeping: release() and
// releaseAll() are synchronous and fire-and-forget. The single await in
// callNextTurn parks on the closure gate — driven by the Agent's loop, opened
// by the test. Nothing else suspends on anything.

import type { GodObject, TurnResult } from "@sanityloop/core";
import { StubModel } from "./stub-model.ts";

export class GatedModel extends StubModel {
    /** Calls currently parked at the gate — the assertion surface. */
    waiting = 0;
    /** Open the gate for exactly one call (hands to a waiter, else banks). */
    release: () => void;
    /** Open the gate permanently — parked calls go through, later ones sail. */
    releaseAll: () => void;

    constructor(script: Array<() => TurnResult>) {
        super(script);

        let open = false; // releaseAll latch — once true, calls never park
        let permits = 0; // banked one-shot releases (release() with nobody waiting)
        // Resolvers of parked calls — CLOSURE, never a field (THE RULE above).
        const parked: Array<() => void> = [];

        this.release = (): void => {
            if (open) return;
            const next = parked.shift();
            if (next) next(); // hand the permit to a parked call directly
            else permits++; // nobody waiting — bank it for the next call
        };
        this.releaseAll = (): void => {
            open = true;
            permits = 0;
            for (const wake of parked.splice(0)) wake();
        };

        // Instance (not prototype) method: it closes over the gate above.
        // Parks first, THEN delegates — while gated the script is untouched
        // (model.calls stays empty), so tests can assert "nothing ran yet".
        this.callNextTurn = async (ctx: GodObject): Promise<TurnResult> => {
            if (!open) {
                if (permits > 0) permits--;
                else {
                    this.waiting++;
                    try {
                        await new Promise<void>((resolve) => {
                            parked.push(resolve);
                        });
                    } finally {
                        this.waiting--;
                    }
                }
            }
            return super.callNextTurn(ctx);
        };
    }
}
