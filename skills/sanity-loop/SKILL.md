---
name: sanity-loop
description: >
  Use this skill when the user wants an agent built on demand with the
  SanityLoop framework — from a requirement list OR a vague idea — ending in
  ONE portable file they can copy anywhere and run with node. Trigger on
  "build me an agent", "make me an agent that...", "I want an agent for X",
  "how do I build an agent", "scaffold me an agent", vague requests
  ("you explain it / you build it"), requirement lists, or picking which
  SanityLoop packages an agent needs. Produces the single agent file, wired
  from SanityLoop blocks, driven by a glossary of the Lego pieces and a
  questionnaire that surfaces what the user asked for AND what they forgot.
metadata:
  version: "1.1.0"
  scope: "sanityloop-agent-builder"
---

# SanityLoop — build the agent file, on demand

The deliverable is **ONE FILE**. Not a framework, not a project structure,
not a language, not a twisty template system — a port:

```ts
// the whole agent, in one file
import { Agent, SimpleModel, EVENTS, Tool } from "@sanityloop/core";
// ...wire the blocks you need...
agent.run();
```

Run it anywhere node exists:

```bash
node --experimental-strip-types my-agent.ts
```

No engine, no CLI, no global install. Copy it to another machine, cron it,
CI it, `npx your-org/my-agent` it — the file carries itself. A "template"
here is just the *starting shape* of that file; the file is the point, and
it is portable by construction.

SanityLoop is a Lego shelf. The skill's job: turn a user's wants into that
file — fast when they know what they want, by asking the right questions
when they don't. Everything is optional except the core; every extra
installs with one line:

```ts
agent.install(createSomething({ /* opts */ }));
```

## Two cases — route first

### Case 1 — "I want this" (requirements given)

The user hands you a description or a list: *"an agent that watches my
folder and emails me"*, *"a coding agent in my repo"*, *"a swarm of workers
on cron"*.

1. Read [`references/glossary.md`](references/glossary.md) and map every
   requirement to blocks. Requirement phrase → blocks is a direct table lookup.
2. Write the **single file** (see [Anatomy](#anatomy-of-the-file)) with
   exactly those blocks wired, config via env vars — **never hardcode local
   paths or usernames**.
3. Run the **gap-check pass** from
   [`references/questionnaire.md`](references/questionnaire.md): before
   declaring done, ask about the common components the user did *not*
   mention (compaction, permissions, storage, interaction surface…). If a
   gap matters, offer it, wire it, or leave it as a commented option in the
   file with a one-line note.

### Case 2 — "I don't know, you explain it / you build it" (vague)

The user has no requirement list, or wants you to propose.

1. Run the **elicitation questions** from
   [`references/questionnaire.md`](references/questionnaire.md) — but only
   enough to shape the loop: domain, autonomy, interaction surface, storage,
   risk. State assumptions openly when the user says "you decide".
2. Default to the **smallest safe useful agent**: one loop, memory-less or
   simple session, zero dangerous tools, everything else as commented-out
   options in the file.
3. Produce the file with the safe MVP wired and the natural next steps
   present as **commented blocks** — the user reads their future in the
   file and uncomments toward it. A file built this way IS the thing they
   asked to "explain" — it explains by running.

> First-time users: point them at `templates/template-agent.ts` — the
> annotated menu of every option — while you write the tailored file.
> Most users never need it: your file IS the answer.

## Anatomy of the file

Every SanityLoop agent is the same skeleton; blocks vary:

```ts
import { Agent, SimpleModel, EVENTS, Tool } from "@sanityloop/core";
import { createDefaultInputs } from "@sanityloop/inputs";
import { jsonlSession } from "@sanityloop/base-storage";
// ...any other extras you need

// 1. model — the one thing you configure
const model = new SimpleModel({
    modelId: process.env.MODEL_ID ?? "gpt-4o-mini",
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: process.env.MODEL_BASE_URL,          // local llama.cpp etc.
    stream: true,
    maxContext: 128_000,
});

// 2. persistence — append-only JSONL + state card; or skip = memory-only
const session = jsonlSession("sessions/my-agent");

// 3. tools — Tool.define: name + JSON schema + one async function
const myTool = Tool.define({
    name: "my_tool",
    description: "What it does.",
    inputSchema: { type: "object", properties: { /* ... */ }, required: [] },
    async execute(args) { return { answer: "what the model sees" }; },
});

// 4. the god object — state is truth
const agent = new Agent({ model, agentId: "my-agent", tools: [myTool] });
await session.restoreInto(agent);                  // crash-safe resume

// 5. plugins — one line each; delete a line, capability gone
agent.install(session.plugin);
agent.install(createDefaultInputs());
agent.install(createSkillsPlugin({ dirs: [".agents/skills"] }));
agent.install(createMcp({ fs: { command: ["npx", "-y", "..."] } }).getPlugin());
agent.install(createPermissions({ /* gates */ }));
agent.install(createCompaction({ /* threshold */ }));

// 6. custom hooks — filters on ANY loop event, one shape, everywhere
agent.addFilter({
    event: EVENTS.textDelta,   // beforeTool, afterTool, inputReceived, stop, ...
    id: "my/stream",
    priority: 0,
    fn: async (_agent, raw) => { /* react */ },
});

// 7. go
agent.run();
```

That's the whole product. The file is the harness, the docs, and the
deployment unit at once.

## Producing the file

Bake every machine-dependent decision as **`process.env.X ?? default`** —
model id, base url, folders, api keys. Never hardcode local paths, drive
letters, usernames, or machine names; a portable file must run on *other*
machines as-is.

Put the extras the user didn't pick as **commented, annotated blocks**
explaining *what it does, when you want it, how to remove it* — so the file
teaches while it runs, and the next version of the agent is one uncomment
away. Keep the skeleton identical across files so any file teaches all of
them.

## Golden rules (borrowed from the best-practices shelf)

- **State is truth.** Everything the agent does is expressed in state;
  every filter, tool, and model call receives the whole agent. Change one
  state parameter, next tick every behavior changes. UI is drawn from state.
- **Everything is an extension.** Input, interrupts, permissions, storage,
  UI — all Lego. 99% of changes must not touch the core.
- **Isolation by default.** Where things are stored, whether at all, which
  session touches which cache — decide per run. `jsonlSession("sessions/name")`
  = resume; `{uuid}` in the path = fresh per run; no storage = memory-only.
- **Every tool call gets a tool result**, even denial, timeout, or error.
- **Risky side effects need runtime policy, not prompt text** — that's what
  `@sanityloop/permission` is for.
- **Auto-compaction preserves working state, not prose.**
- **Skills and connectors load on demand** (progressive disclosure) — never
  push every capability into context at boot.
- **No hardcoded local paths, ever.** A portable file must run on any
  machine: env vars with defaults, or derived from the OS at runtime.
- **Smallest safe loop first** — add autonomy, tools, and scale only when
  the user asks for it or the gap-check earns it.

## Gotchas

- Don't design multi-agent before a single loop has proven useful.
- Don't give a broad tool (`execute`, `shell`, `write`) without a wrapper
  - permission policy when it touches a real environment.
- Don't pair `repl` with `quit-on-end` — opposites.
- Don't leave the agent without an interaction surface: every agent needs
  inputs (createDefaultInputs) or nothing it receives means anything.
- Don't forget storage when the user says "survive a crash" — that is
  literally `@sanityloop/base-storage`, nothing else.
- Don't skip the questionnaire's gap-check pass — "forgot compaction?" is
  the difference between a demo and a marathon agent.
- Don't ship a file with a hardcoded path or key baked in — the file is
  portable; the secrets and paths are not.

## Reference map

- [`references/glossary.md`](references/glossary.md) — every SanityLoop
  block: what it is, when you want it, how to wire it, and the
  requirement-phrase → blocks router. **Read first in Case 1.**
- [`references/questionnaire.md`](references/questionnaire.md) — the two
  question passes: elicitation (Case 2) and gap-check (Case 1), each
  question with *why it matters* and *wire with*. **Read first in Case 2.**
- `templates/template-agent.ts` — the annotated menu of every option;
  `templates/simple-agent.ts`, `repl-agent.ts`, `worker.ts`, `admin.ts` —
  ready-made shapes to adapt.
