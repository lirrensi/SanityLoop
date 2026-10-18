// Backward-compatible shim — basic-compaction is now `compaction` with
// method:"soft". New code: `import { createCompaction } from "@sanityloop/compaction"`.
import { createCompaction as createUnified, type SoftOptions } from "@sanityloop/compaction";
import type { Message, Plugin } from "@sanityloop/core";

export interface CompactionOptions {
  /** Fraction of maxContext that triggers compaction. Default: 0.7. */
  threshold?: number;
  /** Non-system messages kept after the summary. Default: 8. */
  keepRecent?: number;
  /** Custom summarizer. Default: the agent's own model, built-in prompt. */
  summarize?: (messages: Message[]) => Promise<string>;
  /** Where compaction metadata lives in session state. Default: "compaction". */
  stateKey?: string;
  /** Extra user focus appended to the summary instruction. */
  focus?: string;
}

/** Default compaction — 70% threshold, keep 8 messages, same-model summarizer. */
export const compaction: Plugin = createCompaction();

export function createCompaction(opts: CompactionOptions = {}): Plugin {
  const soft: SoftOptions = {
    ...(opts.summarize ? { summarize: opts.summarize } : {}),
    ...(opts.focus ? { focus: opts.focus } : {}),
  };
  return createUnified({
    method: "soft",
    threshold: opts.threshold,
    keepRecent: opts.keepRecent,
    stateKey: opts.stateKey,
    soft,
  }).plugin;
}
