import { loadHashStore, parseHashList, type HashStore } from "./hash-store.ts";
import { HASH_CLASS } from "./hashline/alphabet.ts";

const SERVED_DIFF_ROW_RE = new RegExp(`^[+ ](${HASH_CLASS})│`);

export function servedHashesFromDiff(diff: string): string[] {
  const hashes: string[] = [];
  for (const line of diff.split("\n")) {
    const match = SERVED_DIFF_ROW_RE.exec(line);
    if (match) hashes.push(match[1]!);
  }
  return hashes;
}

export function getServed(store: HashStore, path: string): Set<string> | undefined {
  const row = store.stmts.servedGet(path);
  if (!row) return undefined;
  const parsed = parseHashList(row.hashes as string, () => store.stmts.servedDelete(path));
  if (!parsed) return undefined;
  return new Set(parsed);
}

export function recordServed(store: HashStore, path: string, hashes: string[]): void {
  if (hashes.length === 0) return;
  const existing = getServed(store, path) ?? new Set<string>();
  let changed = false;
  for (const hash of hashes) {
    if (!existing.has(hash)) {
      existing.add(hash);
      changed = true;
    }
  }
  if (!changed) return;
  store.stmts.servedUpsert(path, JSON.stringify([...existing]), Date.now());
}

export function recordServedDiff(store: HashStore, path: string, diff: string): void {
  recordServed(store, path, servedHashesFromDiff(diff));
}

export function clearServed(store: HashStore, path: string): void {
  store.stmts.servedDelete(path);
}

export async function recordServedSafe(
  path: string,
  hashes: string[],
  context: string,
): Promise<void> {
  if (hashes.length === 0) return;
  try {
    const store = await loadHashStore();
    recordServed(store, path, hashes);
  } catch (error) {
    console.error(`Failed to record served state (${context}):`, error);
  }
}

export async function recordServedDiffSafe(
  path: string,
  diff: string,
  context: string,
): Promise<void> {
  if (!diff) return;
  await recordServedSafe(path, servedHashesFromDiff(diff), context);
}
