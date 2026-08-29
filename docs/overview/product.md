---
node_type: overview
title: Sanity — the agent loop and SDK that does not make you insane
status: active
updated: 2026-08-23
tags: [sdk, agent, doctrine]
confidence: decided
links:
  depends_on: [/ontology.md]
  documents: [/packages/core/src/core/v1/agent.ts]
  implemented_by: [/packages/core/src/core/v1/]
---

# Sanity

An agent loop and agent SDK that does not make you insane. And it is truly
yours — no opinion that holds you back.

## The Doctrine

These are the rules that never change. They are the reason the code looks the
way it does. If a recipe or a refactor ever fights one of these, the rule wins.

### 1. One entity, everywhere

The agent IS the god object. It is passed to every function — filters get
`(agent, event)`, tools get `(agent, params)`, models get `(agent)`. No
wrapper, no context object, no shadow surface. Every field and method is on
it: `agent.messages`, `agent.state`, `agent.pendingAwaits`, `agent.emit(...)`,
`agent.park(...)`, `agent.stop()`.

### 2. State is truth

Every write to the agent — any key, any depth — is observed by a Proxy,
becomes a `KeyChange`, and flows everywhere: `patched` events, the tape
(persistence), the dashboard. Write `agent.state.x = 1` and the whole system
reacts. You can pause, crash, and restore — state explains everything, at
every moment.

### 3. The core is two eternal clocks

Loop 1 (the signal supervisor) processes inputs and sets the literal `blocked`
flag; loop 2 (the worker) takes one step per beat when not blocked. Both are
`while(!terminated){ sleep; check }` — the sleeps are CPU breathers, nothing
more. THE LAW: no break, ever — flags (aborted/errored/stopped) change what
ticks DO (usually: nothing), nothing changes whether the loops run. The ONE
exception is `terminate()`: the off switch that stops the heartbeat and
resolves `run()` — for ephemeral agents and multi-agent hosts. Without it,
shutdown happens at the app layer.
Loop state is
derived fresh every beat. Everything else — input vocabulary, permissions,
guards, compaction, storage — is an extension.

### 4. The core imports nothing from extras

Dependency direction: extras → core ONLY. The extras folder can be deleted at
any time and the core still works. You never fork the core — you hang
extensions on it (composition), or you subclass it and override a `protected`
seam (the inheritance door — step, land, the loops; no fork, no side repo).

### 5. Everything is a Lego

A plugin is a named batch of registrations with a lifecycle
(`{ id, install(agent), uninstall(agent) }`). A filter is a WordPress-style
hook (`addFilter(event, id, priority, fn)`). A tool is a function that receives
the entity. 100 people can build and extend their own little thing without
forking the core — the cookbook is the proof and the test.

### 6. Awaits are plugin-owned

`awaiting` means "parked on pending awaits". The awaits are state — taped,
restored. Who resolves an await is the plugin's business: a human, a channel
input, or the plugin's own timer. Orphans are your bug, by design.

### 7. You are responsible

Last write wins. Filter conflicts are resolved by looking at the source and
adjusting priorities. Messages are never deleted — they are enabled/disabled.
Compaction is your strategy. The system has no opinion that holds you back;
it also has no safety net that hides your mistakes.

## Core Value

- An agent loop SDK where **the agent is a god object you modify at runtime** — any part, any time.
- **Truly yours**: no defaults that require a fork to change. Every class is a class you can override.
- **State is the truth**: crash anywhere, restore exactly where the state says you were.
- **Extensions → core, one direction**: build and ship your own pieces without touching the core.

## Main User Flows

1. **The embedder** — imports the core (`Agent`, `SimpleModel`, `Tool`), defines an agent in a single file, installs the extras they want, runs it. One node process.
2. **The extender** — writes a plugin (filters, tools, capabilities), installs it, uninstalls it cleanly. Ships it to other users without a fork.
3. **The operator** — runs sessions with persistence (`jsonlSession`), crashes, restores from the tape, watches the dashboard (`/getState`), parks on permission gates and resumes.

## System Shape

- **Core** (`packages/core/src/core/v1/`) — the Agent class (god object +
  the TWO CLOCKS: loop 1 the signal supervisor with the literal block flag,
  loop 2 the worker stepping one unit per beat), the filter bus
  (WordPress-style, awaited), the event contract, `SimpleModel`.
- **Extras** (`packages/extras/`) — optional plugins as their own workspace
  packages (`@sanityloop/<name>`): inputs, storage, compaction, permission,
  questions, rules loaders, http-server, observer, repl. Delete any of them;
  the core still runs. Catalogued in [/reference/extensions.md](/reference/extensions.md).
- **The swarm** (`packages/swarm/`) — the daemon hub + join extension: agents
  from anywhere report state and take commands without being owned.
- **The tape** — append-only `{t, change}` JSONL per session folder plus an
  atomic `state.json` card; restore = baseline + deltas.
- **The dashboard surface** — `/getState` over HTTP reads the live god object;
  the snapshot card summarizes it.

## Non-Goals

- No built-in opinions about prompts, models, or workflows — those are profiles, not the core.
- No forced storage, auth, or UI — those are extras or the daemon era, not the core.
- No protection from your own parallel tools or conflicting filters — that is your responsibility, by design.

## User Experience Principles

- **The user always sees the truth.** The snapshot card, `/getState`, `activity`, `currentEvent` — state explains what is happening, always.
- **The user never loses state.** Crash anywhere; the tape restores exactly where the state says you were.
- **The user never hits a wall.** Anything you want to change is a class to override or an extension to install — not a fork.

Licensed MIT — see [LICENSE](/LICENSE) at the repo root.
