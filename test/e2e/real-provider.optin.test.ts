// ============================================================================
// test/e2e/real-provider.optin.test.ts — REAL PROVIDER, REAL THINKING.
// ============================================================================
// strategy.md used to confess: "NO real-provider test today." Now there are
// TWO — and they only arm when you hand them credentials. No env → clean
// SKIP. CI stays free, locals stay safe.
//
//   SANITYLOOP_E2E_KEY       (or OPENAI_API_KEY)  — required to arm
//   SANITYLOOP_E2E_BASE_URL  default https://api.openai.com/v1
//   SANITYLOOP_E2E_MODEL     default gpt-4o-mini
//
// Test 1 — CONTRACT: one tiny completion, identity-checked (fetch tap asserts
//          the dial-out origin and prints the server-echoed model + usage).
// Test 2 — THINKING: a real multi-turn loop in a SPAWNED child process (the
//          eternal heartbeat dies with its own process — no libuv handle race
//          in node:test's teardown). Turn 1: explain quantum entanglement in
//          the WORST, most complex way possible. Turn 2: explain it to a
//          tired 5-year-old in ONE sentence. Verbose → terse, jargon-density
//          asserted, receipts printed as TURN1:/TURN2: evidence lines.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, SimpleModel } from "@sanityloop/core";
import type { GodObject, TurnResult } from "@sanityloop/core";
import { runNode } from "./helpers/spawn.ts";
import { deriveAgent, QUANTUM_WORKER_SOURCE } from "./helpers/derive.ts";

const KEY = process.env.SANITYLOOP_E2E_KEY ?? process.env.OPENAI_API_KEY;
const BASE_URL = process.env.SANITYLOOP_E2E_BASE_URL ?? "https://api.openai.com/v1";
const MODEL = process.env.SANITYLOOP_E2E_MODEL ?? "gpt-4o-mini";

interface TapRecord {
    url: string;
    echoedModel?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** Intercept global fetch — record every dial-out with the server's own echo. */
function tapFetch(): { records: TapRecord[]; restore: () => void } {
    const records: TapRecord[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await orig(input as Parameters<typeof fetch>[0], init);
        try {
            void (res.clone().json() as Promise<{ model?: string; usage?: TapRecord["usage"] }>)
                .then((j) => records.push({ url: String(input), echoedModel: j.model, usage: j.usage }))
                .catch(() => {});
        } catch {
            /* non-JSON — the asserts will scream instead */
        }
        return res;
    }) as typeof fetch;
    return { records, restore: () => (globalThis.fetch = orig) };
}

/** Identity gate: the dial-out origin must be EXACTLY where we configured. */
function assertRouted(records: TapRecord[], atLeast: number): void {
    assert.ok(records.length >= atLeast, `expected >= ${atLeast} HTTP calls, saw ${records.length}`);
    const wanted = new URL(BASE_URL).origin;
    for (const r of records) {
        assert.equal(new URL(r.url).origin, wanted, `MISROUTED: wanted ${wanted}, dialed ${r.url}`);
    }
}

// ============================================================================
// TEST 1 — the CONTRACT probe (fast, deterministic-ish, identity-checked).
// ============================================================================

test("real provider: contract probe — one tiny completion, identity-checked", async (t) => {
    if (!KEY) return t.skip("no SANITYLOOP_E2E_KEY / OPENAI_API_KEY — staying free");

    const tap = tapFetch();
    let result: TurnResult;
    try {
        const model = new SimpleModel({
            api: "chat_completions",
            modelId: MODEL,
            apiKey: KEY,
            baseUrl: BASE_URL,
            stream: false,
        });
        const agent = new Agent({ model, agentId: "provider-probe" });
        agent.messages.push({
            id: "probe-user",
            enabled: true,
            type: "user",
            committedAt: Date.now(),
            content: [{ type: "text", content: "Reply with exactly: PONG" }],
        });
        result = await new Promise<TurnResult>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("provider call exceeded 45s")), 45_000);
            model
                .callNextTurn(agent as unknown as GodObject)
                .then((r) => { clearTimeout(timer); resolve(r); })
                .catch((e) => { clearTimeout(timer); reject(e); });
        });
    } finally {
        tap.restore();
    }

    assertRouted(tap.records, 1);
    console.log(
        `PROBE_EVIDENCE: ${JSON.stringify({ url: tap.records[0]?.url, echoedModel: tap.records[0]?.echoedModel, usage: tap.records[0]?.usage })}`,
    );

    const content = result.message.content;
    const text =
        typeof content === "string"
            ? content
            : JSON.stringify(
                  Array.isArray(content)
                      ? content.map((b) => (b as { content?: unknown }).content ?? b)
                      : content,
              );
    assert.ok(text.includes("PONG"), `provider replied with: ${text}`);
    assert.ok(result.stats.totalTokens > 0, "no token accounting came back");
    assert.equal(result.stopReason, "stop");
});

// ============================================================================
// TEST 2 — the THINKING probe. Spawned child, real loop, real brain-flex.
// ============================================================================

const JARGON = [
    "entangl", "superposition", "wavefunction", "hilbert", "tensor",
    "bell", "nonlocal", "locality", "qubit", "decoherence",
    "measurement", "spin", "epr", "unitary", "correlation",
    "state vector", "operator", "hamiltonian", "phase", "observable",
];

interface TurnEvidence {
    ms: number;
    words: number;
    url?: string;
    usage?: TapRecord["usage"];
    text: string;
}

test("real provider: it THINKS — worst-complex quantum entanglement, then 5-year-old terse", async (t) => {
    if (!KEY) return t.skip("no SANITYLOOP_E2E_KEY / OPENAI_API_KEY — staying free");

    const { file, dir } = await deriveAgent(t, "quantum-worker.ts", QUANTUM_WORKER_SOURCE);
    const r = await runNode(file, {
        cwd: dir,
        timeoutMs: 360_000,
        env: {
            SANITYLOOP_E2E_KEY: KEY,
            SANITYLOOP_E2E_BASE_URL: BASE_URL,
            SANITYLOOP_E2E_MODEL: MODEL,
        },
    });

    assert.equal(r.timedOut, false, "quantum worker HUNG — kill at deadline");
    assert.equal(r.code, 0, `child exited ${r.code}\nstdout: ${r.stdout.slice(0, 800)}`);
    assert.ok(r.stdout.includes("QUANTUM_OK"), "child never finished both turns");

    const turn1 = parseTurn(r.stdout, "TURN1");
    const turn2 = parseTurn(r.stdout, "TURN2");
    console.log(`QUANTUM_EVIDENCE turn1: ${JSON.stringify(turn1)}`);
    console.log(`QUANTUM_EVIDENCE turn2: ${JSON.stringify(turn2)}`);

    // Identity: the child's HTTP calls went where we configured.
    for (const turn of [turn1, turn2]) {
        assert.ok(turn.url, "turn missing dial-out URL");
        assert.equal(
            new URL(turn.url!).origin,
            new URL(BASE_URL).origin,
            `MISROUTED: configured ${BASE_URL}, dialed ${turn.url}`,
        );
    }

    // Verbose contract — it must actually THINK, not shrug.
    assert.ok(turn1.words >= 120, `turn 1 too short to be "worst complex": ${turn1.words} words`);
    const hits = JARGON.filter((j) => turn1.text.toLowerCase().includes(j));
    assert.ok(
        hits.length >= 6,
        `jargon density too low (${hits.length}/6): found [${hits.join(", ")}]`,
    );

    // Terse contract — the same brain, one sentence.
    assert.ok(turn2.words <= 60, `turn 2 refused to be short: ${turn2.words} words`);
    assert.ok(turn2.words > 0, "turn 2 came back empty");
    assert.ok(turn2.words < turn1.words, "turn 2 was not shorter than the physics lecture?!");
});

function parseTurn(stdout: string, marker: "TURN1" | "TURN2"): TurnEvidence {
    const line = stdout.split("\n").find((l) => l.startsWith(marker + ":"));
    assert.ok(line, `missing ${marker} evidence line\nstdout: ${stdout.slice(0, 800)}`);
    return JSON.parse(line!.slice(marker.length + 1)) as TurnEvidence;
}