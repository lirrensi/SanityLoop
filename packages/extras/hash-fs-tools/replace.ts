// sanity/src/extras/hash-fs-tools/replace.ts — the `replace` (edit) tool, adapted from
// pi-hashline-edit-pro. Stripped of TUI rendering (out of our contract),
// pi registerTool → Tool.define factory, TypeBox → plain JSON Schema,
// withFileMutationQueue vendored in compat.ts.
import { constants } from "fs";
import {
  genDiff,
  restoreEndings,
  type LineEnding,
} from "./replace-diff.ts";
import { readNormFile, safeSnapId } from "./file-reader.ts";
import { normReq } from "./replace-normalize.ts";
import { isRec, rejectUnknownFields, abortIf } from "./utils.ts";
import { resolveTarget, writeAtomic } from "./fs-write.ts";
import {
  applyEdit,
  lineHashes,
  resEdit,
  parseHashRef,
  MAX_HASH_LINES,
  RangeStaleError,
  AnchorMismatchError,
  type HEdit,
  type NEdit,
} from "./hashline/index.ts";
import { toCwd } from "./paths.ts";
import {
  buildChanged,
  buildNoop,
  type RMeta,
  type RMetrics,
} from "./replace-response.ts";
import { loadP, loadGuide } from "./prompts.ts";
import { saveUndo } from "./replace-undo.ts";
import { loadHashStore, findSnapshotPaths, type HashStore } from "./hash-store.ts";
import { getServed, recordServedSafe, recordServedDiffSafe } from "./served.ts";
import { withFileMutationQueue } from "./compat.ts";
import { Tool, type JsonSchema } from "@sanityloop/core";

// ---- factory knobs ---------------------------------------------------------
export interface EditToolOptions {
  /** Where the hash store + config live. Default: ~/.config/pi-hashline-edit-pro */
  storeDir?: string;
  /** Override the max hashable lines for edit-target files. */
  maxHashLines?: number;
}

// ---- request shape (plain JSON Schema, our Tool contract) ------------------

const editToolSchema: JsonSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description:
        'Path to edit. Required — always provide it explicitly; it is only auto-resolved from the anchors as a fallback when omitted by mistake.',
    },
    remove_from: {
      type: "string",
      description:
        'Bare 3-char HASH only (e.g. "aB3") — copy just the hash from the leftmost column of a read row like `aB3│content`; never the line content. Marks the FIRST line to remove (inclusive)',
    },
    remove_to: {
      type: "string",
      description:
        'Bare 3-char HASH only (e.g. "aB3") — copy just the hash from the leftmost column of a read row like `aB3│content`; never the line content. Marks the LAST line to remove (inclusive)',
    },
    replacement_text: {
      type: "string",
      description:
        'Replacement text as a single string with \\n line separators; every \\n separates lines, so a trailing \\n adds a final empty line. Mirror the removed lines exactly, blank lines included. A replacement that is only blank lines is written as one \\n per blank line. Use "" to delete the range.',
    },
  },
  required: ["remove_from", "remove_to", "replacement_text"],
  additionalProperties: false,
};

export type ReqParams = {
  path: string;
  remove_from: string;
  remove_to: string;
  replacement_text: string;
};

export type ReplaceDetails = {
  diff: string;
  firstChangedLine?: number;
  snapshotId?: string;
  classification?: "noop";
  metrics?: RMetrics;
};

interface PipelineResult {
  path: string;
  originalNormalized: string;
  result: string;
  bom: string;
  originalEnding: LineEnding;
  hadUtf8DecodeErrors: boolean;
  warnings: string[];
  noopEdit?: NEdit;
  firstChangedLine?: number;
  lastChangedLine?: number;
  originalHashes: string[];
  resultHashes: string[];
  totalAddedLines: number;
  totalRemovedLines: number;
}

const ROOT_KS = new Set(["path", "remove_from", "remove_to", "replacement_text"]);

export function assertReq(request: unknown): asserts request is ReqParams {
  if (!isRec(request)) {
    throw new Error("[E_BAD_SHAPE] Edit request must be an object.");
  }
  rejectUnknownFields(request, ROOT_KS, "Edit request");
  if (typeof request.path !== "string" || request.path.length === 0) {
    throw new Error('[E_BAD_SHAPE] Edit request requires a non-empty "path" string.');
  }
  if (
    typeof request.remove_from !== "string" ||
    typeof request.remove_to !== "string" ||
    typeof request.replacement_text !== "string"
  ) {
    throw new Error(
      '[E_BAD_SHAPE] Edit request requires "remove_from", "remove_to", and "replacement_text" at the top level.',
    );
  }
}

async function resolveMissingPath(
  request: Record<string, unknown>,
): Promise<{ path: string; warning: string } | undefined> {
  if (typeof request.path === "string") return undefined;
  const from = request.remove_from;
  const to = request.remove_to;
  if (typeof from !== "string" || typeof to !== "string") return undefined;
  const hashes: string[] = [];
  for (const ref of [from, to]) {
    try {
      hashes.push(parseHashRef(ref).hash);
    } catch {
      return undefined;
    }
  }
  let store: HashStore;
  try {
    store = await loadHashStore();
  } catch {
    return undefined;
  }
  const matches = findSnapshotPaths(store, hashes);
  if (matches.length === 1) {
    return {
      path: matches[0]!,
      warning: `[E_BAD_SHAPE] Autocorrected: missing "path" resolved to ${matches[0]} — the only file whose stored hashes contain both anchors.`,
    };
  }
  if (matches.length > 1) {
    throw new Error(
      `[E_BAD_SHAPE] Edit request requires a non-empty "path" string; the anchors match multiple known files: ${matches.join(", ")}. Include the intended path.`,
    );
  }
  return undefined;
}

export interface ExecPipelineOptions {
  accessMode?: number;
  signal?: AbortSignal;
  store?: HashStore;
  noPersist?: boolean;
}

function collectRemovedHashes(edit: HEdit, originalHashes: string[]): Set<string> {
  const removedHashes = new Set<string>();
  const startHash = edit.hash_bounds[0].hash;
  const endHash = edit.hash_bounds[1].hash;
  const startLine = originalHashes.indexOf(startHash);
  const endLine = originalHashes.indexOf(endHash);
  if (startLine >= 0 && endLine >= 0) {
    const firstLine = Math.min(startLine, endLine);
    const lastLine = Math.max(startLine, endLine);
    for (let i = firstLine; i <= lastLine; i++) {
      removedHashes.add(originalHashes[i]!);
    }
  }
  return removedHashes;
}

function countLineChanges(
  edit: HEdit,
  originalHashes: string[],
  isNoop: boolean,
  removedAutoFixes: number,
): { totalAddedLines: number; totalRemovedLines: number } {
  if (isNoop) return { totalAddedLines: 0, totalRemovedLines: 0 };
  let totalRemovedLines = 0;
  const startLine = originalHashes.indexOf(edit.hash_bounds[0].hash);
  const endLine = originalHashes.indexOf(edit.hash_bounds[1].hash);
  if (startLine >= 0 && endLine >= 0) {
    totalRemovedLines = Math.abs(endLine - startLine) + 1;
  }
  return {
    totalAddedLines: Math.max(0, edit.content_lines.length - removedAutoFixes),
    totalRemovedLines,
  };
}

export async function execPipeline(
  params: ReqParams,
  cwd: string,
  options?: ExecPipelineOptions,
): Promise<PipelineResult> {
  const path = params.path;
  const editWarnings: string[] = [];
  const edit = resEdit(
    {
      remove_from: params.remove_from,
      remove_to: params.remove_to,
      replacement_text: params.replacement_text,
    },
    editWarnings,
  );

  const hashStore = options?.store ?? (await loadHashStore());
  const { normalized: originalNormalized, bom, originalEnding, fileHashes: originalHashes, hadUtf8DecodeErrors, absolutePath } = await readNormFile(
    path,
    cwd,
    { signal: options?.signal, accessMode: options?.accessMode, maxLines: MAX_HASH_LINES, store: hashStore, noPersist: options?.noPersist },
  );

  const served = await getServed(hashStore, absolutePath);
  let anchorResult: ReturnType<typeof applyEdit>;
  try {
    anchorResult = applyEdit(originalNormalized, edit, options?.signal, originalHashes, path, served);
  } catch (error) {
    if (options?.noPersist !== true) {
      if (error instanceof RangeStaleError) {
        await recordServedSafe(absolutePath, error.rangeHashes, "range-stale feedback");
      } else if (error instanceof AnchorMismatchError) {
        await recordServedSafe(absolutePath, error.feedbackHashes, "anchor-mismatch feedback");
      }
    }
    throw error;
  }

  const result = anchorResult.content;
  const isNoop = result === originalNormalized;

  const noPersist = options?.noPersist;
  const removedHashes = isNoop ? undefined : collectRemovedHashes(edit, originalHashes);
  const resultHashes = isNoop
    ? originalHashes
    : await lineHashes(result, absolutePath, { content: originalNormalized, hashes: originalHashes, removedHashes }, hashStore, noPersist !== true);
  const warnings = [...editWarnings, ...(anchorResult.warnings ?? [])];
  const { totalAddedLines, totalRemovedLines } = countLineChanges(edit, originalHashes, isNoop, anchorResult.autoFixes?.length ?? 0);

  return {
    path,
    originalNormalized,
    result,
    bom,
    originalEnding,
    hadUtf8DecodeErrors,
    warnings,
    noopEdit: anchorResult.noopEdit,
    firstChangedLine: anchorResult.firstChangedLine,
    lastChangedLine: anchorResult.lastChangedLine,
    resultHashes,
    originalHashes,
    totalAddedLines,
    totalRemovedLines,
  };
}

/** Dry-run preview: run the pipeline without persisting, return the diff. */
export async function compPreview(request: unknown, cwd: string): Promise<{ diff: string } | { error: string }> {
  try {
    const normalized = normReq(request);
    assertReq(normalized);
    const { path, originalNormalized, result, resultHashes, originalHashes } = await execPipeline(normalized, cwd, {
      accessMode: constants.R_OK,
      noPersist: true,
    });
    if (originalNormalized === result) {
      return { error: `No changes made to ${path}. The edit produced identical content.` };
    }
    return { diff: genDiff(originalNormalized, result, 4, resultHashes, originalHashes).diff };
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Factory: build the `replace` tool with configurable guts. */
export function createReplaceTool(_opts: EditToolOptions = {}) {
  const E_DESC = loadP("./prompts/replace.md");
  const E_SNIPPET = loadP("./prompts/replace-snippet.md");
  const E_GUIDE = loadGuide("./prompts/replace-guidelines.md");

  return Tool.define({
    name: "replace",
    description: `${E_DESC}\n\n${E_GUIDE.join("\n")}`,
    promptSnippet: E_SNIPPET.trim(),
    promptGuidelines: E_GUIDE,
    executionMode: "sequential",
    inputSchema: editToolSchema,
    async execute(params, agent) {
      const canonical = normReq(params);
      const resolution = isRec(canonical) ? await resolveMissingPath(canonical) : undefined;
      if (resolution && isRec(canonical)) canonical.path = resolution.path;
      assertReq(canonical);

      const normalizedParams = canonical;
      const path = normalizedParams.path;
      const absolutePath = toCwd(path, agent.cwd);
      const mutationTargetPath = await resolveTarget(absolutePath);
      return withFileMutationQueue(mutationTargetPath, async () => {
        abortIf(agent.abortSignal);

        const {
          originalNormalized,
          originalHashes,
          result,
          bom,
          originalEnding,
          hadUtf8DecodeErrors,
          warnings,
          noopEdit,
          firstChangedLine,
          lastChangedLine,
          resultHashes,
          totalAddedLines,
          totalRemovedLines,
        } = await execPipeline(normalizedParams, agent.cwd, {
          accessMode: constants.R_OK | constants.W_OK,
          signal: agent.abortSignal,
        });

        if (resolution) warnings.unshift(resolution.warning);

        const editsAttempted = 1;
        if (originalNormalized === result) {
          const noopSnapshotId = await safeSnapId(absolutePath, "noop edit");
          return buildNoop({
            path,
            noopEdit,
            snapshotId: noopSnapshotId,
            editMeta: { editsAttempted, noopEditsCount: noopEdit ? 1 : 0, addedLines: 0, removedLines: 0 },
            warnings,
          });
        }

        if (hadUtf8DecodeErrors) {
          warnings.push("Non-UTF-8 bytes were shown as U+FFFD; this edit rewrote the file as UTF-8.");
        }

        abortIf(agent.abortSignal);
        const undo = await saveUndo(mutationTargetPath, {
          content: originalNormalized,
          bom,
          originalEnding,
          hashes: originalHashes,
          resultContent: result,
        });
        if (!undo.persisted) {
          throw new Error(
            `[E_UNDO_UNAVAILABLE] Cannot persist undo history to the hash store; the edit was NOT applied and ${path} is unchanged. Retry the replace, or use write if the store cannot be recovered.`,
          );
        }
        try {
          abortIf(agent.abortSignal);
          await writeAtomic(absolutePath, bom + restoreEndings(result, originalEnding));
        } catch (error) {
          await undo.restore();
          throw error;
        }
        const updatedSnapshotId = await safeSnapId(absolutePath, "post-edit");

        const editMeta: RMeta = {
          editsAttempted,
          noopEditsCount: noopEdit ? 1 : 0,
          firstChangedLine,
          lastChangedLine,
          addedLines: totalAddedLines,
          removedLines: totalRemovedLines,
        };

        const successInput = {
          path,
          originalNormalized,
          originalHashes,
          result,
          resultHashes,
          warnings,
          snapshotId: updatedSnapshotId,
          editMeta,
        };
        const changed = buildChanged(successInput);
        if (changed.stored.diff) {
          await recordServedDiffSafe(mutationTargetPath, changed.stored.diff, "post-edit diff");
        }
        return changed;
      });
    },
  });
}
