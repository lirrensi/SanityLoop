// ============================================================================
// test/quit-on-end.test.ts — terminate mode stands down while work is owed.
// ============================================================================
// The unified contract: BOTH exit and terminate lanes stand down while
// hasWork is true or a compaction rebuild is in flight; terminal states
// (aborted/errored/terminated) always quit immediately. Proven WITHOUT
// process.exit: terminate mode is spied by monkey-patching agent.terminate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, EVENTS } from "@sanityloop/core";
import { StubModel, assistantTurn } from "@sanityloop/test-kit/core";
import { createQuitOnEndPlugin } from "@sanityloop/quit-on-end";

function seed(agent: Agent, text = "go"): void {
    agent.messages.push({
        id: `seed-${Math.random().toString(36).slice(2, 8)}`,
        enabled: true,
        type: "user",
        committedAt: Date.now(),
        content: [{ type: "text", content: text }],
    });
}

async function fireAgentEnd(agent: Agent): Promise<void> {
    await agent.bus.runFromRegistry(EVENTS.agentEnd, { loopState: agent.loopState });
}

test("terminate mode stands down while work is owed", async () => {
    const agent = new Agent({ model: new StubModel([() => assistantTurn("done")]) });
    agent.install(createQuitOnEndPlugin({ mode: "terminate" }));
    let terminateCalls = 0;
    agent.terminate = ((..._args: unknown[]) => {
        terminateCalls += 1;
        return Promise.resolve();
    }) as typeof agent.terminate;
    seed(agent); // unanswered user message → hasWork true
    assert.equal(agent.hasWork, true, "seeded message must be owed work");
    await fireAgentEnd(agent);
    assert.equal(terminateCalls, 0, "terminate must stand down while hasWork");
});

test("terminate mode fires when workless", async () => {
    const agent = new Agent({ model: new StubModel([() => assistantTurn("done")]) });
    agent.install(createQuitOnEndPlugin({ mode: "terminate" }));
    let terminateCalls = 0;
    agent.terminate = ((..._args: unknown[]) => {
        terminateCalls += 1;
        return Promise.resolve();
    }) as typeof agent.terminate;
    assert.equal(agent.hasWork, false, "fresh agent must be workless");
    await fireAgentEnd(agent);
    assert.equal(terminateCalls, 1, "terminate must fire when workless");
});

test("terminate mode stands down during a compaction rebuild", async () => {
    const agent = new Agent({ model: new StubModel([() => assistantTurn("done")]) });
    agent.install(createQuitOnEndPlugin({ mode: "terminate" }));
    let terminateCalls = 0;
    agent.terminate = ((..._args: unknown[]) => {
        terminateCalls += 1;
        return Promise.resolve();
    }) as typeof agent.terminate;
    agent.state.compacting = true;
    await fireAgentEnd(agent);
    assert.equal(terminateCalls, 0, "terminate must stand down while compacting");
});

test("terminated fires immediately even with work owed (canQuit bypassed)", async () => {
    const agent = new Agent({ model: new StubModel([() => assistantTurn("done")]) });
    let consults = 0;
    agent.install(createQuitOnEndPlugin({
        mode: "terminate",
        canQuit: () => {
            consults += 1;
            return false;
        },
    }));
    let terminateCalls = 0;
    agent.terminate = ((..._args: unknown[]) => {
        terminateCalls += 1;
        return Promise.resolve();
    }) as typeof agent.terminate;
    seed(agent);
    agent.loopState = "terminated";
    await fireAgentEnd(agent);
    assert.equal(terminateCalls, 1, "terminated must terminate immediately");
    assert.equal(consults, 0, "terminated bypasses the predicate");
});

test("aborted takes the LANDING path: stands down while work is owed", async () => {
    const agent = new Agent({ model: new StubModel([() => assistantTurn("done")]) });
    agent.install(createQuitOnEndPlugin({ mode: "terminate" }));
    let terminateCalls = 0;
    agent.terminate = ((..._args: unknown[]) => {
        terminateCalls += 1;
        return Promise.resolve();
    }) as typeof agent.terminate;
    seed(agent);
    agent.loopState = "aborted";
    await fireAgentEnd(agent);
    assert.equal(terminateCalls, 0, "aborted + owed work must stand down (landing path)");
});

test("aborted takes the LANDING path: quits when workless", async () => {
    const agent = new Agent({ model: new StubModel([() => assistantTurn("done")]) });
    agent.install(createQuitOnEndPlugin({ mode: "terminate" }));
    let terminateCalls = 0;
    agent.terminate = ((..._args: unknown[]) => {
        terminateCalls += 1;
        return Promise.resolve();
    }) as typeof agent.terminate;
    agent.loopState = "aborted";
    await fireAgentEnd(agent);
    assert.equal(terminateCalls, 1, "aborted + workless must quit");
});

test("canQuit veto stands down (terminate mode)", async () => {
    const agent = new Agent({ model: new StubModel([() => assistantTurn("done")]) });
    let consults = 0;
    agent.install(createQuitOnEndPlugin({
        mode: "terminate",
        canQuit: () => {
            consults += 1;
            return false;
        },
    }));
    let terminateCalls = 0;
    agent.terminate = ((..._args: unknown[]) => {
        terminateCalls += 1;
        return Promise.resolve();
    }) as typeof agent.terminate;
    assert.equal(agent.hasWork, false, "fresh agent must be workless");
    await fireAgentEnd(agent);
    assert.equal(consults, 1, "predicate must be consulted when built-ins pass");
    assert.equal(terminateCalls, 0, "veto must stand down");
});

test("canQuit allow quits (terminate mode)", async () => {
    const agent = new Agent({ model: new StubModel([() => assistantTurn("done")]) });
    agent.install(createQuitOnEndPlugin({ mode: "terminate", canQuit: () => true }));
    let terminateCalls = 0;
    agent.terminate = ((..._args: unknown[]) => {
        terminateCalls += 1;
        return Promise.resolve();
    }) as typeof agent.terminate;
    await fireAgentEnd(agent);
    assert.equal(terminateCalls, 1, "allow must quit");
});

test("canQuit NOT consulted when built-ins already stand down", async () => {
    const agent = new Agent({ model: new StubModel([() => assistantTurn("done")]) });
    let consults = 0;
    agent.install(createQuitOnEndPlugin({
        mode: "terminate",
        canQuit: () => {
            consults += 1;
            return true;
        },
    }));
    agent.terminate = (() => Promise.resolve()) as typeof agent.terminate;
    seed(agent); // hasWork true → built-in stands down first
    await fireAgentEnd(agent);
    assert.equal(consults, 0, "predicate must not run when built-ins already stand down");
});

test("canQuit NOT consulted on terminated (deliberate death bypasses the gate)", async () => {
    const agent = new Agent({ model: new StubModel([() => assistantTurn("done")]) });
    let consults = 0;
    agent.install(createQuitOnEndPlugin({
        mode: "terminate",
        canQuit: () => {
            consults += 1;
            return false;
        },
    }));
    let terminateCalls = 0;
    agent.terminate = ((..._args: unknown[]) => {
        terminateCalls += 1;
        return Promise.resolve();
    }) as typeof agent.terminate;
    agent.loopState = "terminated";
    await fireAgentEnd(agent);
    assert.equal(consults, 0, "terminated path must bypass the predicate");
    assert.equal(terminateCalls, 1, "terminated quits immediately");
});

test("canQuit IS consulted on aborted (landing path)", async () => {
    const agent = new Agent({ model: new StubModel([() => assistantTurn("done")]) });
    let consults = 0;
    agent.install(createQuitOnEndPlugin({
        mode: "terminate",
        canQuit: () => {
            consults += 1;
            return false;
        },
    }));
    let terminateCalls = 0;
    agent.terminate = ((..._args: unknown[]) => {
        terminateCalls += 1;
        return Promise.resolve();
    }) as typeof agent.terminate;
    agent.loopState = "aborted";
    await fireAgentEnd(agent);
    assert.equal(consults, 1, "aborted path must consult the predicate");
    assert.equal(terminateCalls, 0, "veto must stand down");
});

test("throwing canQuit stands down (fail-closed)", async () => {
    const agent = new Agent({ model: new StubModel([() => assistantTurn("done")]) });
    agent.install(createQuitOnEndPlugin({
        mode: "terminate",
        canQuit: () => {
            throw new Error("predicate bug");
        },
    }));
    let terminateCalls = 0;
    agent.terminate = ((..._args: unknown[]) => {
        terminateCalls += 1;
        return Promise.resolve();
    }) as typeof agent.terminate;
    await fireAgentEnd(agent);
    assert.equal(terminateCalls, 0, "throw must stand down, never quit");
});

// ---------------------------------------------------------------------------
// mode: "destroy" — the one-shot-pool mode
// ---------------------------------------------------------------------------

test("destroy mode calls destroy() when workless", async () => {
    const agent = new Agent({ model: new StubModel([() => assistantTurn("done")]) });
    agent.install(createQuitOnEndPlugin({ mode: "destroy" }));
    let destroyCalls = 0;
    agent.destroy = ((..._args: unknown[]) => {
        destroyCalls += 1;
        return Promise.resolve();
    }) as typeof agent.destroy;
    let terminateCalls = 0;
    agent.terminate = ((..._args: unknown[]) => {
        terminateCalls += 1;
        return Promise.resolve();
    }) as typeof agent.terminate;
    assert.equal(agent.hasWork, false, "fresh agent must be workless");
    await fireAgentEnd(agent);
    assert.equal(destroyCalls, 1, "destroy must fire when workless");
    assert.equal(terminateCalls, 0, "terminate must NOT fire in destroy mode");
});

test("destroy mode stands down while work is owed", async () => {
    const agent = new Agent({ model: new StubModel([() => assistantTurn("done")]) });
    agent.install(createQuitOnEndPlugin({ mode: "destroy" }));
    let destroyCalls = 0;
    agent.destroy = ((..._args: unknown[]) => {
        destroyCalls += 1;
        return Promise.resolve();
    }) as typeof agent.destroy;
    seed(agent);
    await fireAgentEnd(agent);
    assert.equal(destroyCalls, 0, "destroy must stand down while hasWork");
});

test("destroy mode fires on terminated immediately (canQuit bypassed)", async () => {
    const agent = new Agent({ model: new StubModel([() => assistantTurn("done")]) });
    let consults = 0;
    agent.install(createQuitOnEndPlugin({
        mode: "destroy",
        canQuit: () => {
            consults += 1;
            return false;
        },
    }));
    let destroyCalls = 0;
    agent.destroy = ((..._args: unknown[]) => {
        destroyCalls += 1;
        return Promise.resolve();
    }) as typeof agent.destroy;
    seed(agent);
    agent.loopState = "terminated";
    await fireAgentEnd(agent);
    assert.equal(destroyCalls, 1, "terminated must destroy immediately");
    assert.equal(consults, 0, "terminated bypasses the predicate");
});

// ---------------------------------------------------------------------------
// exit-mode matrix — exit codes answer "did the process fail?"
// ---------------------------------------------------------------------------

function exitAgent(mode: "exit" | "terminate" | "destroy", opts: Parameters<typeof createQuitOnEndPlugin>[0] = {}) {
    const agent = new Agent({ model: new StubModel([() => assistantTurn("done")]) });
    agent.install(createQuitOnEndPlugin({ ...opts, mode }));
    return agent;
}

async function captureExit(agent: Agent): Promise<{ code: number | null; calls: string[] }> {
    const calls: string[] = [];
    // Test-only process.exit stub — node types exit as never-returning.
    const proc = process as unknown as { exit: (code: number) => never };
    const origExit = proc.exit;
    let code: number | null = null;
    const stubExit = (c: number): never => {
        code = c;
        calls.push(`exit(${c})`);
        throw new Error("__test_exit__");
    };
    proc.exit = stubExit;
    // spy the heart-stop lanes so exit mode never actually kills the agent
    agent.terminate = ((..._a: unknown[]) => {
        calls.push("terminate");
        return Promise.resolve();
    }) as typeof agent.terminate;
    agent.destroy = ((..._a: unknown[]) => {
        calls.push("destroy");
        return Promise.resolve();
    }) as typeof agent.destroy;
    try {
        await fireAgentEnd(agent);
    } catch (err) {
        if (!(err instanceof Error) || err.message !== "__test_exit__") throw err;
    } finally {
        proc.exit = origExit;
    }
    return { code, calls };
}

test("MATRIX exit mode: terminated exits 0 (deliberate death is clean)", async () => {
    const agent = exitAgent("exit");
    agent.loopState = "terminated";
    const { code } = await captureExit(agent);
    assert.equal(code, 0, "terminated must exit 0, not 1");
});

test("MATRIX exit mode: errored exits 1 after loud log", async () => {
    const agent = exitAgent("exit");
    agent.loopState = "errored";
    let logged = "";
    const origError = console.error;
    console.error = ((...a: unknown[]) => {
        logged += a.map(String).join(" ");
    }) as typeof console.error;
    try {
        const { code } = await captureExit(agent);
        assert.equal(code, 1, "errored must exit 1");
    } finally {
        console.error = origError;
    }
    assert.match(logged, /quit-on-end: agent errored/, "errored must log loudly");
});

test("MATRIX exit mode: errored + canQuit veto stands down (no exit)", async () => {
    const agent = exitAgent("exit", { canQuit: () => false });
    agent.loopState = "errored";
    const origError = console.error;
    const origWarn = console.warn;
    console.error = (() => {}) as typeof console.error;
    console.warn = (() => {}) as typeof console.warn;
    try {
        const { code, calls } = await captureExit(agent);
        assert.equal(code, null, "veto must stand down — no exit");
        assert.deepEqual(calls, [], "nothing called on veto");
    } finally {
        console.error = origError;
        console.warn = origWarn;
    }
});

test("MATRIX exit mode: aborted workless exits 0 via landing path", async () => {
    const agent = exitAgent("exit");
    agent.loopState = "aborted";
    const { code } = await captureExit(agent);
    assert.equal(code, 0, "aborted-then-parked must exit 0");
});

test("MATRIX exit mode: aborted + owed work stands down (no exit)", async () => {
    const agent = exitAgent("exit");
    seed(agent);
    agent.loopState = "aborted";
    const { code } = await captureExit(agent);
    assert.equal(code, null, "aborted + owed work must stand down");
});

test("MATRIX exit mode: graceful landing exits 0 (custom code honored)", async () => {
    const agent = exitAgent("exit", { code: 7 });
    const { code } = await captureExit(agent);
    assert.equal(code, 7, "custom code honored on graceful landing");
});

test("MATRIX exit mode: graceful landing stands down while work owed", async () => {
    const agent = exitAgent("exit");
    seed(agent);
    const { code } = await captureExit(agent);
    assert.equal(code, null, "owed work must stand down");
});
