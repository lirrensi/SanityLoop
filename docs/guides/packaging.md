---
title: Packaging — the monorepo, the names, the versions
node_type: guide
status: active
updated: 2026-08-16
tags: [packaging, monorepo, workspaces, versioning]
---

SanityLoop is an **npm-workspaces monorepo** published as **three independent
trains** — core, extras (the shelf), and swarm (its own package with a bin).

| train | version file | tag | npm package |
|---|---|---|---|
| core | `packages/core/package.json` | `core-vX.Y.Z` | `@sanityloop/core` |
| extras | `packages/extras/shelf.json` (`version` + `core` range) | `extras-vX.Y.Z` | `@sanityloop/extras` |
| swarm | `packages/swarm/package.json` | `swarm-vX.Y.Z` | `@sanityloop/swarm` |

Each train versions on its own. Extras and swarm never lockstep core: extras
declares the minimum core it supports (`"core": "^0.3.0"` in `shelf.json`);
swarm declares its own core range plus its own deps (`croner`, `ws`) in
`packages/swarm/package.json`. Bump core only when core itself changed.
Release flow per train: `npm run release:<train>` bumps the version file
(lockfile sync for core + swarm), commits, pushes main, tags
`<train>-vX.Y.Z` — the tag is the publish trigger (`publish.yml` validates
the tag against that train's version file and publishes only that train).
On a core minor/major, `release.ts` also sweeps every workspace
`@sanityloop/core` range plus `shelf.json:core` to the new `^x.y.0`.

## Layout

```
SanityLoop/
├── package.json                 # private root, workspaces: ["packages/*", "packages/extras/*"]
├── tsconfig.base.json
├── packages/
│   ├── core/                    # @sanityloop/core  — zero runtime deps
│   │   └── src/{index.ts, core/v1/*}
│   ├── swarm/                   # @sanityloop/swarm — daemon hub + join + `swarm` bin
│   │   └── src/{index.ts, server/*, join/*} + bin/swarm.js
│   └── extras/
│       ├── shelf.json          # the shelf version + minimum supported core range
│       ├── util/               # subpath @sanityloop/extras/util
│       ├── repl/               # subpath @sanityloop/extras/repl
│       └── ...                 # one folder per brick → one subpath import
├── templates/                  # example agents — import by package name
└── docs/
```

`packages/*` covers `core` + `swarm` + the `extras` folder; `packages/extras/*`
covers every shelf brick. **Adding a new shelf brick = drop a folder in
`packages/extras/`** — it becomes a bundled subpath automatically. Swarm is
NOT a shelf brick: it has its own `package.json` (own version, own deps,
`bin`), and `bundle.ts` stages it to `.publish/pkgs/swarm` untouched.

## Names

- **Core:** `@sanityloop/core` (zero deps, the god object + loop + types).
- **Extras:** `@sanityloop/extras` — one package, every brick a subpath
  (`@sanityloop/extras/repl`, `@sanityloop/extras/shell-tool`, …).
- **Swarm:** `@sanityloop/swarm` — its own package (daemon hub + join
  extension + `swarm` bin), installable alone: `npx @sanityloop/swarm`.
- Scope `@sanityloop` is chosen because `sanity` and `@sanity` are owned on npm
  by the Sanity CMS — the scope dodges that collision entirely.

## Import surface

```ts
import { Agent, SimpleModel, Tool, EVENTS } from "@sanityloop/core";
import { createReplPlugin } from "@sanityloop/extras/repl";
import { createBashPlugin, globTool } from "@sanityloop/extras/shell-tool";
import { wireSwarm } from "@sanityloop/swarm";
```

Cross-brick deps are bundled at publish: `bundle.ts` copies each shelf brick
under `extras/<brick>/` and rewrites `@sanityloop/x` imports to relative
subpaths (core stays external — extras depends on it). The swarm stage keeps
its own `package.json` as-is: its only `@sanityloop` dep is core, which stays
external too. `npm i @sanityloop/extras` pulls core + light libs and
**nothing else** — no croner, no ws, no MCP SDK — unless you import those
subpaths.

> The node_modules you get locally (after `npm install` at the repo root) is
> the *whole* workspace, so it does contain every extra's deps. That is the
> workshop. External consumers who `npm i` only the packages they import get
> only those packages' deps.

## Versioning — one train per package, import-path majors

Each train versions independently (core `0.3.0`, extras `0.3.0`, swarm `0.2.0`
today — they coincide by history, not by contract). To release: `npm run
release:<core|extras|swarm>` (bumps that train's version file, tags
`<train>-vX.Y.Z`, CI publishes only that train). Never bump a train because
another one moved.

The **API major lives in the import path**, not in the package version:

- `@sanityloop/core` → the newest major (today: v1).
- `@sanityloop/core/v1` → an explicit, frozen major. Old majors stay on disk
  forever, un-migrated — the import IS the version. v2 will be a new
  `packages/core/src/core/v2/` folder + a `"./v2"` export; v1 keeps resolving.

Shelf bricks don't get folder majors (their `createX()` factory surface is
stable); if a brick ever breaks API, give it the same treatment.

## Ship as-is

Packages export their `src/*.ts` directly (`exports: { ".": "./src/index.ts" }`)
and ship **TypeScript source** — no build step. Consumers on Node 22.6+ run it
natively; older Node / bundlers need TS-aware config (`--experimental-strip-types`,
`tsx`, or a bundler that strips types). Swarm ships `src/` + `bin/` (`files:
["src", "bin"]`): the `swarm` bin resolves `../src/server/cli.ts` relative to
itself, so it works from the installed layout with no build.
