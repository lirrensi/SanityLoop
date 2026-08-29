---
node_type: reference
title: The Public API — everything an extension author touches
status: active
updated: 2026-08-23
tags: [api, core, reference, extensions]
confidence: decided
links:
  depends_on: [/architecture/core.md, /reference/events.md, /reference/state.md]
  documents: [/packages/core/src/core/v1/types.ts, /packages/core/src/core/v1/agent.ts, /packages/core/src/core/v1/tool.ts]
  verified_by: [/verification/strategy.md]
sync_status: verified
last_synced: 2026-08-23
---

# The Public API

Everything in `@sanityloop/core` you touch to build tools, filters, plugins,
and model adapters. Verified against `packages/core/src/core/v1/`
(2026-08-22). Recipes for all of this live in [the cookbook](/guides/cookbook.md);
the ready-made building blocks are catalogued in
[the extensions catalog](/reference/extensions.md).

## Import surface

```ts
import { Agent, SimpleModel, Tool, EVENTS } from "@sanityloop/core";
import type {
  GodObject, Plugin, Filter, Input, Message, MessageStats,
  ModelContract, TurnResult, ToolResult, PendingAwait, PendingQuestion,
} from "@sanityloop/core";
```

`@sanityloop/core` resolves to the newest major; `@sanityloop/core/v1` pins
the frozen one (see [packaging](/guides/packaging.md)).

## GodObject — THE interface

Every filter, tool, and model receives the same live object. There is no
wrapper. It is `Session` (serialized state) plus the machinery:

### Session data (observed — every write → `KeyChange` → `patched`)

| Member | Type | Notes |
| --- | --- | --- |
| `id`, `agentId` | string | session identity (taped, restored, forkable) |
| `cwd` | string | working directory — first-class (`setCwd`) |
| `description` | string | what this agent does |
| `activity` | string | LIVE natural-language status — write via `setActivity()` |
| `model` | ModelContract | the adapter (swappable at runtime) |
| `messages` | Message[] | ID-addressable slots; never deleted, enabled/disabled |
| `stats` | Stats | tokens/cost/context totals (recomputed by `recordStats`) |
| `state` | Record<string, unknown> | the plugin playground — your keys, observed + taped |
| `transient` | Record<string, unknown> | tick memory + `currentEvent`. Observed, NEVER stored |
| `loopState` | `"idle \| running \| awaiting \| stopped \| aborted \| errored"` | closed — derived fresh each beat; `stopped` is transient (gentle stop in flight, lands to idle) |
| `runState` | string (open) | introspectable execution phase; extensions add their own |
| `pendingAwaits` | PendingAwait[] | the park — push to block the worker at the next wall |
| `pendingQuestions` | PendingQuestion[] | async asks — never gate the loop |
| `currentAction` | unknown | saved worker position while parked |
| `tools` | Tool[] | the live tool list |
| `currentTurn?`, `currentInput?` | — | what's in the pipeline right now |
| `lastResponse` | number | index of last provider-answered message — owed work derives from it |

Read-only observables: `hasWork`, `blocked` (the literal block flag — loop 1
owns it, loop 2 reads it), `inTurn`, `inFlight`, `ticks`, `tickPlan`,
`pendingInputs`, `plugins`.

### Registration surface

```ts
agent.addFilter(filter): this            // removeFilter(event,id) / disableFilter / enableFilter
agent.addTool(tool): this                // removeTool(name) · updateTool · disable/enableTool
agent.install(plugin): this              // uninstall(pluginId); duplicate id throws
agent.addDeclaredInput({id, schema})     // what a plugin ACCEPTS
agent.addDeclaredCapability({id, description})   // coarse identity (description REQUIRED)
agent.addDeclaredEvent({id})             // what a plugin PRODUCES
// each has remove*/list*/get* siblings
```

Ids are unique handles — duplicates throw loudly ("add once, delete once").
Installing a plugin whose `requires` is missing throws `PluginDependencyError`
before anything registers.

### Loop control (commands, not events)

```ts
agent.input(input)      // THE door — a PURE SIGNAL. Never starts a loop, never flips state.
                        // sync = drained by loop 1 under the block flag; async = fire-and-forget
agent.run()             // THE TWO CLOCKS — starts loop 1 + loop 2; resolves ONLY on terminate()
                        // (without it, the process is shut down at the app layer, e.g. process.exit)
agent.wake()            // pure "keep going" signal — sets wakeRequested, nothing else
agent.stop()            // GENTLE request — finish the step, land at the next boundary
agent.pause()           // GENTLE request — same family, land after the current message commits
agent.abort(reason?)    // HARD kill — controller aborted, beforeAbort → abort → terminal (heart keeps ticking)
agent.terminate(reason?) // THE OFF SWITCH — stops the heartbeat, run() RESOLVES; idempotent,
                        // fire-and-forget safe; await for a "corpse is cold" join point
agent.endCycle()        // veto: discard this cycle, run again (filters call it)
agent.park(awaitItem)   // push a pending await — loop 1 raises blocked, loop 2 parks
agent.emit(event, payload?, publish?)   // custom announcement (registry dispatch)
agent.setState(key, value) / setCwd(path) / setActivity(text)
agent.merge(fn)         // silent mass-write (restore/checkpoint) — ONE `merged` event
agent.onFilter(cb) / agent.onCycle(cb)  // meta-callbacks, NOT filters
```

## Filter — listen and mutate

```ts
agent.addFilter({
  event: EVENTS.beforeTool,   // any of the 38, or your own string
  id: "my-plugin/gate",       // unique across ALL events
  priority: 100,              // lower runs first
  fn: async (agent, event) => { /* mutate the god object; return value ignored */ },
});
```

Rules (enforced by the bus):

- **Async is the law** — `fn` is awaited end-to-end; filter N settles before N+1.
- **Mutate directly** — no return-merge; writes are observed instantly.
- **Throw = skip** — logged, `handlerError` fires `{ error, filterId, event }`,
  the queue always completes.
- **Children nest depth-first** — events fired inside a filter drain right
  after their trigger, before the next sibling (recursion capped at depth 32).

## Tool — the four boring blocks

```ts
const t = Tool.define({
  name: "read_file",
  description: "...",                    // what the MODEL reads
  inputSchema: { type: "object", ... },  // JSON Schema
  executionMode?: "sequential" | "parallel",
  disabled?: true,                       // non-destructive off-switch
  execute(params, agent) { return { answer, stored?, error?, errorMessage? } },
});
Tool.factory({ tool: someTool, prefix: "!!!" })  // pre-lock params merged into every call
```

The result contract: `answer` (string — what the model sees), `stored` (raw,
verbatim, never on the wire), `error: true` + `errorMessage` (failure as a
RESULT — the loop never dies from a tool). Return garbage and the core
synthesizes an error result telling the model it was a tool bug.

## Plugin — the named bundle

```ts
const kit: Plugin = {
  id: "my-kit",
  requires: ["inputs"],                  // optional — checked before install
  install(agent) { /* register under "my-kit/" ids */ },
  uninstall(agent) { /* REQUIRED — remove everything */ },
};
```

`install` may also be a **record of named steps** — a subclass can spread and
null individual steps instead of copying the body.

## ModelContract — one function

```ts
interface ModelContract {
  api: string; modelId: string; stream: boolean;
  maxContext?: number; temperature?: number; /* open runtime params */
  callNextTurn(ctx: GodObject): Promise<TurnResult>;
}
```

Return `{ message, stats, stopReason }`. Stream via
`ctx.streamSink?.emit({ type: "textDelta", delta })` — temporal-only events
loop 1 flushes every beat. `stats` is a flat `MessageStats`:
`{ input, output, cacheRead, cacheWrite, totalTokens,
cost: { input, output, cacheRead, cacheWrite, total }, ...provider extras }`.
`SimpleModel` covers OpenAI-compatible APIs; extend and override
`callNextTurn` or `prepareMessages` for anything else.

## Input — the universal envelope

```ts
{ type: "input_steer", text: "...", store?: boolean, async?: boolean, ... }
```

The core is type-blind: `type` is metadata, filters assign meaning. Sync
inputs drain through full chains in loop 1 (with the block flag raised, so
loop 2 stands down); `async: true` inputs never wake or block anything.
Default vocabulary lives in `@sanityloop/inputs` (`input_abort`, `input_stop`,
`input_steer`, `input_followup`, `request_clear`, `request_reset`) — there is
NO prompt type; a message-bearing input only becomes history because its
handler pushes it.

## Pending awaits & questions

```ts
{ type: "my-plugin/thing", id?: string, schema?: unknown, createdAt?: number }
```

Push onto `pendingAwaits` → loop 1 raises `blocked` → the worker parks at its
next checkpoint (`awaiting`), position saved in `currentAction`; the answer
clears the await (splice it), loop 1 drops `blocked`, and the next worker beat
resumes from where it stood. They are pure JSON — taped, restored.
`pendingQuestions` share the shape but never gate anything. Whoever creates
an await owns matching + resolving it.

## The preResolved contract

On a `ToolCallRecord`, `preResolved` means **the result is predetermined** —
a denial, a cached result, or crash-healing. `error` is a SEPARATE dimension:
a denial/heal sets `error: true`; a cache hit omits it. `executeOne`
short-circuits preResolved calls (no tool runs); the gate walk skips them;
the batch commits them synthetically — every call still matches a result.

## The override seam (the inheritance door)

Every meaningful machine method on `Agent` is `protected` — import the class,
extend it, override ONE seam, call `super` for the rest. No fork, no side repo.

- **Whole machine:** `loop1()` / `loop2()`
- **The pipeline:** `step()` / `providerStep()` / `batchStep()` /
  `executeToolBatch()` / `executeOne()` / `commitProviderResponse()` /
  `commitToolResult()`
- **Lifecycle:** `startTurn()` / `parkNow()` / `land()` / `fail()`
- **Derivation + chores:** `deriveLoopState()` / `drainInputs()` /
  `processInputSeq()` / `flushStream()` / `teardown()`
- **Helpers an override calls:** `hasWorkerWork()` / `owedResponse()` /
  `isTerminal()` / `parkBlocked()` / `openCycle()` / `closeCycle()` /
  `discardCycle()` / `errorFacts()`

The plumbing (observer/proxy, event internals) stays private. Versioning:
the public surface + these seams are semi-contractual — stable across minors,
changed only on a major.

## The declared registries (discovery without imports)

Three id-keyed Maps on the agent: **declared inputs** (Zod schema = the
promise), **declared capabilities** (coarse identity), **declared events**
(the 38 built-ins pre-loaded). They are the agent's contract surface — a
stranger UI or peer plugin reads them and trusts them. Producers declare,
consumers discover, nobody imports anybody (see how the log convention and
permission use this in [extensions](/reference/extensions.md)).
