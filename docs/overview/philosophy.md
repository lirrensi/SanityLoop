---
node_type: overview
title: Philosophy — why this exists and why it had to be easy
status: active
updated: 2026-08-22
tags: [philosophy, origin, sdk, ease]
confidence: decided
links:
  codifies_into: [/overview/product.md]
  documents: [/packages/core/src/core/v1/agent.ts]
---

# Philosophy — why this exists and why it had to be easy

This is the origin story: the "why", in plain text. The codified rules that
came out of it live in [the doctrine](/overview/product.md) — read that for
the contract, this for the reasons.

## The itch

Every agent framework I tried was limiting in the same way: I could not
define how *my* agent operates in a simple way. The framework had opinions —
about structure, about lifecycle, about what a "proper" agent looks like — and
the moment my needs disagreed with those opinions, the only way out was a
fork. Forking a framework to change one behavior is not extension; it is
surrender with extra steps.

So the requirement was never "another harness". It was: **compose an agent
from building blocks and run it** — the way you'd write any other program.
Define the model, the prompt, the skills, the tools, the MCP servers. Uncomment
what you need. Run the file. Done.

## The simple idea

An agent is a **single file**.

You import the core classes, define the parts, and start it. One Node process,
no engine around it. Because the definition exports itself, you can copy the
file into any folder, modify one piece — half a prompt, a single tool — import
it somewhere else, and it just works. The file IS the agent; owning the file
means owning the agent.

And because profiles are files, you can have infinitely many of them: a writer,
a coder, a tester — not just different prompts but entirely different tool
sets. Nothing ties your projects together through one global config that makes
every work life inseparable from the others.

## Easy means changeable, not configurable

"Easy" here does not mean more options. Options multiply until they become
their own framework. Easy means every part is *changeable in place*:

- Every module is a class. If you dislike how something works, you import the
  class, extend it, change the one method, and use yours instead. No default
  should ever require a hard fork to replace.
- Extension follows the WordPress lesson: a light core plus filters. Filters
  are hooks into every stage of the loop — `addFilter(event, id, priority, fn)`
  — and a plugin is just a named bundle of them with an install/uninstall
  lifecycle. Thousands of small hook points beat five grand ones.
- Everything flows through one object. The agent is a god object in the React
  sense: it holds the entire state, every hook receives it whole, and mutating
  any part of it changes what happens on the next tick. Change the messages —
  the next model call uses them. Swap a tool mid-session — the next cycle sees
  it. There is no shadow copy and no reconciliation step, because there is
  nothing to reconcile: the object is the truth.

The working goal this produced: **99% of what you'd want from a conventional
agent — coding agents, business automations, guards, compaction, permissions —
should be buildable without ever touching the core.** Forking the core is the
last resort, not the interface.

## What the early runs taught

The design earned its shape by being run, not by being specified:

- **State is truth survived contact.** Because every mutation lands on the
  observed object, you can pause, crash, or kill the process at any moment and
  the restored object explains exactly what was happening — including parked
  questions waiting for a human answer.
- **The core really could stay stupid.** Input turned out not to be a core
  concept at all — it is an extension with a vocabulary. Permissions became a
  pair of filters — one at the `beforeTool` wall, one answering at
  `inputReceived` — plus a parked await. Logging is a convention: producers
  emit onto a shared channel, sinks subscribe, neither knows the other. Each
  of these started as "this must be in the core" and each turned out to be Lego.
- **Concurrency fell out of the object.** Tool calls execute in parallel;
  filters always run sequentially by priority. No locks, because the worker is
  a linear awaited pipeline and a park is simply the worker not running.
- **Messages are never deleted.** They are enabled or disabled. Compaction is
  therefore *your* strategy — summarize and append, truncate outputs, disable
  history — instead of our opinion imposed on your context window.
- **The session is just text.** Persistence is an append-only JSONL tape of
  state changes. You can read it, diff it, replay it. No database required to
  understand your own agent.

## Where it is heading

Two directions follow from the same idea, both in progress rather than
promises:

- **The fleet.** Agents anywhere can join a swarm hub with one extension. The
  hub observes and coordinates, but it does not own them — an agent that joined
  still originated from its own file and answers to its own definition.
- **UI as a function of state.** Since the object explains everything, an
  interface is just a renderer over it — detachable, reattachable, replaceable,
  with no special protocol beyond reading state and posting inputs.

## What it became

The ease obsession crystallized into seven rules — one entity everywhere,
state is truth, a stupid loop, dependencies pointing one way, everything is
Lego, awaits owned by plugins, and you are responsible. They are written down
with their full consequences in [the doctrine](/overview/product.md).

If any recipe or refactor ever fights one of those rules, the rule wins —
because the rule is just this story, compressed.
