---
node_type: architecture
title: The Swarm — PROCESS, TASK, AGENT, TEMPLATE and the honest mirror
status: active
updated: 2026-10-19
tags: [swarm, rooms, federation, daemon, protocol, visibility, mirror, process, task, agent, template]
confidence: decided
links:
  depends_on: [/reference/events.md]
  documents: [/packages/swarm/src/]
  implemented_by: [/packages/swarm/src/protocol.ts, /packages/swarm/src/join/index.ts, /packages/swarm/src/server/index.ts, /packages/swarm/src/server/federate.ts, /packages/swarm/src/server/rest.ts, /packages/swarm/src/server/config.ts, /packages/swarm/src/server/stores.ts, /packages/swarm/src/server/templates.ts, /packages/swarm/src/server/pm2.ts]
  verified_by: [/packages/swarm/test/rooms.test.ts, /packages/swarm/test/join.test.ts, /packages/swarm/test/e2e.test.ts, /packages/swarm/test/tasks.test.ts, /packages/swarm/test/processes.test.ts]
sync_status: verified
last_synced: 2026-10-19
---

# The Swarm — PROCESS, TASK, AGENT, TEMPLATE and the honest mirror

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
| **PROCESS** | a named remembered fork — long-lived, PM2-supervised, `autorestart` decides whether a crash reforks | `processes.json` (the only memory) | `start` forks now; `stop` murders the pid (desired → stopped); `restart` kills then reforks; boot reforks every `running` def |
| **TASK** | a named fire-and-die definition — `every` (interval), `at` (one-shot epoch), `manual` (only by hand) | `tasks.json` (the only memory) | `define` remembers; the 60s clock `fire`s due slots; `trigger` fires a manual run on the paused-immune path; `at` is consumed by its fire |
| **AGENT** | whoever joined — wild (no parent) or forked (parent = process name or `task:<name>#<n>`, echoed from `SWARM_SPAWN_ID`) | registry (live only) + history (every agent ever seen) | joins via `register`, reports voices, takes `input`/`control`, dies into `lastExit`/`lastResult` facts |
| **TEMPLATE** | a JSON manifest pointing at an agent file — the menu of what the daemon may spawn | `templates/` scanned at boot | `scanTemplates`/`findTemplate` resolve `from` → file; never executed by the scan itself |

Asking an agent for a pid is a category error (ask `processes`/`tasks`).
Asking a process for its voices is a category error (ask `agents`). A room is
NOT a noun — it is a path prefix on registry entries (see below).

The daemon's home holds it all: `config.json` (declared identity), the two
definition files, `templates/`, `sessions/`, `tasks/` scratch, and the scoped
PM2 state. Inner PM2 holds no recipes: no `pm2 save`, no dump resurrect — it
boots clean and the daemon submits desired state. Declarative, no ghosts.

## The TASK clock — every slot accounted for, exactly once

`fire` forks once through the same fork path as `start`, stamping
`task:<name>#<n>` as the parent. The clock's durability contract:

- **Fire identity.** `runs` + `lastSlot` (the due timestamp) identify the slot.
- **Pre-dispatch advance.** The claim — `runs++`, `nextFire` advanced (or the
  one-shot consumed), `pendingFire` stamped — is **persisted BEFORE the fork**.
  A crash after the claim leaves `pendingFire`, which boot converts into a
  **logged skip** (`lastSkipped`): never silent, never refired.
- **Grace.** Late beats stay graceful: half the period, clamped to
  `[120s, 2h]`. Inside grace a missed `every` slot fires late.
- **Catch-up.** Past grace, missed `every` slots collapse into **ONE**
  catch-up fire with the miss logged on the def (`lastCatchup`: slot, miss
  count, reason) — never a fork storm. Past-grace `at` one-shots log a skip
  instead of forking a stale moment.
- **Paused tasks never fire** — the clock skips them; `fire` on a paused task
  is refused. The manual path is `trigger`.
- **`trigger`** fires any task on the **paused-immune path** with **transient
  context** (delivered as the fork's prompt, never stored — the definition is
  untouched, schedule included). **At-most-once**: a second concurrent trigger
  while a claim is in flight is refused `busy` (WS: error frame; REST: 409)
  instead of double-firing.

```
tick: due? → claim (runs++, nextFire→, pendingFire, persist) → fork
crash between claim and fork → boot: pendingFire → lastSkipped (logged, no refire)
late ≤ grace → fire late       late > grace → ONE catch-up (every) / logged skip (at)
trigger → claim (runs++, schedule untouched, persist) → fork with context
```

The clock ticks every 60s; tests drive `tickTasks(now)` deterministically (no
fake timers — the fire path forks real processes).

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
| `AgentInfo` | `room?`, `address?`, `origin?`, `parent?` | Where it lives, its full address, `local` \| `mirrored`, fork backlink (`proc:<name>` / `task:<name>#<n>` / unset = wild). |
| `task_trigger` | `context?`, `prompt?` | Paused-immune manual run; transient context rides the fork prompt, never stored; concurrent claims refuse `busy`. |
| `list` | — | Compat alias of `agents_list` — the federation mount's wire, never advertised. |

## REST — the same law, no x-ray

The REST door lost its special status. A caller presents its mount point via
`?room=` or the `X-Swarm-Room` header (default `global` = see everything) and
every route — including writes — filters through the same prefix check. One
visibility rule, four doors (WS worker, WS peer/admin, REST, CLI), zero
special cases.

Task routes: `GET /api/v1/tasks`, `POST /api/v1/tasks`,
`GET /api/v1/tasks/:name`, `POST /api/v1/tasks/:name/fire`,
`POST /api/v1/tasks/:name/trigger {context?, prompt?}` (paused-immune,
409 when a claim is already in flight), `POST .../pause`, `POST .../resume`,
`DELETE /api/v1/tasks/:name`.

## Agents: what changed for a worker

```ts
// a worker in a specific room
wireSwarm(agent, { mode: "worker", room: "global/roomMeow/room2" });

// an admin mounted high — sees every room below
wireSwarm(agent, { mode: "admin", room: "global" });

// a peer scoped to one leaf
wireSwarm(agent, { mode: "peer", room: "global/roomMeow/room2" });
```

Admin tools: `swarm_task_define` / `swarm_task_fire` / `swarm_task_trigger` /
`swarm_task_list` alongside the proc tools; `swarm_send`/`swarm_control`
accept a bare sessionId (local) or a full address (mirrored) through the same
`resolve()`. `swarm/welcome` carries the daemon's declared name, so an agent
knows which swarm it landed in.

Operator doors: `swarm tasks define <name> <every|at|manual> [--every-ms N]
[--at EPOCH] [--from T] [--file F]`, `swarm tasks fire <name> [--prompt TEXT]`,
`swarm tasks trigger <name> [--context TEXT] [--prompt TEXT]`,
`swarm tasks pause|resume|remove|get|list`.

## Verification

- `/packages/swarm/test/rooms.test.ts` — address stamping, mount filtering,
  404-for-invisible, broadcast scope, mount-as-ceiling, hermit mode, malformed
  path rejection, federation end-to-end (mirror, fold, relay, forward,
  same-sessionId-on-both-sides, no-transit, offline-follow, hermit refusal,
  collision refusal).
- `/packages/swarm/test/join.test.ts`, `/packages/swarm/test/e2e.test.ts` —
  the pre-rooms behavior, still green unchanged (the default path is
  byte-identical).
- `/packages/swarm/test/tasks.test.ts` — durable fires: pre-dispatch advance,
  grace/catch-up, past-grace `at` skips, trigger paused-immune/transient/
  at-most-once (WS+REST), boot reconciliation of the crash window,
  kill -9 drill transcript in the phase-3 report.
- `/packages/swarm/test/processes.test.ts` — templates module, processes.json
  CRUD, atomic write-through, torn-file behavior, autorestart policy, boot
  resubmit, fleet.json migration.
