// ============================================================================
// simple-agent.ts — THE PROOF. The whole runtime in one file.
// ============================================================================
// Imports raw classes, wires them, runs. No engine, no magic.
// The vertical slice IS this file running.
//
// Demonstrates the settled design:
//   - dead events now fire (beforeAgentStart, agentStart, stop, toolListChanged)
//   - parking: a beforeTool permission gate issues a pendingAwait → loop parks
//     (loopState awaiting) → an input resolves it → loop resumes → tool runs
//   - stats accumulate across turns
//   - endCycle discard (discard-first-response)
//   - stream-phase visibility (textDelta)
// ============================================================================

import { Agent, SimpleModel, Tool, EVENTS } from "@sanityloop/core";
import { createDefaultInputs } from "@sanityloop/inputs";

// ---- tools: the boring four blocks ----
const echoTool = Tool.define({
    name: "echo",
    description: "Echoes back the given text. Use for testing.",
    inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
    },
    async execute({ text }: { text: string }, agent) {
        console.log(
            `[tool:echo] got: "${text}" | messages so far: ${agent.messages.length}`,
        );
        return { answer: `You said: ${text}`, stored: { length: text.length } };
    },
});

// factory — pre-lock runtime params
const loudEcho = Tool.factory({
    prefix: "!!! ",
    tool: echoTool,
});

// ---- model: the wrapper — swap guts without touching the contract ----
const model = new SimpleModel({
    api: "chat_completions",
    modelId: "gpt-4o-mini",
    stream: true,
    maxContext: 128_000,
});
// STUB override so we can run without keys.
// call 1 → a toolCall (the model wants the echo tool).
// call 2 → a plain assistant message (turn ends).
let stubCalls = 0;
model.callNextTurn = async (agent) => {
    stubCalls++;
    const last = agent.messages.at(-1);
    const text =
        typeof last?.content === "string"
            ? last.content
            : JSON.stringify(last?.content ?? "");

    // ---- STREAM phase: emit deltas through the sink → the bus ----
    agent.streamSink?.emit({ type: "streamStarted" });
    const words = `stub reply #${stubCalls} to: "${text}"`.split(" ");
    for (const w of words) {
        agent.streamSink?.emit({ type: "textDelta", delta: w + " " });
    }
    agent.streamSink?.emit({ type: "textEnd" });

    if (stubCalls === 2) {
        // the model wants to call echo once (call 1 gets discarded by the demo)
        return {
            message: {
                id: `runtime-${crypto.randomUUID().slice(0, 8)}`,
                enabled: true,
                type: "toolCall",
                content: {
                    answer: "",
                    stored: [
                        {
                            id: "call-1",
                            type: "function",
                            name: "echo",
                            parameters: { text },
                        },
                    ],
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
            id: `runtime-${crypto.randomUUID().slice(0, 8)}`,
            enabled: true,
            type: "assistant",
            content: [{ type: "text", content: words.join(" ") }],
        },
        stats: {
            input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
    };
};

// ---- the agent ----
const agent = new Agent({
    model,
    agentId: "simple-agent",
    tools: [loudEcho],
    messages: [
        {
            id: "system",
            enabled: true,
            type: "system-compound",
            content: [
                { id: "agent.md", content: "You are a precise coding agent." },
                { id: "cwd-rules", content: "No rules yet." },
            ],
        },
    ],
});

// ---- the default input umbrella — the control hats (abort/stop/steer/followup).
// The core is type-blind; THIS extra assigns meaning. Wire it like any other extra. ----
agent.install(createDefaultInputs());

// ---- lifecycle listeners: the dead events now fire ----
agent.addFilter({
    event: EVENTS.beforeAgentStart,
    id: "log-before-start",
    priority: 0,
    fn: async (agent) => {
        console.log("[filter:beforeAgentStart] the system-prompt assembly point");
    },
});
agent.addFilter({
    event: EVENTS.agentStart,
    id: "log-start",
    priority: 0,
    fn: async (agent) => {
        console.log("[filter:agentStart] loop alive");
    },
});
agent.addFilter({
    event: EVENTS.stop,
    id: "log-stop",
    priority: 0,
    fn: async (agent) => {
        console.log(`[filter:stop] landing: loopState=${agent.loopState}`);
    },
});
agent.addFilter({
    event: EVENTS.toolListChanged,
    id: "log-tool-list",
    priority: 0,
    fn: async (agent) => {
        console.log(
            `[filter:toolListChanged] tools now: ${agent.tools.map((t) => t.name).join(", ")}`,
        );
    },
});
agent.addFilter({
    event: EVENTS.toolUpdate,
    id: "log-tool-update",
    priority: 0,
    fn: async (agent) => {
        console.log(
            `[filter:toolUpdate] a tool definition changed: ${agent.tools.map((t) => `${t.name}${t.disabled ? " (disabled)" : ""}`).join(", ")}`,
        );
    },
});

// ---- PERMISSION = a plugin (two filters). Issue + clear. ----
let askedOnce = false;
agent.addFilter({
    event: EVENTS.beforeTool,
    id: "permission-issue",
    priority: 5,
    fn: async (agent) => {
        if (!askedOnce) {
            askedOnce = true;
            console.log("[filter:permission] issuing a pending await — park!");
            agent.pendingAwaits.push({
                type: "permission-answer",   // the plugin's kind — ties to the universal input type
                id: "perm-1",
                schema: { type: "permission-answer" },
            });
        }
    },
});
agent.addFilter({
    event: EVENTS.inputReceived,
    id: "permission-clear",
    priority: 10,
    fn: async (agent) => {
        const input = agent.currentInput;
        if (input?.type === "permission-answer") {
            const idx = agent.pendingAwaits.findIndex((a) => a.id === "perm-1");
            if (idx !== -1) {
                agent.pendingAwaits.splice(idx, 1);
                console.log("[filter:permission] await cleared — resume!");
            }
        }
    },
});

// ---- the meta-callbacks: watch + control the machinery (NOT filters) ----
agent.onFilter({
    attached: (f) => console.log(`[meta:attached] "${f.id}" → ${f.event}`),
    before: (f) => console.log(`[meta:before] ${f.event}.${f.id}`),
    after: (f, agent) =>
        console.log(
            `[meta:after] ${f.event}.${f.id} → ${agent === null ? "no-op" : "merged"}`,
        ),
});

// ---- stream phase visibility ----
agent.addFilter({
    event: EVENTS.textDelta,
    id: "stream-paint",
    priority: 0,
    fn: async (agent) => {
        process.stdout.write(".");
    },
});

// ---- fragment machine: direct mutation, observed, flushed at the seam ----
let fragmentTouched = false;
agent.addFilter({
    event: EVENTS.afterTool,
    id: "fragment-mutator",
    priority: 0,
    fn: async (agent) => {
        if (!fragmentTouched) {
            fragmentTouched = true;
            // DIRECT mutation — the observer catches it → fragmentUpdate queued
            const sys = agent.messages[0];
            const block = (sys.content as { id: string; content: string }[]).find(
                (b) => b.id === "agent.md",
            );
            if (block)
                block.content =
                    "You are a precise coding agent. (fragment updated after the tool!)";
            // tool definition change — fires toolUpdate (per-tool, not list-level)
            agent.updateTool("echo", {
                description: "Echoes back the given text. (definition updated)",
            });
        }
    },
});
agent.addFilter({
    event: EVENTS.fragmentUpdate,
    id: "log-fragment",
    priority: 0,
    fn: async (agent) => {
        console.log(
            `\n[filter:fragmentUpdate] "${agent.currentTurn?.id}" — a fragment changed (flushed at the seam)`,
        );
    },
});
agent.addFilter({
    event: EVENTS.messageUpdate,
    id: "log-msg-update",
    priority: 0,
    fn: async (agent) => {
        console.log(`\n[filter:messageUpdate] "${agent.currentTurn?.id}" updated`);
    },
});

// ---- endCycle: discard the FIRST response (no commit, next iteration) ----
let discardCount = 0;
agent.addFilter({
    event: EVENTS.afterProviderResponse,
    id: "discard-first-response",
    priority: 5,
    fn: async (agent) => {
        if (discardCount < 1) {
            discardCount++;
            console.log("\n[filter:discard] discarding the response — endCycle!");
            agent.endCycle();
        }
    },
});

// ---- run: the eternal heartbeat. Never returns. The process is shut down
// explicitly at the bottom (process.exit) — app-layer, as the doctrine says. ----
console.log("=== sanity simple-agent running (stub model) ===");
agent.run();
agent.input({ type: "input_followup", text: "hello cutie" });

// let the loop run, then drive the permission gate + dump the story
setTimeout(() => {
    console.log(
        `\n[driver] loopState after first input: ${agent.loopState} (expect awaiting — parked on permission)`,
    );
    agent.input({ type: "permission-answer", allowed: true });
}, 150);

setTimeout(() => {
    console.log(
        `\n[driver] loopState after resolve: ${agent.loopState} (expect idle)`,
    );
    console.log(`\n=== messages after turn ===`);
    for (const m of agent.messages) {
        const content =
            typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        console.log(`  [${m.type}] ${content.slice(0, 120)}`);
    }
    console.log(`\n=== stats (accumulated) ===`);
    console.log(JSON.stringify(agent.stats));
    process.exit(0);
}, 500);
