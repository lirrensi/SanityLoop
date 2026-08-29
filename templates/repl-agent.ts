// ============================================================================
// repl-agent.ts — THE REPL. A real session, composed from general plugins.
// ============================================================================
// The repl is THIN. The interactive session — prompt loop, commands, micro
// TUI — is itself a plugin. The file is only composition + your model/tools:
//
//   agent.install(createAgentsMdLoader())    — AGENTS.md rules
//   agent.install(createCompaction())        — context compaction
//   agent.install(createDefaultInputs())     — the input vocabulary (abort/stop/steer/followup)
//   agent.install(createSkillsPlugin(...))   — skills catalog + tool
//   agent.install(createBashPlugin())        — the shell
//   agent.install(createReplPlugin())        — the SESSION: prompt loop + commands
//                                              (/help /status /plugins /clear /exit)
//                                              + micro TUI (stream inline, ⚙ tools)
//
// repl is the SESSION counterpart of quit-on-end: a repl stays open, a batch
// worker installs quit-on-end (dies when done). Never both.
//
// Model: llama.cpp at localhost:58080. Point SimpleModel anywhere — nothing
// else moves.
// ============================================================================
import { Agent, SimpleModel, Tool } from "@sanityloop/core";
import { createBasicTools } from "@sanityloop/basic-fs-tools";
import { globTool } from "@sanityloop/shell-tool";
import { createAgentsMdLoader } from "@sanityloop/agents-md-loader";
import { createCompaction } from "@sanityloop/basic-compaction";
import { createDefaultInputs } from "@sanityloop/inputs";
import { createSkillsPlugin } from "@sanityloop/skills";
import { createBashPlugin } from "@sanityloop/shell-tool";
import { createReplPlugin } from "@sanityloop/repl";

// ============================================================================
// tools — the boring four blocks. (bash comes from its plugin, not here.)
// ============================================================================
const echoTool = Tool.define({
    name: "echo",
    description: "Echoes back the given text.",
    inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
    },
    async execute({ text }: { text: string }) {
        return { answer: `You said: ${text}` };
    },
});

const addTool = Tool.define({
    name: "add",
    description: "Adds two numbers. Use for arithmetic.",
    inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
    },
    async execute({ a, b }: { a: number; b: number }) {
        return { answer: `${a} + ${b} = ${a + b}` };
    },
});

// ============================================================================
// model — the real thing: llama.cpp at localhost:58080 (gemma-4-E4B, 128k ctx)
// ============================================================================
const model = new SimpleModel({
    api: "chat_completions",
    modelId: process.env.SWARM_MODEL ?? "local-model",
    baseUrl: "http://localhost:58080/v1",
    stream: true,
    maxContext: 128_000,
});

// ============================================================================
// the agent
// ============================================================================
const { read, edit, write } = createBasicTools();

const agent = new Agent({
    model,
    agentId: "repl",
    tools: [echoTool, addTool, globTool, read, edit, write],
    messages: [
        {
            id: "system",
            enabled: true,
            type: "system",
            content: [
                {
                    type: "text",
                    content:
                        "You are a REPL assistant with file tools. Keep replies short. " +
                        "You have: `glob` (find files), `read` (read a file, numbered lines), " +
                        "`edit` (edit a file by exact string replace), `write` (create or overwrite a file), " +
                        "`bash` (run a shell command), " +
                        "`add` (arithmetic), `echo` (repeat). " +
                        "To edit a file: first `read` it, then `edit` with the exact old text and your new text. " +
                        "The current working directory is the repo root.",
                },
            ],
        },
    ],
});

// ============================================================================
// plugins — the whole runtime, batch in. The repl plugin IS the session:
// prompt loop + commands + micro TUI. Nothing else needs wiring.
// ============================================================================
agent.install(createAgentsMdLoader()); // AGENTS.md rules, auto-loaded
agent.install(createCompaction()); // context compaction at 70%
agent.install(createDefaultInputs()); // input vocabulary: abort/stop/steer/followup
agent.install(createSkillsPlugin({ dirs: [".agents/skills"] })); // skills catalog + the skill tool
agent.install(createBashPlugin()); // the shell
agent.install(createReplPlugin()); // the session: prompt, commands, micro TUI

// ============================================================================
// go — the Viola loop. Born-landed: the machine ticks but WAITS — the TUI is
// up, idle, and the first message you type starts the very first turn.
// (No console.log here — the repl plugin owns the screen from install on.)
// ============================================================================
agent.run({ startState: "idle" });
