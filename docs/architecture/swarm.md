---
node_type: architecture
title: The Swarm — PROGRAM, RUN, AGENT, TEMPLATE and the honest mirror
status: active
updated: 2026-11-03
tags: [swarm, rooms, federation, daemon, protocol, visibility, mirror, program, run, agent, template]
confidence: decided
links:
  depends_on: [/reference/events.md]
  documents: [/packages/swarm/src/]
  implemented_by: [/packages/swarm/src/protocol.ts, /packages/swarm/src/join/index.ts, /packages/swarm/src/server/index.ts, /packages/swarm/src/server/federate.ts, /packages/swarm/src/server/rest.ts, /packages/swarm/src/server/config.ts, /packages/swarm/src/server/stores.ts, /packages/swarm/src/server/templates.ts, /packages/swarm/src/server/supervisor.ts, /packages/swarm/src/server/runs.ts]
  verified_by: [/packages/swarm/test/rooms.test.ts, /packages/swarm/test/join.test.ts, /packages/swarm/test/e2e.test.ts, /packages/swarm/test/supervisor.test.ts, /packages/swarm/test/runs.test.ts, /packages/swarm/test/programs.test.ts, /packages/swarm/test/rest.test.ts, /packages/swarm/test/cli.test.ts, /packages/swarm/test/processes.test.ts]
sync_status: verified
last_synced: 2026-11-03
---

# The Swarm — PROGRAM, RUN, AGENT, TEMPLATE and the honest mirror

`packages/swarm` is a fleet hypervisor. The **daemon** is a dumb router that
never thinks: it routes frames by address, folds lifecycle reports into derived
state, and forks workers from templates. The **join extension**
(`createSwarmJoin`/`wireSwarm`) is the one import that couples an agent into a
swarm — without it, the agent is completely independent. One API, many
surfaces: WS frames, REST routes and the CLI all speak the same ops over the
same `FleetApi`.

Everything below is governed by the two house laws: **state is truth** (the
daemon only folds what it hears, it never invents) and **the daemon is dumb**
(it interprets a frame's shape, never its payload).

## The four nouns

The whole machine is four definitions plus whoever showed up:

| Noun | What it is | Where it lives | Lifecycle |
| --- | --- | --- | --- |
| **PROGRAM** | one saved table — a named remembered fork. `kind` is a preset: `service` (long-lived, respawn on crash) or `job` (scheduled/manual, overlap + catch-up + retries). Changing what a program means is a merge = PATCH (promotion, never a new verb). | `programs.json` (the only memory) | `define` remembers; `launch` forks now; `patch` merges fields (incl. `desired`/`paused`); `remove` forgets the def (in-flight runs finish, then settle as orphans) |
| **RUN** | every life — one fork, one ledger entry, uniform logs/kill/status whether it came from a service, a schedule, a manual launch, or a bare `exec`. Runs whose program was removed finish as **orphans** (settled, still readable). | `runs/<id>/` (`meta.json` + `stdout.log` + `stderr.log` + `exit.json`) | `exec` always creates one; `get`/`list`/`logs`/`wait`/`kill`/`signal` observe and stop; `save` promotes an orphan into a remembered program; `restart` reforks the same spawn; `prune` forgets old ones |
| **AGENT** | whoever joined — wild (no parent) or forked (parent = the run id echoed from `SWARM_SPAWN_ID`, carried as `AgentInfo.parent` / `spawnId=runId` backlink) | registry (live only) + history (every agent ever seen) | joins via `register`, reports voices, takes `input`/`control`, dies into `lastExit`/`lastResult` facts |
| **TEMPLATE** | a JSON manifest pointing at an agent file — the menu of what the daemon may spawn | `templates/` scanned at boot | `scanTemplates`/`findTemplate` resolve `from` → file; never executed by the scan itself |

Asking an agent for a pid is a category error (ask `programs`/`runs`).
Asking a program for its voices is a category error (ask `agents`). A room is
NOT a noun — it is a path prefix on registry entries (see below).

`programs.json` (the only memory — the two legacy definition files migrate into
it once at boot and are kept, never deleted silently), `templates/`,
`sessions/`, `runs/` ledger dirs, and `daemon.lock` (the home lock — a second
daemon on the same home refuses). The supervisor is `node:child_process`
directly (`supervisor.ts`) — one in-process supervisor, no external
supervision, no scoped state dir. Declarative, no ghosts.

## The PROGRAM clock — every slot accounted for, exactly once

The 1s clock calls `tickPrograms(now)`; tests drive `tickPrograms` directly
(no fake timers — the fire path forks real children). Cron schedules come from
croner v11 (`expr` + optional `tz`); `every` (interval, `delay`/`anchor`
variants), `at` (one-shot epoch), `manual` (launch-only) round out the kinds.
The clock's durability contract:

- **Fire identity.** `counters.runs` + `lastSlot` (the due timestamp) identify
  the slot.
- **Pre-dispatch advance.** The claim — `counters.runs++`, `lastSlot`,
  `nextFire` advanced (or the one-shot consumed), `pendingClaim` stamped — is
  **persisted BEFORE the fork**. A crash after the claim leaves
  `pendingClaim`, which boot converts into a **logged skip**: never silent,
  never refired.
- **Overlap policies.** A due slot while the program is still running resolves
  per `overlap`: `skip` (count `overlapSkipped`), `allow`, `allowN` (cap),
  `buffer1`/`bufferAll` (one queued slot / unbounded), `cancel` (kill the live
  run, start fresh), `restart` (kill + refork the same run law).
- **Catch-up.** Missed slots inside `catchupWindowMs` (explicit, else derived
  from the schedule gap) collapse into **ONE** catch-up fire per `missPolicy`
  (`fireOnce` fires once, `skip` logs and moves on) — never a fork storm.
  Past-window one-shots log a skip instead of forking a stale moment.
- **Retries.** A nonzero exit/signal on a job with `retries` forks a NEW run
  (`attempt+1`, `backoffMs` delay); `pauseOnFail` pauses the program instead of
  retrying forever.
- **Paused programs never fire** — the clock skips them. The manual path is
  **launch**: `program_launch` forks on the **paused-immune path** with
  **transient context** (delivered as the fork's prompt, never stored — the
  definition is untouched, schedule included). A concurrent claim in flight is
  refused `busy` (WS: error frame; REST: 409) instead of double-firing.
- **`triggerToken` watchdog.** When set, only a launch carrying the matching
  token fires on the watchdog path — automation proves it holds the token,
  strangers get refused.
- **`waitMs` vs `timeoutMs`.** `waitMs` is caller patience (how long
  launch/exec waits for the run before returning); `timeoutMs` is run lifetime
  (overrun → killed, settled `timedOut`).
- **Boot reconciliation.** Live runs found at boot (the daemon died mid-run)
  are marked `interrupted` + logged — never silently adopted, never refired.

```
tick: due? → claim (runs++, lastSlot, nextFire→, pendingClaim, persist) → fork
crash between claim and fork → boot: pendingClaim → logged skip (no refire)
live at boot → interrupted (logged)      overlap → skip|allow|allowN|buffer|cancel|restart
missed ≤ window → ONE catch-up (fireOnce) / logged skip (skip policy)
launch → claim (runs++, schedule untouched, persist) → fork with context
```

## The address — a room is NOT an object

There is no create-room op. **A room is a path prefix on registry entries** —
it exists exactly as long as entries live under that prefix, and disappears
when the last one leaves. Nothing is ever "mounted as a room"; entries simply
declare where they live.

```
address =  <swarm name> / <room path> / <sessionId>
            └─ stamped ─┘ └─ claimed ─┘ └─ claimed ─┘
```

- **The worker never claims which swarm it belongs to.** "Which swarm" is not
  a property of a worker — it is a property of *which daemon heard the
  register*. The daemon stamps its own declared name (`--name`, optional) onto
  every address. A letter does not choose its postmark.
- The **room path** is claimed at register (`room: "global/roomMeow/room2"`,
  normalized: slashes trimmed, `.`/`..` rejected — traversal is a config
  error, never guessed). Default: `global`.
- The **sessionId stays the routing + storage key**. It must be unique per
  daemon (it always was); it may collide across swarms, because the swarm name
  disambiguates. `myswarm/.../w1` and `swarm2/.../w1` are different addresses
  and both legal.

An unnamed daemon is a **hermit**: fully functional local swarm, addresses
degrade to `<room>/<sessionId>`, and federation is refused in BOTH directions
(a mount needs a name to stamp under; an unnamed daemon dials nobody). This is
a rule, not a bug.

## The ONE visibility rule

> **An ancestor sees its descendants. Sideways and upward: invisible.**

```
visible(viewer, room)  ⇔  room === viewer || room.startsWith(viewer + "/")
```

- A **worker** claims where it *lives* (`register.room`).
- A **peer/admin** claims where it *looks* — its mount point. Mounted at
  `global` → sees the whole tree (the "global ones see the rooms"). Mounted at
  `global/roomMeow` → sees only that subtree; `global/roomMeow/room2` → only
  the leaf.
- `list`, `get`, `events`, `history`, report fan-out, and **every write route**
  (input/control/kill/restart) pass through the same check. An agent you can't
  see **doesn't exist**: 404, not 403 — a room you can't see might as well not
  be there.
- Roles and rooms never blur: **rooms answer *where*, tokens answer *what*.**
  The PERMS table is unchanged; a mount is a hard ceiling even for an admin
  wearing one.

**Broadcast blast radius = caller's mount ∩ explicit `room` scope ∩ online.**
`broadcast { room: "global/room1" }` only reaches workers under that subtree,
filtered through the caller's own visibility. One default `swarm_broadcast`
never nukes a fleet it wasn't aimed at.

## Target resolution — two addressing modes, one door

Every op that takes a target accepts both:

- **bare sessionId** → resolved through the `bySessionId` index (works for
  everything local — today's behavior, nothing broke);
- **full address** (contains `/`) → resolved against the registry directly
  (required for mirrored workers, whose sessionIds may collide with locals).

Index precedence: **locals outrank mirrors**. If a mirrored worker's sessionId
collides with a local one, the index keeps pointing at the local worker; the
mirror remains reachable by its full address. Never ambiguous, never silent.

## Federation — the honest mirror

Two independent daemons, possibly on two machines, see each other's workers
without merging anything. The mechanism:

```
swarm serve --name myswarm --connect ws://other-machine:5317 [--as alias]
```

The daemon **dials the remote as a peer** (one WS connection, existing wire,
existing tokens), learns the remote's *declared name* from the `welcome`
handshake, and **mirrors its online workers** into its own registry:

```
A ("alpha") dials B ("beta"):

A's registry:                        B's registry:
  alpha/global/room1/alice   local     shared-id  (online)
  alpha/global/room1/shared  local
  alpha/global/beta/global/shared-id  ← mirrored
```

Mirrors live **under the root room** — `global/<mount>/...` — so the default
global mount sees them. The mount name is the remote's declared name, or
`--as` to override. This is the punchline of the whole design: **a foreign
daemon is just a room**. The room tree and the federation tree are the same
tree; visibility, blast radius and addressing all work identically on both —
because they are the same mechanism.

The four encoded rules:

1. **State is truth, relayed.** Mirrors are upserted from the remote's
   registry snapshot and advanced *only* by the remote workers' own reports,
   folded by the host's existing `LIFECYCLE_FOLD`. When A's mirror shows
   `busy`, it is because B's worker actually said so — one hop away. The
   daemon never invents mirror state, not even remotely.
2. **Offline is free.** The mount socket drops → every mirror under it flips
   `offline`. TCP is the heartbeat — no heuristics, no ghosts. On reconnect:
   backoff, re-list, re-subscribe, diff. New workers appear, forgotten workers
   are removed — the mirror follows the remote's truth, it never caches it.
3. **Authority stays home.** Input/control/kill/restart on a mirror are
   forwarded verbatim to the remote, which enforces its own tokens and PERMS.
   A can never command B's fleet harder than B allows. Mirrors are
   `spawned: false` — A correctly refuses to restart what it didn't spawn.
4. **No transit.** A mirrors B's *local* workers (`origin: "local"` on B's
   side) and skips B's own mirrors. A sees B's workers, never B's view of C.
   Want C? Dial C. No infinity mirrors, no transitive visibility.

**Name collisions refuse loudly**: a remote claiming your own name, or a name
already claimed by another mount, is refused at the mount and stays refused on
retry until `--as` changes it. Silence is how ghost topologies happen; we
don't do silence.

Federation forwarding of processes/tasks/templates ops stays parked in
`private/workerAndCronManagerRuntime/later.md` — mirrors are read-only agents
until the single-server story is fully proven.

## Wire deltas (the whole protocol change)

| Frame | Field | Meaning |
|---|---|---|
| `register` | `room?` | worker: where I live. peer/admin: my mount point. Default `global`. |
| `broadcast` | `room?` | Optional blast-radius scope (subtree). |
| `welcome` | `swarm?` | The daemon's declared name — the handshake answer to "who are you?". Undefined = hermit. |
| `AgentInfo` | `room?`, `address?`, `origin?`, `parent?` | Where it lives, its full address, `local` \| `mirrored`, fork backlink (the run id / unset = wild). |
| `program_launch` | `context?`, `prompt?`, `waitMs?`, `token?` | Paused-immune manual run; transient context rides the fork prompt, never stored; concurrent claims refuse `busy`; token must match `triggerToken` on the watchdog path. |
| `run_exec` | `spawn`, `waitMs?`, `timeoutMs?`, `name?`, `context?` | Bare fork — always creates an orphan run, no program touched. |
| `list` | — | Compat alias of `agents_list` — the federation mount's wire, never advertised. |

## REST — the same law, no x-ray

The REST door lost its special status. A caller presents its mount point via
`?room=` or the `X-Swarm-Room` header (default `global` = see everything) and
every route — including writes — filters through the same prefix check. One
visibility rule, four doors (WS worker, WS peer/admin, REST, CLI), zero
special cases.

Program routes: `GET /api/v1/programs`, `POST /api/v1/programs` (define),
`GET /api/v1/programs/:name`, `PATCH /api/v1/programs/:name` (merge +
validate = promotion), `DELETE /api/v1/programs/:name` (forget the def),
`POST /api/v1/programs/:name/launch {context?, prompt?, waitMs?, token?}`
(paused-immune, 409 when a claim is already in flight),
`GET .../preview?n=`, `GET .../logs?tailBytes=`.

Run routes: `POST /api/v1/runs/exec {spawn, waitMs?, timeoutMs?, name?,
context?}`, `GET /api/v1/runs?program=&state=&limit=`,
`GET /api/v1/runs/:id`, `GET /api/v1/runs/:id/logs?stream=&tailBytes=&offset=`,
`POST /api/v1/runs/:id/wait {match?, timeoutMs?}` (timeout → 408 + snapshot),
`POST /api/v1/runs/:id/kill {graceMs?, force?}`,
`POST /api/v1/runs/:id/signal {signal}`,
`POST /api/v1/runs/:id/save {name, kind?}` (promote an orphan),
`POST /api/v1/runs/:id/restart` (same spawn, new run),
`POST /api/v1/runs/prune {olderThanMs?, keep?}`.

## Agents: what changed for a worker

```ts
// a worker in a specific room
wireSwarm(agent, { mode: "worker", room: "global/roomMeow/room2" });

// an admin mounted high — sees every room below
wireSwarm(agent, { mode: "admin", room: "global" });

// a peer scoped to one leaf
wireSwarm(agent, { mode: "peer", room: "global/roomMeow/room2" });
```

Admin tools: `swarm_program_define` / `swarm_program_patch` /
`swarm_program_launch` / `swarm_program_remove` / `swarm_program_list` /
`swarm_program_get` / `swarm_program_preview` alongside `swarm_run_exec` /
`swarm_run_get` / `swarm_run_list` / `swarm_run_logs` / `swarm_run_wait` /
`swarm_run_kill` / `swarm_run_save` / `swarm_run_restart`;
`swarm_send`/`swarm_control` accept a bare sessionId (local) or a full address
(mirrored) through the same `resolve()`. `swarm/welcome` carries the daemon's
declared name, so an agent knows which swarm it landed in.

Operator doors: `swarm programs list|get|define|patch|launch|remove|preview|logs`
(`define <name> [--kind service|job]`, `launch <name> [--context TEXT]
[--prompt TEXT] [--wait-ms N] [--token TOK]`), `swarm runs
list|get|logs|wait|kill|signal|save|restart|prune`, `swarm exec [--wait-ms N]
[--timeout-ms N] [--name NAME] [--detach] -- <cmd> [args...]`.

## Verification

- `/packages/swarm/test/rooms.test.ts` — address stamping, mount filtering,
  404-for-invisible, broadcast scope, mount-as-ceiling, hermit mode, malformed
  path rejection, federation end-to-end (mirror, fold, relay, forward,
  same-sessionId-on-both-sides, no-transit, offline-follow, hermit refusal,
  collision refusal).
- `/packages/swarm/test/join.test.ts`, `/packages/swarm/test/e2e.test.ts` —
  the pre-rooms behavior, still green unchanged (the default path keeps the
  same wire semantics; the fork layer is now the `node:child_process`
  supervisor, not the pre-rooms spawner).
- `/packages/swarm/test/supervisor.test.ts` — fork/kill/backoff over
  `node:child_process`, crash-loop guard, home lock (`daemon.lock`).
- `/packages/swarm/test/runs.test.ts` — the run ledger: `runs/<id>/`
  layout, uniform logs/kill/status, orphans, save-promotion, restart, prune,
  `waitMs` vs `timeoutMs`.
- `/packages/swarm/test/programs.test.ts` — the program clock: pre-dispatch
  claim, overlap policies, catch-up windows + miss policies, retries /
  `pauseOnFail`, `triggerToken` watchdog, boot reconciliation (live →
  interrupted, pendingClaim → logged skip), kill -9 drill transcript.
- `/packages/swarm/test/rest.test.ts`, `/packages/swarm/test/cli.test.ts` —
  FleetApi v2 surfaces: programs + runs routes and commands over the same ops.
- `/packages/swarm/test/processes.test.ts` — templates module, definition
  CRUD, atomic write-through, torn-file behavior, migration of legacy
  definitions into `programs.json`.
