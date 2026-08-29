// sanity/src/extras/shell-tool/echo.ts — an EXTRA tool (optional, import-or-not).
//
// The extras live OUTSIDE the versioned core. Their core binding is the
// IMPORT: this file imports from core/v1, so it connects to v1. When core/v2
// breaks the contract, fork this file, change the import to core/v2, fix the
// diffs — same file, another export (echoV2), or a new file. No metadata, no
// config: the import path IS the version.
import { Tool } from "@sanityloop/core";

export const echo = Tool.define({
    name: "echo",
    description: "Echoes back the given text. Use for testing.",
    inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
    },
    async execute({ text }: { text: string }) {
        return { answer: `You said: ${text}`, stored: { length: text.length } };
    },
});
