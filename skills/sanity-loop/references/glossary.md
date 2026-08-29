# Glossary — the SanityLoop Lego shelf

Everything is optional except the core; every extra is its own package
(`@sanityloop/<name>`), installed only if imported. Wiring is always:

```ts
agent.install(createSomething({ /* opts */ }));
```

## The core — `@sanityloop/core`

| Piece | What it is | Wire |
| --- | --- | --- |
| `Agent` | The god object. Holds all state; every filter, tool, and model call receives it whole. Mutate any part, next tick reflects it. | `new Agent({ model, agentId, tools, messages })` |
| Two eternal clocks | Loop 1 supervises signals (inputs set a literal `blocked` flag), loop 2 takes one step per beat. Flags change what ticks *do*, never whether loops run. | (internal) |
| Filter bus | WordPress-style hooks at every stage of the loop. **This is how you write custom hooks.** | `agent.addFilter({ event, id, priority, fn })` |
| `SimpleModel` | OpenAI-compatible model wrapper, streaming. Swap guts without touching the contract. | `new SimpleModel({ modelId, apiKey, baseUrl, stream, maxContext })` |
| `Tool` | Define tools as plain functions that receive the agent. | `Tool.define({ name, description, inputSchema, execute })` |
| `EVENTS` | `beforeTool`, `afterTool`, `textDelta`, `inputReceived`, `stop`, … the whole loop is observable and hookable. | `agent.addFilter({ event: EVENTS.afterTool, ... })` |

## Run shapes — what KIND of process?

| You want… | Grab | Wire |
| --- | --- | --- |
| One-shot script — run, print, die | `@sanityloop/quit-on-end` | `createQuitOnEndPlugin()` |
| Interactive terminal chat | `@sanityloop/repl` | `createReplPlugin()` — never pair with quit-on-end |
| Batch / unattended with safety | `@sanityloop/loop-control` | `loopControl({ maxTurns, doom })` + `loopControlGuard` |
| Long-lived daemon / service | `@sanityloop/keep-open` | `createKeepOpenPlugin()` |
| Survive a crash / resume sessions | `@sanityloop/base-storage` | `jsonlSession("sessions/name")` → `restoreInto(agent)` + install `session.plugin` |
| Memory-only (no persistence at all) | *(nothing)* | skip storage entirely |

`jsonlSession` semantics: fixed folder = resume each run; `{uuid}` in the
path = fresh folder per run; skipped = memory-only.

## Capabilities — what can the agent DO?

| You want… | Grab | Wire |
| --- | --- | --- |
| Raw inputs to mean something | `@sanityloop/inputs` | `createDefaultInputs()` — every agent needs it |
| Quick file read/write/edit | `@sanityloop/basic-fs-tools` | `createBasicTools()` → `{ read, edit, write }` |
| Precise, drift-proof edits | `@sanityloop/hash-fs-tools` | hash-addressed replacements; set the hash store |
| Shell execution + glob (Windows-first) | `@sanityloop/shell-tool` | `createBashPlugin()`, `bashTool`, `globTool` |
| Task list surviving crashes | `@sanityloop/simple-todo` | `createTodoTool()` |
| Model needs a human decision | `@sanityloop/ask-question` | `createQuestionTool()` — parks an await, any channel answers |
| Playbooks / SKILL.md skills, loaded on demand | `@sanityloop/skills` | `createSkillsPlugin({ dirs: [".agents/skills"] })` |
| Rules files (incl. `.mdc`) into the system block | `@sanityloop/rules-loader` | `createRulesLoader()` |
| AGENTS.md discovery + injection | `@sanityloop/agents-md-loader` | `createAgentsMdLoader()` |
| Existing MCP servers as native tools | `@sanityloop/mcp` | `createMcp({ name: cfg })` → `await mcp.init(15_000)` → `agent.install(mcp.getPlugin())` |
| Models beyond OpenAI-compatible (anthropic, local llama…) | `@sanityloop/pi-model` | swap the model class — nothing else moves |
| Marathon sessions without blowing context | `@sanityloop/basic-compaction` *or* `@sanityloop/compact-handover` | `createCompaction({ threshold })` (summarize in place) vs `createCompactHandover()` (summarize → fresh start) |
| Admin isolates a sandbox | `@sanityloop/sandbox` / `sandbox-docker` | see `templates/sandboxed-agent.ts` |

## Safety — gates & approvals

| You want… | Grab | Wire |
| --- | --- | --- |
| Allow/ask/deny gates on real side effects | `@sanityloop/permission` | `createPermissions({ gates })` with `askAll`, `allowAll`, `denyAll`, `fsPathGate`; approvals park the loop (`PERMISSION_AWAIT`), any channel answers (`PERMISSION_ANSWER`) |

Risky side effects need runtime policy — prompt text is not enforcement.

## Surfaces & scale — who talks to it, how many of them

| You want… | Grab | Wire |
| --- | --- | --- |
| Web app / anything remote drives it | `@sanityloop/http-server` | `createHttpServer({ port, apikey })` — `POST /input` is the only write door; `GET /getState` reads live state; SSE streams deltas |
| Eyes on it — console headlines | `@sanityloop/observer` | `createObserverPlugin()` |
| Real structured logs, rotation | `@sanityloop/log-sink` | `createFileLog()`, `createConsoleLog()` |
| Status cards / dashboards over live state | `@sanityloop/snapshot` | `agentSnapshot(...)` |
| A terminal TUI | `@sanityloop/tui` | see `templates/` / package README |
| Agents as tools (same process) | `@sanityloop/subagents` | `agentAsTool(...)`, `createSubAgents()` — parent delegates, results flow back as tool answers |
| Many agents, many machines | `@sanityloop/swarm` | workers join a daemon hub from their own files (`templates/worker.ts`); `templates/admin.ts` commands the fleet |
| Shared glue: log channel, truncation, filter helpers | `@sanityloop/util` | `toolAnswer`, `truncateHead/Tail`, `removeFiltersByPrefix` … |

> Beyond the menu: `packages/extras/` also holds `loops`, `powergoal`,
> `ram`, `runlog`, `sandbox-docker`, `tui` — newer bricks. Check the
> package README before wiring; if they feel raw, say so to the user.

## Requirement phrase → blocks (the router)

| User says… | Blocks |
| --- | --- |
| "watch my folder and email me" | `inputs` + `basic-fs-tools`/`hash-fs-tools` + your own `Tool.define` (email) + `loop-control`/`keep-open` + `permission` if it sends externally + `base-storage` if it must survive restarts |
| "coding agent in my repo" | `basic-fs-tools` *or* `hash-fs-tools` + `shell-tool` + `rules-loader`/`agents-md-loader` + `basic-compaction` + `permission` — see `templates/repl-agent.ts` |
| "copilot for my product team" (skills/playbooks) | `skills` + `inputs` + your domain tools |
| "runs nightly from cron, writes a report" | `quit-on-end` + `base-storage` (or not) + custom tool(s) — wrap in `loop-control` if unattended |
| "my web app shows a live agent" | `http-server` + `snapshot` + `inputs` + `keep-open` |
| "agents that coordinate across machines" | `swarm` + `inputs` + `base-storage` per worker |
| "I want to sell it as an agent that provisions itself" | single-file agent + `ask-question` (first-run key prompt) — see README Pattern 1 |
| "survive crashes" | `base-storage` — that's it |
| "ask me before doing anything scary" | `permission` (+ `ask-question` when the MODEL needs to ask you) |

## The file — a portable shape

The deliverable is one portable `.ts` file you can copy and run with
`node --experimental-strip-types my-agent.ts` — no setup. A 'template' is just
its starting shape.

- Landing decisions as **`process.env.X ?? default`** — model id, base url,
  folders, api keys. **Never hardcode local paths, drive letters,
  usernames, or machine names.**
- Extras as **commented, annotated blocks** — *what it does, when you want
  it, how to remove it* — so the user uncomments their way to an agent.
- Keep the skeleton identical (model → session → tools → plugins → filters
  → run) so one template teaches all of them.
- Point at `templates/template-agent.ts` as the master menu.

## Informative errors — the house convention

When an agent fails, both the HUMAN and the MODEL must be able to tell
*what* failed, *where*, and *why* — without grepping. Every error message
follows one template:

```text
[pkg] <what> "<id>" <conflict or failure> — <why / what to do>
```

Rules that never bend:

- **Never log secrets** — apiKey, tokens, auth headers. Provider errors
  say *model* and *endpoint*, never the key.
- **Truncate the loud parts** — provider body capped at ~400 chars with a
  `…[truncated, N chars total]` marker; SSE snippets at ~120 chars.
- **Stamp structured facts** on thrown errors for the core's `errorFacts`
  (forwarded verbatim on `EVENTS.error`): `code`, `status`, `reason`,
  `retryable`, `truncated`. `errorFacts` picks these up for free.
- **Aborts vs failures** — a control stop (aborted) is not a tool failure;
  keep the structural signal, enrich the message.
- **Runtime policy, not prose** — an error message never replaces a
  permission gate.
- **No silent skips** — if a stream/tape/parse must tolerate bad input
  (malformed SSE chunk, torn JSONL tail), warn ONCE with context and
  count the rest silently.
- **Extras log through `emitLog(agent, level, source, message, data)`**
  (channel `log`); sinks subscribe once and catch everyone. Core stays
  dependency-free and uses `console.*` directly — never import `emitLog`
  into core.

