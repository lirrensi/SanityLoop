---
node_type: story
title: The Entity Refactor — how the promise became the type system
status: resolved
updated: 2026-08-16
tags: [story, refactor, architecture]
links:
  relates_to: [/architecture/core.md, /overview/product.md, /guides/cookbook.md]
---

# The Entity Refactor (2026-08-16)

## The promise

The original design was: **GOD OBJECT = AGENT = passed everywhere.** One
entity, full access, every field and method on it. "Any tool can modify any
key — `agent.messages`, `agent.state.meow`, `agent.<any method>`, `.emit(...)`."

## How it broke

The `Context` wrapper ("the box") was documented as *"the core object —
everything a filter needs"* but implemented as a **fresh bundle with the agent
inside** — snapshots for primitives, a thin `GodObject` interface that drifted
from the `Agent` class. Three symptoms, one root cause:

1. `ctx.loopState = "x"` silently did nothing (snapshot, not live).
2. `GodObject` lacked `bus`, `emit`, `park`, `setActivity` — so the type said
   "no" while the runtime had everything (interface drift).
3. Plugins couldn't fire events as a typed capability — only via `as any`.

The promises were leaking through the wrapper. The design wasn't wrong — the
box was.

## The fix

Deleted the box. `Filter.fn(agent, event)` — the whole entity + the facts,
mutate directly, no return-merge dance. `Context`/`makeContext` deleted.
`GodObject` = the full surface (bus, emit, park, setState, setCwd,
disable/enableFilter, onFilter/onCycle, run, runTurn, endCycle, currentTurn,
currentInput, setActivity). `agent.emit(name, payload)` — WordPress
`do_action`, registry dispatch, works outside cycles.

~26 files renamed, the core rewritten, `tsc` back to zero. The entity is now
structural: the type you receive IS the whole object.

## The cookbook caught a real bug

The cookbook (docs/guides/cookbook.md) was written as the architecture's exam.
First run: **`FAIL — restore replayed the tape`**. The tape buffers appends
asynchronously but `restore()` read the disk immediately — write → tick-flush
→ restore = empty tape. The "crash anywhere, restore everything" promise was
lying for the last few writes. Fixed in the API, not the recipe:
`restore()` flushes first. The exam then passed 11/11.

## Lesson

The cookbook is the test: if a recipe is awkward, the architecture is wrong —
fix the architecture, not the recipe. And docs written from memory lie the
moment the code moves: reference docs must be verified against `types.ts`,
never assumed.
