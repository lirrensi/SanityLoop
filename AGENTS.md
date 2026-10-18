We are building here a harness and agent SDK which is completely modular and maximally flexible. 

At this point we already have the core and most of the decisions locked and we are now in a process of making more and more extensions which govern everything. And basically this is a Lego. Everything is a Lego. And we try to build more tools and extensions to be usable. 

Currently we are on pure SDK stage where we create a pattern when the agent is a single file and it just imports important stuff inside. 

## Testing the bash tool (and anything shell-spawning)

- **Test in an ISOLATED shell, never from your own.** Your own shell session
  (pwsh) sets env vars, PATH entries, aliases, and ANSI behavior that the tool
  may inherit or misread. The tool must be proven against a clean, controlled
  terminal so you know it works "nice enough" on its own.
- **Use tmux on Windows** (installed via WinGet, `tmux 3.3.4`, works from pwsh):
  - `tmux new-session -d -s <name> -x 120 -y 40` — spawn the agent/REPL there
  - `tmux send-keys -t <name> "cmd" Enter` — drive input (works with readline)
  - `tmux capture-pane -t <name> -p` — read output
  - `tmux kill-session -t <name>` — teardown
  - Works end-to-end for the interactive REPL: spawn `repl-agent.ts` inside,
    send prompts, verify stream deltas + tool results + the `you>` re-prompt.
- Keep the throwaway smoke scripts at the repo root (e.g. `bash-smoke*.ts`),
  run them with `node --experimental-strip-types --experimental-transform-types`,
  then delete them.



## Core fucking idea, again and again how everything works. 
- Object is state, state is truth. Everything driven by state, you change one state parameter, next tick every behavior changes. State is everything. UI is drawn from state. Everything is drawn from state. You can pause, crash at any time, because state is preserved. If state is preserved you can just remove where you were running. At each point state explains everything how what's happening. You can just inspect and understand exactly what is going on. 
- Core is very light, basically stupid loop, send prompt, run couple of tools, that's it. Everything, even including input, including interrupts, including everything about the loop is by extensions. 
- Users have absolutely massive control over everything, they can change, modify as much as they can without touching the core. 99% of the cases should be able without core modification. Even so, we can just import the class, change anything, import that instead and make it work. 



## Map — read before exploring

- **The reading spine is `docs/guides/start-here.md`.** Four ordered routes:
  understand the machine / build an agent / adopt an existing one / change the SDK.
  Pick one; every route assumes the page before it.
- **The truth is five files** in `packages/core/src/core/v1/`: `types.ts`
  (vocabulary) → `agent.ts` (the two clocks, step, park, terminate) →
  `filter-bus.ts` (dispatch) → `tool.ts` (tool + batch) → `simple-model.ts`
  (the model seam). Everything else composes them. Read these before grepping.

| Task | Read first |
| --- | --- |
| add/modify an extension | `docs/reference/extensions.md`, `docs/reference/api.md` |
| touch the loop, state, or parking | `docs/architecture/core.md`, `docs/reference/state.md` |
| adopt/port an existing agent | `docs/guides/adopting.md` |
| build a new agent | `docs/guides/mini-map.md`, `templates/template-agent.ts` |
| release | `docs/guides/releasing.md` |
| verify | `docs/verification/strategy.md` — `npm run verify` |

- **Docs are an ontology** (`docs/ontology.md`). `INDEX.md` files are generated —
  never hand-edit them. `npm run docs:check` (also inside `npm run verify`) is the
  gate: frontmatter, resolving links, orphans, coverage. A behavior change updates
  its doc in the same commit.

## Releases — the contract (read `docs/guides/releasing.md` before touching this)

- **A push to main is inert.** Only `ci.yml` runs (verify). npm is NEVER touched by a push.
- **"release" means: do it end to end, silently, without asking.** Bump if needed → commit
  → push main → tag → push the tag. CI publishes to npm. Never run `npm publish` from this
  machine, never ask which tag, never ask whether to push.
- Version bumps: `npm run release:core -- --patch` / `npm run release:extras -- --minor`
  (`scripts/release.ts` does bump → commit → push → tag → push tag).
- Triggers are `core-vX.Y.Z` / `extras-vX.Y.Z` only; the workflow validates the tag against
  that package's own version file (`packages/core/package.json`, `packages/extras/shelf.json`).
- If a release fails: the symptom table in `docs/guides/releasing.md` covers the failure
  modes already paid for (credential scope, unpushed tree, silent gate, tag/version drift).
  Fix, re-tag, push — do not hand-publish to npm.

## Any changes in the core API must be confirmed by me. Do not make core changes without me understanding how it would look like. 