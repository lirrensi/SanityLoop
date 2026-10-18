---
node_type: guide
title: Adopting — migrating an existing agent onto SanityLoop
status: active
updated: 2026-10-18
tags: [migration, adoption, onboarding, guide]
confidence: decided
links:
  depends_on: [/guides/start-here.md, /reference/extensions.md, /reference/state.md, /reference/api.md]
  documents: [/packages/core/src/core/v1/]
  verified_by: [/verification/strategy.md]
---

# Adopting — from their agent to your file

The target state: **one file you own** that imports `@sanityloop/core` plus the
extras you choose, and runs as a plain script. Nothing else — no engine, no
config directory, no framework runtime.

Migration is not a port of your old abstraction layer; it is a **deletion** of
it. The old harness's config, plugin loader, retry policy, and session manager
are replaced by lines in that file. Port the *behavior*, not the machinery.

## The map: old concept → the brick that replaces it

| You have | Here | How it appears |
| --- | --- | --- |
| model client / SDK wrapper | `SimpleModel` (OpenAI-compatible) or `PiAdapterModel` (multi-provider) | constructor |
| system prompt (one string) | a `system-compound` message made of addressable fragments | `messages: [{ id: "system", type: "system-compound", content: [...] }]` |
| rules / AGENTS.md injection | `rules-loader` / `agents-md-loader` | `agent.install(...)` |
| function calling / tools | `Tool.define({ name, description, inputSchema, execute })` | `tools: [...]` |
| MCP servers | `createMcp(config)` → `await init()` → `getPlugin()` | `agent.install(mcp.getPlugin())` |
| skills / playbooks | `skills` — SKILL.md folders, bodies loaded on demand | `agent.install(createSkillsPlugin({ dirs }))` |
| chat history / sessions | `base-storage` — JSONL tape + atomic state card | `jsonlSession(dir)` + `restoreInto(agent)` + `install(session.plugin)` |
| approval prompts | `permission` (gates) + `ask-question` (model asks you) | install lines |
| steer / abort / stop / follow-up | `inputs` — the input vocabulary | `agent.install(createDefaultInputs())` |
| retries / loop guards / turn budget | `loop-control` watchdogs (opt-in paranoia) | `agent.install(loopControl(...))` |
| context compaction | `basic-compaction` or `compact-handover` | install line |
| streaming to a UI | `EVENTS.textDelta` filter, or `http-server` SSE | `agent.addFilter(...)` |
| CLI chat | `repl` | `agent.install(createReplPlugin(...))` |
| process lifecycle | `quit-on-end` (batch) / `keep-open` (daemon) | one install line |
| sub-agents | `subagents` — agents as tools | `createSubAgents(...)` |
| many machines | `swarm` — dumb hub + join | `wireSwarm(...)` |

Every brick, with entry points and caveats: [the extensions catalog](/reference/extensions.md).
The worked example to copy: [`templates/template-agent.ts`](/templates/template-agent.ts).

## The ordered checklist

1. **Pick the model seam.** `new SimpleModel({ modelId, apiKey, stream: true })`
   for anything OpenAI-shaped; `new PiAdapterModel(...)` for other providers.
   Swapping later touches nothing else.
2. **Seed the system prompt as fragments.** A `messages` entry of type
   `system-compound` with named blocks. Fragments are addressable — you (or
   `agents-md-loader`) can rewrite one mid-session.
3. **Declare the tools.** One `Tool.define` per capability: name, description,
   JSON schema, one async function. `execute` receives the params plus the agent.
4. **Wire persistence — restore, then install.** `jsonlSession(dir)` returns the
   session; `await session.restoreInto(agent)` replays the tape into the fresh
   agent; *then* `agent.install(session.plugin)`. That is the order every
   template uses and the one the crash tests exercise.
5. **Install `inputs`.** Without it `agent.input()` is a signal nobody speaks.
6. **Gate what touches reality.** `permission` allow/ask/deny per tool; an
   "ask" parks the loop until an answer arrives as an input.
7. **Pick the process shape.** One-shot → `quit-on-end`; daemon →
   `keep-open` (+ `http-server` if it needs a remote door); human chat → `repl`.
8. **Add eyes only if you need them.** `observer` while developing,
   `log-sink` in production, `snapshot` for status cards.
9. **Run it as a script.** `node --experimental-strip-types my-agent.ts` — no
   build step required. Bundle later if you want to ship it.
10. **Delete the old layer.** The previous SDK's config loader, plugin
    registry, and wrapper types are now dead code. Deleting them is the
    migration; keeping them "for parity" is how two systems drift.

## The four traps

1. **Inputs are an extension, not a core behavior.** The core is type-blind: it
   parks and wakes on raw signals. `createDefaultInputs()` is what turns
   `input_abort`, `input_stop`, `input_steer`, `input_followup`,
   `request_clear`, `request_reset` into messages. Install it or control inputs
   do nothing.
2. **Restore before installs.** Replay is silent (one `merged`), and it lands in
   an empty machine — plugins should start from the restored truth, not from an
   agent that was half-built when the tape arrived.
3. **A pending await freezes the worker — that is the design.** An approval is
   not a callback: it parks the loop, the tape records it, and the answer
   arrives as an input (`{ type: "permission/answer", ref, answer }`). On
   restart the question is re-presented, not silently healed.
4. **Nothing is on by default.** The core imports no extras. If your old
   harness auto-loaded everything, here an uninstalled capability is simply
   absent — no config flag, no hidden default.

## Done when

- the file runs headless (`node --experimental-strip-types my-agent.ts`);
- kill the process mid tool-batch, restart: the transcript is whole, no tool
  re-ran, the model sees the crash note;
- a denied tool never executes, and the loop says why;
- the session folder holds the `{t, change}` tape plus `state.json` — crash,
  restore, and state explains exactly where you were.

## Not on this page

- npm packaging / bundling: [packaging](/guides/packaging.md)
- writing a plugin or overriding a core seam: [the API reference](/reference/api.md)
- the full brick catalog: [the extensions catalog](/reference/extensions.md)
- the reading order for the machine itself: [Start Here](/guides/start-here.md)
