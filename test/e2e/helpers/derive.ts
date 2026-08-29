// ============================================================================
// test/e2e/helpers/derive.ts — "take template, change something" factory.
// ============================================================================
// Writes a DERIVED agent (the user story: copy the template, tweak it) into a
// fresh temp dir and junctions the repo's node_modules into it, so the derived
// file resolves @sanityloop/* exactly like a real user checkout would.
// Everything is cleaned up via the test context.

import { symlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "@sanityloop/test-kit";
import { REPO_ROOT } from "./spawn.ts";

export interface DerivedCtx {
    /** Absolute path of the written agent file. */
    file: string;
    /** The temp dir that plays "user project root". */
    dir: string;
}

async function linkNodeModules(dir: string): Promise<void> {
    const target = join(REPO_ROOT, "node_modules");
    const link = join(dir, "node_modules");
    // 'junction' needs no admin rights on Windows; falls back to 'dir' elsewhere.
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

/**
 * Materialize `source` as <tempDir>/<name> and return its path.
 * `t` is the node:test context — cleanup hooks register on it.
 */
export async function deriveAgent(
    t: { after: (fn: () => unknown | Promise<unknown>) => unknown },
    name: string,
    source: string,
    files: Record<string, string> = {},
): Promise<DerivedCtx> {
    const dir = await makeTempDir(t, "sanity-e2e-derived-");
    await linkNodeModules(dir);
    const file = join(dir, name);
    await writeFile(file, source, "utf8");
    for (const [rel, content] of Object.entries(files)) {
        await writeFile(join(dir, rel), content, "utf8");
    }
    return { file, dir };
}

// ============================================================================
// THE DERIVED TEMPLATES — what a user ships after "changing something".
// Self-contained on purpose: inline stub model, real tools, real effects.
// ============================================================================

/**
 * Mode A ("write"): one turn — model calls write_note → a REAL file lands on
 * disk. Session tape persists to <dir>/sessions/<id>. quit-on-end kills the
 * process when the work drains. This is the smallest production-shaped batch
 * worker that can exist.
 *
 * Mode B ("restore"): boots, restores the SAME session dir, prints what came
 * back as JSON, exits WITHOUT running the loop. The crash-resume promise,
 * proven across a REAL process boundary.
 */
export const PERSISTENT_WORKER_SOURCE = String.raw`
// e2e derived template — take template-agent, change something, run it.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Agent, SimpleModel, Tool } from "@sanityloop/core";
import { createDefaultInputs } from "@sanityloop/inputs";
import { createQuitOnEndPlugin } from "@sanityloop/quit-on-end";
import { jsonlSession } from "@sanityloop/base-storage";

const MODE = process.env.DERIVED_MODE ?? "write";
const SESSION_ID = "e2e-persistent-worker";
const CWD = process.cwd();
const session = jsonlSession(join(CWD, "sessions", SESSION_ID));

const writeNote = Tool.define({
    name: "write_note",
    description: "Write a note file into the workspace.",
    inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
    },
    async execute({ path, content }: { path: string; content: string }) {
        const full = join(CWD, path);
        await writeFile(full, content, "utf8");
        return { answer: "wrote " + path, stored: { bytes: content.length } };
    },
});

let calls = 0;
const model = new SimpleModel({ api: "chat_completions", modelId: "stub-e2e-001", stream: false });
model.callNextTurn = async () => {
    calls++;
    if (calls === 1) {
        return {
            message: {
                id: "m-tool-" + calls,
                enabled: true,
                type: "toolCall",
                content: {
                    answer: "",
                    stored: [{
                        id: "call-write-1",
                        type: "function",
                        name: "write_note",
                        parameters: { path: "hello.txt", content: "REAL EFFECT FROM A SPAWNED PROCESS" },
                    }],
                },
            },
            stats: {
                input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "tool_calls",
        };
    }
    return {
        message: {
            id: "m-assistant-" + calls,
            enabled: true,
            type: "assistant",
            content: [{ type: "text", content: "note written, work done" }],
        },
        stats: {
            input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
    };
};

const agent = new Agent({
    model,
    agentId: "derived-worker",
    cwd: CWD,
    tools: [writeNote],
});
agent.install(createDefaultInputs());
agent.install(session.plugin);
agent.install(createQuitOnEndPlugin());

if (MODE === "restore") {
    // Crash-resume path: replay the tape into this fresh process and report.
    const restored = await session.restoreInto(agent);
    const texts = agent.messages.map((m) => JSON.stringify(m.content));
    console.log("RESTORE_RESULT:" + JSON.stringify({ restored, count: agent.messages.length, texts }));
    process.exit(0);
}

agent.messages.push({
    id: "user-seed",
    enabled: true,
    type: "user",
    committedAt: Date.now(),
    content: [{ type: "text", content: "please write hello.txt" }],
});
console.log("DERIVED_WORKER_RUNNING");
agent.run();
`;

/**
 * REPL variant: repl plugin + stub model. Interactive surface, zero keys.
 */
export const STUB_REPL_SOURCE = String.raw`
// e2e derived template — the repl-agent composition with a stubbed model.
import { Agent, SimpleModel } from "@sanityloop/core";
import { createDefaultInputs } from "@sanityloop/inputs";
import { createReplPlugin } from "@sanityloop/repl";

let calls = 0;
const model = new SimpleModel({ api: "chat_completions", modelId: "stub-repl-001", stream: false });
model.callNextTurn = async (agent) => {
    calls++;
    // The repl TUI paints from the STREAM — emit the deltas like a real
    // streaming provider would (same trick templates/simple-agent.ts uses).
    const text = "STUB REPLY " + calls + " OK";
    agent.streamSink?.emit({ type: "streamStarted" });
    for (const w of text.split(" ")) agent.streamSink?.emit({ type: "textDelta", delta: w + " " });
    agent.streamSink?.emit({ type: "textEnd" });
    return {
        message: {
            id: "reply-" + calls,
            enabled: true,
            type: "assistant",
            content: [{ type: "text", content: text }],
        },
        stats: {
            input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
    };
};

const agent = new Agent({ model, agentId: "stub-repl" });
agent.install(createDefaultInputs());
agent.install(createReplPlugin({ prompt: "you> " }));

console.log("=== sanity repl — type something, /help for commands ===");
agent.run();
`;

/**
 * Crash variants. CRASH_MODE=model → provider throws mid-turn.
 * CRASH_MODE=tool → the tool explodes AFTER being called.
 * Both must land bounded (quit-on-end), never hang — THE burn test.
 */
export const CRASH_WORKER_SOURCE = String.raw`
// e2e derived template — hostile runtime edition.
import { Agent, EVENTS, SimpleModel, Tool } from "@sanityloop/core";
import { createDefaultInputs } from "@sanityloop/inputs";
import { createQuitOnEndPlugin } from "@sanityloop/quit-on-end";

const MODE = process.env.CRASH_MODE ?? "model";

const bombTool = Tool.define({
    name: "bomb",
    description: "Always throws. For crash drills.",
    inputSchema: {
        type: "object",
        properties: {},
        required: [],
    },
    async execute() {
        throw new Error("BOMB_TOOL_EXPLODED");
    },
});

let calls = 0;
const model = new SimpleModel({ api: "chat_completions", modelId: "stub-crash-001", stream: false });
model.callNextTurn = async () => {
    calls++;
    if (MODE === "model" && calls >= 1) {
        throw new Error("BOMB_MODEL_EXPLODED");
    }
    if (MODE === "tool" && calls === 1) {
        return {
            message: {
                id: "crash-tool-call",
                enabled: true,
                type: "toolCall",
                content: {
                    answer: "",
                    stored: [{ id: "call-bomb-1", type: "function", name: "bomb", parameters: {} }],
                },
            },
            stats: {
                input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "tool_calls",
        };
    }
    return {
        message: {
            id: "crash-assistant",
            enabled: true,
            type: "assistant",
            content: [{ type: "text", content: "survived the tool explosion" }],
        },
        stats: {
            input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
    };
};

const agent = new Agent({
    model,
    agentId: "crash-worker",
    tools: MODE === "tool" ? [bombTool] : [],
});
agent.install(createDefaultInputs());
agent.install(createQuitOnEndPlugin());

agent.onFilter({
    after: (_f, a) => {
        for (const m of a?.messages ?? []) {
            const c = m.content;
            if (typeof c === "object" && c !== null && "error" in (c as Record<string, unknown>)) {
                console.log("SAW_ERROR_RESULT:" + JSON.stringify(c).slice(0, 200));
            }
        }
    },
});

// Landing receipt — proves the turn ENDED with the assistant's own words.
agent.addFilter({
    event: EVENTS.stop,
    id: "crash/landing-receipt",
    priority: 0,
    fn: async (a) => {
        for (const m of a.messages) {
            if (m.type === "assistant") console.log("ASSISTANT_SAID:" + JSON.stringify(m.content));
        }
    },
});

agent.messages.push({
    id: "user-crash-seed",
    enabled: true,
    type: "user",
    committedAt: Date.now(),
    content: [{ type: "text", content: "do something dangerous" }],
});
console.log("CRASH_WORKER_RUNNING mode=" + MODE);
agent.run();
`;

/**
 * THINKING worker — REAL provider, REAL loop, two turns:
 *   1. "Explain quantum entanglement in the worst, most complex way possible."
 *   2. "Now explain it to a tired 5-year-old in ONE short sentence."
 * Prints TURN1:/TURN2: evidence lines (JSON: ms, words, text, usage) driven by
 * the stop-event landing counter, then exits 0 at the app layer — THE doctrine.
 * A 300s safety net exits 1 if any turn never lands. Runs OUT-OF-PROCESS so
 * the eternal heartbeat never haunts node:test's own teardown (Windows libuv
 * handle race).
 */
export const QUANTUM_WORKER_SOURCE = String.raw`
// e2e derived template — the thinking man's burn test.
process.on("unhandledRejection", (r) => { console.log("CHILD_UNHANDLED:" + String(r)); process.exit(1); });

import { Agent, EVENTS, SimpleModel } from "@sanityloop/core";
import { createDefaultInputs } from "@sanityloop/inputs";

const BASE_URL = process.env.SANITYLOOP_E2E_BASE_URL ?? "https://api.openai.com/v1";
const records = [];
const origFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    const res = await origFetch(input, init);
    try {
        res.clone().json().then((j) => records.push({ url: String(input), usage: j.usage })).catch(() => {});
    } catch {}
    return res;
};

const model = new SimpleModel({
    api: "chat_completions",
    modelId: process.env.SANITYLOOP_E2E_MODEL ?? "gpt-4o-mini",
    apiKey: process.env.SANITYLOOP_E2E_KEY,
    baseUrl: BASE_URL,
    stream: false,
    maxOutputTokens: 1200,
});
const agent = new Agent({ model, agentId: "quantum-worker" });
agent.install(createDefaultInputs());

const words = (s) => s.split(/\s+/).filter(Boolean).length;
const textOf = (m) =>
    typeof m?.content === "string"
        ? m.content
        : Array.isArray(m?.content)
            ? m.content.map((b) => b?.content ?? "").join(" ")
            : "";
const lastAssistant = (msgs) => [...msgs].reverse().find((m) => m.type === "assistant");

let landings = 0;
let t0 = Date.now();
agent.addFilter({
    event: EVENTS.stop,
    id: "quantum/driver",
    priority: 0,
    fn: async (a) => {
        if (a.loopState !== "idle") return; // only real graceful landings
        landings++;
        const text = textOf(lastAssistant(a.messages));
        const payload = {
            ms: Date.now() - t0,
            words: words(text),
            url: records[records.length - 1]?.url,
            usage: records[records.length - 1]?.usage,
            text,
        };
        if (landings === 1) {
            console.log("TURN1:" + JSON.stringify(payload));
            t0 = Date.now(); // reset the clock for turn 2
            a.input({
                type: "input_followup",
                text: "Now explain it to a tired 5-year-old in ONE short sentence.",
            });
        } else if (landings >= 2) {
            console.log("TURN2:" + JSON.stringify(payload));
            console.log("QUANTUM_OK");
            setTimeout(() => process.exit(0), 50); // let dispatch settle — app layer
        }
    },
});

setTimeout(() => {
    console.log("QUANTUM_TIMEOUT after 300s, landings=" + landings);
    process.exit(1);
}, 300_000);

agent.messages.push({
    id: "quantum-seed",
    enabled: true,
    type: "user",
    committedAt: Date.now(),
    content: [{
        type: "text",
        content:
            "Explain quantum entanglement in the worst, most complex way possible. " +
            "Maximum jargon, formal notation, no analogies, no mercy.",
    }],
});
console.log("QUANTUM_RUNNING");
agent.run();
`;
