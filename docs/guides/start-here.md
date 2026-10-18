---
node_type: guide
title: Start Here — the map, in reading order
status: active
updated: 2026-10-18
tags: [map, onboarding, reading-order]
confidence: decided
links:
  depends_on: [/overview/product.md]
  documents: [/packages/core/src/core/v1/]
  verified_by: [/verification/strategy.md]
---

# Start Here

Four ways in. Pick the route matching what you are doing — each is an **ordered**
path, and every page assumes the one before it. The library is deep; the order is
what makes it cheap.

| You want to… | Route | Time |
| --- | --- | --- |
| understand how the machine works | [1 — Understand](#route-1--understand-the-machine) | ~30 min |
| build an agent from scratch | [2 — Build](#route-2--build-an-agent) | ~15 min |
| bring an existing agent/app here | [3 — Adopt](#route-3--adopt-an-existing-agent) | ~1 h |
| change the SDK itself | [4 — Change](#route-4--change-the-sdk) | ~1 h |

Every route ends in the same place: one file you own, running headless.

## Route 1 — Understand the machine

Read in this order, no skipping. Each step says what to internalize.

1. [The doctrine — seven rules that never change](/overview/product.md).
   *Internalize:* one entity, state is truth, two eternal clocks, extras → core
   one direction, everything is a Lego, awaits are plugin-owned, you are
   responsible. If you remember one page, this is it.
2. [Core architecture — the god object and the two clocks](/architecture/core.md).
   *Internalize:* loop 1 drains inputs and owns the literal `blocked` flag; loop 2
   takes ONE step per beat; the step tree is derived from state, never remembered.
3. [The event contract](/reference/events.md). *Internalize:* 38 built-in events,
   two dispatch lanes (cycle queue vs registry), throw = skip + `handlerError`.
4. [The state model](/reference/state.md). *Internalize:* every write →
   `KeyChange` → `patched` → tape; restore = baseline + deltas; crash-heal,
   parked-not-healed.
5. [The public API](/reference/api.md). *Internalize:* the surface an extension
   author touches — `addFilter`, `install`, `input`, `park`, `emit`, the subclass
   seams.

**The code tour — five files are the truth** (`packages/core/src/core/v1/`):

| # | File | What it is |
| --- | --- | --- |
| 1 | [`types.ts`](/packages/core/src/core/v1/types.ts) | the vocabulary: `SessionData`, `GodObject`, `Plugin`, `Filter`, the event names |
| 2 | [`agent.ts`](/packages/core/src/core/v1/agent.ts) | the machine: the two loops, `blocked`, the step tree, park, terminate |
| 3 | [`filter-bus.ts`](/packages/core/src/core/v1/filter-bus.ts) | dispatch: async chains, cycle queues vs registry, the three commands |
| 4 | [`tool.ts`](/packages/core/src/core/v1/tool.ts) | the tool contract and the batch |
| 5 | [`simple-model.ts`](/packages/core/src/core/v1/simple-model.ts) | the model seam — swap the class, nothing else moves |

**Done check.** You are through this route when you can answer these without
opening a file:

1. What makes loop 2 take a step, and what freezes it?
2. Where does a write to `agent.state.x` land, and who hears it?
3. Why does a pending await park the loop instead of blocking it?
4. What happens to a tool call that was owed when the process crashed?
5. How do you remove one capability? (Delete one install line.)

## Route 2 — Build an agent

1. [The mini-map](/guides/mini-map.md) — pick the shape you are building
   (script, REPL, worker, daemon, coding agent, swarm). It routes you to the
   exact bricks.
2. [`templates/template-agent.ts`](/templates/template-agent.ts) — the annotated
   menu. Every block says *what it does, when you want it, how to remove it*.
   This is the file you copy and own.
3. [The cookbook](/guides/cookbook.md) — recipes for the awkward parts
   (sessions, permission gates, timers, activity feeds).
4. [The extensions catalog](/reference/extensions.md) — every brick with its
   entry point, grouped by what it gives the agent.

Run it: `node --experimental-strip-types my-agent.ts`. No engine, no CLI.

## Route 3 — Adopt an existing agent

You have an agent somewhere else — another harness, a homegrown loop, a chatbot
with tools — and want it here, as one file you own.

1. [Adopting — the migration map](/guides/adopting.md) — old concept → brick,
   the ordered checklist, and the four traps that cost the most time.
2. [The extensions catalog](/reference/extensions.md) — pick the bricks.
3. [The state model](/reference/state.md) — what persists, what the tape keeps.
4. [Packaging](/guides/packaging.md) — the repo is a monorepo; the packages are
   `@sanityloop/core` + `@sanityloop/extras`.

## Route 4 — Change the SDK

1. [Core architecture](/architecture/core.md) — the seams and the invariants you
   must not break.
2. [The verification strategy](/verification/strategy.md) — what "works" means
   here, and the gate (`npm run verify`).
3. [Releasing](/guides/releasing.md) — a push is inert; tags publish.
4. The repo-root `AGENTS.md` — operating rules (core API changes need the
   owner's sign-off; shell-spawning tests run in an isolated terminal).

## The map enforces itself

- `npm run docs:check` — frontmatter, links, orphans, coverage. It runs inside
  `npm run verify`, therefore in CI: a stale link fails the build.
- [`docs/ontology.md`](/ontology.md) — the rules this tree obeys (node types,
  typed links, absolute paths).
- `INDEX.md` files are generated. Never hand-edit them.
