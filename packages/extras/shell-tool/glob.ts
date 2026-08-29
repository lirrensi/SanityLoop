// sanity/src/extras/tools/glob.ts — the FIRST extra tool.
//
// EXTRA = optional, import-or-not. The core binding IS the import (core/v1).
// Engine: tinyglobby (fast, minimal, .gitignore-aware via explicit ignore).
// Shape adapted from opencode's glob.ts: default cwd, absolute output,
// result cap + truncation note, "No files found" when empty.
import { glob } from "tinyglobby";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { Tool } from "@sanityloop/core";

const RESULT_LIMIT = 100;

export const globTool = Tool.define({
    name: "glob",
    description:
        "Glob for files matching a pattern. Returns absolute paths, respects .gitignore. " +
        "Defaults to the agent's working directory. Use a specific path for speed.",
    inputSchema: {
        type: "object",
        properties: {
            pattern: {
                type: "string",
                description: "The glob pattern to match files against, e.g. \"**/*.ts\" or \"src/**/*.tsx\"",
            },
            path: {
                type: "string",
                description: "Directory to search in. If omitted, the agent's cwd is used. Must be a valid directory.",
            },
        },
        required: ["pattern"],
    },
    async execute({ pattern, path: searchPath }: { pattern: string; path?: string }, agent) {
        // agent IS the god object (the agent) — cwd is first-class on it
        const cwd = searchPath ? path.resolve(agent.cwd, searchPath) : agent.cwd;
        const ignore = await readGitignore(cwd);

        // abort() cancels the crawl — a runaway glob dies with the loop
        const files = await glob(pattern, { cwd, absolute: true, ignore, signal: agent.abortSignal });
        const truncated = files.length > RESULT_LIMIT;
        const shown = truncated ? files.slice(0, RESULT_LIMIT) : files;

        if (shown.length === 0) {
            return { answer: "No files found", stored: { count: 0, truncated: false } };
        }
        const lines = shown.map((f) => path.resolve(f));
        if (truncated) {
            lines.push("", `(Results truncated: showing first ${RESULT_LIMIT} results. Consider a more specific pattern or path.)`);
        }
        return { answer: lines.join("\n"), stored: { count: files.length, truncated } };
    },
});

/** Read .gitignore (and .git/info/exclude) → ignore patterns for the crawl. */
async function readGitignore(cwd: string): Promise<string[]> {
    const patterns: string[] = [];
    for (const file of [".gitignore", path.join(".git", "info", "exclude")]) {
        try {
            const raw = await readFile(path.join(cwd, file), "utf8");
            patterns.push(
                ...raw
                    .split("\n")
                    .map((l) => l.trim())
                    .filter((l) => l && !l.startsWith("#") && !l.startsWith("!")),
            );
        } catch {
            // no ignore file — fine
        }
    }
    return patterns;
}
