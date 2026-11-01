# @sanityloop/code-mode

One `code` tool + persistent Python/JS kernels. The model writes cells; the
code calls tools. OMP chassis, SanityLoop seams — no core edits.

```ts
import { Agent } from "@sanityloop/core";
import { createCodeMode, buildCodeModePromptPart } from "@sanityloop/code-mode";

const agent = new Agent({ model, tools: [...] });
agent.install(createCodeMode({ persistDir: undefined })); // pure memory
agent.messages.push(buildCodeModePromptPart(agent));      // catalog block
```

## The tool

`code({ language: "py"|"js", code, timeout?, reset? })`, sequential.

- One cell per call; top-level state persists across cells until
  reset/timeout/crash. Python: `user_ns` dict. JS: retained vm context
  (`"js"` cells also accept TS — annotation-stripping only, no
  enum/namespace/parameter-properties).
- Trailing expression echoed (`=> value`). TLA cells run in an async
  wrapper — `return expr;` to echo, and top-level `const`/`let` there are
  cell-local (assign without declaring to keep them).
- `timeout` (seconds, default 60, clamp 1–3600) counts ONLY the cell's own
  work. Every bridge RPC — tool call, gate wait, `sub_await`, `%pip` —
  pauses the clock. An absolute ceiling (default 3600 s wall) always applies.
- `%magics` are rejected host-side (`%bun`/`%pip`/`%load`/`%environment`):
  v1 installs nothing, loads nothing. `%` inside a multi-line cell is a
  kernel syntax error, not magic.

## Guest calls

Per cell, stubs are generated from `visibleTools()` minus `code`:

- Python: `await tools.read(path="…")` (lazy — frame emitted on await),
  `tools.read(...).value` (blocking), `tools.call(name, args)`,
  `tools.search/help` (local, free). Optional args default to `OMIT`;
  explicit `None` is sent as JSON null.
- JS/TS: `await tools.read({ path: "…" })`, `tools.call(name, args)`.
- At most 50 calls per cell (host-counted, pre-gate). `code`, `delegate`
  and `call_tool` are blocked from cells (recursion/bypass).
- Every guest call re-enters the full wall: resolve → `beforeTool` (registry
  lane — works outside a cycle) → parked-gate wait → schema wall →
  `toolStart` → execute → `toolEnd` (both with `via: "code"`). No message is
  pushed; `afterTool` is not fired (commit patch-point, no commit here).
- A gate parked mid-cell waits for loop 1 to drain the answer; the cell
  clock is paused meanwhile. `invalid_arguments` comes back enriched with
  the cell's signature + hints (host errors verbatim).

## State & lifecycle

- Pure memory default: kernels live in the plugin closure + a `transient`
  pointer (never taped). Crash/resume = kernel gone; the next cell says so.
- `persistDir` opts the **py** kernel into a best-effort dill sidecar
  (`kernel-<id>.dill`, atomic write, interpreter-guarded). Never taped.
- Registry: key = session + cwd + language, LRU 4, idle TTL 30 min (idle
  only), monotonic generation per key. `reset: true` kills + bumps.
- Kill ladder (POSIX): SIGINT group → 5 s → SIGTERM group → 5 s → SIGKILL
  group. Spawn env is an allowlist (a cell can `printenv`).
- Output: ≤ 50 KiB whole; above → 25 KiB head + elision + 25 KiB tail, full
  text spilled to tmpdir, path in `stored.fullOutputPath`.

## Files

`protocol.ts` (wire) · `kernel.ts` (process + kill ladder) · `registry.ts`
(registry + cell runner) · `call-tool.ts` (the via:"code" callTool preset:
recursion block, then core delegation) · `clock.ts` (pausable budget) ·
`output.ts` (head+tail + spill) · `shapes.ts`/`schema-types.ts`/`stubs.ts`
(one derivation → py prelude + .d.ts) · `catalog.ts` (2k-token round-robin +
sync search) · `diagnostics.ts` (InvalidToolInput format) ·
`runner/py-runner.py` · `runner/js-runner.mjs`.

## Core seam (landed)

Guest calls go through `agent.callTool(name, args, { via: "code", depth: 1 })`
— the universal wall (gate → park-wait → schema → execute → toolEnd).
`call-tool.ts` is only the preset: recursion block (`code`, `delegate`,
`call_tool`), then delegation. The permission OOB gap is closed in core
(`activeCall` rendezvous), and `call_tool`'s old bypass is gone with it.
