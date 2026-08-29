// sanity/src/extras/edit/index.ts — the hashline edit suite factory.
// EXTRA = optional, import-or-not. The whole suite is a FACTORY: swap whatever
// guts you need without touching the core.
//
// STORE RULES (no files unless you ask):
//   - no store options        → IN-MEMORY store (zero disk writes; anchors,
//                               undo, served tracking work in-session)
//   - storeDir: string        → persistent SQLite at that directory
//   - store: HashStore        → your own store, full control
//   Config lives in the factory options — no config.json file, no home folder.
import { createReadTool, type ReadToolOptions } from "./read.ts";
import { createReplaceTool, type EditToolOptions } from "./replace.ts";
import { createUndoTool } from "./replace-undo.ts";
import { createMemoryHashStore, setHashStore, type HashStore } from "./hash-store.ts";
import { setConfigDir } from "./paths.ts";

export interface HashlineEditOptions extends EditToolOptions, ReadToolOptions {
  /** Your own HashStore — full control over persistence. */
  store?: HashStore;
}

/**
 * Build the read + replace + undo_last_replace suite.
 * `read` finds and anchors lines, `replace` edits by hashline anchors (stable
 * against drift), `undo_last_replace` reverts. All guts configurable.
 */
export function createEditTools(opts: HashlineEditOptions = {}) {
  // store wiring: custom store > persistent at storeDir > in-memory (default)
  if (opts.store) {
    setHashStore(opts.store);
  } else if (opts.storeDir) {
    setConfigDir(opts.storeDir);
    setHashStore(undefined); // clear override → persistent SQLite at the dir
  } else {
    setHashStore(createMemoryHashStore());
  }

  return {
    read: createReadTool(opts),
    replace: createReplaceTool(opts),
    undo: createUndoTool(),
  };
}

export * from "./read.ts";
export * from "./replace.ts";
export * from "./replace-undo.ts";
export { createMemoryHashStore, setHashStore, type HashStore } from "./hash-store.ts";
export { lineHashes, fmtRegion, HASH_SEP, MAX_HASH_LINES } from "./hashline/index.ts";
