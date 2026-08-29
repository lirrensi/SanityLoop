---
title: Packaging — the monorepo, the names, the versions
node_type: guide
status: active
updated: 2026-08-16
tags: [packaging, monorepo, workspaces, versioning]
---

# Packaging

SanityLoop is an **npm-workspaces monorepo**. The core is one zero-dependency
package; every extra is its own package. You install only what you import.

## Layout

```
SanityLoop/
├── package.json                 # private root, workspaces: ["packages/*", "packages/extras/*"]
├── tsconfig.base.json
├── packages/
│   ├── core/                    # @sanityloop/core  — zero runtime deps
│   │   └── src/{index.ts, core/v1/*}
│   └── extras/
│       ├── util/               # @sanityloop/util
│       ├── repl/               # @sanityloop/repl
│       ├── shell-tool/         # @sanityloop/shell-tool
│       └── ...                 # one folder per extra
├── templates/                  # example agents — import by package name
└── docs/
```

`packages/*` covers `core` + the `extras` folder; `packages/extras/*` covers
every extra. **Adding a new extra = drop a folder in `packages/extras/`** — it
becomes a linked workspace member automatically. No config edit.

## Names

- **Core:** `@sanityloop/core` (zero deps, the god object + loop + types).
- **Extras:** `@sanityloop/<name>` — versionless plugins (`@sanityloop/repl`,
  `@sanityloop/shell-tool`, …).
- Scope `@sanityloop` is chosen because `sanity` and `@sanity` are owned on npm
  by the Sanity CMS — the scope dodges that collision entirely.

## Import surface

```ts
import { Agent, SimpleModel, Tool, EVENTS } from "@sanityloop/core";
import { createReplPlugin } from "@sanityloop/repl";
import { createBashPlugin, globTool } from "@sanityloop/shell-tool";
```

Cross-extra deps are normal package deps (`repl` → `@sanityloop/util` +
`@sanityloop/snapshot`), resolved transitively. `npm i @sanityloop/repl` pulls
core + util + snapshot and **nothing else** — no elysia, no MCP SDK, no web
server — unless you import those extras.

> The node_modules you get locally (after `npm install` at the repo root) is
> the *whole* workspace, so it does contain every extra's deps. That is the
> workshop. External consumers who `npm i` only the packages they import get
> only those packages' deps.

## Versioning — one number, import-path majors

Every package shares a **single synchronized version** (currently `0.1.0`). A
release bumps every `package.json` together; there is no per-package semver
train. To bump: edit the `version` field in all `packages/*/package.json` and
`packages/extras/*/package.json` (they must match).

The **API major lives in the import path**, not in the package version:

- `@sanityloop/core` → the newest major (today: v1).
- `@sanityloop/core/v1` → an explicit, frozen major. Old majors stay on disk
  forever, un-migrated — the import IS the version. v2 will be a new
  `packages/core/src/core/v2/` folder + a `"./v2"` export; v1 keeps resolving.

Extras don't get folder majors (their `createX()` factory surface is stable);
if an extra ever breaks API, give it the same treatment.

## Ship as-is

Packages export their `src/*.ts` directly (`exports: { ".": "./src/index.ts" }`)
and ship **TypeScript source** — no build step. Consumers on Node 22.6+ run it
natively; older Node / bundlers need TS-aware config (`--experimental-strip-types`,
`tsx`, or a bundler that strips types).
