# Questionnaire — ask the right questions, then the NEXT right questions

Two passes. Use them in the order the case demands.

- **Pass A — Elicitation** (Case 2, "I don't know"): shape the loop from
  nothing. Ask only as much as the user tolerates; state assumptions for
  anything they wave off ("you decide").
- **Pass B — Gap-check** (Case 1, "I want this"): after mapping their
  requirements, go through the common components they did NOT mention and
  offer them. The art is *"did you forget compaction?"*, not *"here is
  everything"*.

---

## Pass A — Elicitation (vague or exploratory requests)

Take these in order; stop early when the shape is clear.

### A1. What is the agent FOR?
>
> Domain + the actual work: "watch a folder and email me", "review my PRs",
> "answer support tickets". If they can't say — state what YOU think it's
> for and move on.

### A2. How much may it do on its own? (autonomy & risk)
>
> Answer-only / draft-only / approval-gated / autonomous within policy?
> **Why:** decides whether `permission` gates are wired and how tools are
> shaped. **Wire:** `createPermissions`, `askAll` if it touches anything real.

### A3. How do you want to talk to it? (interaction surface)
>
> Terminal REPL? Your web app? Cron/batch? Another program? Nothing (pure
> API from code)?
> **Why:** decides run shape — `repl` vs `http-server` vs `quit-on-end`
> vs embedded. **Wire:** `createReplPlugin()` / `createHttpServer()` /
> `createQuitOnEndPlugin()` / nothing extra.
> Every agent needs `createDefaultInputs()` regardless.

### A4. Does it need to remember things between runs?
>
> Resume after crash/restart? Fresh start every run? Memory-only?
> **Why:** decides `base-storage`. **Wire:** `jsonlSession("sessions/x")`
> = resume; `{uuid}` path = fresh; skip = memory-only.

### A5. What does it touch? (tool surface)
>
> Files, shell, your internal APIs, web, a database, MCP servers?
> **Why:** decides the tool bricks and the risk profile.
> **Wire:** `basic-fs-tools` / `hash-fs-tools` / `shell-tool` / your own
> `Tool.define` / `createMcp(...)`.

### A6. How long does a session run?
>
> A minute? An hour? Days?
> **Why:** decides compaction and loop budgets.
> **Wire:** `basic-compaction` or `compact-handover` for long sessions;
> `loopControl` for unattended runs.

### A7. Do you want it to keep growing over time?
>
> Skills/playbooks? Rules files? AGENTS.md? New abilities added later?
> **Why:** decides knowledge bricks. **Wire:** `skills`,
> `rules-loader`, `agents-md-loader`.

---

## Pass B — Gap-check ("did you forget…") — RUN THIS ALWAYS, CASE 1

After wiring their stated requirements, walk the common-components list.
Only offer what matters for their shape — but ask, because the user usually
*doesn't know what they don't know*.

### B1. You added a tool that touches something real — do you want permissions?
>
> Any tool that writes files, sends messages, runs shell, or reaches out:
> **"Do you want it to ask you before doing that?"**
> **Why:** prompt text is not enforcement; risky side effects need runtime
> policy. **Wire:** `createPermissions({ gates })`, `askAll`/`fsPathGate`.

### B2. How did you expect to interact with it — did we cover the surface?
>
> **"Terminal, web app, cron, or called from your code?"**
> **Why:** the most-forgotten brick is the interface. An agent without an
> input surface (or without `createDefaultInputs`) receives nothing that
> means anything. **Wire:** REPL / HTTP / batch / embedded per answer.

### B3. It's going to run long — did you forget the compaction strategy?
>
> **"If it runs marathon sessions, what happens when context fills?"**
> **Why:** nothing destroys a long-lived agent like the context window
> blowing mid-run. **Wire:** `createCompaction` (summarize in place) vs
> `createCompactHandover` (summarize → fresh start).

### B4. Does it need to survive crashes or resume work?
>
> **"What happens if the machine restarts mid-run?"**
> **Why:** "survive a crash" is literally one brick. **Wire:**
> `jsonlSession(...)` + `restoreInto(agent)` + `session.plugin`.

### B5. Does it run unattended? — do you want guardrails?
>
> **"Batch/cron, no human watching?"**
> **Why:** unattended runs need budgets and doom-loop detection.
> **Wire:** `loopControl({ maxTurns, doom })`.

### B6. Knowledge: skills, rules, AGENTS.md — do you want any of these?
>
> **"Will it read playbooks / project rules as it works?"**
> **Why:** the cheapest superpower; but only if they'll actually use them.
> **Wire:** `createSkillsPlugin({ dirs })`, `createRulesLoader()`,
> `createAgentsMdLoader()`.

### B7. Do you want to reuse existing tools via MCP?
>
> **"Any MCP servers already in your stack you'd like bridged in?"**
> **Why:** one `createMcp` + `init` turns an existing server into native
> tools. **Wire:** `createMcp(...)`.

### B8. Do you want visibility — logs or a dashboard?
>
> **"Do you need to watch it work?"**
> **Why:** debugging ≠ production. **Wire:** `createObserverPlugin()`
> (console) vs `createFileLog()`/`createConsoleLog()` (production) vs
> `createHttpServer` + `agentSnapshot` (dashboards).

### B9. Multi-agent? — sub-agents or a swarm?
>
> **"Will it delegate to other agents, or is it one of a fleet?"**
> **Why:** don't design multi-agent before a single loop proves useful —
> but ask so they know it exists. **Wire:** `agentAsTool`/`createSubAgents`
> (same process) vs `@sanityloop/swarm` (many machines).

### B10. Custom hooks — anything you want to happen *around* the loop?
>
> **"Any side behavior — streaming to a UI, saving every tool result,
> reacting to 'stop'?"**
> **Why:** this is the 'write your own custom hooks' door.
> **Wire:** `agent.addFilter({ event, id, priority, fn })` on any `EVENTS`
> (`beforeTool`, `afterTool`, `textDelta`, `inputReceived`, `stop`, …).

### B11. Cost — long sessions with a big model?
>
> **"Is prompt cost a concern?"**
> **Why:** compacting and caching shape cost. **Wire:**
> `basic-compaction`, keep the system prompt tight, stable prefix first.

---

## How to record decisions

One line per answer, e.g. a build note:

```text
agent:  nightly folder watcher
loop:   one-shot (quit-on-end) + loop-control (unattended)
surface: cron, no UI
storage: jsonlSession, resume
tools:  read + own email tool + permission(ask) on send
knowledge: none this round
compaction: basic-compaction @ 60k tokens
hooks:  afterTool → save result to state.keys["lastResult"]
```

Then write the file — one portable thing that runs anywhere node exists.
If a gap-check offer is declined, write it as a **commented block** in the
file so the user can uncomment it later — deferred ≠ forgotten.
