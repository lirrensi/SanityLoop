// ============================================================================
// packages/extras/code-mode/output.ts — cell output: bounded answer + spill.
// ============================================================================
// One OutputAccumulator per cell (append-after-finish throws, so never share).
// ≤ 50 KiB → shown whole. Above → 25 KiB head + elision marker + 25 KiB tail,
// full text spilled to tmpdir. The head is built from a streaming TextDecoder:
// the accumulator's spill path decodes per-chunk, so a multibyte char split
// across chunks becomes U+FFFD in the file — fine for completeness, not display.
// ============================================================================

import { OutputAccumulator } from "@sanityloop/shell-tool";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@sanityloop/util";

export const ANSWER_MAX_BYTES = DEFAULT_MAX_BYTES; // 50 KiB
const HEAD_MAX_BYTES = Math.floor(ANSWER_MAX_BYTES / 2); // 25 KiB

export interface CellOutput {
    /** Model-facing text: head [+ elision] + tail + value echo. */
    text: string;
    truncated: boolean;
    totalBytes: number;
    totalLines: number;
    fullOutputPath?: string;
}

/** Collects one cell's frames, then seals into a bounded answer. */
export class CellOutputSink {
    private readonly acc: OutputAccumulator;
    private readonly headRing: string[] = [];
    private headBytes = 0;
    private readonly decoder = new TextDecoder();
    private valueText: string | undefined;

    constructor() {
        this.acc = new OutputAccumulator({
            maxLines: DEFAULT_MAX_LINES,
            maxBytes: ANSWER_MAX_BYTES,
            tempFilePrefix: "sanity-code",
        });
    }

    /** Feed one stdout/stderr frame. */
    append(data: string): void {
        const buf = Buffer.from(data, "utf8");
        this.acc.append(buf);
        // Head ring: first 25 KiB, decoded as a stream (UTF-8 safe).
        if (this.headBytes < HEAD_MAX_BYTES) {
            const text = this.decoder.decode(buf, { stream: true });
            const room = HEAD_MAX_BYTES - this.headBytes;
            const take = text.slice(0, room);
            this.headRing.push(take);
            this.headBytes += Buffer.byteLength(take, "utf8");
        }
    }

    /** Feed raw child stderr (crash noise, ordered by arrival). */
    appendRaw(chunk: Buffer): void {
        this.acc.append(chunk);
    }

    /** The trailing-expression value, rendered by the kernel. */
    setValue(repr: string): void {
        this.valueText = repr;
    }

    /** Seal (idempotent) and compose the bounded answer. Always runs, even
     * on the kill path — partial output is the deliverable. */
    async seal(): Promise<CellOutput> {
        this.acc.finish();
        const snap = this.acc.snapshot({ persistIfTruncated: true });
        await this.acc.closeTempFile();
        let text: string;
        if (!snap.truncation.truncated) {
            text = snap.content || "(no output)";
        } else {
            const head = truncateHead(this.headRing.join(""), { maxBytes: HEAD_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
            const omitted = Math.max(0, snap.truncation.totalBytes - Buffer.byteLength(head.content, "utf8") - Buffer.byteLength(snap.content, "utf8"));
            text =
                head.content +
                `\n\n[... ${formatSize(omitted)} omitted — full output: ${snap.fullOutputPath} ...]\n\n` +
                snap.content;
        }
        if (this.valueText !== undefined && this.valueText.length > 0) {
            text += `\n=> ${this.valueText}`;
        }
        return {
            text,
            truncated: snap.truncation.truncated,
            totalBytes: snap.truncation.totalBytes,
            totalLines: snap.truncation.totalLines,
            ...(snap.fullOutputPath !== undefined ? { fullOutputPath: snap.fullOutputPath } : {}),
        };
    }
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
