// Backward-compatible shim — compact-handover is now `compaction` with
// method:"handoff". New code: `import { createCompaction } from "@sanityloop/compaction"`.
import { createCompaction as createUnified } from "@sanityloop/compaction";
import type { Plugin } from "@sanityloop/core";

export interface CompactHandoverOptions {
  /** Fraction of maxContext that triggers the handover. Default: 0.7. */
  threshold?: number;
  /** Non-system messages kept after the handover. Default: 8. */
  keepRecent?: number;
  /** Where handover meta lives in session state. Default: "handover". */
  stateKey?: string;
  /** Temp folder for the handover file. Default: <os tmpdir>/sanity-handovers. */
  dir?: string;
  /** Custom instruction for the handover request. Default: built-in prompt. */
  handoffInstruction?: string;
  /** Extra user focus appended to the handover request. */
  focus?: string;
}

export function createCompactHandover(opts: CompactHandoverOptions = {}): Plugin {
  return createUnified({
    method: "handoff",
    threshold: opts.threshold,
    keepRecent: opts.keepRecent,
    stateKey: opts.stateKey ?? "handover",
    handoff: {
      ...(opts.dir ? { dir: opts.dir } : {}),
      ...(opts.handoffInstruction ? { instruction: opts.handoffInstruction } : {}),
      ...(opts.focus ? { focus: opts.focus } : {}),
    },
  }).plugin;
}
