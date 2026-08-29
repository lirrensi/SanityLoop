# SanityLoop

<p align="center">
  <img src="assets/orocat.webp" alt="orocat — the SanityLoop mascot" width="280" />
</p>

**An agent loop and SDK that does not make you insane.**

SanityLoop is a small agent SDK you bring into any of your apps — so you keep control over the harness and build it yourself out of building blocks. It is not a framework that owns your agent. The agent is a single file you own, and everything around it is Lego.

---

## What it is

A tiny core — a stupid loop that sends a prompt, runs some tools, repeats — plus a shelf of optional modules. You compose an agent in **one file**: import the classes, wire what you need, call `run()`. That file is your entire harness. Import it from your app, run it directly as a script, or compile it into a portable distribution. Whatever you want.

Because the definition lives in a file you own, you can copy it anywhere, change half a prompt or a single tool, and it just works. Owning the file means owning the agent.

## Why it exists

I wanted something simple: embed an agent programmatically, or run it as a script somewhere. When I went looking, every SDK I found was limited in one of two ways — either too complicated to be truly programmatic, or so magical and template-hostile that you fight it the moment your needs disagree with its opinions.

Other harnesses advertise themselves as *"yours — build and modify freely"*. Pi promises exactly that. I found out on day two of customizing that I had to fork it anyway. Not to mention an "SDK mode" so confusing I still couldn't tell you what it is.

And then there's isolation — or the total lack of it. Most tools give you **zero isolation between runs**: cache, sessions, storage — everything follows you around globally, because they were built as global installs, not embeddable components.

So the promise here is simple:

- **Maximum customizability from day 0**, because the core is just a simple stupid loop.
- **Everything is an extension.** Even the ability to send signals *into* the loop is an extension. Input, interrupts, permissions, storage, UI — all Lego.
- **Isolation by default.** Where things are stored, whether they're stored at all, which session touches which cache — you decide, per run.

## What it is NOT

Because disappointment is preventable:

- **Not a finished product.** No flagship app, no polished TUI, no batteries-included assistant — and that is the point, not an apology. A "complete product" means making decisions on your behalf, then making more when people disagree, then maintaining all of them forever. This hands you bricks instead of verdicts. If it's less pretty than a funded launch page, that was the trade.
- **Not human-first — worker-first.** The intended interface isn't you at a chat window; it's *your existing harness*. An agent that runs headless from cron once a day, embedded in your app, or shipped inside a repo to do one job there — without retrofitting somebody else's SDK with your config, your preferences, your rules. The REPL exists so you can *feel* the loop; it is not the destination.
- **Not a generalist with baggage.** A security audit after every commit should be a tiny agent file: two skills, one MCP server, a focused prompt — not a general agent hauling ten servers' worth of context it will never use. On batteries-included harnesses, even the skills won't isolate away. Here, a narrow agent stays narrow because the file says so.
- **Not anti-TUI.** These blocks could absolutely carry an entire coding agent with a proper terminal UI — everything swaps, so it would behave beautifully. But that product is monumental work, and it is explicitly not the goal. If someone builds it on these bricks: wonderful, go ahead.

Stated positively, the paradigm underneath is the **self-executing agent**. The usual pattern is one central agent with skills slapped into it — and the baggage still rides in the middle. Here the entire agent is a file, exactly like a skill is a file: open it, modify it in place, rerun it. An email processor stays an email processor — isolated, focused, and unable to pollute its neighbors — because each run loads, stores, and shares only what its file says.

## The template

This is the taste — the core moves in one file:

```ts
// my-agent.ts — copy it, rename it, make it yours.
// This snippet is HALF the story; the full annotated menu is
// templates/template-agent.ts (see below).
import { Agent, SimpleModel, EVENTS, Tool } from "@sanityloop/core";
import { createDefaultInputs } from "@sanityloop/extras/inputs";   // without this, inputs mean nothing
import { jsonlSession } from "@sanityloop/extras/base-storage";    // crash-safe persistence
import { createSkillsPlugin } from "@sanityloop/extras/skills";     // SKILL.md catalog, loaded on demand
import { createMcp } from "@sanityloop/extras/mcp";                 // MCP servers → native tools

// ---- 1. the model — the one thing you configure ----
const model = new SimpleModel({
    modelId: "gpt-4o-mini",
    apiKey: process.env.OPENAI_API_KEY,
    stream: true,
});

// ---- 2. persistence — append-only JSONL tape + state card in one folder ----
const session = jsonlSession("sessions/my-agent"); // static folder = resume each run

// ---- 3. your own tool = name + JSON schema + one async function ----
const echo = Tool.define({
    name: "echo",
    description: "Echoes the given text back.",
    inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
    },
    async execute({ text }: { text: string }) {
        return { answer: `You said: ${text}` };
    },
});

// ---- 4. MCP servers become native tools: declare → init → install ----
const mcp = createMcp({
    fs: { command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."] },
});
await mcp.init(15_000);

// ---- 5. assemble the god object; replay the tape before installing plugins ----
const agent = new Agent({ model, agentId: "my-agent", tools: [echo] });
await session.restoreInto(agent);   // crash? restore exactly where you were

// ---- 6. plugins — one line each. Delete a line, capability gone. ----
agent.install(session.plugin);
agent.install(createDefaultInputs());
agent.install(createSkillsPlugin({ dirs: [".agents/skills"] }));
agent.install(mcp.getPlugin());

// ---- 7. hook ANY moment of the loop — one shape, everywhere ----
agent.addFilter({
    event: EVENTS.textDelta,
    id: "my/stream",
    priority: 0,
    fn: async (_agent, raw) => {
        const sd = (raw as { streamDelta?: { type?: string; delta?: string } })?.streamDelta;
        if (sd?.type === "textDelta") process.stdout.write(sd.delta ?? "");
    },
});

// ---- 8. go ----
agent.run();
agent.input({ type: "input_followup", text: "hello cutie" });
```

Run it with `node --experimental-strip-types my-agent.ts`. No engine, no CLI, no global install.

That's half the story. **[`templates/template-agent.ts`](templates/template-agent.ts) is the full annotated menu** — every option commented with *what it does, when you want it, how to remove it*: permissions gates, file tools (plain & drift-proof), bash, compaction, AGENTS.md/rules loaders, HTTP server, REPL vs batch-vs-daemon personalities, logging, watchdogs. Uncomment your way to an agent.

## Extensions, not forks

You should be able to build anything out of extensions and almost never fork. But even when you do, forking here doesn't mean maintaining a side repository: just import a class, extend it, override the one method, hand yours in instead. Every default is a class you can replace.

The API is kept mostly stable, and versioning happens with **major versions only** — so nothing breaks underneath you quietly.

Nothing is forced on you either. You define where stuff is stored, whether it's stored at all, what gets loaded per run, how, and to what extent. Every component is something you explicitly enable — or write yourself. You are not a slave to defaults that are painfully hard to override.

Zero surprises.

## Source layout vs published packages

The repository is a monorepo, so its development folders do not map one-to-one
to npm packages. The source is kept in separate folders for focused development
and testing; the GitHub Actions publish workflow curates those folders into the
two public packages:

```text
packages/
├── core/        → @sanityloop/core
├── extras/      → optional bricks, bundled into @sanityloop/extras
├── swarm/       → developed separately, bundled as @sanityloop/extras/swarm
└── test-kit/    → private development/test helper; not published
```

Install the published packages with:

```sh
npm install @sanityloop/core @sanityloop/extras
```

Although `swarm` lives at `packages/swarm` in the source tree, its published
import path is:

```ts
import { /* swarm APIs */ } from "@sanityloop/extras/swarm";
```

Every push to `main` runs the verification gate and publishes only `core` and
`extras`, in that order.

Publishing is deliberately gated by an explicit version change. To release a
new version, update the version in `packages/core/package.json` and push it:

```sh
npm version patch --workspace packages/core --no-git-tag-version
git add packages/core/package.json package-lock.json
git commit -m "release: v0.1.1"
git push origin main
```

The workflow detects that version change, uses the core version for both
packages, and publishes them. Ordinary code, documentation, or workflow pushes
run no npm publish.

## What you can build

Same blocks, different shapes:

- A **one-shot script** — runs the model in a loop, finishes, dies ([`quit-on-end`](packages/extras/quit-on-end/)).
- A **long-lived worker** — stays open, restarts on demand, runs from cron.
- An **entire coding agent** — TUI, permissions, compaction, skills, the works — like `pi` or `opencode`, except it's yours.
- **Multi-agent orchestration** — spawn agents that talk to each other.
- A **swarm** — an organization of agents joining a hub from anywhere, reporting state and taking commands without being owned by it ([`swarm`](packages/swarm/)).

## Start in three steps

1. **Check a template.** Copy [`templates/template-agent.ts`](templates/template-agent.ts) — it's an annotated menu: every plugin documented inline, keep what you want, delete the rest. (Or steal [`templates/repl-agent.ts`](templates/repl-agent.ts) / [`templates/simple-agent.ts`](templates/simple-agent.ts) for ready-made shapes.)
2. **Uncomment what you need.** Modify prompts, inputs, tool lists — as much or as little as you want.
3. **Run it as a plain script.** Portable, everywhere, pulling configs from exactly where *you* specified.


## Patterns

> Higher-level recipes — combinations of the blocks aimed at a specific *outcome*, not just a shape. Pattern 1 to start; the list grows as we find more.

### Pattern 1 — The single-file, self-hosting agent

The dream: **one file on GitHub, `npx` it, you have an agent.** No `npm install`, no cloning, no dotenv ritual. Whoever runs it — you, a teammate, a CI box, a stranger on the internet — gets a working agent from a single command, because `npx` pulls the package *and* its dependencies on the fly. The whole setup and the whole runner live in that one script, so the thing is trivially hostable, redistributable, and runnable anywhere Node exists.

And because the setup and the runner are the *same file*, you can **bake in everything you're missing right there** — including the parts that would normally block a first run. No API key in the environment? The script asks for it *right there*, on first launch, and **saves it for next time** so subsequent runs are silent. Missing a skill folder, a config file, a session store? Same trick: detect, prompt-or-default, persist. By the time the loop starts, the agent is already fully provisioned — and the provisioning ships *with* the agent.

The shape:

```ts
// my-agent.ts — the entire product. Host it; `npx your-org/my-agent` runs it.
import { Agent, SimpleModel, EVENTS } from "@sanityloop/core";
import { createDefaultInputs } from "@sanityloop/extras/inputs";
import { jsonlSession } from "@sanityloop/extras/base-storage";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";

// ---- 0. provision what's missing, BEFORE the loop even exists ----
const KEY_FILE = ".agent-key";
async function ensureKey(): Promise<string> {
  const fromEnv = process.env.OPENAI_API_KEY;
  if (fromEnv) return fromEnv;
  if (existsSync(KEY_FILE)) return readFileSync(KEY_FILE, "utf8").trim();
  // nothing baked in? ask right here, then save for the future.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const key = (await rl.question("No API key found — paste one to continue: ")).trim();
  rl.close();
  writeFileSync(KEY_FILE, key); // persisted: next run is zero-prompt
  return key;
}

const model = new SimpleModel({ modelId: "gpt-4o-mini", apiKey: await ensureKey(), stream: true });
const session = jsonlSession("sessions/my-agent");
const agent = new Agent({ model, agentId: "my-agent", tools: [] });
await session.restoreInto(agent);
agent.install(createDefaultInputs());
agent.addFilter({ event: EVENTS.textDelta, id: "out", priority: 0,
  fn: async (_a, raw) => {
    const sd = (raw as { streamDelta?: { type?: string; delta?: string } })?.streamDelta;
    if (sd?.type === "textDelta") process.stdout.write(sd.delta ?? "");
  }});
agent.run();
agent.input({ type: "input_followup", text: process.argv[2] ?? "hello cutie" });
```

Wire it for redistribution with a one-line `package.json` bin, then it's live:

```json
{ "name": "my-agent", "bin": { "my-agent": "my-agent.ts" },
  "dependencies": { "@sanityloop/core": "*", "@sanityloop/extras": "*",  } }
```

Now `npx your-org/my-agent` — after a publish, or straight from source with `npx github:your-org/my-agent` — fetches the package and its dependencies on the fly and runs the single bin; no local `npm install` required. Keep the source as one `.ts` file (run with `node --experimental-strip-types`, or compile to a `.js` bin): either way it stays one file you own, hostable and redistributable. **One file is the whole product, and it carries its own onboarding.**

(Inside a running loop you can pull the same *ask-and-remember* move for any decision with  [`@sanityloop/extras/ask-question`](packages/extras/ask-question/) — park an await, answer from any channel, persist the result.)

---
## The building blocks

Everything outside the core lives in one shelf package — `@sanityloop/extras` — each extra as its own subpath import. You install the shelf once and import only what you use; the heavy worlds (mcp, pi-model, http-server) stay lazy and only load when actually used. The wiring pattern is always the same:

```ts
agent.install(createSomething({ /* opts */ }));
```

Delete any of these folders and the core still runs.

### The core — `@sanityloop/core`

| Piece | What it is |
| --- | --- |
| `Agent` | The god object. Holds all state; every filter, tool, and model call receives it whole. Mutate any part and the next tick reflects it. |
| Two eternal clocks | Loop 1 supervises signals (inputs set a literal `blocked` flag), loop 2 takes one step per beat. Flags change what ticks *do*, never whether loops run. |
| Filter bus | WordPress-style hooks: `addFilter(event, id, priority, fn)` at every stage of the loop. |
| `SimpleModel` | The model wrapper — OpenAI-compatible APIs, streaming. Swap guts without touching the contract. |
| `Tool` | Define tools as plain functions that receive the agent. |
| Events | `beforeTool`, `afterTool`, `textDelta`, `inputReceived`, `stop`, … — the whole loop is observable and hookable. |

### Loop control & safety

| Package | When you want it |
| --- | --- |
|  [`@sanityloop/extras/permission`](packages/extras/permission/) | Tools touch real files/systems and you want allow/ask/deny gates. Approvals park the loop until someone answers. |
|  [`@sanityloop/extras/inputs`](packages/extras/inputs/) | Basically always. Turns raw inputs into the standard vocabulary: abort, stop, steer mid-turn, follow-ups, clear/reset history. Without it, inputs mean nothing. |
|  [`@sanityloop/extras/loop-control`](packages/extras/loop-control/) | Unattended/batch runs — doom-loop detection and max-turn budgets. (A strong model needs none of it; production paranoia does.) |
|  [`@sanityloop/extras/keep-open`](packages/extras/keep-open/) | Long-lived processes that must keep breathing instead of settling after each job. |
|  [`@sanityloop/extras/quit-on-end`](packages/extras/quit-on-end/) | Batch scripts — exit the process the moment the agent lands idle. |

### Context & knowledge

| Package | When you want it |
| --- | --- |
|  [`@sanityloop/extras/basic-compaction`](packages/extras/basic-compaction/) | Long sessions that hit context limits — threshold-triggered summarization. |
|  [`@sanityloop/extras/compact-handover`](packages/extras/compact-handover/) | Handover-style compaction: summarize, then continue fresh. |
|  [`@sanityloop/extras/skills`](packages/extras/skills/) | `SKILL.md` skill folders loaded into context on demand. |
|  [`@sanityloop/extras/rules-loader`](packages/extras/rules-loader/) | Rules files (incl. `.mdc`) injected into the system block from disk. |
|  [`@sanityloop/extras/agents-md-loader`](packages/extras/agents-md-loader/) | `AGENTS.md` discovery + injection, opencode-style. |
|  [`@sanityloop/extras/mcp`](packages/extras/mcp/) | Existing MCP servers bridged in as native tools. |

### Tools — giving the agent hands

| Package | When you want it |
| --- | --- |
|  [`@sanityloop/extras/basic-fs-tools`](packages/extras/basic-fs-tools/) | Quick read/write/edit file tools with truncation guards. |
|  [`@sanityloop/extras/hash-fs-tools`](packages/extras/hash-fs-tools/) | Precise, conflict-safe edits — hash-addressed replacements instead of fuzzy string matching. |
|  [`@sanityloop/extras/shell-tool`](packages/extras/shell-tool/) | Shell execution (Windows-first: login-shell resolution, process-tree kills, tail-truncating output so errors survive) plus `glob`. |
|  [`@sanityloop/extras/simple-todo`](packages/extras/simple-todo/) | Task-list tool writing into observed state — survives crashes like everything else. |
|  [`@sanityloop/extras/ask-question`](packages/extras/ask-question/) | The model needs a human decision: parks an await, any channel can answer. |

### Observability & logging

| Package | When you want it |
| --- | --- |
|  [`@sanityloop/extras/observer`](packages/extras/observer/) | Developing/debugging — prints the loop: lifecycle headlines, stream details. |
|  [`@sanityloop/extras/log-sink`](packages/extras/log-sink/) | Real logging — JSONL with rotation to file, or pretty console output. |
|  [`@sanityloop/extras/snapshot`](packages/extras/snapshot/) | Building status cards and dashboards over the live agent. |

### Persistence

| Package | When you want it |
| --- | --- |
|  [`@sanityloop/extras/base-storage`](packages/extras/base-storage/) | Crash safety. Append-only JSONL tape (`{t, change}`) + atomic `state.json`; `restoreInto(agent)` replays baseline + deltas — parked awaits come back too. |

### Channels & UI

| Package | When you want it |
| --- | --- |
|  [`@sanityloop/extras/http-server`](packages/extras/http-server/) | Driving the agent from anywhere: HTTP + SSE + WS. `POST /input` is the only write door; `/getState` reads live state. |
|  [`@sanityloop/extras/repl`](packages/extras/repl/) | A terminal chat session — readline prompt, commands, stream feedback. The fastest way to feel the loop. |

### Models & fleet

| Package | When you want it |
| --- | --- |
|  [`@sanityloop/extras/pi-model`](packages/extras/pi-model/) | Multi-provider models beyond OpenAI-compatible APIs, via the pi provider library. |
|  [`@sanityloop/extras/swarm`](packages/swarm/) | Many agents, many machines. A dumb daemon hub + a join extension: agents join, report state, get commanded — never owned. |

### Utilities

| Package | When you want it |
| --- | --- |
|  [`@sanityloop/extras/util`](packages/extras/util/) | Zero-policy glue: shared log channel + `emitLog`, truncation helpers, filter management helpers. |

## Templates

| Template | Shape |
| --- | --- |
| [`templates/simple-agent.ts`](templates/simple-agent.ts) | The proof — raw classes wired by hand, stub model included, runs with zero keys. |
| [`templates/template-agent.ts`](templates/template-agent.ts) | THE template — an annotated menu: every option commented with *what it does, when you want it, how to remove it*. Uncomment your way to an agent. |
| [`templates/repl-agent.ts`](templates/repl-agent.ts) | Interactive coding-agent session composed entirely from plugins. |
| [`templates/worker.ts`](templates/worker.ts) + [`worker.json`](templates/worker.json) | Swarm worker — spawned by the daemon, env-configured, persistent. |
| [`templates/admin.ts`](templates/admin.ts) + [`admin.json`](templates/admin.json) | Fleet admin — attach to the hub and command workers. |

## Documentation

Deeper doctrine, references, and guides live in [`docs/`](docs/):

- [The mini-map](docs/guides/mini-map.md) — "I want to build…" → which bricks, which recipe. Start here.
- [Build your own coding agent](docs/guides/coding-agent.md) — the full assembly: tools, skills, MCP, sub-agents, and REPL-vs-your-own-UI.
- [Philosophy](docs/overview/philosophy.md) — why this exists and why it had to be easy.
- [Product & doctrine](docs/overview/product.md) — the seven rules that never change.
- [Extensions catalog](docs/reference/extensions.md) — every package, entry points included.
- [Architecture](docs/architecture/core.md), [API reference](docs/reference/api.md), [Cookbook](docs/guides/cookbook.md).

## License

MIT — see [LICENSE](LICENSE).
