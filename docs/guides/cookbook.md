---
node_type: guide
title: The Sanity Cookbook — how to build anything on the loop
status: active
updated: 2026-08-23
tags: [cookbook, guide, recipes]
links:
  depends_on: [/overview/product.md, /architecture/core.md, /reference/events.md, /reference/state.md, /reference/api.md]
  supersedes: [/docs/cookbook.md]
  verified_by: [/verification/strategy.md]
sync_status: verified
last_synced: 2026-08-23
---

# The Sanity Cookbook

> How to build anything on the sanity loop. One entity, one rule, every door open.
> Written for the 100 people who will extend it without forking it — the cookbook
> is also the architecture's exam: if a recipe is awkward, the architecture is wrong.

> Just want to know *what to grab* for your goal? Skip to
> [the mini-map](mini-map.md) — the router version of this page.

---

## Part 0 — The mental model (5 minutes)

**ONE entity.** The agent IS the god object. It's passed to every function —
filters get `(agent, event)`, tools get `(agent, params)`, models get `(agent)`.
There is no wrapper, no context object, no shadow surface. Every field and
method is on it: `agent.messages`, `agent.state`, `agent.pendingAwaits`,
`agent.emit(...)`, `agent.park(...)`, `agent.stop()`.

**State is truth.** Every write you make to the agent — any key, any depth —
is observed by a Proxy, becomes a `KeyChange`, and flows everywhere:
`patched` events, the tape (persistence), the dashboard. Write `agent.state.x = 1`
and the whole system reacts. You can pause, crash, restore — state explains everything.

**Events are a skeleton + your channels.** The loop fires a fixed, guaranteed
set of events (the skeleton: `turnStart`, `beforeTool`, `afterProviderResponse`,
`cycleEnd`, `stop`, ...). You LISTEN with filters. You ANNOUNCE your own things
with `agent.emit("your/event", payload)` — WordPress `do_action`, priority-ordered.
The loop's commands (`stop`, `abort`, `park`, `wake`, `endCycle`) are methods,
not events.

**Extensions → core, one direction.** The core never imports your code. You
import the core and hang pieces on it. You never fork it — you subclass it.

---

## Part 1 — The fundamentals

### How do I build an agent?

```ts
import { Agent, SimpleModel } from "@sanityloop/core";
import { createDefaultInputs } from "@sanityloop/inputs";

const agent = new Agent({
  model: new SimpleModel({ api: "chat_completions", modelId: "gpt-4o-mini", stream: true }),
  agentId: "my-agent",                              // the name
  description: "What this agent does",              // optional, queryable
  tools: [...],
  messages: [...],                                  // optional history
});
agent.install(createDefaultInputs());               // the standard input vocabulary
agent.input({ type: "input_followup", text: "hello" });   // becomes a user message
```

*Why it works:* the agent is the god object from birth — `id`, `agentId`,
`description`, `cwd`, `model`, `messages`, `state`, `activity` are all real,
observed fields. The core is type-blind about inputs; `createDefaultInputs`
is what turns the followup into a real message and starts the turn.

### How do I build a tool?

```ts
import { Tool } from "@sanityloop/core";

const readFile = Tool.define({
  name: "read_file",
  description: "Read a file. Use for understanding code.",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  async execute({ path }, agent) {                 // ← the WHOLE agent
    agent.setActivity(`reading ${path}`);          // tools can write anything
    return { answer: "the contents...", stored: { path } };  // answer = model sees; stored = yours
  },
});
```

*Why it works:* `execute(params, agent)` — the entity is handed to every tool.
`answer` is what the model reads; `stored` is your raw payload, verbatim;
`error: true` marks a failure without killing the loop (error-as-result).

### How do I build a filter? (listen + mutate)

```ts
import { EVENTS } from "@sanityloop/core";

agent.addFilter({
  event: EVENTS.cycleEnd,          // or any string — yours included
  id: "my-verifier",
  priority: 10,                    // lower runs first
  fn(agent, event) {               // (agent, event) — the entity + the facts
    if (agent.state.shouldStop) agent.stop();   // mutate directly
    agent.state.lastCycle = event?.turn?.id;    // write anything, observed
  },
});
```

*Why it works:* filters receive the god object and the payload. No return-merge
dance — you mutate, you're done. Throw and the loop survives (fires `handlerError`).

### How do I build a plugin? (a named bundle)

```ts
import type { Plugin } from "@sanityloop/core";

const myKit: Plugin = {
  id: "my-kit",
  requires: ["some-dependency"],               // optional — checked at install
  install(agent) {
    agent.addTool(...);
    agent.addFilter(...);
    agent.addDeclaredCapability({ id: "my-kit", description: "does the thing" });
  },
  uninstall(agent) {                           // REQUIRED — leave clean
    // remove what you added, remove the capability
  },
};

agent.install(myKit);                          // one unit, in and out
```

*Why it works:* a plugin is just filters/tools with a lifecycle wrapper. Every
registration namespaces under `${plugin.id}/`. Install/uninstall as one unit.
`requires` is checked before anything registers — a missing dependency throws
`PluginDependencyError` instead of leaving zombies.

---

## Part 2 — The loop's doors

### How do I control the loop?

```ts
agent.stop();        // soft — finish the current step, land
agent.pause();       // stop after the current message commits
agent.abort("why");  // hard kill — fires beforeAbort → abort
agent.wake();        // "keep going" — starts a turn if idle/parked
agent.endCycle();    // discard this cycle — don't commit, run again
agent.park({ type: "my-kind", id: "x", schema: {...} });  // wait for something
agent.input({ type: "input", text: "..." });   // the input door
```

### How do I build a permission gate?

The shipped brick first — `@sanityloop/permission` gives you gates, classic
choices, session approvals, and a denial audit with zero code:

```ts
import { createPermissions, fsPathGate, askAll, classicResolve } from "@sanityloop/permission";

agent.install(createPermissions({
  tools: {
    "*": { gate: askAll, resolve: classicResolve },   // broad first…
    read_file: { gate: fsPathGate },                  // …specific wins (last match)
  },
}));
// an ask parks the loop (`awaiting`); answer with:
agent.input({ type: "permission/answer", ref: callId, answer: { choice: "once" } });
```

The raw pattern underneath (build your own policy from this):

```ts
// gate: before the world-touching wall, park on an await
agent.addFilter({
  event: EVENTS.beforeTool,
  id: "perm/issue",
  priority: 5,
  fn(agent, event) {
    if (!approved(event?.tool?.name)) {
      agent.park({ type: "permission-answer", id: event?.call?.id, schema: {...} });
    }
  },
});

// unlock: an input resolves the await → the loop resumes the SAME batch
agent.addFilter({
  event: EVENTS.inputReceived,
  id: "perm/clear",
  priority: 10,
  fn(agent, event) {
    const answer = event?.input;
    if (answer?.type === "permission-answer") {
      agent.pendingAwaits = agent.pendingAwaits.filter(a => a.id !== answer.ref);
    }
  },
});
```

*Why it works:* `beforeTool` is a blocking wall. If awaits pend after it, the
worker saves its position and parks `awaiting` — resume re-runs the gate +
batch (the gate cursor prevents re-asking answered calls). This is your
human-in-the-loop, crash-safe.

### How do I build a custom input type?

```ts
// the core is TYPE-BLIND — inputs are metadata; filters wear the hats.
// NOTE: a bare input() does nothing visible by itself. Install
// @sanityloop/inputs (createDefaultInputs) for the standard vocabulary
// (input_abort / input_stop / input_steer / input_followup), or handle
// your own type like below.
agent.input({ type: "my-command", payload: "..." });   // send anything

agent.addFilter({
  event: EVENTS.inputReceived,
  id: "my-command",
  priority: 0,
  fn(agent, event) {
    const input = event?.input;
    if (input?.type === "my-command") { ... }          // you define the meaning
  },
});
```

### How do I build a custom event channel? (announce anything)

```ts
// sender — anywhere: a timer, a tool, a filter
agent.emit("cron/tick", { wakeAt: Date.now() + 30_000 });

// receiver — priority-ordered, WordPress-style
agent.addFilter({
  event: "cron/tick",
  id: "tick-listener",
  priority: 1,
  fn(agent, event) {
    console.log("tick", event?.wakeAt);
  },
});
```

*Why it works:* `emit` dispatches from the registry, so it reaches listeners
even outside a cycle (timers, install-time). `publish = true` (default) also
lands the event in `transient.currentEvent` → visible live on the dashboard.

### How do I build a model adapter?

```ts
import { SimpleModel } from "@sanityloop/core";

class MyModel extends SimpleModel {
  async callNextTurn(agent) {                 // ← the WHOLE god object
    // build messages, call your API, emit stream deltas:
    agent.streamSink?.emit({ type: "textDelta", delta: "..." });
    return {
      message: { id: "m1", enabled: true, type: "assistant", content: [{ type: "text", content: "hi" }] },
      stats: {                                // flat MessageStats — no nesting
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
    };
  }
}
```

*Why it works:* the model contract is `callNextTurn(ctx: GodObject)` — one
function, the whole object, stream deltas via `streamSink` (temporal-only;
loop 1 flushes them every beat). Under the two clocks, loop 2 awaits your
call inline at the PROVIDER phase — a slow model holds loop 2, but loop 1
keeps beating: inputs drain mid-call, and `abort()` kills the call
cooperatively through `ctx.abortSignal`.

---

## Part 3 — Living systems

### How do I build a timer / cron loop?

```ts
// a self-scheduled loop: nudge the model every N seconds toward a goal.
// the schedule lives in STATE (an await) — crash-safe, re-armable.
const T = "loop-control/timer";
let timer: ReturnType<typeof setTimeout> | undefined;

const plugin: Plugin = {
  id: "cron",
  install(agent) {
    const arm = (wakeAt: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        agent.pendingAwaits = agent.pendingAwaits.filter(a => a.type !== T);  // cleanup
        agent.wake();                                                          // loop continues
        arm(Date.now() + opts.everyMs);                                        // re-arm
      }, Math.max(0, wakeAt - Date.now()));
    };

    // park the next nudge BEFORE the landing → the loop lands `awaiting` (honest)
    agent.addFilter({
      event: EVENTS.cycleEnd,
      id: "cron/schedule",
      priority: 0,
      fn(agent) {
        if (agent.pendingAwaits.some(a => a.type === T)) return;
        const wakeAt = Date.now() + opts.everyMs;
        agent.pendingAwaits.push({ type: T, id: `tick-${wakeAt}`, schema: { wakeAt } });
        arm(wakeAt);
      },
    });

    // the nudge — real message, observed, the loop keeps going
    agent.addFilter({
      event: EVENTS.turnStart,
      id: "cron/nudge",
      priority: 0,
      fn(agent) {
        agent.setActivity(`nudging toward "${opts.goal}"`);
        agent.emit("cron/tick", { goal: opts.goal });        // announce
        agent.messages.push({ id: "nudge", enabled: true, type: "user",
          content: [{ type: "text", content: `Continue toward the goal: ${opts.goal}` }] });
      },
    });

    // re-arm on restore: the tape brought the await back, we bring the timer back
    for (const a of agent.pendingAwaits) if (a.type === T) arm((a.schema as any)?.wakeAt ?? Date.now());
  },
  uninstall(agent) { if (timer) clearTimeout(timer); },
};
```

*Why it works:* the await is state — taped, restored, honest. `hasWork` reads
awaits, so a parked timer reads "hungry". `setActivity` paints the dashboard;
`emit` announces to listeners. Nothing here forks the core.

### How do I build a session? (persist + crash-restore)

```ts
import { jsonlSession } from "@sanityloop/base-storage";

const session = jsonlSession("sessions/meow");     // a folder: tape + card

const agent = new Agent({ model, agentId: "meow" });
const restored = await session.restoreInto(agent); // replay the tape → resume (true/false)
agent.install(session.plugin);                     // tape + card from here on
```

*Why it works:* every restore-relevant write is appended to the tape as a
`KeyChange`; restore = baseline + deltas, applied silently (`merge`). Parked
awaits, messages, state — all back. Crash anywhere, resume exactly where the
state says you were.

### How do I build a watchdog / doom guard?

```ts
import { loopControl } from "@sanityloop/loop-control";

agent.install(loopControl({
  doomLoop: { enabled: true, threshold: 3, reaction: "nudge" },  // repeated tool failures
  maxTurns: { enabled: true, cap: 200, announceLast: true },     // hard budget
}));
```

*Why it works:* the loop stays light; the guard is an optional extra that
watches `content.error === true` (never "same call" — success resets). The
doctrine: with a strong model you install none of it.

### How do I build an activity feed?

```ts
agent.setActivity("waiting 4:59 until next trigger");  // natural language, observed
// → patched → tape → dashboard. Update on MEANINGFUL change, not every tick.
```

### How do I build a question flow? (ask a human)

```ts
import { createQuestionTool } from "@sanityloop/ask-question";

agent.install(createQuestionTool({
  tools: { name: "ask", description: "Ask the user something." },
}));
// the tool parks on an await; the terminal/UI answers; the loop resumes.
```

### How do I build a dashboard?

```ts
import { createObserverPlugin } from "@sanityloop/observer";
import { createHttpServer } from "@sanityloop/http-server";

agent.install(createObserverPlugin({ verbosity: 2 }));  // lifecycle → console
agent.install(createHttpServer({ port: 7377 }));        // GET /getState → the god object
```

---

## Part 4 — Going deep

### How do I build a custom loop? (subclass the core — the "never fork" promise)

```ts
import { Agent } from "@sanityloop/core";

class MyAgent extends Agent {
  protected async loop2() {   // the worker clock — the whole machine is two clocks
    // override ONE seam — or call super.loop2() and adjust the rhythm
    await super.loop2();
  }

  protected deriveLoopState() {   // or change the state derivation
    super.deriveLoopState();
  }
}
```

*Why it works:* every meaningful machine method is `protected` — `loop1`/`loop2`
(the clocks), `step`/`providerStep`/`batchStep` (the pipeline), `land`/`parkNow`
(lifecycle), `deriveLoopState`. Import the class, extend it, override ONE seam,
call `super` for the rest — no fork, no fork tax. The plumbing stays private.

### The event contract (the skeleton)

Loop lifecycle: `beforeAgentStart agentStart agentEnd agentSettled turnStart
cycleEnd turnEnd beforeStop stop beforeAbort abort beforeRunEnd error handlerError`

Input: `inputReceived inputProcessed` · Messages: `beforeMessageAdd messageUpdate
messageAdded messageRemoved fragmentUpdate` · Tools: `beforeTool afterTool toolStart
toolUpdate toolEnd toolListChanged` · Stream: `streamStarted textDelta textEnd
thinkingDelta thinkingEnd toolcallDelta` · Provider: `beforeProviderRequest
afterProviderResponse` · Generic: `patched merged usage`

Listen with `addFilter({ event: EVENTS.x, ... })`. The loop fires them in a
guaranteed order — that's what makes restore and "state is truth" work.

### The restore rules (why you can crash anywhere)

- `patched` → tape, for restore-relevant keys only (transient never taped).
- Restore = baseline + deltas, applied silently → ONE `merged` event.
- Awaits are plugin-owned: a timer await comes back, YOU re-arm it. Orphans are
  your bug, by design.
- **Crash-heal (at-most-once):** a mid-batch crash restores with missing calls
  marked "not executed — crashed" (`preResolved` errors); committed calls are
  skipped — no side effect fires twice, the transcript stays whole.
- **Parked restores are NOT healed:** the ask was never answered, so it is
  re-presented and the batch runs fresh after the answer.

---

*The cookbook is the test. If a recipe is awkward, the architecture is wrong —
tell us and we fix the architecture, not the recipe.*
