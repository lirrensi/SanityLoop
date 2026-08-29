---
node_type: reference
title: The Extensions Catalog — every @sanityloop package
status: active
updated: 2026-08-22
tags: [extras, catalog, reference, extensions, packages]
confidence: decided
links:
  depends_on: [/reference/api.md, /guides/packaging.md]
  documents: [/packages/extras/, /packages/swarm/]
  verified_by: [/verification/strategy.md]
sync_status: verified
last_synced: 2026-08-23
---

# The Extensions Catalog

Every ready-made Lego brick. Install only what you import — each extra is its
own npm package (`@sanityloop/<name>`, source-distributed TypeScript). The
core imports nothing here; delete any folder and the core still runs.

Wiring pattern is always the same:

```ts
import { createSomething } from "@sanityloop/something";
agent.install(createSomething({ /* opts */ }));
```

## Loop control & safety

| Package | Entry point | What it gives you |
| --- | --- | --- |
| `@sanityloop/permission` | `createPermissions(config)` | Per-tool allow/ask/deny gates over the core park. Sparse tool map (`"*"` → specific, last match wins), shipped gates (`allowAll`/`askAll`/`denyAll`/`fsPathGate` workspace+blacklist policy), classic choices (`once`/`session`/`no`/`no_explain`). Approvals + a capped denial audit live in `state.permission`. Answers arrive as input `{ type: "permission/answer", ref, answer }`. |
| `@sanityloop/inputs` | `createDefaultInputs()` | The default input vocabulary: `input_abort`, `input_stop`, `input_steer` (inserts after current tool batch), `input_followup` (inserts at landing), `request_clear` (hide history), `request_reset` (back to system-only). Install this or nothing turns inputs into messages. |
| `@sanityloop/loop-control` | `loopControl(opts)` | Watchdogs: doom-loop detection (repeated tool failures), max-turns budget. The doctrine says a strong model needs none of it. |
| `@sanityloop/keep-open` | `createKeepOpenPlugin()` | Keeps the loop breathing when it would otherwise settle (long-lived processes). |
| `@sanityloop/quit-on-end` | `createQuitOnEndPlugin()` | Exits the process when the agent lands idle (batch scripts). |

## Context & knowledge

| Package | Entry point | What it gives you |
| --- | --- | --- |
| `@sanityloop/basic-compaction` | `createCompaction(opts)` | Threshold-triggered context compaction; also answers `request_compact`. |
| `@sanityloop/compact-handover` | `createCompactHandover(...)` | Handover-style compaction — summarize and continue fresh. |
| `@sanityloop/skills` | `createSkillsPlugin(options)` | Skill folders (SKILL.md) loaded into context on demand. |
| `@sanityloop/rules-loader` | `createRulesLoader(opts)` | Loads rules files (incl. `.mdc` parsing) from disk into the system block. |
| `@sanityloop/agents-md-loader` | `createAgentsMdLoader(opts)` | AGENTS.md discovery + injection, opencode-style. |
| `@sanityloop/mcp` | `createMcp(config)` (`McpAdapter`) | Bridges MCP servers into native tools; undeclared tools fall back to name-based permission matching. |

## Tools (give the agent hands)

| Package | Entry point | What it gives you |
| --- | --- | --- |
| `@sanityloop/basic-fs-tools` | `createBasicTools(opts)` | Read/write/edit file tools with truncation guards. |
| `@sanityloop/hash-fs-tools` | `createEditTools(opts)` | Hash-addressed edit tools — precise, conflict-safe edits. |
| `@sanityloop/shell-tool` | `bashTool` / `createBashPlugin(opts)`, plus `globTool`, `echo` | Shell execution (Windows-first: resolves login shell/coreutils, kills process trees, accumulates output, truncates tail so errors survive). |
| `@sanityloop/simple-todo` | `createTodoTool()` | Task-list tool writing `state.todos` — observed, restorable. |
| `@sanityloop/ask-question` | `createQuestionTool(opts)` | The model asks the human a question: parks an await, any channel answers (`terminalAsk` included). |

## Observability & logging

| Package | Entry point | What it gives you |
| --- | --- | --- |
| `@sanityloop/observer` | `createObserverPlugin({ verbosity, write, logs })` | Prints the loop: lifecycle headlines (1), + stream/details (2). `logs: true` also catches the shared `log` channel and declared `log/*` events. |
| `@sanityloop/log-sink` | `createFileLog({ path })`, `createConsoleLog()` | Sinks for the shared log channel — JSONL with size rotation, or pretty console lines. Producers just `emitLog(...)` from util. |
| `@sanityloop/snapshot` | `agentSnapshot(agent)` | The light status card builder (used by storage cards and dashboards). |

## Persistence

| Package | Entry point | What it gives you |
| --- | --- | --- |
| `@sanityloop/base-storage` | `jsonlSession(path)` | Folder-backed sessions: append-only JSONL tape (`{t, change}` KeyChanges) + atomic `state.json` card. `restoreInto(agent)` replays baseline+deltas; parked awaits come back. Swap the tape backend by implementing the Storage contract. |

## Channels & UI

| Package | Entry point | What it gives you |
| --- | --- | --- |
| `@sanityloop/http-server` | `createHttpServer({ port, addr, apikey? })` | Elysia on Node: `POST /input` (the ONLY write door), `GET /getState` (+`?keys=` dotted picks), SSE stream + WS ops (`getState`/`awaits`/`questions`/...). Port 0 = random → real port lands in `state.http.port`. |
| `@sanityloop/repl` | `createReplPlugin(opts)` | Terminal REPL: readline chat, ANSI markdown, stream feedback, `/tools` `/model` `/compact` commands, auto-stats after each turn. The quick prototype surface. |

## Models & fleet

| Package | Entry point | What it gives you |
| --- | --- | --- |
| `@sanityloop/pi-model` | `PiAdapterModel` | Model adapter riding the pi provider library (multi-provider beyond OpenAI-compatible). |
| `@sanityloop/swarm` | `createSwarmServer()`, `wireSwarm()` / `createSwarmJoin()` | The dumb daemon hub + the join extension. Agents from anywhere join, report state, get commanded; `FleetApi` is the fleet-ops surface. Workers never belong to the hub — they answer to their own definition. |

## Utilities

| Package | What it gives you |
| --- | --- |
| `@sanityloop/util` | Shared helpers: `emitLog` + the `LOG_CHANNEL` convention (`log.ts`), truncation (`truncateHead`/`truncateTail`), `toolNames`/`toolAnswer`, `removeFiltersByPrefix`/`listFiltersByPrefix`, control-input constants (`requestCompactInput` etc.). Zero-policy, dependency-free glue. |

## The canonical stack (what the templates use)

```ts
import { Agent } from "@sanityloop/core";
import { PiAdapterModel } from "@sanityloop/pi-model";       // or SimpleModel
import { createDefaultInputs } from "@sanityloop/inputs";
import { createReplPlugin } from "@sanityloop/repl";
import { createPermissions } from "@sanityloop/permission";
import { jsonlSession } from "@sanityloop/base-storage";

const session = jsonlSession("sessions/my-agent");
const agent = new Agent({ model /* , tools, messages */ });
await session.restoreInto(agent);
agent.install(session.plugin);        // tape + card
agent.install(createDefaultInputs()); // input vocabulary
agent.install(createPermissions());   // gates
agent.install(/* your extras */);
agent.input({ type: "input_followup", text: "hello" });
```

See `templates/simple-agent.ts` and `templates/repl-agent.ts` at the repo
root for running examples.
