# COMPLAINTS.md

Friction log: things that bit during real work, and what we did about it.
Closed items stay as history with a pointer to the fix.

## 2026-09-06 — swarm REST shipped untested through green CI [CLOSED]
**Context:** swarm rooms/federation release — CI publish gate failed on `tsc` over the staged extras shelf.
**Friction:** the test suite (join/e2e/rooms) never exercised `server/rest.ts`, so a genuine every-request 500 shipped straight through "10/10 green" — the mount-point block referenced `query` before its declaration (TDZ). Only the publish typecheck caught it. Same class: the WS server's initial `Connection` literal missed the new required `room` field and nothing noticed.
**Fix:** `packages/swarm/test/rest.test.ts` (REST smoke: health/list/get/input/control/auth against a live daemon); `commit 6349c2d` fixed the TDZ + missing `room`.
---

## 2026-08-21 — spawned worker crashes are silent [CLOSED]
**Context:** Building the swarm REST surface; smoke-testing a daemon-spawned template worker.
**Friction:** Spawned template workers resolve bare imports (e.g. `ws`) relative to the template file's own location. A template placed outside any `node_modules` tree (e.g. a temp home dir) crashed silently on import — the child died, the registry entry stayed `offline` forever, and nothing told you why. `stdio: "inherit"` meant the error scrolled by once in the daemon console — easy to miss.
**Fix:** `ensureNodeModulesLink` (`packages/swarm/src/server/config.ts`) junctions daemon HOME at boot so spawned workers resolve `@sanityloop/*`; spawner records `lastExit` (`packages/swarm/src/server/spawner.ts`, surfaced on `WorkerInfo` + CLI list) with exit code/signal + stderr tail, marks the entry offline on exit-before-register, and warns when a template dir has no `node_modules` up-tree. Tests in `packages/swarm/test/spawner.test.ts`.
---

## 2026-08-25 — proxied gate promise detonates (model fields) [CLOSED]
**Context:** Writing e2e tests for the loops engine — needed a model whose response waits on a manual gate.
**Friction:** Storing the gate promise on a model FIELD detonated with `TypeError: Method Promise.prototype.then called on incompatible receiver` — the Agent's observer deep-proxies everything reachable from it (model included), so `await this.gate` awaited a PROXIED promise.
**Fix:** `GatedModel` in `packages/test-kit/gated-model.ts` (exported from `@sanityloop/test-kit/core`) — closure-held gate with `release()`/`releaseAll()`/`waiting`, header documents THE RULE (closure, never field). Self-test in `packages/test-kit/test/gated-model.test.ts`. Observer left alone (core surgery for a rare case, declined).
---

## 2026-08-25 — quit-on-end terminate ignored pending work [CLOSED]
**Context:** Building the powergoal/loops prevent-exit story — needed to know exactly when quit-on-end decides to kill.
**Friction:** `createQuitOnEndPlugin` mode `"terminate"` terminated at EVERY agentEnd unconditionally — its `hasWork` guard sat AFTER the early return, so only mode `"exit"` respected pending work. The header comment ("safe when the process hosts other agents") read like a graceful idle-exit; it was actually one-shot-worker semantics.
**Fix:** unified contract — both modes stand down on `hasWork`/compacting, terminal states quit immediately (`packages/extras/quit-on-end/index.ts`). Tests in `packages/extras/quit-on-end/test/`. Owner chose behavior fix over docs.
---

## Standing note — escape regex metacharacters in shell filters
**Context (2026-08-30):** Inspecting a healthy GitHub Actions publish run; a PowerShell regex filter failed on an unescaped `+`.
**Rule:** prefer literal-string filters or escape regex metacharacters in shell inspection commands. Not code — just discipline.
---
