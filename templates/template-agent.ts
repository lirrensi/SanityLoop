// ============================================================================
// template-agent.ts — THE TEMPLATE. A build-your-own agent, à la carte.
// ============================================================================
//
// HOW TO USE THIS FILE:
//   1. Copy it. Rename it. It's yours now.
//   2. Read top to bottom. Every block tells you:
//        WHAT it does · WHEN you want it · HOW to remove it.
//   3. Uncomment the imports + install lines of what you need.
//      Comment out what you don't. Each block is independent — removing one
//      never breaks the others. That's the whole point of Lego.
//   4. Run it:
//        node --experimental-strip-types my-agent.ts
//
// THE GOLDEN RULE OF THIS REPO:
//   every capability = one import + one install line. Comment both out and
//   the capability is GONE — cleanly, no leftovers, no hidden globals.
//   Nothing here requires touching @sanityloop/core. Ever.
//
// ============================================================================

// ============================================================================
// §0 — THE SKELETON (always needed)
// ============================================================================
// `Agent`       — the god object. Holds ALL state (messages, tools, stats,
//                 pending awaits…). Filters, tools and the model all receive
//                 it whole; mutate any part and the next tick reflects it.
// `SimpleModel` — the OpenAI-compatible model wrapper (chat completions,
//                 streaming). Swap guts without touching any contract.
// `EVENTS`      — the event-name constants for filters (§6).
// `Tool`        — define your own tools (§3).
import {
    Agent,
    SimpleModel,
    EVENTS,
    Tool,
} from "@sanityloop/core";

// ============================================================================
// §1 — THE MODEL (the one thing you MUST configure)
// ============================================================================
// WHEN: always. No model, no loop.
// PICK ONE of the shapes below. Everything else in this file works with either.
const model = new SimpleModel({
    modelId: "gpt-4o-mini",
    apiKey: process.env.OPENAI_API_KEY,
    stream: true,          // token-by-token deltas → your filters (§6) see them
});

// --- OPTION B: any provider beyond OpenAI-compatible -----------------------
// WANT: anthropic / google / mistral / deepseek / groq / openrouter / ~40 more?
// HOW:  swap the class. Same contract, nothing else moves.
//
// import { PiAdapterModel } from "@sanityloop/pi-model";
// const model = new PiAdapterModel({
//     provider: "anthropic",                    // pi-ai provider id
//     modelId: "claude-sonnet-4-5",
//     apiKey: process.env.ANTHROPIC_API_KEY,    // omitted → provider's env var
// });

// --- OPTION C: local model (llama.cpp, vLLM, anything OpenAI-shaped) -------
// WANT: free, private, offline?
// HOW:  point ANY wrapper at the endpoint. Example with PiAdapterModel:
//
// const model = new PiAdapterModel({
//     provider: "openai",
//     modelId: "local",
//     baseUrl: "http://localhost:58080/v1",     // your llama.cpp server
// });

// ============================================================================
// §2 — STORAGE: where state lives between runs (and whether it lives at all)
// ============================================================================
// WANT: crash safety. Kill -9 mid-turn, restart, and the agent resumes EXACTLY
//       where it was — messages, stats, even parked questions come back.
// HOW:  an append-only JSONL tape (`{t, change}` records) + a tiny `state.json`
//       status card, both inside one folder you choose.
//
// THREE TIERS — pick by editing ONE string:
//   jsonlSession("sessions/my-agent")    static folder  → SAME session each run
//                                                        (resume semantics)
//   jsonlSession("sessions/{uuid}")      random folder  → persisted, but a fresh
//                                                        folder every run
//   (no session at all)                  memory         → nothing touches disk;
//                                                        zero persistence
//
// WANT: in-memory but replayable within this process? Import MemoryLog from
//       @sanityloop/base-storage and build your own SessionStorage — the tape
//       contract is two methods (append/replay).
//
// REMOVE: delete the two lines marked (1)/(2) below → pure ephemeral agent.
import { jsonlSession } from "@sanityloop/base-storage";
const session = jsonlSession("sessions/my-agent");            // ← (1) pick a folder

// ============================================================================
// §3 — TOOLS: give the agent hands
// ============================================================================
// A tool = name + description + JSON schema + one async function.
// It receives `(params)` and may receive the whole `agent` as 2nd arg.
// Return `{ answer }` (what the model reads). Add `stored` to also write state.

const echoTool = Tool.define({
    name: "echo",
    description: "Echoes back the given text. Use for testing.",
    inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
    },
    async execute({ text }: { text: string }) {
        return { answer: `You said: ${text}` };
    },
});
const myTools = [echoTool];   // ← collect tools here, feed them to the agent (§4)

// --- OPTION: file tools, the plain trio ------------------------------------
// WANT: read/edit/write files, boring and predictable (exact-string replace)?
//
// import { createBasicTools } from "@sanityloop/basic-fs-tools";
// myTools.push(...Object.values(createBasicTools()));   // read + edit + write

// --- OPTION: file tools, drift-proof edition -------------------------------
// WANT: precise, conflict-safe edits that survive the file changing under the
//       model (hashline anchors + undo)? This is the coding-agent grade kit.
//
// import { createEditTools } from "@sanityloop/hash-fs-tools";
// myTools.push(...Object.values(createEditTools()));    // read + replace + undo
// // store options: none → in-memory anchors | storeDir → persistent SQLite

// --- OPTION: the shell ------------------------------------------------------
// WANT: bash/shell execution? Windows-first (resolves login shell + coreutils,
//       kills whole process trees, keeps the TAIL of output so errors survive).
//
// import { createBashPlugin, globTool } from "@sanityloop/shell-tool";
// // ^ bash arrives as a PLUGIN — install it down in §5, NOT as a tool here.
// myTools.push(globTool);                               // glob file search

// --- OPTION: task list ------------------------------------------------------
// WANT: the model keeping a visible plan? Writes `state.todos` — observed,
//       taped, restored like everything else.
//
// import { createTodoTool } from "@sanityloop/simple-todo";
// // ^ also a PLUGIN — install down in §5.

// --- OPTION: "ask the human" tool -------------------------------------------
// WANT: the model able to ASK you a question mid-task? Parks the loop until
//       any channel answers (terminal, HTTP POST /input, your own code).
//
// import { createQuestionTool } from "@sanityloop/ask-question";
// // ^ also a PLUGIN — install down in §5.

// ============================================================================
// §4 — THE AGENT: assemble the god object
// ============================================================================
const agent = new Agent({
    model,
    agentId: "my-agent",
    description: "built from template-agent.ts",   // free-form, shows in cards
    tools: myTools,
    messages: [
        {
            id: "system",
            enabled: true,
            type: "system-compound",
            // The system prompt is FRAGMENTS — addressable blocks you (or
            // plugins like agents-md-loader) can rewrite live, mid-session.
            // Messages are NEVER deleted, only enabled/disabled.
            content: [
                { id: "agent.md", content: "You are a precise coding agent." },
                { id: "cwd-rules", content: "No extra rules yet." },
            ],
        },
    ],
});

// Crash safety, act II: replay the tape into the fresh agent BEFORE installing
// plugins. Parked questions come back too — kill the process while it waited
// for permission, restart, still waiting. (1)+(2)+this line = full resume.
await session.restoreInto(agent);

// ============================================================================
// §5 — PLUGINS: the runtime, à la carte. One import + one install each.
// ============================================================================
// Order rarely matters. Removing any block removes exactly that capability.

// ---- INPUTS — the input vocabulary ────────────────────────────────────────
// WHAT: turns raw inputs into verbs — abort, stop, steer mid-turn, follow-up,
//       clear history, reset to system-only.
// WANT: basically always. Without it, agent.input() means nothing.
// REMOVE: delete both lines → the loop runs but deaf to control inputs.
import { createDefaultInputs } from "@sanityloop/inputs";
agent.install(createDefaultInputs());

// ---- PERMISSIONS — gates over dangerous tools ─────────────────────────────
// WHAT: allow/ask/deny per tool (wildcards ok, last match wins). An "ask"
//       PARKS the loop until answered; approvals + denial audit live in
//       state.permission (taped, restored). Classic choices included:
//       once / session / no / no_explain.
// WANT: tools that touch real files, networks, prod. Humans say yes/no.
// REMOVE: delete both lines → everything just runs ungated.
//
// import { createPermissions, askAll } from "@sanityloop/permission";
// agent.install(
//     createPermissions({
//         // `rules` = your policy blob, handed to every gate/resolver:
//         rules: {
//             paths: {
//                 mode: "workspace",               // cwd ok, outside → ask
//                 whitelist: ["D:/shared/**"],     // extra allowed roots
//                 blacklist: ["**/.env"],          // ALWAYS denied, beats all
//             },
//         },
//         // sparse map — broad FIRST, specific AFTER (last match wins):
//         tools: {
//             "*": { gate: askAll },     // ask for everything…
//             echo: { gate: null },      // …except echo (null = bows out)
//         },
//     }),
// );
// // answer from ANYWHERE: agent.input({ type: "permission/answer",
// //                                    ref: <callId>, answer: "once" })

// ---- COMPACTION — survive long contexts ───────────────────────────────────
// WHAT: when context nears the limit (default 70% of maxContext), summarizes
//       older history (keeping recent messages) and continues. Also answers
//       request_compact inputs.
// WANT: sessions longer than one window. Coding agents. Marathon workers.
// NOTE: messages are never DELETED — summarization is your strategy, this is
//       just the shipped one. Prefer "fresh start with a summary"? Use
//       compact-handover instead (summarize → continue brand-new).
// REMOVE: delete both lines → context overflow becomes YOUR problem.
//
// import { createCompaction } from "@sanityloop/basic-compaction";
// agent.install(createCompaction({ threshold: 0.7, keepRecent: 8 }));
//
// import { createCompactHandover } from "@sanityloop/compact-handover"; // ALT
// agent.install(createCompactHandover(/* same idea, handover-style */));

// ---- SKILLS — load knowledge on demand ────────────────────────────────────
// WHAT: scans folders for SKILL.md files; their names+descriptions go into
//       the system prompt as a menu, and the model loads full bodies via a
//       `skill` tool only when relevant. Prompt stays lean.
// WANT: big instruction sets (coding standards, recipes) without bloating
//       every single call.
// REMOVE: delete both lines → no skill catalog, no skill tool.
//
// import { createSkillsPlugin } from "@sanityloop/skills";
// agent.install(createSkillsPlugin({ dirs: [".agents/skills"], max: 8,
//   preload: ["anubis", "osiris"] }));   // ← force these skills' full bodies into
//                                        //    context at boot (deterministic)

// ---- AGENTS.MD — repo rule injection ──────────────────────────────────────
// WHAT: discovers AGENTS.md files up the directory tree and injects them as
//       system fragments (opencode-style). Rewrites live as you cd around.
// WANT: your agent working inside real repos that carry AGENTS.md.
// REMOVE: delete both lines → static system prompt only.
//
// import { createAgentsMdLoader } from "@sanityloop/agents-md-loader";
// agent.install(createAgentsMdLoader());

// ---- RULES LOADER — .mdc rules, cursor-style ──────────────────────────────
// WHAT: scans .cursor/rules, .claude/rules, .codex/rules, .agents/rules …
//       globs decide which rules apply when which files get read.
// WANT: teams already living in cursor/.claude rule formats.
// REMOVE: delete both lines → no rule discovery.
//
// import { createRulesLoader } from "@sanityloop/rules-loader";
// agent.install(createRulesLoader());

// ---- MCP — existing servers become native tools ───────────────────────────
// WHAT: spawns stdio MCP servers, converts their tools to plain Sanity tools,
//       namespaced server_tool (collision-proof). Per-server failure
//       degrades gracefully — one dead server never kills the init.
// WANT: the whole MCP ecosystem (filesystem, fetch, github, sqlite…) without
//       writing a single tool yourself.
// SHAPE: 3 steps — declare (sync) → init (the ONLY await) → install.
// REMOVE: delete all lines of this block → no MCP tools.
//
// import { createMcp } from "@sanityloop/mcp";
// const mcp = createMcp({
//     fs:  { command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."] },
//     web: { command: "uvx", args: ["mcp-server-fetch"] },
// });
// await mcp.init(15_000);
// agent.install(mcp.getPlugin());

// ==== SESSION SURFACE — pick EXACTLY ONE personality for this process ======
//
// A) REPL — interactive terminal session ────────────────────────────────────
// WHAT: readline chat with ANSI markdown, streaming feedback, slash commands
//       (/help /status /plugins /clear /exit), custom commands via opts.
// WANT: humans typing at this thing right now.
//
// import { createReplPlugin } from "@sanityloop/repl";
// agent.install(createReplPlugin());     // or { prompt: "me> ", commands: {...} }
//
// B) QUIT-ON-END — batch script ◀── ACTIVE DEFAULT ──────────────────────────
// WHAT: process exits the moment the agent lands idle. Work done → die.
// WANT: cron jobs, CI steps, one-shot scripts piped into stdin.
//       (This is the default below so a first `node my-agent.ts` run streams
//       its reply and exits cleanly instead of hanging.)
import { createQuitOnEndPlugin } from "@sanityloop/quit-on-end";
agent.install(createQuitOnEndPlugin());
//
// C) KEEP-OPEN — long-lived daemon ──────────────────────────────────────────
// WHAT: keeps the loop breathing after each job settles — the opposite of B.
// WANT: services, watchers, swarm workers waiting for the next command.
//
// import { createKeepOpenPlugin } from "@sanityloop/keep-open";
// agent.install(createKeepOpenPlugin());
//
// ⚠ NEVER combine A+B. REPL stays open, quit-on-end dies when done —
//   they are opposites by design. Swapping = comment one line, uncomment other.

// ---- HTTP SERVER — drive the agent from anywhere ──────────────────────────
// WHAT: HTTP+SSE+WS over the live god object. POST /input is the ONLY write
//       door; GET /getState reads state (?keys= picks); SSE streams deltas.
//       port 0 = random → the real port lands in state.http.port.
// WANT: web UIs, remote control, other processes feeding inputs. Add `apikey`
//       before binding beyond localhost, obviously.
// REMOVE: delete both lines → terminal-only (or code-driven) agent.
//
// import { createHttpServer } from "@sanityloop/http-server";
// agent.install(createHttpServer({ port: 0 }));

// ---- OBSERVER — watch the loop think ──────────────────────────────────────
// WHAT: prints lifecycle headlines (verbosity 1) or +stream details (2).
//       logs:true also relays the shared log channel.
// WANT: developing/debugging. Turn off in production.
//
// import { createObserverPlugin } from "@sanityloop/observer";
// agent.install(createObserverPlugin({ verbosity: 2, logs: true }));

// ---- LOG SINK — structured logs ───────────────────────────────────────────
// WHAT: producers emitLog(agent, level, source, msg) anywhere; sinks subscribe
//       on the shared channel. File sink = JSONL with size rotation.
// WANT: real logging you can grep/diff later. Producers never know sinks.
//
// import { createFileLog, createConsoleLog } from "@sanityloop/log-sink";
// agent.install(createFileLog({ path: "logs/my-agent.jsonl" }));
// agent.install(createConsoleLog());

// ---- LOOP CONTROL — watchdogs for unattended runs ─────────────────────────
// WHAT: doom-loop detection (same tool failing repeatedly) + max-turns budget.
// WANT: cron/unattended runs where nobody watches. The doctrine says a strong
//       model needs none of this — production paranoia disagrees.
//
// import { loopControl } from "@sanityloop/loop-control";
// agent.install(loopControl({ maxTurns: { enabled: true, cap: 50 } }));

// ============================================================================
// §6 — YOUR FILTERS: hook ANY moment of the loop. One shape, everywhere.
// ============================================================================
// addFilter({ event, id, priority, fn }) — WordPress-style. fn is awaited,
// runs by priority. See EVENTS.* for every hook point (beforeTool, afterTool,
// inputReceived, stop, fragmentUpdate, …).

// Live-stream tokens to your own UI (the classic):
agent.addFilter({
    event: EVENTS.textDelta,
    id: "my/stream-paint",
    priority: 0,
    fn: async (_agent, raw) => {
        const payload = raw as { streamDelta?: { type?: string; delta?: string } };
        const sd = payload?.streamDelta;
        if (sd?.type === "textDelta") process.stdout.write(sd.delta ?? "");
    },
});

// --- EXAMPLE: veto a tool call before it runs -------------------------------
// WANT: your own guard rails next to (or instead of) the permission plugin.
//
// agent.addFilter({
//     event: EVENTS.beforeTool,
//     id: "my/guard",
//     priority: 50,
//     fn: async (agent, payload) => {
//         const call = payload?.call;
//         if (call?.name === "bash" && /rm\s+-rf/.test(JSON.stringify(call.parameters))) {
//             call.preResolved = { answer: "blocked by guard", error: true };
//         }
//     },
// });

// ============================================================================
// §7 — GO
// ============================================================================
console.log("=== my-agent running ===");
agent.run();   // the eternal heartbeat — never returns until YOU end it
               // (repl keeps it alive · quit-on-end ends it · terminate() is
               // the off switch for hosts embedding many agents)

// Drive it from code (works alongside repl/http, or alone with keep-open):
agent.input({ type: "input_followup", text: "hello cutie" });   // ← the first prompt
// agent.input({ type: "input_steer", text: "actually, focus on X" }); // mid-turn
