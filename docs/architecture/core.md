---
node_type: architecture
title: Core Architecture — the god object and the two clocks
status: active
updated: 2026-08-23
tags: [core, architecture, loop, observer, clock, blocked, worker]
confidence: decided
links:
  depends_on: [/overview/product.md, /reference/state.md, /reference/api.md]
  documents: [/packages/core/src/core/v1/]
  implemented_by: [/packages/core/src/core/v1/agent.ts, /packages/core/src/core/v1/filter-bus.ts, /packages/core/src/core/v1/types.ts]
  verified_by: [/verification/strategy.md]
sync_status: verified
last_synced: 2026-08-23
---

# Core Architecture

The whole system is ONE entity — the agent, the god object — plus the
machinery that observes it, derives work from it, and announces what happens
to it. The machinery is **two eternal clocks**: loop 1 (the signal
supervisor) and loop 2 (the worker). Both are `while(true){ sleep; check }`
loops, coordinated ONLY through a literal `blocked` flag and state derived
fresh every beat.

## The entity (the god object)

The `Agent` class IS the god object. It implements `GodObject` — `Session`
(serialized data) plus the full public surface: registration
(`addFilter`/`addTool`/`install`/declared registries), loop control
(`run`, `wake`, `input`, `stop`, `pause`, `abort`, `endCycle`,
`park`, `merge`, `emit`) and observables (`hasWork`, `blocked`, `inTurn`,
`inFlight`, `ticks`, `tickPlan`). The complete annotated surface lives in
[the API reference](/reference/api.md).

There is exactly one type. Filters receive `(agent, event)`, tools receive
`(params, agent)`, models receive `(agent)`. No wrapper, no shadow surface.
Every field is observed; every write cascades.

## The observer (state is truth)

A path-tracking `Proxy` wraps the whole data container (`SessionData`).
Every mutation — any key, any depth — emits a `KeyChange {key, path, op, value}`
O(1) at the moment of the set. No diff, no serialization. The traps queue
records + semantic events; `flushPendingEvents()` drains them at the logical
seams between beats. The lazy gate: nothing runs when nobody listens.

One mutation → one `KeyChange` → `patched` → tape/storage/dashboard/snapshot.
Message-level mutations route to semantic events inline at the trap:
`messageUpdate`, `fragmentUpdate`; array removers are patched so
`messageRemoved` carries the actually-removed ids. `merge()` writes silently
(restore/checkpoint) and announces once with `merged`.

## THE TWO CLOCKS

```
LOOP 1 — the signal supervisor          LOOP 2 — the worker
  while true:                            while true:
    await sleep(10)  ← CPU breather        await sleep(10)  ← CPU breather
    if sync inputs:                       if blocked: continue      ← LITERAL FLAG
      blocked = true                      if terminal: continue
      await each input (full chain)       if stop/pause: land
      blocked = false                     if no work: continue
    blocked = pendingAwaits.length > 0    startTurn (once per turn)
    deriveLoopState()                     park-checkpoint? → parkNow
    chores: teardown / flush-stream       one step(), then back to sleep
    flushPendingEvents()
```

- **The sleeps are CPU breathers, nothing more.** The awaits inside the loops
  are the real suspension. There is no step in the sleep — the clock just lets
  the event loop breathe.
- **THE LAW: no break, ever — except terminate().** A loop is a clock, not a
  decision-maker. Flags (`aborted`/`errored`/`stopped`) change what ticks DO
  (usually: nothing); nothing changes whether the loops run. Errors are flags
  too — `fail()` sets `errored` + runs cleanup chores, then the clock keeps
  ticking, silent, same as idle. The ONE exception is `terminate()`: the
  sanctioned off switch that stops the heartbeat itself, stamps `terminated`,
  and RESOLVES `run()` (ephemeral agents, multi-agent hosts).
- **`run()` is the only driver.** It starts both clocks
  (`Promise.all([loop1(), loop2()])`) and resolves only on `terminate()`.
  There is no second driver, no `runTurn`, no "settled" predicate — those died
  because a loop that must decide when to stop has to sample state, and every
  sample can go stale. An eternal clock never decides anything; only the
  explicit off switch ends it.
- **The literal `blocked` flag.** Loop 1 sets it; loop 2 reads it every beat.
  True while inputs drain OR pending awaits pin the worker. Observable via
  `agent.blocked`, never written by the worker itself.

### The state doctrine (derived fresh every beat)

`deriveLoopState()` runs in loop 1 and refreshes `loopState` from raw state:

| State | How it appears | Meaning |
| --- | --- | --- |
| `idle` | derived | the NATURAL CONCLUSION — never requested, what the loop is when exhausted |
| `running` | derived | a live cycle / owed work exists |
| `awaiting` | derived / `parkNow()` | pinned by pending awaits — the worker is blocked |
| `stopped` | derived, transient | a gentle stop request in flight — lands to `idle`, NEVER terminal |
| `aborted` | `abort()` | HARD terminal — controller killed, nothing survives, never overwritten |
| `errored` | `fail()` | HARD terminal — never overwritten |

The doctrine: `abort()` is the HARD stop (kills the AbortController — in-flight
model/bash/streams get the signal — clears the resume position, terminal).
`stop()`/`pause()` are GENTLE requests (a flag only — no controller, no stream
kill; the worker lands at the next natural boundary; observable as `stopped`
while landing). `idle` is never requested — it is just what the machine is
when there is nothing left to do.

## The worker step — ONE unit per beat

`step()` is the only "complicated" part of the machine. Called once per loop-2
beat, it makes ONE decision, does one unit of work, and returns
`"continue" | "parked" | "landed"`. It derives everything from state fields
(`phase`, `gateCursor`, `currentAction`, `cycleOpen`, `lastResponse`) — it has
**no memory of its own**, which is what makes crash-recovery and park/resume
work. The decision tree, top to bottom:

```
1. RESUME?         currentAction saved (parked earlier)?
                     awaits pending  → "parked" (stay frozen)
                     phase providerCall → providerStep()   // re-fire the wall FRESH
                     phase toolExec     → fall through to gates (cursor remembers)
2. STOP?           stop/pause requested → land(), "landed"
3. DISCARD?        a filter called endCycle() → discardCycle()
4. OUTSTANDING BATCH?   the last toolCall has calls not ALL committed yet
                     (covers fresh toolCalls AND crash-heal partial results)
                     → gates → batch (skip preResolved / already-committed calls)
5. NO WORK?        nothing owed → land(), "landed"
6. PROVIDER        providerStep() — the money path
```

`providerStep()`: the `beforeProviderRequest` wall (BREAKPOINT #1 — may park) →
`model.callNextTurn(this)` awaited directly (cooperative abort via
`ctx.abortSignal`) → `afterProviderResponse` (filters may `endCycle`) →
`commitProviderResponse` (COMMIT #1).

## The two breakpoints

1. **BREAKPOINT #1 — the commit.** After `afterProviderResponse`, the message
   is stamped `committedAt` and pushed; stats recorded (`usage` fires). Truth
   freezes here — the next API call sees new data. A `toolCall` message does
   NOT advance `lastResponse`: its results owe an answer first.
2. **BREAKPOINT #2 — the park.** At any wall (`beforeTool` per call,
   `beforeProviderRequest`) with pending awaits: save position
   (`currentAction = { phase }`), `parkNow()` fires the stop family once,
   transition to `awaiting`. Loop 1 sees the awaits → raises `blocked` → the
   worker sleeps. The answer arrives as an input → loop 1 drains it, a filter
   clears the await → `blocked` drops → the next worker beat resumes from the
   saved position. Gates re-run fresh for ungated calls, but `gateCursor`
   prevents re-asking answered gates — and calls that are `preResolved` (a
   denial, a cached result, crash-healing) skip the gate entirely.

### The preResolved contract

`preResolved` on a tool call means **the result is predetermined** — a denial,
a cached result, or crash-healing. `error` is a SEPARATE dimension: denial/heal
set `error: true`; a cache hit omits it. `executeOne` short-circuits
preResolved calls (no tool runs); the gate walk skips them; the batch commits
them synthetically. Every call still matches a result.

## The tool batch

Gates all pass (`gateCursor` reaches the end) → `batchStep()`: phase
`EXECUTING`, the sealed lane closes (`sealLock`), then:

- Any `executionMode: "sequential"` tool → the whole batch sequential; a
  stop/pause breaks between calls.
- Otherwise parallel exec (`Promise.all`), then SYNCHRONOUS sequential commit
  in call order.
- `executeOne`: preResolved → unknown tool → disabled tool → the real tool.
  A throwing tool becomes an ERROR RESULT (`error: true` + trace in `stored`)
  — never a thrown exception, the batch never dies.
- **The crash-heal rule:** a call whose result is already committed in history
  is DONE — the batch skips it (never re-run, never re-commit).

## Sealed-phase deferral (THE LANE)

While the tool batch executes, the transcript is SEALED for mutation. Events
in the deferral whitelist (`toolUpdate`, `toolListChanged`) fired mid-batch
are held in THE LANE and drain at the seams (`closeCycle`/`land`) — after
tool results commit, when the transcript is whole again. Control events are
never deferred.

## The filter bus (WordPress-style, awaited)

`FilterBus` is agent-injected and hands every filter `(agent, payload)`:

- **Async chains end-to-end** — filter N is fully awaited before N+1 starts;
  a gate may freely await remote policy engines while loop 1 keeps beating
  (inputs, UI, aborts stay live — loop 1 is never blocked by loop 2's work).
- **Children nest depth-first** — an event fired inside a filter drains right
  after its trigger, before the next sibling (recursion capped at depth 32).
- **Throw = skip + `handlerError`** — `{ error, filterId, event }`; the queue
  NEVER rejects, floating callers can't explode.
- **Cycle queues vs registry** — `beginCycle` rebuilds all queues fresh
  (registry − disabled); cycle events dispatch from the rebuilt queue,
  control events and `emit()` dispatch from the registry so they reach
  listeners ANY time (timers, install-time).
- **Three commands, three lifetimes** — `disable` (out of future queues),
  `enable` (back), `remove` (gone from the record). Filter ids are unique
  across ALL events — duplicates throw at `addFilter`.
- Meta-callbacks (`onFilter`, `onCycle`) watch the machinery without being
  filters; `onCycle.start` is the whole-queue reorganization point.

## The lifecycle of one turn

1. Input arrives through `agent.input` (the only door, a pure signal — it
   never starts a loop and never flips state; if no clock is running the
   signal sits in the queue until a host starts `run()`). Sync inputs drain
   in loop 1 with `blocked` raised — each through its FULL chain. The core is
   type-blind; filters wear the hats.
2. Loop 2 sees work (owed response) → `startTurn` (once per turn) → open
   cycle → `beforeProviderRequest` (blocking wall) → provider call →
   `afterProviderResponse`.
3. COMMIT #1: `beforeMessageAdd` → push → `messageAdded` → `usage`. A
   `toolCall` leaves the batch owed (`lastResponse` holds).
4. GATING: per-call `beforeTool` walls with `gateCursor`. A filter parks an
   ask → BREAKPOINT #2. All calls gated (or preResolved / already committed)
   → the batch executes.
5. Per call: `toolStart` → execute → `afterTool` (patch point) → push result
   → `toolEnd`.
6. `cycleEnd` → close cycle → the machine decides: more work, or land.
7. Landing: `turnEnd` → `beforeStop` → `stop` → `agentEnd` → `beforeRunEnd`
   → `agentSettled` (the true ending: nothing happens until input).

## The parking model + crash-heal

`awaiting` = parked on pending awaits. The awaits are state — taped,
restored. Resume = the matching resolver (human input, channel, plugin timer)
removes the await; loop 1 drops `blocked`; the next worker beat resumes.

**Crash semantics — at-most-once with healing** (the CRASH HEAL, lives in the
storage restore): if the tape ends with an OWED toolCall and NO pending asks
(mid-batch crash), the tools that never ran must NOT auto-execute on resume.
The restore marks every missing call `preResolved` as an error
("not executed — process crashed before it ran"); calls whose results already
committed are skipped by the batch. The transcript stays whole (call ↔ result
1:1), no side effect fires twice, and the model sees exactly what happened and
self-corrects.

**The PARKED case is deliberately NOT healed.** The ask is a general QUESTION
(permission is one use). Its answer was never seen by anyone — the side effect
it would have triggered never ran in this process — so the question is
RE-PRESENTED and the batch runs fresh after the answer.

## The command doors vs events

`stop()` soft (gentle request), `abort()` hard (terminal), `pause()`, `wake()`
(pure signal — sets `wakeRequested` only), `endCycle()`, `park()`, `input()`
(signal only) — these drive the loop. `blocked` is the observable flag loop 1
owns. Events are announcements; you listen to them. Custom announcements go
through `emit()`.

## Declared registries & dependency guard

Three id-keyed Maps — declared inputs (Zod schema), declared capabilities
(id + required description), declared events (the 38 built-ins pre-loaded).
They are the agent's promise surface: producers declare, consumers discover,
nobody imports anybody. Plugins may declare `requires`; installing with a
missing dependency throws `PluginDependencyError` before anything registers.

## Extensions → core, one direction

The core (`packages/core/src/core/v1/`) imports nothing from extras. Plugins
hang off the entity: filters, tools, capabilities, state. There are TWO
extension doors, no fork:

1. **Composition (99%)** — the filter bus, plugins, declared registries,
   custom tools/models/inputs. Build anything by adding behaviors; the core
   never changes.
2. **Inheritance (the override seam)** — every meaningful machine method is
   `protected`: `loop1`/`loop2` (the whole machine shape), `step`/`providerStep`/
   `batchStep`/`executeToolBatch`/`executeOne`/`commitProviderResponse`/
   `commitToolResult` (the pipeline), `land`/`parkNow`/`startTurn`/`fail`
   (lifecycle), `deriveLoopState`, `drainInputs`/`processInputSeq`, the chores.
   Import the class, extend it, override ONE seam, call `super` for the rest.
   The plumbing (observer/proxy, event internals) stays private.

The ready-made bricks are catalogued in [extensions](/reference/extensions.md).