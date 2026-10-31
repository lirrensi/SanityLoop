// sanity/src/extras/basic/index.ts — the SIMPLE read + edit + write suite.
// EXTRA = optional, import-or-not. Boring by default: read plain text, edit by
// exact string replace, write full files. No hashes, no store, no undo.
// For drift-proof anchor editing, see ../edit (the hashline suite).
// Each tool is ALSO importable separately: .../basic/read.ts, edit.ts, patch.ts, write.ts.
import { createReadTool, type BasicReadOptions } from "./read.ts";
import { createEditTool } from "./edit.ts";
import { createPatchTool } from "./patch.ts";
import { createWriteTool } from "./write.ts";

/** Which edit tool the suite ships — ONE per agent, never both. */
export type BasicEditTool = "simple" | "patch";

export interface BasicToolsOptions extends BasicReadOptions {
  /** `"simple"` (default) → `edit` (exact string replace);
   * `"patch"` → `patch` (unified diff) INSTEAD of `edit`. */
  edit?: BasicEditTool;
}

/** Build the simple `read` + `edit` + `write` trio (`patch` instead of `edit` with `{ edit: "patch" }`). */
export function createBasicTools(opts: BasicToolsOptions = {}) {
  return {
    read: createReadTool(opts),
    edit: opts.edit === "patch" ? createPatchTool() : createEditTool(),
    write: createWriteTool(),
  };
}

export * from "./read.ts";
export * from "./edit.ts";
export * from "./patch.ts";
export * from "./write.ts";
export { writeAtomic } from "./atomic.ts";
