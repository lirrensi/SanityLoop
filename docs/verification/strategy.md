---
node_type: verification
title: Sanity Verification Strategy
status: active
updated: 2026-08-23
tags: [verification, testing]
links:
  depends_on: [/overview/product.md, /architecture/core.md, /reference/events.md, /reference/state.md, /reference/api.md, /reference/extensions.md]
  verifies: [/overview/product.md, /architecture/core.md, /reference/events.md, /reference/state.md, /guides/cookbook.md]
---

# Sanity Verification Strategy

## Purpose and Scope

"Works" for SanityLoop means: **the docs match the code, the code matches the
doctrine, and the recipes a stranger follows actually run.** This strategy is
the anti-drift guarantee — the thing that makes the 100-people-no-forks
promise hold. Verification here is broader than a test pass: it is
doc↔code↔doctrine coherence.

The project is at SDK stage: an npm-workspaces monorepo (core + one package
per extra), source-distributed TypeScript, run with
`node --experimental-strip-types`. There IS a permanent test suite — a `test/`
folder inside each package, driven by `npm test` at the root (112 tests, node's built-in runner)
— but NO CI yet. This strategy documents what is checked, how, by which
command, and the honest gaps.

## System Surfaces

| Surface | What must be verified | Primary evidence |
| --- | --- | --- |
| Core loops (two clocks) | loop 1 drains inputs under the literal `blocked` flag; loop 2 steps one unit per beat; derived `loopState` (incl. `stopped`); no breaks except terminate() (run() resolves, heart stops); terminal paths incl. `terminated` | `packages/core/test/*` + template runs |
| The block flag | literal `blocked` observable: raised by pending awaits, dropped by the answer, worker frozen while true | `packages/core/test/agent-state.test.ts` (V-BLOCK) |
| Event contract | the 38 events exist; dispatch lanes (cycle vs registry); sealed-phase deferral of `toolUpdate`/`toolListChanged` | `packages/core/test/events.test.ts`, `filter-bus.test.ts` |
| State / observer | any write → `KeyChange` → `patched` → tape; semantic message events; merge silence | `packages/core/test/agent-state.test.ts` |
| Persistence / restore | baseline + deltas, flush-before-restore, atomic card, version scream, torn-tail | `packages/extras/base-storage/test/storage.test.ts` |
| Crash-heal | mid-batch crash restore NEVER re-runs tools; parked restore is NOT healed (ask re-presented) | `packages/extras/base-storage/test/storage.test.ts` (V-CRASH-HEAL) |
| Extras | each plugin installs/uninstalls cleanly; permission park→answer→execute; log channel fan-in | `packages/extras/*/test/*.test.ts` |
| The inheritance promise | a subclass can override protected seams and they fire through virtual dispatch | `packages/core/test/subclass.test.ts` (V-SUBCLASS) |
| Recipes (cookbook) | every recipe runs end-to-end | the cookbook exam |
| Docs ↔ code | reference docs match `types.ts`/`agent.ts` exactly | sync pass (`sync_status` + `last_synced`) |

Absent surfaces: no browser UI (SDK stage — the state-driven UI is designed,
not built), no CI, no release pipeline. The daemon/swarm era exists as code
but has no automated verification — stated honestly.

## Toolchain

| Tool | Version / source | Purpose | Evidence produced |
| --- | --- | --- | --- |
| `tsc` | typescript ^7.0.2 (root devDep) | type-check the whole workspace (`npm run typecheck`) | exit status |
| `npm test` | node's built-in runner (`node --test --test-force-exit`) over each package's `test/**/*.test.ts` (`npm test --workspaces --if-present`) | the PERMANENT suite — 112 tests across core + extras | pass/fail counts, per-test names |
| node ≥ 22.6 with `--experimental-strip-types` (+ `--experimental-transform-types` when TS-only syntax is present) | runtime | run templates + the test suite | stdout assertions, exit status |
| `@sanityloop/test-kit` | workspace package — `.` entry: bounded waits + temp dirs; `./core` entry: `StubModel` + harness (`kick`, `withDriver`, `makeAgent`); core is a peerDependency | shared fixtures for every package's suite | shared fixture code |
| `templates/simple-agent.ts` | demo agent | full lifecycle proof (permission gate → park → resume → tool → land) with a stubbed model | run output |
| `templates/repl-agent.ts` + `@sanityloop/repl` | interactive demo | REPL surface; tested inside an isolated tmux session (`tmux new-session -d -x 120 -y 40`, send-keys, capture-pane) per AGENTS.md | captured pane output |
| npm scripts | root package.json: `typecheck`, `test`, `dev`, `dev:repl`, `swarm`, `package:bun` | standard entry points | exit status |
| code-docs scripts (`index.py`, `check-no-relative.py`, `status.py`, `map.py`) | skill scripts (`~/.config/opencode/skills/code-docs/scripts/`) | INDEX.md generation + link lint + doc status reports | generated INDEX files, exit status |

## Verification Taxonomy

| Layer | What it proves here | What it does NOT prove | Tool / entry point |
| --- | --- | --- | --- |
| Static / type | the whole workspace compiles; the API surface is coherent | runtime behavior | `npm run typecheck` |
| Component (permanent) | a specific behavior works — events, filter bus, state/observer, tool contract, registries, pending, storage, permission, logs, inputs | long-run behavior, real providers | `npm test` (`packages/core/test/*`, `packages/extras/*/test/*`) |
| Integration | production-shaped runs: real subprocesses (the way users actually run templates), derived "take template, change something" agents, REAL disk effects verified post-mortem, cross-process session restore, crash hardening (provider/tool explosions land bounded — never hang) | streaming fidelity, real LLM providers (opt-in probe covers the contract) | `npm run test:e2e` (`test/e2e/*`) |
| Interactive / manual | REPL ergonomics, swarm join, dashboard reads | automation-safe regression coverage | tmux-driven REPL sessions (`test/e2e/repl-tmux.test.ts`, skip-if-no-tmux), curl `/getState` |
| Recipes | the cookbook's recipes actually run | every conceivable plugin pattern | the cookbook exam |
| Docs ↔ code | reference docs match the core source (`sync_status: verified`) | docs stay verified after the next refactor | sync pass + reindex |

There is NO CI today. The real-provider gap is CLOSED opt-in: `test/e2e/real-provider.optin.test.ts`
arms only with `SANITYLOOP_E2E_KEY` (or `OPENAI_API_KEY`) and skips cleanly otherwise.
The permanent suite covers the architecture's core promises; the e2e tier covers
process-kill scale: spawned templates, real side effects, cross-process restore,
and crash hardening. Fixed during the e2e drop: `quit-on-end`'s missing braces
(inverted exit logic — done workers hung forever); stream deltas dropped when
flushed after cycle-close (now: registry-lane dispatch + seam flush in
providerStep, cycle-independent delivery, verified by `repl-tmux.test.ts`
asserting real reply text).

## Suite Tiers

| Tier | Command | Prerequisites | Approx. runtime | Cadence / gate | Evidence |
| --- | --- | --- | --- | --- | --- |
| Fast / typecheck | `npm run typecheck` | node + `npm install` at repo root | seconds | local, after every change | exit 0 |
| The suite | `npm test` | none (stub models) | ~1.5s | local, after every change | 112 pass / 0 fail |
| E2E / burn-prevention | `npm run test:e2e` (or `npm run test:all` for both tiers) | none (stub models; tmux optional — REPL test skips without it) | ~3s | after template/extras/core changes, before shipping | subprocess exit codes, disk effects, restore reports, tmux captures |
| Opt-in real provider | `SANITYLOOP_E2E_KEY=… npm run test:e2e` | an OpenAI-compatible key (+ optional `SANITYLOOP_E2E_BASE_URL`/`_MODEL`) | seconds | when the model adapter changes | one real completion, token accounting |
| Demo | `node --experimental-strip-types templates/simple-agent.ts` | stub model (no API key) | ~1s | after core changes | lifecycle output + exit 0 |
| REPL interactive | tmux session running `npm run dev:repl` | none | minutes | when REPL/extras change | captured pane |
| Cookbook exam | `npm test`-style, per recipe | none | ~1s | when a recipe is added/changed | recipe passes |

Release gates: none yet — there is no release pipeline (tickets T-0013..T-0018
track the licensing/remote/packaging/CI/pipeline work). The doctrine, the
suite, and the cookbook exam are the de-facto gates for the architecture.

## Traceability Matrix

| Claim / requirement | Check ID | Layer | Tool / command | Environment | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| One entity everywhere (`/overview/product.md` §1) | `V-CORE-001` | component | `npm test` (cookbook exam: tool mutates entity, emit reaches listener) | local | assertions | verified |
| State is truth — any write → `patched` (`/overview/product.md` §2) | `V-OBS-001` | component | `packages/core/test/agent-state.test.ts` captures `patched {key}` for state/cwd/activity | local | assertions | verified (2026-08-23) |
| Restore = baseline + deltas, flush-on-restore, atomic card, torn-tail (`/reference/state.md`) | `V-STO-001` | component | `packages/extras/base-storage/test/storage.test.ts` (round-trip + silent-restore + torn tail) | local | assertions | verified (2026-08-23) |
| The 38 events exist (`/reference/events.md`) | `V-EVT-001` | static | read of `EVENTS` in types.ts during sync pass + `packages/core/test/events.test.ts` | local | sync_status + assertions | verified (2026-08-23) |
| Two clocks: loop 1 drains under block, loop 2 steps; terminal paths | `V-LOOP-001` | integration | `templates/simple-agent.ts` + permission tests | local | run output | verified (2026-08-23) |
| THE LITERAL BLOCK FLAG: awaits pin the worker until answered (`/reference/api.md`) | `V-BLOCK-001` | component | `packages/core/test/agent-state.test.ts` ("THE LITERAL BLOCK FLAG") | local | assertions | verified (2026-08-23) |
| Permission approvals execute the call; denials preResolve + audit (`/reference/extensions.md`) | `V-PERM-001` | component | `packages/extras/permission/test/permission.test.ts` (17 cases incl. silent-approval guards) | local | assertions | verified (2026-08-23) |
| Shared log channel fan-in: producer → observer + JSONL sink (`/reference/extensions.md`) | `V-LOG-001` | component | `packages/extras/log-sink/test/logs.test.ts` (10 cases) | local | assertions | verified (2026-08-23) |
| Crash-heal: partial-batch restore NEVER re-runs tools; parked restore is NOT healed (`/reference/state.md`) | `V-CRASH-HEAL-001` | component | `packages/extras/base-storage/test/storage.test.ts` (CRASH HEAL + PARKED restore) | local | assertions (spies prove zero re-execution) | verified (2026-08-23) |
| The inheritance promise: subclass can override protected seams (`/reference/api.md`) | `V-SUBCLASS-001` | component | `packages/core/test/subclass.test.ts` (override `land` + `deriveLoopState`) | local | assertions | verified (2026-08-23) |
| Recipes run (`/guides/cookbook.md`) | `V-RCP-001` | component | cookbook exam via `npm test` | local | assertions | verified (11/11 at last full run; recipes edited 2026-08-23 — re-run pending) |
| Filter throw → `handlerError`, loop survives | `V-FIL-001` | component | `packages/core/test/filter-bus.test.ts` (throw → skip + handlerError) | local | assertions | verified (2026-08-23) |
| Swarm join/server handshake | `V-SWRM-001` | manual | `npm run swarm` + a joining worker | local | observed run | missing — no scripted check |

## Environments and Test Data

- **Local:** Windows-first (pwsh), node ≥ 22.6 (24.x used), deps via
  `npm install` at the repo root. Tests use stub models — no API keys,
  deterministic. `npm test` uses `--test-force-exit` because the eternal
  clocks hold ref'd timers (the app-layer exit, as the doctrine demands).
- **CI:** none. No workflows exist. A CI gate should run `typecheck` +
  `npm test` once a workflow lands (tracked by ticket T-0017).
- **Fixtures:** session tests write to `os.tmpdir()` temp dirs (`makeTempDir`)
  and clean up via test hooks; crash tapes are hand-written to the JSONL log.
- **Real providers:** none used in verification — models are stubbed
  (`StubModel` / fake `ModelContract`). Real-provider behavior
  (streaming fidelity, retry) is UNVERIFIED.

## Failure Interpretation

1. A failing test means the behavior changed or the test was wrong — read the
   assertion, check the code path, fix the right one (the cookbook exam
   philosophy: fix the architecture, not the recipe — or vice versa).
2. Docs ↔ code mismatch: the code was just refactored, or a doc was written
   from memory. Re-run the sync pass; update the doc (or write
   `code-flags.md` if the doc is right) and reset `sync_status`.
3. `tsc` failure after an extras change usually means the GodObject surface
   drifted — reconcile the interface, don't cast around it.
4. A hang in `npm test` usually means a test awaited a turn without starting
   the heartbeat (`kick`) or the waits sampled before the clock advanced —
   use the clock-aware helpers (`awaitLanded`), never raw `loopState` sampling.

## Coverage Gaps and Risks

| Gap / risk | Affected claim | Consequence | Compensating check or next action | Owner / status |
| --- | --- | --- | --- | --- |
| No CI | everything | nothing runs on commit | wire `typecheck` + `npm test` into a workflow | open (ticket T-0017) |
| No real-provider test | streaming, retries, adapters | provider quirks unverified | a llama.cpp-style local-model proof (done once, not maintained) | open |
| Crash-heal tested at component scale, not process-kill scale | V-CRASH-HEAL | OS-level kill mid-batch unproven | a subprocess-kill e2e test | open |
| Swarm unverified by script | V-SWRM-001 | fleet regressions silent | script a boot+join smoke | open |
| Docs can drift again | docs ↔ code | the anti-drift guarantee weakens | sync passes when the breadcrumb gap grows past ~10 commits | process |
| W2 recoverable-error seam not built | `/architecture/core.md` error path | errors are terminal-only | W2 remains the known next core change | open |

## Maintenance Triggers

Review this strategy when behavior, requirements, architecture, dependencies,
test tools, commands, CI workflows, environments, fixtures, or release gates
change. Update the traceability matrix and evidence expectations in the same
change. In particular: after ANY core refactor, re-run the doc sync and reset
`sync_status`/`last_synced` on the touched reference docs.