---
node_type: architecture
title: The Swarm — rooms, federation, and the honest mirror
status: active
updated: 2026-09-05
tags: [swarm, rooms, federation, daemon, protocol, visibility, mirror]
confidence: decided
links:
  depends_on: [/reference/events.md]
  documents: [/packages/swarm/src/]
  implemented_by: [/packages/swarm/src/protocol.ts, /packages/swarm/src/join/index.ts, /packages/swarm/src/server/index.ts, /packages/swarm/src/server/federate.ts, /packages/swarm/src/server/rest.ts, /packages/swarm/src/server/config.ts, /packages/swarm/src/server/spawner.ts]
  verified_by: [/packages/swarm/test/rooms.test.ts, /packages/swarm/test/join.test.ts, /packages/swarm/test/e2e.test.ts]
sync_status: verified
last_synced: 2026-09-05
---

# The Swarm — rooms, federation, and the honest mirror

`packages/swarm` is a fleet hypervisor. The **daemon** is a dumb router that
never thinks: it routes frames by address, folds lifecycle reports into derived
state, and spawns workers from templates. The **join extension**
(`createSwarmJoin`/`wireSwarm`) is the one import that couples an agent into a
swarm — without it, the agent is completely independent. One API, many
surfaces: WS frames, REST routes and the CLI all speak the same ops over the
same `FleetApi`.

Everything below is governed by the two house laws: **state is truth** (the
daemon only folds what it hears, it never invents) and **the daemon is dumb**
(it interprets a frame's shape, never its payload).

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
  (input/control/kill/restart) pass through the same check. A worker you can't
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

## Wire deltas (the whole protocol change)

| Frame | Field | Meaning |
|---|---|---|
| `register` | `room?` | worker: where I live. peer/admin: my mount point. Default `global`. |
| `broadcast` | `room?` | Optional blast-radius scope (subtree). |
| `welcome` | `swarm?` | The daemon's declared name — the handshake answer to "who are you?". Undefined = hermit. |
| `WorkerInfo` | `room?`, `address?`, `origin?` | Where it lives, its full address, `local` \| `mirrored`. |

Everything else — ops, roles, PERMS, storage, spawner — untouched. With no
flags and no `room` claims, behavior is byte-identical to the pre-rooms daemon.

## REST — the same law, no x-ray

The REST door lost its special status. A caller presents its mount point via
`?room=` or the `X-Swarm-Room` header (default `global` = see everything) and
every route — including writes — filters through the same prefix check. One
visibility rule, four doors (WS worker, WS peer/admin, REST, CLI), zero
special cases.

## Agents: what changed for a worker

```ts
// a worker in a specific room
wireSwarm(agent, { mode: "worker", room: "global/roomMeow/room2" });

// an admin mounted high — sees every room below
wireSwarm(agent, { mode: "admin", room: "global" });

// a peer scoped to one leaf
wireSwarm(agent, { mode: "peer", room: "global/roomMeow/room2" });
```

Tools are unchanged — `swarm_send`/`swarm_control` accept a bare sessionId
(local) or a full address (mirrored) through the same `resolve()`.
`swarm/welcome` now carries the daemon's declared name, so an agent knows
which swarm it landed in.

## Verification

- `/packages/swarm/test/rooms.test.ts` — address stamping, mount filtering,
  404-for-invisible, broadcast scope, mount-as-ceiling, hermit mode, malformed
  path rejection, federation end-to-end (mirror, fold, relay, forward,
  same-sessionId-on-both-sides, no-transit, offline-follow, hermit refusal,
  collision refusal).
- `/packages/swarm/test/join.test.ts`, `/packages/swarm/test/e2e.test.ts` —
  the pre-rooms behavior, still green unchanged (the default path is
  byte-identical).
