// sanity/src/extras/basic/read.ts — the SIMPLE read: plain text, line numbers.
// No hashes, no anchors, no store. Read → page through → done.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Tool, type JsonSchema } from "@sanityloop/core";
import { truncateHead, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from "@sanityloop/util";

export interface BasicReadOptions {
    maxBytes?: number;
    maxLines?: number;
}

const readSchema: JsonSchema = {
    type: "object",
    properties: {
        path: { type: "string", description: "Path to the file to read (relative or absolute)" },
        offset: { type: "integer", minimum: 1, description: "1-indexed line number to start from" },
        limit: { type: "integer", minimum: 1, description: "Maximum number of lines to read" },
    },
    required: ["path"],
};

/** Factory: build the simple `read` tool. */
export function createReadTool(opts: BasicReadOptions = {}) {
    return Tool.define({
        name: "read",
        description:
            "Read a file as plain text with line numbers. " +
            "Paged: large files return a chunk plus an offset hint to continue. " +
            "Use this BEFORE edit to see exact current content.",
        inputSchema: readSchema,
        async execute(params, agent) {
            const { path: p, offset, limit } = params as { path: string; offset?: number; limit?: number };
            const absolute = path.isAbsolute(p) ? p : path.resolve(agent.cwd, p);
            const raw = await readFile(absolute, "utf8");

            if (raw.includes("\u0000")) {
                return {
                    answer: `Cannot read ${p}: appears to be a binary file.`,
                    stored: { path: absolute },
                    error: true,
                    errorMessage: "binary file",
                };
            }

            const allLines = raw.split("\n");
            if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();
            const total = allLines.length;

            if (total === 0) {
                return { answer: "File is empty.", stored: { path: absolute, total: 0 } };
            }

            const start = offset ?? 1;
            if (!Number.isInteger(start) || start < 1 || start > total) {
                return {
                    answer: `Offset ${start} is out of range (file has ${total} lines). Use offset=1 to start, or offset=${total} for the last line.`,
                    stored: { total },
                    error: true,
                    errorMessage: "offset out of range",
                };
            }

            const selected = allLines.slice(start - 1, limit ? start - 1 + limit : undefined);
            const numbered = selected.map((line, i) => `${start + i}:${line}`);
            const text = numbered.join("\n");
            const trunc = truncateHead(text, {
                maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
                maxLines: opts.maxLines ?? DEFAULT_MAX_LINES,
            });

            let answer = trunc.content;
            let nextOffset: number | undefined;
            const shownCount = trunc.content === "" ? 0 : trunc.content.split("\n").length;
            const lastShown = start + shownCount - 1;
            if (trunc.truncated || lastShown < total) {
                nextOffset = lastShown + 1;
                answer += `\n\n[Showing lines ${start}-${lastShown} of ${total}. Use offset=${nextOffset} to continue.]`;
            }

            return { answer, stored: { path: absolute, total, nextOffset } };
        },
    });
}
