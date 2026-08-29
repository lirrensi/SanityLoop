---
node_type: reference
title: The State Model — SessionData, the tape, restore
status: active
updated: 2026-08-23
tags: [state, restore, persistence, reference]
confidence: decided
links:
  depends_on: [/architecture/core.md]
  documents: [/packages/core/src/core/v1/types.ts, /packages/extras/base-storage/]
  implemented_by: [/packages/extras/base-storage/src/session.ts, /packages/extras/base-storage/src/jsonl.ts]
  verified_by: [/verification/strategy.md]
sync_status: verified
last_synced: 2026-08-23
---

# The State Model

Verified against `SessionData` in `packages/core/src/core/v1/types.ts` and
the base-storage extras (2026-08-23).

## SessionData — the observed container

Every field is observed by the Proxy. Every mutation → `KeyChange` → `patched`.

| Field | Type | Notes |
| --- | --- | --- |
| `id`, `agentId` | string | session + profile identity — taped, restored, forkable |
| `cwd` | string | the working directory — first-class, tools rely on it |
| `description` | string? | what the agent does — static, constructor-set |
| `activity` | string | the LIVE state string — natural language, plugin-written via `setActivity()` |
| `model` | ModelContract | the adapter |
| `messages` | Message[] | ID-addressable slots, never deleted — enabled/disabled |
| `stats` | Stats | tokens/cost/context, accumulated |
| `state` | Record<string, unknown> | the plugin playground — arbitrary JSON, observed, taped |
| `transient` | Record<string, unknown> | current tick's working memory + `currentEvent`. Observed, NEVER stored |
| `loopState` | LoopState | `idle \| running \| awaiting \| stopped \| aborted \| errored` — derived fresh every beat by loop 1; `stopped` is the transient gentle-stop-in-flight, never terminal |
| `runState` | RunState | open — many states, extensions can add |
| `pendingAwaits` | PendingAwait[] | the park — plugin-owned, taped, restored |
| `pendingQuestions` | PendingQuestion[] | async, never gate |
| `currentAction` | unknown | what's in flight at pause — serialized for resume |
| `tools` | Tool[] | the tool list |
| `tickPlan` | string[] | the last loop-1 beat's decisions — observable, never taped |
| `lastResponse` | number | index of the last answered message — owed work derives from it |

**Declared registries are NOT fields.** Inputs, capabilities, and events live
in code-side Maps (`addDeclaredInput/Capability/Event`). They never ride the
observer; the storage baseline tapes a snapshot of declared capabilities
under the key `"capabilities"` so restored sessions keep their promise card.

## The two state dimensions

- **loopState** — SMALL, CLOSED: what logic gates on. The loop transitions it.
- **runState** — MANY, OPEN: the introspectable truth. Extensions can add states.

The `hasWork` observable reads: owed response OR pending sync inputs OR
pending awaits. An `awaiting` loop with awaits pending reads "hungry" — by
design.

## The tape (persistence)

Append-only `{t, change}` JSONL — one line per restore-relevant KeyChange.
`TAPE_KEYS` whitelist (exact): `id, agentId, messages, state, stats,
loopState, pendingAwaits, pendingQuestions, currentAction, lastResponse,
capabilities, cwd, description, activity`. Ephemeral churn (`tickPlan`,
`runState`, `transient`) stays off-disk.

The first install on a fresh tape writes a BASELINE snapshot of these keys;
after that every matching `patched` change appends. The tape buffers appends
asynchronously — restore flushes first, so restore reads EVERYTHING written
so far.

## Restore — baseline + deltas

- `jsonlSession(dir).restoreInto(agent)` replays baseline + deltas,
  rebuilding the ENTIRE data layer via the KeyChange applier, applied
  silently (`merge`), ONE `merged` event announces it.
- The card (`state.json`) is atomic (tmp+rename) and screams on schema
  version mismatch; a torn card is ignored — the tape is the truth.
- Parked awaits come back — the plugin re-arms its own machinery (timers).
  Orphans are your bug, by design.
- **Crash-heal (at-most-once with healing):** a tape ending with an OWED
  toolCall and NO pending asks was a mid-batch crash. Restore marks every
  missing call `preResolved` as "not executed — process crashed before it
  ran"; calls whose results already committed are skipped by the batch. No
  side effect fires twice; the transcript stays whole; the model sees exactly
  what happened and self-corrects.
- **Parked restores are NOT healed:** the ask (permission is one use) was
  never answered — its side effect never ran in this process — so the question
  is RE-PRESENTED and the batch runs fresh after the answer.

## Crash anywhere

Crash, resume, and state explains exactly where you were: the loop, the
parked awaits, the in-flight action, the messages. `currentEvent` in
`transient` shows what was happening. That is the whole promise.
