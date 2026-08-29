// sanity/src/extras/hash-fs-tools/read.ts — the `read` tool, adapted from
// pi-hashline-edit-pro. Keeps pagination + hashline anchors + truncation.
// pi registerTool → Tool.define factory, TypeBox → JsonSchema, truncation
// utils vendored in compat.ts.
import { formatSize, truncateHead, DEFAULT_MAX_LINES, type TruncationResult } from "./compat.ts";
import { MAX_READ_LINE_BYTES } from "./constants.ts";
import { loadFileKindAndText } from "./file-kind.ts";
import { readNormFile, safeSnapId } from "./file-reader.ts";
import { lineHashes, fmtRegion, HASH_SEP, MAX_HASH_LINES } from "./hashline/index.ts";
import { toCwd } from "./paths.ts";
import { abortIf, visLines } from "./utils.ts";
import { recordServedSafe } from "./served.ts";
import { loadP, loadGuide } from "./prompts.ts";
import { valAccess } from "./validation.ts";
import { Tool, type JsonSchema } from "@sanityloop/core";

// ---- factory knobs ---------------------------------------------------------
export interface ReadToolOptions {
  /** What to return when the target is an image (we can't read images as text). */
  imageHandler?: (path: string) => { answer: string; stored?: unknown } | Promise<{ answer: string; stored?: unknown }>;
}

const R_DESC = loadP("./prompts/read.md");
const R_SNIPPET = loadP("./prompts/read-snippet.md");

function readGuide(): string[] {
  return loadGuide("./prompts/read-guidelines.md");
}

function normPosInt(value: number | undefined, name: "offset" | "limit"): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`[E_BAD_SHAPE] Read request field "${name}" must be a positive integer.`);
  }
  return value;
}

export function formatPaginationHint(
  startLine: number,
  endLine: number,
  totalLines: number,
  nextOffset: number,
  byteLimit?: number,
): string {
  const sizeSuffix = byteLimit !== undefined ? ` (${formatSize(byteLimit)} limit)` : "";
  return `[Showing lines ${startLine}-${endLine} of ${totalLines}${sizeSuffix}. Use offset=${nextOffset} to continue.]`;
}

export async function fmtReadPreview(
  text: string,
  options: { offset?: number; limit?: number },
  precomputedHashes?: string[],
  path?: string,
  maxLineBytes = MAX_READ_LINE_BYTES,
  maxTruncLines = DEFAULT_MAX_LINES,
): Promise<{ text: string; truncation?: TruncationResult; nextOffset?: number; servedHashes: string[] }> {
  const allLines = visLines(text);
  const totalLines = allLines.length;
  const startLine = normPosInt(options.offset, "offset") ?? 1;
  if (totalLines === 0) {
    if (startLine === 1) {
      const allHashes = precomputedHashes ?? (await (path ? lineHashes(text, path) : lineHashes(text)));
      const emptyLineHash = allHashes[0] ?? "";
      return {
        text: `${emptyLineHash}${HASH_SEP}\n[File is empty. Use replace to insert content.]`,
        servedHashes: emptyLineHash ? [emptyLineHash] : [],
      };
    }
    return {
      text: `Offset ${startLine} is beyond end of file (0 lines total). The file is empty. Use replace to insert content.`,
      servedHashes: [],
    };
  }
  if (startLine > totalLines) {
    return {
      text: `Offset ${startLine} is beyond end of file (${totalLines} lines total). Use offset=1 to read from the start, or offset=${totalLines} to read the last line.`,
      servedHashes: [],
    };
  }

  const limit = normPosInt(options.limit, "limit");
  const endIdx = limit ? Math.min(startLine - 1 + limit, totalLines) : totalLines;
  const selected = allLines.slice(startLine - 1, endIdx);
  const allHashes = precomputedHashes ?? (await (path ? lineHashes(text, path) : lineHashes(text)));
  const selectedHashes = allHashes.slice(startLine - 1, endIdx);
  const formatted = fmtRegion(selectedHashes, selected);
  const maxBytes = maxLineBytes;
  const rowSizes = selected.map((line, index) => ({
    lineNumber: startLine + index,
    bytes: Buffer.byteLength(`${selectedHashes[index]}${HASH_SEP}${line}`, "utf-8"),
  }));
  if (rowSizes.some((row) => row.bytes > maxBytes)) {
    const oversized = rowSizes.filter((row) => row.bytes > maxBytes);
    const rows = rowSizes.map((row, index) =>
      row.bytes > maxBytes
        ? `[Line ${row.lineNumber} is ${formatSize(row.bytes)}, exceeds ${formatSize(maxBytes)}; content not shown. Use bash: sed -n '${row.lineNumber}p' <path> | head -c ${maxBytes}]`
        : fmtRegion([selectedHashes[index]!], [selected[index]!]),
    );
    const skippedTruncation = truncateHead(rows.join("\n"), { maxBytes, maxLines: maxTruncLines });
    const shownRowCount = skippedTruncation.content === "" ? 0 : skippedTruncation.content.split("\n").length;
    const lastShownLine = shownRowCount > 0 ? startLine + shownRowCount - 1 : startLine - 1;
    const oversizedIndexes = new Set(rowSizes.map((row, index) => (row.bytes > maxBytes ? index : -1)).filter((index) => index >= 0));
    const servedHashes: string[] = [];
    for (let index = 0; index < Math.min(shownRowCount, rows.length); index++) {
      if (!oversizedIndexes.has(index)) servedHashes.push(selectedHashes[index]!);
    }
    const lineLabel = oversized.length === 1 ? `Line ${oversized[0]!.lineNumber}` : `Lines ${oversized.map((row) => row.lineNumber).join(", ")}`;
    const verb = oversized.length === 1 ? "exceeds" : "exceed";
    const addresses = oversized.map((row) => `${row.lineNumber}p`).join(";");
    const warning = `[${lineLabel} ${verb} ${formatSize(maxBytes)}; content not shown because hashline anchors require full lines. Inspect with bash: sed -n '${addresses}' <path> | head -c ${maxBytes}]`;
    let preview = skippedTruncation.content;
    let nextOffset: number | undefined;
    if (shownRowCount > 0 && (skippedTruncation.truncated || lastShownLine < totalLines)) {
      nextOffset = lastShownLine + 1;
      preview += `\n\n${warning}\n${formatPaginationHint(startLine, lastShownLine, totalLines, nextOffset, skippedTruncation.truncated ? skippedTruncation.maxBytes : undefined)}`;
    } else {
      preview += `\n\n${warning}`;
    }
    return {
      text: preview,
      truncation: skippedTruncation.truncated ? skippedTruncation : undefined,
      ...(nextOffset !== undefined ? { nextOffset } : {}),
      servedHashes,
    };
  }

  const truncation = truncateHead(formatted, { maxBytes, maxLines: maxTruncLines });

  let preview = truncation.content;
  let nextOffset: number | undefined;
  const shownCount = truncation.content === "" ? 0 : truncation.content.split("\n").length;
  const servedHashes = selectedHashes.slice(0, shownCount);
  if (truncation.truncated) {
    const endLineDisplay = startLine + truncation.outputLines - 1;
    nextOffset = endLineDisplay + 1;
    if (truncation.truncatedBy === "lines") {
      preview += `\n\n${formatPaginationHint(startLine, endLineDisplay, totalLines, nextOffset)}`;
    } else {
      preview += `\n\n${formatPaginationHint(startLine, endLineDisplay, totalLines, nextOffset, truncation.maxBytes)}`;
    }
  } else if (endIdx < totalLines) {
    nextOffset = endIdx + 1;
    preview += `\n\n${formatPaginationHint(startLine, endIdx, totalLines, nextOffset)}`;
  }

  return {
    text: preview,
    truncation: truncation.truncated ? truncation : undefined,
    ...(nextOffset !== undefined ? { nextOffset } : {}),
    servedHashes,
  };
}

const readSchema: JsonSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path to the file to read (relative or absolute)" },
    offset: { type: "integer", minimum: 1, description: "Line number to start reading from (1-indexed)" },
    limit: { type: "integer", minimum: 1, description: "Maximum number of lines to read" },
  },
  required: ["path"],
};

/** Factory: build the `read` tool with configurable guts. */
export function createReadTool(opts: ReadToolOptions = {}) {
  const imageHandler =
    opts.imageHandler ??
    ((path: string) => ({
      answer: `Cannot read ${path}: it is an image. Images are not supported by the read tool.`,
      error: true,
      errorMessage: "image file",
    }));

  return Tool.define({
    name: "read",
    description: `${R_DESC}\n\n${readGuide().join("\n")}`,
    inputSchema: readSchema,
    async execute(params, agent) {
      const { path: rawPath, offset, limit } = params as { path: string; offset?: number; limit?: number };
      const absolutePath = toCwd(rawPath, agent.cwd);

      abortIf(agent.abortSignal);
      await valAccess(absolutePath, rawPath);

      abortIf(agent.abortSignal);
      const file = await loadFileKindAndText(absolutePath, { maxLines: MAX_HASH_LINES, displayPath: rawPath });
      if (file.kind === "image") {
        return imageHandler(rawPath);
      }

      const { normalized, fileHashes, hadUtf8DecodeErrors, absolutePath: resolvedPath } = await readNormFile(rawPath, agent.cwd, {
        signal: agent.abortSignal,
        preloadedFile: file,
        maxLines: MAX_HASH_LINES,
      });
      const preview = await fmtReadPreview(normalized, { offset, limit }, fileHashes, resolvedPath);
      await recordServedSafe(resolvedPath, preview.servedHashes, "read");
      const snapshotId = await safeSnapId(absolutePath, "read");
      const previewText = hadUtf8DecodeErrors
        ? `${preview.text}\n\n[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]`
        : preview.text;

      return {
        answer: previewText,
        stored: {
          truncation: preview.truncation,
          snapshotId,
          ...(preview.nextOffset !== undefined ? { nextOffset: preview.nextOffset } : {}),
          metrics: {
            truncated: !!preview.truncation,
            ...(preview.nextOffset !== undefined ? { next_offset: preview.nextOffset } : {}),
          },
        },
      };
    },
  });
}
