// sanity/src/extras/basic/index.ts — the SIMPLE read + edit + write suite.
// EXTRA = optional, import-or-not. Boring by default: read plain text, edit by
// exact string replace, write full files. No hashes, no store, no undo.
// For drift-proof anchor editing, see ../edit (the hashline suite).
// Each tool is ALSO importable separately: .../basic/read.ts, edit.ts, write.ts.
import { createReadTool, type BasicReadOptions } from "./read.ts";
import { createEditTool } from "./edit.ts";
import { createWriteTool } from "./write.ts";

export interface BasicToolsOptions extends BasicReadOptions {}

/** Build the simple `read` + `edit` + `write` trio. */
export function createBasicTools(opts: BasicToolsOptions = {}) {
  return {
    read: createReadTool(opts),
    edit: createEditTool(),
    write: createWriteTool(),
  };
}

export * from "./read.ts";
export * from "./edit.ts";
export * from "./write.ts";
export { writeAtomic } from "./atomic.ts";
