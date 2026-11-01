---
node_type: index
updated: 2026-11-01
---

# architecture Index

## Folder Registry

- `docs/` — 2 direct files, 0 direct subfolders, 2 files recursively; INDEX.md

## Contents

- [Core Architecture — the god object and the two clocks 🟢](core.md)

  → /overview/product.md (depends_on)
  → /reference/state.md (depends_on)
  → /reference/api.md (depends_on)
  → /packages/core/src/core/v1/ (documents)
  → /packages/core/src/core/v1/agent.ts (implemented_by)
  → /packages/core/src/core/v1/filter-bus.ts (implemented_by)
  → /packages/core/src/core/v1/types.ts (implemented_by)
  → /packages/core/src/core/v1/tool.ts (implemented_by)
  → /packages/core/src/core/v1/simple-model.ts (implemented_by)
  → /packages/core/src/core/v1/index.ts (implemented_by)
  → /packages/core/src/core/v1/token-estimate.ts (implemented_by)
  → /packages/core/src/core/v1/stats-format.ts (implemented_by)
- [The Swarm — PROCESS, TASK, AGENT, TEMPLATE and the honest mirror 🟢](swarm.md)

  → /reference/events.md (depends_on)
  → /packages/swarm/src/ (documents)
  → /packages/swarm/src/protocol.ts (implemented_by)
  → /packages/swarm/src/join/index.ts (implemented_by)
  → /packages/swarm/src/server/index.ts (implemented_by)
  → /packages/swarm/src/server/federate.ts (implemented_by)
  → /packages/swarm/src/server/rest.ts (implemented_by)
  → /packages/swarm/src/server/config.ts (implemented_by)
  → /packages/swarm/src/server/stores.ts (implemented_by)
  → /packages/swarm/src/server/templates.ts (implemented_by)
  → /packages/swarm/src/server/pm2.ts (implemented_by)

## Tags

`agent` `architecture` `blocked` `clock` `core` `daemon` `federation` `loop` `mirror` `observer` `process` `protocol` `rooms` `swarm` `task` `template` `visibility` `worker`

## Git Context

- **Commit:** `74352e0`
- **Branch:** `main`

---
*Auto-generated. Last rebuilt: 2026-11-01*
