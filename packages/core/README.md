# @sanityloop/core

the core agent loop + SDK — zero dependencies

Part of [SanityLoop](https://github.com/lirrensi/SanityLoop) — an agent loop and SDK that does not make you insane. A tiny core, a shelf of optional modules, and you compose your agent in **one file you own**.

## Install

```sh
npm i @sanityloop/core
```

## Use

```ts
import { Agent, SimpleModel, EVENTS, Tool } from "@sanityloop/core"
```

## Runtime

Ships as TypeScript source, dependency-light on purpose. Import the TS directly and run with **Node ≥ 22.6** (type stripping, `--experimental-strip-types` on older 22.x), or with **tsx / bun** — no build step, no dist.

