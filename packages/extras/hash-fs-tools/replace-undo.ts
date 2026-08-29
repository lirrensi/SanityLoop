import { readFile } from "fs/promises";
import { withFileMutationQueue } from "./compat.ts";
import { loadHashStore, upsertSnapshot, upsertUndo, getUndoEntry, deleteUndo, type UndoRecord } from "./hash-store.ts";
import { recordServedDiff } from "./served.ts";
import { contentChecksum } from "./hashline/hasher.ts";
import { resolveTarget, writeAtomic } from "./fs-write.ts";
import { toCwd } from "./paths.ts";
import { toLF, stripBOM, genDiff, restoreEndings, type LineEnding } from "./replace-diff.ts";
import { cntDiff, splitLines, errCode } from "./utils.ts";
import { loadP, loadGuide } from "./prompts.ts";
import { buildMetrics } from "./replace-response.ts";
import { changedRange, lineHashes } from "./hashline/index.ts";
import { Tool, type JsonSchema } from "@sanityloop/core";
export interface UndoEntry {
  content: string;
  bom: string;
  originalEnding: LineEnding;
  hashes: string[];
  resultContent: string;
}

export async function saveUndo(
  path: string,
  entry: UndoEntry,
): Promise<{ persisted: boolean; restore: () => Promise<void> }> {
  let previous: UndoRecord | undefined;
  try {
    const store = await loadHashStore();
    previous = getUndoEntry(store, path);
    upsertUndo(store, path, {
      content: entry.content,
      bom: entry.bom,
      ending: entry.originalEnding,
      hashes: entry.hashes,
      resultContent: entry.resultContent,
    });
  } catch (error) {
    console.error("Failed to persist undo entry:", error);
    return { persisted: false, restore: async () => undefined };
  }
  return {
    persisted: true,
    restore: async () => {
      try {
        const store = await loadHashStore();
        if (previous) upsertUndo(store, path, previous);
        else deleteUndo(store, path);
      } catch (error) {
        console.error("Failed to restore previous undo entry:", error);
      }
    },
  };
}

export async function getUndo(path: string): Promise<UndoEntry | undefined> {
  try {
    const store = await loadHashStore();
    const record = getUndoEntry(store, path);
    if (!record) return undefined;
    const originalEnding = record.ending;
    if (originalEnding !== "\r\n" && originalEnding !== "\n" && originalEnding !== "\r") {
      await deleteUndo(store, path);
      return undefined;
    }
    return {
      content: record.content,
      bom: record.bom,
      originalEnding,
      hashes: record.hashes,
      resultContent: record.resultContent,
    };
  } catch (error) {
    console.error("Failed to load undo entry:", error);
    return undefined;
  }
}

export async function clearUndo(path: string): Promise<void> {
  try {
    const store = await loadHashStore();
    deleteUndo(store, path);
  } catch (error) {
    console.error("Failed to clear undo entry:", error);
  }
}

const undoSchema: JsonSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path to the file to undo" },
  },
  required: ["path"],
};

/** Factory: build the `undo_last_replace` tool. */
export function createUndoTool() {
  return Tool.define({
    name: "undo_last_replace",
    description: `${loadP("./prompts/undo-last-replace.md")}\n\n${loadGuide("./prompts/undo-last-replace-guidelines.md").join("\n")}`,
    inputSchema: undoSchema,
    async execute(params, agent) {
      const path = (params as { path: string }).path;
      const absolutePath = toCwd(path, agent.cwd);
      const mutationTargetPath = await resolveTarget(absolutePath);

      const undo = await getUndo(mutationTargetPath);
      if (!undo) {
        return {
          answer: `No undo history for ${path}. There is no previous replace to revert.`,
          stored: { error: true },
          error: true,
          errorMessage: "no undo history",
        };
      }

      return withFileMutationQueue(mutationTargetPath, async () => {
        let currentRaw: string | undefined;
        try {
          currentRaw = await readFile(mutationTargetPath, "utf-8");
        } catch (error) {
          if (errCode(error) !== "ENOENT") throw error;
        }

        if (currentRaw === undefined) {
          await clearUndo(mutationTargetPath);
          return {
            answer: `[E_UNDO_STALE] Cannot undo last replace on ${path}: the file no longer exists. Call read() to inspect the current state.`,
            stored: { error: true },
            error: true,
            errorMessage: "E_UNDO_STALE file missing",
          };
        }
        if (currentRaw !== undo.bom + restoreEndings(undo.resultContent, undo.originalEnding)) {
          await clearUndo(mutationTargetPath);
          return {
            answer: `[E_UNDO_STALE] Cannot undo last replace on ${path}: the file was modified after the replace, so undoing would overwrite those changes. Call read() to inspect the current state.`,
            stored: { error: true },
            error: true,
            errorMessage: "E_UNDO_STALE file modified",
          };
        }

        const { text: currentStripped } = stripBOM(currentRaw);
        const currentNormalized = toLF(currentStripped);
        const currentHashes = await lineHashes(currentNormalized, mutationTargetPath);
        const diffResult = genDiff(undo.content, currentNormalized, 0, undefined, undo.hashes);
        const linesAddedByReplace = cntDiff(diffResult.diff, "+");
        const linesRemovedByReplace = cntDiff(diffResult.diff, "-");
        const restoredRange = changedRange(currentNormalized, undo.content);
        const undoDiff = genDiff(currentNormalized, undo.content, 1, undo.hashes, currentHashes).diff;

        await writeAtomic(mutationTargetPath, undo.bom + restoreEndings(undo.content, undo.originalEnding));

        try {
          const store = await loadHashStore();
          upsertSnapshot(store, mutationTargetPath, contentChecksum(undo.content), splitLines(undo.content).length, undo.hashes);
          recordServedDiff(store, mutationTargetPath, undoDiff);
        } catch (error) {
          console.error("Failed to restore hash store snapshot after undo:", error);
        }

        await clearUndo(mutationTargetPath);

        const parts: string[] = [`Undone last replace on ${path}.`];
        if (linesAddedByReplace > 0 || linesRemovedByReplace > 0) {
          parts.push(
            `Removed ${linesAddedByReplace} line(s) that were added and restored ${linesRemovedByReplace} line(s) that were removed.`,
          );
        }
        parts.push("File reverted to previous state. Call `read` to get fresh anchors for follow-up edits.");

        return {
          answer: parts.join("\n"),
          stored: {
            diff: undoDiff,
            metrics: buildMetrics({
              classification: "applied",
              editsAttempted: 1,
              noopEditsCount: 0,
              warningsCount: 0,
              firstChangedLine: restoredRange?.firstChangedLine,
              lastChangedLine: restoredRange?.lastChangedLine,
              addedLines: linesRemovedByReplace,
              removedLines: linesAddedByReplace,
            }),
          },
        };
      });
    },
  });
}
