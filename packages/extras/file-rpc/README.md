# @sanityloop/file-rpc

A file-backed RPC channel — any process talks to any agent through a shared
dir. No pipes, no ports, no daemon, cron-safe.

```ts
import { Agent } from "@sanityloop/core";
import { createFileRpc } from "@sanityloop/file-rpc";

agent.install(createFileRpc({ dir: "/var/run/my-lobby" }));
```

## Layout

One room per agent id inside the lobby:

```
<lobby>/<agent.id>/live.json              aliveness card (pid, loopState, …)
<lobby>/<agent.id>/inbox/                  command files `req-<uuid>.json`
<lobby>/<agent.id>/processed/              handled commands (receipts)
<lobby>/<agent.id>/processed/failed/        malformed / oversized commands
<lobby>/<agent.id>/outbox/events.jsonl     responses + voices (append-only)
```

Dir resolution: explicit `dir` > `sessionDir + "/rpc"` > `mkdtemp` ephemeral
(best-effort `rm` on uninstall/exit). Session-nested and explicit dirs are
never deleted by the plugin. `state.rpc = { lobby, room }` while installed.

## Wire format (the canon)

**Command** — `{ id?, type, ... }`, dropped via tmp+rename into `inbox/`:

| `type` | fields | effect |
|---|---|---|
| `input` | `body` (an input with string `type`) | `agent.input(body)` verbatim |
| `input_*` | rest = the input | `agent.input({ type, ...rest })` verbatim |
| `control` | `op`: `stop`\|`abort`\|`pause`\|`wake` | the loop control call |
| `health` | — | `{ ok, pid, loopState, runState, time }` |
| `get_state` | `keys?`: dotted paths (`state.todos`) | picked state doc (missing → null) |
| `awaits` / `questions` | — | the parked queues, read-only |
| `tools` / `capabilities` | — | schemas / declared capabilities |
| anything else | — | **ignored**: moved to `processed/`, no reply |

**Response** — every handled command with an `id` appends one pi-shaped record:

```json
{ "id": "abc", "type": "response", "command": "health", "success": true, "data": { "ok": true } }
{ "id": "abc", "type": "response", "command": "control", "success": false, "error": "unknown op: dance" }
```

Malformed JSON (or a missing string `type`) appends an id-less
`{ type:"response", command:"parse", success:false, error }` and the file moves
to `processed/failed/`. Payloads over 1 MiB are rejected the same way (the
sender's `id` is recovered best-effort from the file head so its wait can
correlate the rejection). `*.tmp` files are never picked up.

**Voice** — `{ type:"event", event, payload, ts }`. Stream voices
(`streamStarted`, `textDelta`, `textEnd`, `thinkingDelta`, `thinkingEnd`,
`toolcallDelta`) and lifecycle voices (`agentStart`, `agentEnd`,
`agentSettled`, `turnStart`, `turnEnd`, `error`) share the same `events.jsonl`.
`agentSettled` = done-done (the loop fully landed); `agentEnd` = one run.

## Sender

```ts
import { sendCommand, listRooms } from "@sanityloop/file-rpc/sender";

const res = await sendCommand(lobby, { body: { id: "a", type: "health" } });
// → { id:"a", type:"response", command:"health", success:true, data:{…} }
```

Room resolution: explicit `to` (matches `id` or `agentId`) · omitted + one
room → it · omitted + many → `FileRpcError` code `ROOMS_AVAILABLE` (exit 2 in
the CLI — re-run with `--to`). `listRooms` flags dead-pid rooms (`live:false`)
instead of hiding them. The response wait tails from the pre-drop end-offset
(default 10s timeout).

CLI (`node --experimental-strip-types cli.ts`):

```
file-rpc --lobby DIR [--to ROOM] --type TYPE [--id ID] [--body JSON] [--keys a,b] [--timeout MS] [--no-wait]
file-rpc --lobby DIR --rooms
file-rpc --lobby DIR [--to ROOM] --stdin < command.json
```

## Cron recipe

```sh
# the long process claims its room once (keep-open, detached — no pipe held)
node --experimental-strip-types my-agent.ts  # installs createFileRpc({ dir: /var/run/lobby })
# any later cron step reaches it:
node --experimental-strip-types node_modules/@sanityloop/file-rpc/cli.ts \
  --lobby /var/run/lobby --to my-agent-id --type input_followup --body '{"text":"nightly run"}'
```

## Options

`createFileRpc({ dir?, sessionDir?, heartbeatMs = 15000, pollMs = 1000 })`.
`heartbeatMs: 0` disables the `live.json` timer (lifecycle rewrites stay);
`pollMs: 0` disables the inbox re-scan (`fs.watch` stays primary).
