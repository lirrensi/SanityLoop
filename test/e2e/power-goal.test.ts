// ============================================================================
// test/e2e/power-goal.test.ts — the goal loop, driven for real.
// ============================================================================
// In-process: core heartbeat + inputs + powergoal + scripted model. Proven:
//   1. THE CHECKER referees every landing — refuses with a reason that rides
//      the next pursuing kick, confirms by reading the last report, and the
//      goal completes ITSELF without any manage_goal call
//   2. manage_goal(complete) passes through the SAME checker — refusal comes
//      back as the tool answer the model sees; satisfaction completes
//   3. blocked parks the pursuit — no further kicks, tombstone visible
//   4. prevent-exit contract: an exit-mode quitter stands down during pursuit
//      (the dwell is a parked await → hasWork true) and is free after completion

import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, EVENTS, SimpleModel } from "@sanityloop/core";
import type { GodObject, TurnResult } from "@sanityloop/core";
import { createDefaultInputs } from "@sanityloop/inputs";
import { powerGoal } from "@sanityloop/powergoal";
import { assistantTurn, seedUserMessage, kick } from "@sanityloop/test-kit/core";
import { awaitLanded, sleep, waitUntil } from "@sanityloop/test-kit";

/** Scripted model that NEVER exhausts loudly — quiet "(script silent)" when dry. */
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

test("checker referees every landing: reasons ride kicks, confirmation self-completes", async () => {
    const script = [
        () => assistantTurn("working on it"),
        () => assistantTurn("still hacking"),
        () => assistantTurn("shipped it — ALL DONE"),
    ];
    const agent = new Agent({ model: new QuietScriptModel(script) });
    agent.install(createDefaultInputs());
    agent.install(
        powerGoal({
            objective: "ship the thing",
            dwellMs: 60,
            check: ({ report }) =>
                report.includes("ALL DONE") ? true : "not done yet",
        }),
    );

    seedUserMessage(agent, "start");
    kick(agent);

    await waitUntil(() => {
        const g = (agent.state.powerGoal ?? {}) as { status?: string };
        return g.status === "completed";
    }, { what: "goal to self-complete via checker" });
    await awaitLanded(agent);

    const mirror = agent.state.powerGoal as { status?: string; fires?: number };
    assert.equal(mirror.status, "completed", "goal must complete itself");
    assert.equal(mirror.fires, 2, `expected exactly 2 pursuing kicks, got ${mirror.fires}`);

    const pursuing = userTexts(agent).filter((t) => t.startsWith("# Pursuing goal:"));
    assert.equal(pursuing.length, 2, `expected 2 pursuing messages, got ${pursuing.length}`);
    assert.ok(
        !userTexts(agent).some((t) => t.startsWith("# Started goal:")),
        "pre-armed goals skip the initial announce (the seeded work IS the start)",
    );
    // the refusal reason rode the SECOND kick (stored after landing two)
    assert.ok(
        pursuing[1]?.includes("checker: not done yet"),
        `reason must ride the next kick: ${JSON.stringify(pursuing[1])}`,
    );

    // completion is terminal — no more kicks ever
    const countAfterComplete = userTexts(agent).length;
    await sleep(250);
    assert.equal(userTexts(agent).length, countAfterComplete, "completed goal must stop kicking");
});

test("manage_goal(complete) gates through the same checker; refusal answers back", async () => {
    let calls = 0;
    const agent = new Agent({ model: new QuietScriptModel([]) });
    agent.install(createDefaultInputs());
    agent.install(
        powerGoal({
            check: () => {
                calls += 1;
                return calls === 1 ? "tests are failing" : true;
            },
        }),
    );
    const tool = agent.tools.find((t) => t.name === "manage_goal");
    assert.ok(tool, "manage_goal tool must be registered");

    const armed = await tool.execute({ set_status: "active", goal_text: "pass the tests" }, agent);
    assert.ok(String(armed.answer).startsWith("Goal active"), `arm failed: ${String(armed.answer)}`);

    const refused = await tool.execute({ set_status: "complete", note: "pretty please" }, agent);
    assert.ok(
        String(refused.answer).includes("NOT confirmed") && String(refused.answer).includes("tests are failing"),
        `refusal must carry the checker's reason: ${String(refused.answer)}`,
    );
    assert.equal((agent.state.powerGoal as { status?: string }).status, "active", "refusal must keep the goal alive");

    const ok = await tool.execute({ set_status: "complete" }, agent);
    assert.ok(String(ok.answer).includes("Goal completed"), `completion failed: ${String(ok.answer)}`);
    assert.equal(calls, 2, "checker must gate both attempts");
    assert.equal((agent.state.powerGoal as { status?: string }).status, "completed");
});

test("blocked parks the pursuit — tombstone visible, kicks cease", async () => {
    const script = [
        () => assistantTurn("first effort"),
        () => assistantTurn("second effort"),
        () => assistantTurn("third effort"),
    ];
    const agent = new Agent({ model: new QuietScriptModel(script) });
    agent.install(createDefaultInputs());
    agent.install(powerGoal({ objective: "endless chore", dwellMs: 60, check: () => false }));

    seedUserMessage(agent, "start");
    kick(agent);

    // let at least one pursuing kick happen, then block mid-pursuit
    await waitUntil(() => userTexts(agent).some((t) => t.startsWith("# Pursuing goal:")), {
        what: "first pursuing kick",
    });
    const tool = agent.tools.find((t) => t.name === "manage_goal")!;
    const res = await tool.execute({ set_status: "blocked" }, agent);
    assert.ok(String(res.answer).includes("blocked"), `block failed: ${String(res.answer)}`);

    const countAtBlock = userTexts(agent).length;
    await awaitLanded(agent);
    await sleep(300);

    assert.equal(userTexts(agent).length, countAtBlock, "blocked goal must stop kicking");
    assert.equal((agent.state.powerGoal as { status?: string }).status, "blocked");
});

test("active goal holds the heart: exit-quitter stands down mid-pursuit, leaves after completion", async () => {
    // quit-onend contract, verified WITHOUT process.exit: an exit-mode quitter
    // runs `if (agent.hasWork) return;` at every agentEnd. During pursuit the
    // dwell is a PARKED AWAIT — hasWork stays true, so it must stand down.
    // After the checker confirms (no new kick), hasWork falls and it WOULD exit.
    // (Real quit-on-end mode "terminate" terminates unconditionally at every
    // landing by design — it never consults hasWork; see its source.)
    const script = Array.from({ length: 6 }, (_, i) => () => assistantTurn(`effort ${i}`));
    const agent = new Agent({ model: new QuietScriptModel(script) });
    agent.install(createDefaultInputs());
    let wouldHaveExited = 0;
    let stoodDown = 0;
    agent.addFilter({
        event: EVENTS.agentEnd,
        id: "spy/exit-quitter",
        priority: 0,
        fn: async (a) => {
            if (a.hasWork) stoodDown += 1;
            else wouldHaveExited += 1;
        },
    });
    agent.install(
        powerGoal({
            objective: "persist",
            dwellMs: 50,
            check: ({ fires }) => (fires >= 3 ? true : "keep going"),
        }),
    );

    seedUserMessage(agent, "start");
    kick(agent);

    await waitUntil(() => {
        const g = (agent.state.powerGoal ?? {}) as { status?: string };
        return g.status === "completed";
    }, { what: "goal to complete after three pursuing kicks" });

    const g = agent.state.powerGoal as { status?: string; fires?: number };
    assert.equal(g.status, "completed");
    assert.equal(g.fires, 3, "exactly three pursuing kicks before the checker yielded");

    // the machine was NEVER idle-and-workless while pursuing…
    await sleep(100); // allow any post-completion landing to fire agentEnd
    assert.ok(stoodDown >= 3, `quitter must stand down during pursuit (saw ${stoodDown})`);
    // …and after completion there is nothing left: it would leave gracefully
    assert.ok(wouldHaveExited >= 1, `quitter must be free to exit post-completion (saw ${wouldHaveExited})`);
    assert.equal(agent.pendingAwaits.length, 0, "no ghost dwells may survive completion");

    void agent.terminate(); // test-local heart stop — no lingering clocks
});
