---
node_type: guide
title: The Mini-Map — "I want to build…"
status: active
updated: 2026-08-23
tags: [minimap, router, recipes, guide]
links:
  depends_on: [/reference/extensions.md, /guides/cookbook.md]
sync_status: verified
last_synced: 2026-08-23
---

# The Mini-Map — "I want to build…"

You know *what* you want. Here's which bricks to grab and where to look next.
Everything is optional except the core; every extra installs with one line:

```ts
agent.install(createSomething({ /* opts */ }));
```

Deep recipes live in [the cookbook](cookbook.md); the full package catalog in
[the extensions reference](../reference/extensions.md). This page is just the router.

---

## Run shapes — what KIND of process am I building?

### 1. A one-shot script — run a task, print, die

**Grab:** core + [`inputs`](../../packages/extras/inputs/) + [`quit-on-end`](../../packages/extras/quit-on-end/)
**See:** [`templates/template-agent.ts`](../../templates/template-agent.ts) §5-B (active default there).
The process exits the moment the agent lands idle. Pipe stdin in, cron it, CI it.

### 2. An interactive terminal assistant

**Grab:** core + [`repl`](../../packages/extras/repl/) (+ everything else you want)
**See:** [`templates/repl-agent.ts`](../../templates/repl-agent.ts) — a full session composed
from plugins; the REPL itself is thin. Never combine with quit-on-end (opposites).

### 3. A cron / scheduled worker

**Grab:** shape 1 or 2 + [`loop-control`](../../packages/extras/loop-control/) watchdogs
**See:** the [timer/cron recipe](cookbook.md#how-do-i-build-a-timer--cron-loop) for a
self-scheduling loop whose schedule lives in state (crash-safe, re-armable on restore).

### 4. A long-lived daemon / service

**Grab:** core + [`keep-open`](../../packages/extras/keep-open/) + [`http-server`](../../packages/extras/http-server/)
**See:** shape 6 below for the remote-control surface. The loop breathes forever;
jobs come in as inputs, state tells you what it's doing right now.

### 5. Anything that must survive a crash

**Grab:** [`base-storage`](../../packages/extras/base-storage/) — that's it
**See:** the [session recipe](cookbook.md#how-do-i-build-a-session-persist--crash-restore).
`jsonlSession("sessions/name")` → same folder = resume semantics; `{uuid}` in the path =
fresh folder per run; skip storage entirely = memory-only. Parked awaits come back too.

---

## Capabilities — what can the agent DO?

### 6. A coding agent working in my repo

**Grab:** [`basic-fs-tools`](../../packages/extras/basic-fs-tools/) *or* the drift-proof
[`hash-fs-tools`](../../packages/extras/hash-fs-tools/) + [`shell-tool`](../../packages/extras/shell-tool/)
+ [`agents-md-loader`](../../packages/extras/agents-md-loader/) / [`rules-loader`](../../packages/extras/rules-loader/)
+ [`compaction`](../../packages/extras/basic-compaction/) + [`permission`](../../packages/extras/permission/)
**See:** [`templates/repl-agent.ts`](../../templates/repl-agent.ts) — this exact stack, wired.
**Or the full tour:** [Build Your Own Coding Agent](coding-agent.md) — every layer
(brain, hands, knowledge, safety, delegation) + how to pick the face: REPL vs your own UI.

### 7. My own tools (internal APIs, domain logic)

**Grab:** nothing — `Tool.define` from core
**See:** [how do I build a tool](cookbook.md#how-do-i-build-a-tool). One schema + one async
function; receives the whole agent; `answer` for the model, `stored` for your state.

### 8. Reuse existing MCP servers

**Grab:** [`mcp`](../../packages/extras/mcp/)
**See:** template §5-MCP block. Declare → `init()` → install the ready plugin.
Per-server failure degrades to `state.mcp.<name>.status`, never throws the boot.

### 9. Models beyond OpenAI-compatible (anthropic, local llama.cpp…)

**Grab:** [`pi-model`](../../packages/extras/pi-model/) — swap the class, nothing else moves
**See:** template §1 Options B/C. ~40 providers via pi-ai; point `baseUrl` at any
OpenAI-shaped endpoint for local models.

### 10. Human approval before dangerous actions

**Grab:** [`permission`](../../packages/extras/permission/) (gates) +
[`ask-question`](../../packages/extras/ask-question/) (the model asking YOU)
**See:** [the permission recipe](cookbook.md#how-do-i-build-a-permission-gate). An "ask"
parks the loop — crash-safe; any channel answers (`permission/answer` input).

### 11. Playbooks / skills loaded only when needed

**Grab:** [`skills`](../../packages/extras/skills/)
**See:** template §5-skills block. SKILL.md folders become a prompt menu + a `skill`
tool; bodies load on demand so the context stays lean.

### 12. Marathon sessions without blowing the context window

**Grab:** [`basic-compaction`](../../packages/extras/basic-compaction/) (summarize in place)
*or* [`compact-handover`](../../packages/extras/compact-handover/) (summarize → fresh start)
**See:** template §5-compaction block. Messages are never deleted — summarization is your
strategy; these are the two shipped strategies.

---

## Surfaces & scale — who talks to it, how many of them?

### 13. My web app drives the agent

**Grab:** [`http-server`](../../packages/extras/http-server/) (+ [`snapshot`](../../packages/extras/snapshot/) for status cards)
**See:** template §5-http block. `POST /input` is the ONLY write door; `GET /getState`
(+`?keys=` picks) reads live state; SSE streams deltas. Add `apikey` beyond localhost.

### 14. Eyes on it — logs, activity, dashboards

**Grab:** [`observer`](../../packages/extras/observer/) (console headlines) +
[`log-sink`](../../packages/extras/log-sink/) (JSONL w/ rotation) + shape 4's `/getState`
**See:** [activity feed recipe](cookbook.md#how-do-i-build-an-activity-feed). Producers
emitLog; sinks subscribe; neither knows the other.

### 15. Many agents — same process or across machines

**Same process:** [`subagents`](../../packages/extras/subagents/) — agents as tools
(`agentAsTool`, `createSubAgents`), parent delegates, sub results flow back as tool answers.
**Across machines:** [`swarm`](../../packages/swarm/) — dumb daemon hub + join extension;
workers spawn from their own files ([`templates/worker.ts`](../../templates/worker.ts)),
an admin commands the fleet ([`templates/admin.ts`](../../templates/admin.ts)).

---

*Missing your want? Every brick composes with every other — start from
[`templates/template-agent.ts`](../../templates/template-agent.ts), uncomment toward your goal,
and if you hit an awkward edge, that's an architecture bug: tell us.*
