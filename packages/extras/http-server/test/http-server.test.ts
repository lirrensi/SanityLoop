// ============================================================================
// packages/extras/http-server/test/http-server.test.ts — thin unit suite.
// ============================================================================
// Real loopback bind ONLY (127.0.0.1 + port 0, in-process fetch): no network
// beyond the loopback, no TTY, no real server. uninstall must close the port
// (a refusal afterwards proves it — the suite never relies on force-exit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "@sanityloop/core";
import type { Input, Plugin } from "@sanityloop/core";
import { StubModel } from "@sanityloop/test-kit/core";
import { sleep, waitUntil } from "@sanityloop/test-kit";
import { createHttpServer } from "@sanityloop/http-server";

/** The state.http stamp the server settles once bound. */
interface HttpState {
    addr: string;
    port: number;
}

interface Bound {
    agent: Agent;
    plugin: Plugin;
    base: string;
    port: number;
}

/** Install on a random loopback port; wait for state.http.port to settle. */
async function bind(opts?: { apikey?: string }): Promise<Bound> {
    const agent = new Agent({
        model: new StubModel([]),
        agentId: "http-test",
        description: "http unit suite",
    });
    const plugin = createHttpServer({
        addr: "127.0.0.1",
        port: 0,
        ...(opts?.apikey ? { apikey: opts.apikey } : {}),
    });
    await agent.install(plugin);
    await waitUntil(() => {
        const port = (agent.state.http as HttpState | undefined)?.port;
        return typeof port === "number" && port !== 0;
    }, { timeout: 5_000, what: "http port to settle" });
    const port = (agent.state.http as HttpState).port;
    return { agent, plugin, base: `http://127.0.0.1:${port}`, port };
}

async function close(b: Bound): Promise<void> {
    b.agent.uninstall("http");
    assert.equal("http" in b.agent.state, false, "state.http is deleted synchronously");
    // The listener closes on the next tick — poll for the refusal; a fixed
    // delay would guess at the timing and flake under load.
    const deadline = Date.now() + 5_000;
    let refused = false;
    while (!refused && Date.now() < deadline) {
        try {
            await fetch(b.base);
            await sleep(10);
        } catch {
            refused = true;
        }
    }
    assert.ok(refused, "the listener refused connections after uninstall");
}

test("/health answers ungated even with an apikey set", async () => {
    const b = await bind({ apikey: "secret" });
    try {
        const res = await fetch(`${b.base}/health`);
        assert.equal(res.status, 200);
        const body: unknown = await res.json();
        assert.ok(typeof body === "object" && body !== null && "ok" in body && "loopState" in body);
        assert.equal(body.ok, true);
        assert.equal(body.loopState, b.agent.loopState);
    } finally {
        await close(b);
    }
});

test("the apikey gate: missing/wrong → 401 on every gated route; Bearer and x-api-key pass", async () => {
    const b = await bind({ apikey: "secret" });
    try {
        for (const path of ["/getState", "/control", "/input"]) {
            const res = await fetch(`${b.base}${path}`, {
                method: path === "/getState" ? "GET" : "POST",
                headers: { "content-type": "application/json" },
                body: path === "/getState" ? undefined : "{}",
            });
            assert.equal(res.status, 401, `${path} without a key → 401`);
        }
        const wrong = await fetch(`${b.base}/getState`, {
            headers: { authorization: "Bearer nope" },
        });
        assert.equal(wrong.status, 401);
        for (const headers of [
            { authorization: "Bearer secret" },
            { "x-api-key": "secret" },
        ]) {
            const res = await fetch(`${b.base}/getState`, { headers });
            assert.equal(res.status, 200, `authed via ${JSON.stringify(headers)}`);
        }
        const ctrlWrong = await fetch(`${b.base}/control`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer nope" },
            body: JSON.stringify({ op: "stop" }),
        });
        assert.equal(ctrlWrong.status, 401);
    } finally {
        await close(b);
    }
});

test("/input {type} replies ok and reaches agent.input (spied)", async () => {
    const b = await bind();
    try {
        const seen: Input[] = [];
        const orig = b.agent.input.bind(b.agent);
        b.agent.input = (input: Input): void => {
            seen.push(input);
            orig(input);
        };
        const res = await fetch(`${b.base}/input`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "input_followup", text: "hi" }),
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true, type: "input_followup" });
        assert.equal(seen.length, 1);
        assert.deepEqual(seen[0], { type: "input_followup", text: "hi" });
    } finally {
        await close(b);
    }
});

test("/input rejects a missing type with 400", async () => {
    const b = await bind();
    try {
        for (const payload of [{}, { type: 42 }, { text: "no type" }]) {
            const res = await fetch(`${b.base}/input`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
            });
            assert.equal(res.status, 400, JSON.stringify(payload));
        }
    } finally {
        await close(b);
    }
});

test("/input rejects invalid JSON with 400", async () => {
    const b = await bind();
    try {
        const res = await fetch(`${b.base}/input`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{not json",
        });
        assert.equal(res.status, 400);
    } finally {
        await close(b);
    }
});

test("/input rejects oversized payloads with 413", async () => {
    const b = await bind();
    try {
        const res = await fetch(`${b.base}/input`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "input_followup", text: "x".repeat(2 * 1024 * 1024) }),
        });
        assert.equal(res.status, 413);
    } finally {
        await close(b);
    }
});

test("/getState keys projection: dotted walk, missing → null, no keys → full doc", async () => {
    const b = await bind();
    try {
        b.agent.state.probe = { deep: 7 };
        const dotted = await fetch(`${b.base}/getState?keys=state.probe.deep,loopState`);
        assert.equal(dotted.status, 200);
        assert.deepEqual(await dotted.json(), {
            "state.probe.deep": 7,
            loopState: b.agent.loopState,
        });
        const missing = await fetch(`${b.base}/getState?keys=does.not.exist`);
        assert.equal(missing.status, 200);
        assert.deepEqual(await missing.json(), { "does.not.exist": null });
        const full = await fetch(`${b.base}/getState`);
        assert.equal(full.status, 200);
        const doc: unknown = await full.json();
        assert.ok(typeof doc === "object" && doc !== null);
        for (const key of ["state", "messages", "tools", "loopState", "runState"]) {
            assert.ok(key in doc, `full doc carries ${key}`);
        }
        assert.ok("loopState" in doc);
        assert.equal(doc.loopState, b.agent.loopState);
    } finally {
        await close(b);
    }
});

test("/control pause/wake/stop/abort answer ok and take effect", async () => {
    const b = await bind();
    try {
        for (const op of ["pause", "stop", "wake", "abort"]) {
            const res = await fetch(`${b.base}/control`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ op }),
            });
            assert.equal(res.status, 200);
            assert.deepEqual(await res.json(), { ok: true, op });
        }
        assert.equal(b.agent.pauseRequested, true);
        assert.equal(b.agent.stopRequested, true);
        assert.equal(b.agent.loopState, "aborted");
    } finally {
        await close(b);
    }
});

test("/control unknown op → 400", async () => {
    const b = await bind();
    try {
        const res = await fetch(`${b.base}/control`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ op: "self-destruct" }),
        });
        assert.equal(res.status, 400);
    } finally {
        await close(b);
    }
});

test("uninstall closes the listener: the port refuses and state.http is deleted", async () => {
    const b = await bind();
    await close(b);
    assert.equal("http" in b.agent.state, false);
    assert.equal(b.agent.getDeclaredCapability("http-server"), undefined);
    await assert.rejects(fetch(b.base), /ECONNREFUSED|Failed to fetch|fetch failed/i);
    await assert.rejects(
        fetch(`http://127.0.0.1:${b.port}/health`),
        /ECONNREFUSED|Failed to fetch|fetch failed/i,
    );
});
