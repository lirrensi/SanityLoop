# @sanityloop/sandbox-tools

Run `read` / `edit` / `write` / `bash` **inside an existing container** while the
loop, history, and streaming stay on the host. Each tool `execute` crosses the
wall via an `ExecTransport`; fs tools talk to a read-only in-image SDK over
stdin/stdout, `bash` runs directly via `sh -lc`.

This is the per-tool complement to `@sanityloop/sandbox` + `@sanityloop/sandbox-docker`
(the one-shot whole-agent-inside execution axis): use those to launch the whole
agent in a micro-sandbox, use this to keep the loop on the host and sandbox
only the tool effects — against **any existing container** (fleet, `docker run -d`, CI).

Foreground only. No background-process API in v1.

## Quick start (layer 1 → layer 2)

Layer 1 — build the reference image and start a long-lived container:

```sh
docker build -f packages/extras/sandbox-tools/Dockerfile.sandbox.ref -t sl-sandbox:ref .
docker run -d --name my-sandbox \
  -v "$PWD:/workspace" \
  -v "$PWD/docs:/docs:ro" \
  sl-sandbox:ref sleep infinity
```

Layer 2 — import the tools in your agent (host side, loop stays in-process):

```ts
import { createSandboxedTools, cliExec } from "@sanityloop/sandbox-tools";

const tools = createSandboxedTools({
  container: "my-sandbox",
  exec: cliExec(),          // zero-dep: `docker exec -i` spawn
  containerCwd: "/workspace", // default; override per container layout
});

agent.addTool(tools.read);
agent.addTool(tools.edit);
agent.addTool(tools.write);
agent.addTool(tools.bash);
```

With dockerode (socket / remote / TLS) instead of the CLI:

```ts
import { createSandboxedTools, dockerodeExec } from "@sanityloop/sandbox-tools";

const tools = createSandboxedTools({
  container: "my-sandbox",
  exec: dockerodeExec({ socketPath: "/var/run/docker.sock" }),
});
```

`containerCwd` override (container layout differs from the agent cwd), plus
extra container-side roots (e.g. a read-only docs mount):

```ts
const tools = createSandboxedTools({ container, exec, containerCwd: "/app/work", extraContainerRoots: ["/docs"] });
```

Model-relative paths resolve against `containerCwd` inside; container-side
absolutes under `containerCwd` (or `extraContainerRoots`) pass through —
the model learned them from `pwd`; `agent.cwd`-prefixed absolutes are
rewritten to `containerCwd`; absolutes outside `agent.cwd` are rejected
before crossing (tool error result, never a throw).

## Hardening (creation-time, fleet-owned)

The tools assume the container already exists — isolation is set when the
container is **created**, not by these tools. Recommended flags for
`docker run` / your fleet's create call:

| Control | Flag | Why |
|---|---|---|
| Memory cap | `--memory 2g` | Bound runaway builds / model-driven loops |
| PID cap | `--pids-limit 256` | Bound fork bombs |
| Drop capabilities | `--cap-drop ALL` (+ `--cap-add` only what you need) | Least privilege |
| No new privileges | `--security-opt no-new-privileges` | Block setuid escalation |
| Read-only root | `--read-only --tmpfs /tmp --tmpfs /run` | Writable only where you allow |
| Read-only mounts | `-v host:container:ro` | Docs / repo visible but untouchable |
| No network | `--network none` | Air-gap when tools don't need it |
| Non-root user | `--user sbx` (baked into the ref image) | Don't run as root |

## File ownership (bind mounts)

Files the SDK creates are owned by the container user. Match it to the bind
owner or writes land root-owned on the host:

```sh
docker run -d --name my-sandbox --user "$(id -u):$(id -g)" \
  -v "$PWD:/workspace" sl-sandbox:ref sleep infinity
```

The ref image bakes user `sbx` (uid 1001); `--user` overrides it per
container. Root-owned host dirs need a `chown` first — the tools surface
EACCES as a tool error, not a crash.

## Wire protocol (v1)

fs tools pipe one JSON doc to the SDK's stdin and read one JSON doc from stdout:

```
→ {"protocol":1,"tool":"read"|"edit"|"write"|"version","args":{...}}
← {"ok":true,"result":{"answer":"...","stored":{...},"error?":true,"errorMessage?" :"..."}}
← {"ok:false,"error":"..."}   // transport-level failure only
```

A tool-level failure (missing file, `old_string` not found, binary guard) is
`ok:true` with `result.error:true` — indistinguishable from the host tools.
Only protocol violations and unexpected crashes yield `ok:false`.

On first use the host runs the `version` check; a mismatch (stale image),
tampered SDK, or dead container becomes a tool error result and the loop
lands idle — it never throws across the loop.

## v1 limits

- **Foreground only** — no `spawn`/`await`/`kill` background API (v2, after core
  builds local bg support). `ExecTransport` is shaped so a `spawn` sibling can
  be added later.
- **Dies-on-idle semantics**: the container is yours to keep (`sleep infinity`);
  stopping/removing it turns every tool call into a clean tool error.
- **Stateful tools stay host-only**: hash-fs-tools, permission, swarm/fleet
  protocol are out of scope.
- **No core changes**: `Tool.define` returns a spreadable object — this package
  wraps, never modifies.
