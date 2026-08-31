// sanity/src/extras/basic/edit.ts — the SIMPLE edit: exact string replace.
// No hashes, no anchors, no store, no undo. Read first, then replace text.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Tool, type JsonSchema } from "@sanityloop/core";
import { writeAtomic } from "./atomic.ts";

const editSchema: JsonSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
    old_string: { type: "string", description: "The exact text to find and replace" },
    new_string: { type: "string", description: "The replacement text" },
    multiple: {
      type: "boolean",
      description:
        "If true, replace ALL occurrences of old_string. Default false — errors when old_string matches multiple times so you don't silently clobber the wrong spot.",
    },
  },
  required: ["path", "old_string", "new_string"],
};

/** Factory: build the simple `edit` tool. */
export function createEditTool() {
  return Tool.define({
    name: "edit",
    description:
      "Edit a file by exact string replacement. Call read() first to see exact content. " +
      "Errors if old_string is not found, or matches multiple times (pass multiple:true to replace all).",
    promptSnippet: "Edit a file by exact string replacement",
    promptGuidelines: [
      "Call read() first — old_string must match the current content exactly.",
      "If old_string matches multiple times, use a more specific old_string; pass multiple:true only when replacing every occurrence is intended.",
      "For surgical changes prefer edit over write (write is a full-file rewrite).",
    ],
    executionMode: "sequential",
    inputSchema: editSchema,
    async execute(params, agent) {
      const { path: p, old_string, new_string, multiple } = params as {
        path: string;
        old_string: string;
        new_string: string;
        multiple?: boolean;
      };
      const absolute = path.isAbsolute(p) ? p : path.resolve(agent.cwd, p);
      const raw = await readFile(absolute, "utf8");

      const matches = raw.split(old_string).length - 1;
      if (matches === 0) {
        return {
          answer: `Edit failed: old_string not found in ${p}. Call read() to inspect the current content.`,
          stored: { error: "not-found" },
          error: true,
          errorMessage: "old_string not found",
        };
      }
      if (matches > 1 && !multiple) {
        return {
          answer: `Edit failed: old_string matches ${matches} times in ${p}. Pass multiple:true to replace all, or use a more specific old_string.`,
          stored: { error: "multiple-matches", matches },
          error: true,
          errorMessage: "old_string matches multiple times",
        };
      }

      const result = multiple ? raw.split(old_string).join(new_string) : raw.replace(old_string, new_string);
      await writeAtomic(absolute, result);
      return { answer: `Successfully edited ${p}: ${matches} replacement(s).`, stored: { replacements: matches } };
    },
  });
}
