
## 2026-08-23

- sync pass across the two-clock core rewrite: architecture/core.md rewritten for LOOP 1 (signal supervisor + literal `blocked` flag + derived `loopState`) and LOOP 2 (one step per beat); api.md/state.md/product.md/cookbook.md updated (no `runTurn`, `stopped` state, preResolved contract, crash-heal, the protected override seam); verification/strategy.md synced to the permanent 112-test suite (`npm test`) with V-BLOCK/V-CRASH-HEAL/V-SUBCLASS evidence; index rebuilt

## 2026-08-22

- full sync pass across a 29-commit drift gap (6b4b058 → HEAD): core architecture rewritten for the two-loops model, events/state references re-verified, cookbook API bugs fixed (addDeclaredCapability, MessageStats shape, input vocabulary), NEW reference/api.md + reference/extensions.md, verification strategy synced to monorepo reality, duplicate docs/docs/cookbook.md deprecated
- index rebuilt (see root Git Context)

## 2026-08-16

- `12:50` **index** rebuilt 19 docs across 9 folders (at commit 6b4b058)
- `19:00` **index** rebuilt 14 docs across 8 folders (at commit 81bf370)
- `12:32` **index** rebuilt 14 docs across 8 folders (at commit aca2487)
