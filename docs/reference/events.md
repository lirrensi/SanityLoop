---
node_type: reference
title: The Event Contract — 38 core events
status: active
updated: 2026-08-22
tags: [events, contract, reference]
confidence: decided
links:
  depends_on: [/architecture/core.md]
  documents: [/packages/core/src/core/v1/types.ts]
  implemented_by: [/packages/core/src/core/v1/types.ts]
  verified_by: [/verification/strategy.md]
sync_status: verified
last_synced: 2026-08-23
---

# The Event Contract

38 events, loop-emitted, guaranteed, versioned. The loop fires them in a
fixed order — that is what makes restore and "state is truth" work. Listen
with `addFilter({ event: EVENTS.x, ... })`. Announce your own with
`agent.emit("your/event", payload)`.

Verified against `EVENTS` in `packages/core/src/core/v1/types.ts`
(2026-08-22).

## Loop lifecycle (14)

| Event | When |
| --- | --- |
| `beforeAgentStart` | before the loop begins a turn — the assembly point |
| `agentStart` | the loop is alive |
| `agentEnd` | the run is over |
| `agentSettled` | the TRUE ending — fully landed (idle or awaiting), nothing happens until input |
| `turnStart` | one cycle's turn boundary (once per turn) |
| `cycleEnd` | one model round-trip completed (response committed, or tool batch committed) |
| `turnEnd` | the turn is done |
| `beforeStop` | about to land (parked or graceful) |
| `stop` | landed — channels latch on it |
| `beforeAbort` | about to abort |
| `abort` | hard kill — terminal |
| `beforeRunEnd` | the run is ending — the user's last-chance hook |
| `error` | a failure — carries rich `ErrorFacts` (`error`, `message`, `source`, `name`, `stopRequested`, `aborted` + adapter facts) |
| `handlerError` | a filter threw — `{ error, filterId, event }` |

## Input (2) — orthogonal to messages

| Event | When |
| --- | --- |
| `inputReceived` | an input arrived — the decision point (filters wear the hats) |
| `inputProcessed` | the input's side effects (and their KeyChanges) are observable |

## Messages (5) — the add lifecycle

| Event | When |
| --- | --- |
| `beforeMessageAdd` | before a message is inserted — modify-before-insert |
| `messageAdded` | after a message is inserted (model commits AND input-driven inserts) |
| `messageUpdate` | a message's content mutated (observer) |
| `messageRemoved` | a message removed via splice/pop/shift (observer) |
| `fragmentUpdate` | a compound fragment's block changed (observer) |

## Tools (6)

| Event | When |
| --- | --- |
| `beforeTool` | per-call gate — blocking wall; carries `{ batch, call, tool }` |
| `afterTool` | the patch point — rewrite the result before commit |
| `toolStart` | execution began |
| `toolUpdate` | a tool's DEFINITION changed (schema/description/disabled) |
| `toolEnd` | execution done |
| `toolListChanged` | the tool LIST mutated at runtime |

## Output stream (6)

`streamStarted`, `textDelta`, `textEnd`, `thinkingDelta`, `thinkingEnd`,
`toolcallDelta` — temporal-only (publish=false), riding the event payload.

## Provider boundary (2)

| Event | When |
| --- | --- |
| `beforeProviderRequest` | before spending money — blocking wall |
| `afterProviderResponse` | the response is in — the commit decision point |

## Generic (3)

| Event | When |
| --- | --- |
| `patched` | THE universal delta — every god-object key change |
| `merged` | a silent mass merge happened (restore/checkpoint) — re-read on it |
| `usage` | stats accumulated |

## The two dispatch paths

- **Cycle queue** (`bus.run`): mid-cycle events — the cycle's rebuilt, priority-sorted queues.
- **Registry** (`bus.runFromRegistry` / `agent.emit`): control events and custom announcements — reach every listener even outside a cycle (timers, install-time).

Chains are AWAITED end-to-end: filter N settles before N+1; an event fired
inside a filter drains depth-first right after its trigger (recursion capped
at depth 32). A filter throw never breaks the queue — it fires
`handlerError { error, filterId, event }` and the chain continues.

## Sealed-phase deferral

While the tool batch executes the transcript is SEALED. Events in the
deferral whitelist — `toolUpdate`, `toolListChanged` — fired mid-batch are
HELD in the lane and drain at the seams (`closeCycle` / `land`), after tool
results commit. Control/abort events are never deferred.

## Custom events

`agent.emit("compaction/start", { reason })` — WordPress `do_action`. Any
string; priority-ordered listeners; `publish` (default true) lands it in
`transient.currentEvent` → observed → visible live on the dashboard.
