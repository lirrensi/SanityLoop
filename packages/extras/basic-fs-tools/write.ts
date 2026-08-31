// sanity/src/extras/basic/write.ts — the SIMPLE write: create or overwrite.
// Part of the basic set, but importable on its own:
//   import { createWriteTool } from ".../extras/basic-fs-tools/write.ts";
import path from "node:path";
import { Tool, type JsonSchema } from "@sanityloop/core";
import { writeAtomic } from "./atomic.ts";

const writeSchema: JsonSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path to the file to write (relative or absolute)" },
    content: { type: "string", description: "The full file content. Every \\n is a newline; a trailing \\n ends the file with a newline." },
  },
  required: ["path", "content"],
};

/** Factory: build the simple `write` tool. */
export function createWriteTool() {
  return Tool.define({
    name: "write",
    description:
      "Write a file with the given content — creates it or overwrites entirely. " +
      "Creates parent directories. For a NEW file or a full rewrite; " +
      "for surgical changes use edit. Call read() before overwriting a file you care about.",
    promptSnippet: "Create or overwrite files",
    promptGuidelines: [
      "Use write only for new files or complete rewrites; for surgical changes use edit.",
      "Call read() before overwriting a file you care about.",
      "A trailing \\n in content ends the file with a newline — most text files should end with one.",
    ],
    executionMode: "sequential",
    inputSchema: writeSchema,
    async execute(params, agent) {
      const { path: p, content } = params as { path: string; content: string };
      const absolute = path.isAbsolute(p) ? p : path.resolve(agent.cwd, p);
      await writeAtomic(absolute, content);
      return {
        answer: `Wrote ${p} (${content.length} chars).`,
        stored: { bytes: Buffer.byteLength(content, "utf8") },
      };
    },
  });
}
