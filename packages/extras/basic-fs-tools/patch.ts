// sanity/src/extras/basic/patch.ts — the PATCH edit: unified-diff application.
// One file per call, one or more @@ hunks, exact context matching. No fuzz:
// a hunk that doesn't match is an honest error (re-read, regenerate), never
// a silent mis-application. Sibling of edit.ts — pick ONE per agent via
// createBasicTools({ edit: "simple" | "patch" }); see index.ts.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Tool, type JsonSchema } from "@sanityloop/core";
import { writeAtomic } from "./atomic.ts";

const patchSchema: JsonSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path to the file to patch (relative or absolute)" },
    patch: {
      type: "string",
      description:
        "Unified diff to apply: one or more @@ -oldStart[,oldCount] +newStart[,newCount] @@ hunks " +
        "with context (' '), removal ('-') and addition ('+') lines. ---/+++ headers are tolerated and ignored.",
    },
  },
  required: ["path", "patch"],
};

interface Hunk {
  /** 1-based line in the ORIGINAL file where the hunk starts. */
  oldStart: number;
  /** Lines the hunk expects to find (context + removals). */
  oldLines: string[];
  /** Lines the hunk emits (context + additions). */
  newLines: string[];
  header: string;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const clip = (s: string, n = 80): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Parse unified diff into hunks. Headers/trailers skipped, bodies strict. */
function parsePatch(patch: string): { hunks: Hunk[]; error?: undefined } | { hunks: Hunk[]; error: string } {
  const lines = patch.split("\n");
  // The patch's own trailing newline splits into a phantom "" — it is an
  // artifact, not hunk content (a real empty context line arrives as " ").
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("*** ")) { i++; continue; }
    if (line.trim() === "" && hunks.length === 0) { i++; continue; }
    const m = HUNK_RE.exec(line);
    if (!m) {
      if (line.trim() === "") { i++; continue; } // blank between hunks
      return { hunks, error: `unrecognized patch line ${i + 1}: ${clip(line)}` };
    }
    const hunk: Hunk = { oldStart: parseInt(m[1]!, 10), oldLines: [], newLines: [], header: line };
    i++;
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.startsWith("@@ ")) break; // next hunk — outer loop takes it
      if (l === "\\ No newline at end of file") { i++; continue; }
      if (l.startsWith(" ")) { hunk.oldLines.push(l.slice(1)); hunk.newLines.push(l.slice(1)); }
      else if (l.startsWith("-")) { hunk.oldLines.push(l.slice(1)); }
      else if (l.startsWith("+")) { hunk.newLines.push(l.slice(1)); }
      // Bare "" inside a hunk = empty context line. Models routinely strip
      // trailing whitespace, so " " arrives as "" — strictness here would
      // reject every patch touching a blank line.
      else if (l === "") { hunk.oldLines.push(""); hunk.newLines.push(""); }
      else if (l.startsWith("*** ")) break; // End Patch trailer
      else return { hunks, error: `bad hunk body line ${i + 1} (want ' ', '-' or '+'): ${clip(l)}` };
      i++;
    }
    if (hunk.oldLines.length === 0 && hunk.newLines.length === 0) {
      return { hunks, error: `empty hunk: ${clip(hunk.header)}` };
    }
    hunks.push(hunk);
  }
  if (hunks.length === 0) return { hunks, error: "no hunks found — patch must contain at least one @@ hunk" };
  return { hunks };
}

/** Strict positional apply. Verifies every expected line; first mismatch aborts. */
function applyHunks(
  orig: string[],
  hunks: Hunk[],
): { lines: string[]; error?: undefined } | { lines?: undefined; error: string } {
  const out: string[] = [];
  let cursor = 0; // next unconsumed original line (0-based)
  for (let hi = 0; hi < hunks.length; hi++) {
    const h = hunks[hi]!;
    const start = h.oldStart - 1; // hunk line numbers are 1-based
    if (start < 0 || start > orig.length) {
      return { error: `hunk ${hi + 1} starts at line ${h.oldStart}, file has ${orig.length} lines: ${clip(h.header)}` };
    }
    if (start < cursor) {
      return { error: `hunk ${hi + 1} overlaps the previous hunk (starts at line ${h.oldStart})` };
    }
    for (let k = cursor; k < start; k++) out.push(orig[k]!);
    cursor = start;
    for (let j = 0; j < h.oldLines.length; j++) {
      const actual = orig[cursor + j];
      const want = h.oldLines[j]!;
      if (actual !== want) {
        return {
          error:
            `hunk ${hi + 1} does not match at line ${cursor + j + 1}: ` +
            `expected ${JSON.stringify(clip(want))} but found ${JSON.stringify(clip(actual ?? "<EOF>"))}. ` +
            `Re-read the file and regenerate the patch.`,
        };
      }
    }
    out.push(...h.newLines);
    cursor += h.oldLines.length;
  }
  for (let k = cursor; k < orig.length; k++) out.push(orig[k]!);
  return { lines: out };
}

/** Factory: build the `patch` tool. */
export function createPatchTool() {
  return Tool.define({
    name: "patch",
    description:
      "Edit a file by applying a unified diff. One file per call, one or more @@ hunks. " +
      "Context must match EXACTLY — a mismatch is an error, never a guess. " +
      "Call read() first for exact line numbers and content.",
    promptSnippet: "Edit a file by applying a unified diff",
    promptGuidelines: [
      "Call read() first — hunk line numbers and context must match the current content exactly.",
      "One file per call; use multiple patch calls for multiple files.",
      "---/+++ headers are allowed but ignored; path comes from the path argument.",
      "On a mismatch error, re-read the file and regenerate the patch — do not retry the same patch.",
      "For multi-spot or large changes prefer patch over edit; for full rewrites prefer write.",
    ],
    executionMode: "sequential",
    inputSchema: patchSchema,
    async execute(params, agent) {
      const { path: p, patch: patchText } = params as { path: string; patch: string };
      const absolute = path.isAbsolute(p) ? p : path.resolve(agent.cwd, p);
      let raw: string;
      try {
        raw = await readFile(absolute, "utf8");
      } catch {
        return {
          answer: `Patch failed: ${p} does not exist or is unreadable. Use write() to create new files.`,
          stored: { error: "not-found" },
          error: true,
          errorMessage: "file not found",
        };
      }
      const parsed = parsePatch(patchText);
      if (parsed.error) {
        return {
          answer: `Patch failed: ${parsed.error}.`,
          stored: { error: "bad-patch" },
          error: true,
          errorMessage: parsed.error,
        };
      }
      const trailingNl = raw.endsWith("\n");
      const orig = raw.split("\n");
      if (trailingNl) orig.pop();
      const applied = applyHunks(orig, parsed.hunks);
      if (applied.lines === undefined) {
        return {
          answer: `Patch failed: ${applied.error}`,
          stored: { error: "mismatch" },
          error: true,
          errorMessage: applied.error,
        };
      }
      await writeAtomic(absolute, applied.lines.join("\n") + (trailingNl ? "\n" : ""));
      return {
        answer: `Successfully patched ${p}: ${parsed.hunks.length} hunk(s) applied.`,
        stored: { hunks: parsed.hunks.length },
      };
    },
  });
}
