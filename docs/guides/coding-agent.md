---
node_type: guide
title: Build Your Own Coding Agent — the pi alternative, assembled from shelves
status: active
updated: 2026-08-23
tags: [coding-agent, assembly, guide, repl, ui, subagents]
links:
  depends_on: [/guides/mini-map.md, /reference/extensions.md, /overview/product.md]
sync_status: verified
last_synced: 2026-08-23
---

# Build Your Own Coding Agent

**The promise:** everything `pi` or `opencode` does for you — repo-aware editing,
shell access, skills, MCP, sub-agents, approvals, crash recovery, an interactive
surface — except every part of it is *yours*. One file owns the whole harness.
No fork. No side repo. No opinions holding you back.

This guide walks the full bill of materials and the assembly, then the one big
decision left to taste: **the face** — ship the built-in REPL, improve it,
or build your own UI over the state door.

---

## The bill of materials

Every capability a coding agent needs, and the brick that provides it:

| Layer | Brick | Notes |
| --- | --- | --- |
| 🧠 Brain | [`SimpleModel`](../../packages/core/) / [`pi-model`](../../packages/extras/pi-model/) | OpenAI-compatible out of the box; ~40 providers (anthropic, google, local llama.cpp…) via PiAdapterModel |
| ✋ Hands (files) | [`basic-fs-tools`](../../packages/extras/basic-fs-tools/) *or* [`hash-fs-tools`](../../packages/extras/hash-fs-tools/) | Plain read/edit/write trio, or drift-proof hashline anchors + undo |
| ✋ Hands (shell) | [`shell-tool`](../../packages/extras/shell-tool/) | Windows-first bash: process-tree kills, tail-preserving output; plus glob |
| 🧹 Context | [`basic-compaction`](../../packages/extras/basic-compaction/) | Summarizes at 70% of the window; messages never deleted |
| 📚 Repo knowledge | [`agents-md-loader`](../../packages/extras/agents-md-loader/), [`rules-loader`](../../packages/extras/rules-loader/) | AGENTS.md discovery; cursor/.claude-style `.mdc` rules with globs |
| 🎓 Playbooks | [`skills`](../../packages/extras/skills/) | SKILL.md catalog in-prompt, bodies loaded on demand |
| 🌐 Ecosystem | [`mcp`](../../packages/extras/mcp/) | Existing MCP servers become native, namespaced tools |
| 🐝 Delegation | [`subagents`](../../packages/extras/subagents/) | Agents as tools, or a persistent managed family |
| 🔒 Safety | [`permission`](../../packages/extras/permission/) | Allow/ask/deny per tool; asks PARK the loop, crash-safe |
| 💾 Memory | [`base-storage`](../../packages/extras/base-storage/) | JSONL tape + state card; kill -9 mid-edit, resume exactly there |
| 😇 Watchdogs *(optional)* | [`loop-control`](../../packages/extras/loop-control/) | Doom-loop detection + turn budgets for unattended runs |
| 🗣 Vocabulary | [`inputs`](../../packages/extras/inputs/) | abort / stop / steer mid-turn / follow-ups — how humans steer live |

What you do **NOT** have to build: park/resume plumbing, crash-heal of half-run
tool batches, stream delta routing, filter ordering, restore replay, approval
audit trails. That's the core doing its job so bricks stay dumb.

---

## The assembly

One file. This is a real, complete coding agent — copy it:

```ts
// my-coding-agent.ts — a pi alternative in ~70 lines of wiring.
import { Agent, EVENTS, SimpleModel } from "@sanityloop/core";
import { createDefaultInputs } from "@sanityloop/inputs";
import { createEditTools } from "@sanityloop/hash-fs-tools";   // or basic-fs-tools
import { createBashPlugin, globTool } from "@sanityloop/shell-tool";
import { createTodoTool } from "@sanityloop/simple-todo";
import { createQuestionTool } from "@sanityloop/ask-question";
import { createCompaction } from "@sanityloop/basic-compaction";
import { createSkillsPlugin } from "@sanityloop/skills";
import { createAgentsMdLoader } from "@sanityloop/agents-md-loader";
import { createRulesLoader } from "@sanityloop/rules-loader";
import { createPermissions, askAll } from "@sanityloop/permission";
import { createReplPlugin } from "@sanityloop/repl";
import { jsonlSession } from "@sanityloop/base-storage";

// ── brain ──────────────────────────────────────────────────────────────
const model = new SimpleModel({
    modelId: "gpt-4o-mini",
    apiKey: process.env.OPENAI_API_KEY,
    stream: true,
    maxContext: 128_000,          // the compaction trigger reads this
});

// ── memory between runs ────────────────────────────────────────────────
const session = jsonlSession("sessions/coder");     // static folder = resume

// ── hands ──────────────────────────────────────────────────────────────
const editTools = createEditTools();                // { read, replace, undo }
const tools = [...Object.values(editTools), globTool];

// ── ecosystem: MCP servers → native tools ─────────────────────────────
const mcp = createMcp({
    github: { command: ["npx", "-y", "@modelcontextprotocol/server-github"] },
});
await mcp.init(15_000);

// ── the god object ─────────────────────────────────────────────────────
const agent = new Agent({
    model,
    agentId: "coder",
    description: "my own coding agent",
    tools,
    messages: [{
        id: "system",
        enabled: true,
        type: "system-compound",
        content: [
            { id: "agent.md", content: "You are a precise coding agent. Work in small verified steps." },
        ],
    }],
});
await session.restoreInto(agent);                  // crash? resume exactly there

// ── install the runtime: one line per capability ───────────────────────
agent.install(session.plugin);                     // the tape, from here on
agent.install(createDefaultInputs());              // steering vocabulary
agent.install(createBashPlugin());                 // the shell
agent.install(createTodoTool());                   // visible task lists
agent.install(createQuestionTool());               // model can ask YOU
agent.install(createCompaction());                 // survive long sessions
agent.install(createSkillsPlugin({ dirs: [".agents/skills"] }));
agent.install(createAgentsMdLoader());             // repo rules auto-load
agent.install(createRulesLoader());                // .mdc rules, glob-matched
agent.install(mcp.getPlugin());                    // MCP tools ready

// ── safety: ask before anything touches the world ──────────────────────
agent.install(createPermissions({
    rules: {
        paths: {
            mode: "workspace",                     // cwd ok; outside → ask
            blacklist: ["**/.env"],                // ALWAYS denied
        },
    },
    tools: {
        "*": { gate: askAll },         // broad posture first…
        read: { gate: null },          // …specific wins: reading is free
        replace: { gate: null },       // workspace policy handles paths
    },
}));

// ── the face (see next section) ────────────────────────────────────────
agent.install(createReplPlugin());

// ── go ─────────────────────────────────────────────────────────────────
console.log("=== my coder ===");
agent.run();
```

Run: `node --experimental-strip-types my-coding-agent.ts`. You now have an
interactive coding session that reads your AGENTS.md, edits files safely,
runs commands behind approval gates, loads skills, talks to MCP servers,
and survives a kill -9 mid-refactor.

---

## The face — three ways to surface it

The agent doesn't care what it looks like. UI is just a renderer over state
plus a door for inputs. Pick a tier:

### Tier A — ship the built-in REPL

`createReplPlugin()` gives you readline chat, ANSI markdown, streaming feedback,
and slash commands (`/help /status /plugins /tools /model /compact /clear /exit`).
Add your own commands in one option:

```ts
agent.install(createReplPlugin({
    prompt: "coder> ",
    commands: {
        deploy: (agent) => agent.input({ type: "input_followup", text: "Deploy the app." }),
        stats: (agent) => console.log(JSON.stringify(agent.stats, null, 2)),
    },
}));
```

### Tier B — improve / replace the REPL

The REPL is **not special** — it's a plugin like any other. Read its source
([`packages/extras/repl/index.ts`](../../packages/extras/repl/index.ts), one file):
it listens to `textDelta` filters, posts `input_followup`s, renders snapshots.
Copy it, rename it, reshape the prompt loop, add a micro-TUI, wire keybindings —
it's yours. The core never knows the difference.

### Tier C — your own UI over the state door

Install [`http-server`](../../packages/extras/http-server/) instead of (or next to)
the REPL and build any frontend you like. The entire protocol:

| Door | Verb | What |
| --- | --- | --- |
| `/input` | POST | the ONLY write door — send `{ type, ... }` inputs |
| `/control` | POST | `{ op: "stop" \| "abort" \| "pause" \| "wake" }` |
| `/getState` | GET | the live god object (`?keys=messages.state` picks) |
| `/awaits`, `/questions` | GET | parked permission asks & questions to answer |
| `/health` | GET | liveness |
| SSE + WebSocket | — | live deltas; WS ops: `input control getState awaits questions tools capabilities` |

A browser UI reads state, paints it, posts inputs. That's the whole contract —
same shape the REPL uses internally, which is why any channel (terminal, web,
another process, a swarm admin) can answer a parked permission identically.

---

## Delegation — sub-agents

Two modes, both from [`subagents`](../../packages/extras/subagents/):

**Mode 1 — agents as tools (one-shot):**

```ts
import { agentAsTool } from "@sanityloop/subagents";

const researcher = agentAsTool({
    name: "researcher",
    description: "Explores the codebase and reports findings. Read-only.",
    agent: () => new Agent({ model, agentId: "researcher", tools: [readTool] }),
});
tools.push(researcher);
```

Fresh pristine agent per call, runs to completion, final text comes back as the
tool answer. Perfect for focused one-shot jobs.

**Mode 2 — the agent-manager (persistent family):**

```ts
import { createSubAgents } from "@sanityloop/subagents";

const subs = createSubAgents({
    subs: [
        { id: "tester", description: "Runs the test suite, triages failures.", build: () => new Agent({ /* ... */ }) },
        { id: "fixer",  description: "Applies fixes for triaged failures.",    build: () => new Agent({ /* ... */ }) },
    ],
    concurrency: 4,                    // background slots; FIFO beyond
    // onPending: "escalate",           // child asks bubble up as proxy awaits
});
agent.install(subs);                   // adds sub_spawn / sub_await / sub_steer / sub_list

subs.instances();                      // host-side peek: who's running, what state
```

The parent spawns instances, steers them (`sub_steer`), collects results
(`sub_await`), lists the family portrait (`sub_list`). A child's parked question
never leaks raw into the parent — THE PENDING LAW wraps it
(`subagents/pending`), answered through one door regardless of depth.

---

## Taste checklist — make it YOURS

- **Different edit philosophy?** Swap `hash-fs-tools` for `basic-fs-tools`, or write your own `replace` — the schema is the only contract.
- **Stricter policy?** `permission.tools` is a sparse map with wildcards; point specific tools at `fsPathGate`, write async gates against your own policy engine.
- **Own prompts?** The system prompt is addressable fragments (`system-compound`) — rewrite any block at runtime, mid-session.
- **Different model per role?** Builders in sub-agents close over whatever model you hand them. Parent on Opus-class, subs on fast-and-cheap.
- **Unattended mode?** Add `loopControl({ doomLoop: {...}, maxTurns: {...} })` and swap REPL for quit-on-end — same wiring, batch shape.

Where to go next: the [mini-map](mini-map.md) for other shapes, the
[cookbook](cookbook.md) for deep recipes, the [extensions catalog](../reference/extensions.md)
for every knob.
