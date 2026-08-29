// sanity/src/extras/edit/compat.ts
// VENDORED pieces that the hashline-edit-pro source borrowed from pi.
// Truncation utils now live in ../util.ts (shared with the basic set) —
// re-exported here so the edit suite's imports stay stable.
// withFileMutationQueue stays here — serialize mutations per absolute path so
// concurrent edits to the same file never race.
export { truncateHead, formatSize, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from "@sanityloop/util";
export type { TruncationResult, TruncationOptions } from "@sanityloop/util";

// ---- per-path mutation queue (serialize concurrent edits to one file) ----

const mutationQueues = new Map<string, Promise<unknown>>();

/**
 * Serialize mutations to the same absolute path: each call awaits the previous
 * call on that path before running, so concurrent edits never race.
 */
export function withFileMutationQueue<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(path) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  mutationQueues.set(path, next.catch(() => undefined));
  return next;
}
