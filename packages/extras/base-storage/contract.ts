// ============================================================================
// sanity/src/extras/storage/contract.ts — the SessionStorage contract
// ============================================================================
// THE swap point. Core owns only the tape contract (`Storage` — append/replay/
// size/clear). Everything a session NEEDS on top of the tape — the light status
// card, resume/restore, flush — is this ONE interface. Any backend implements
// it: a JSON folder (jsonl.ts/session.ts), a plain-text tape (plain-text.ts),
// an in-memory provider (memory.ts), a future SQLite connection, whatever.
//
// The plugin (createSessionStoragePlugin) and the restore flow consume ONLY
// this contract — swap the provider, nothing else moves.
// ============================================================================
import type { AgentSnapshot } from "@sanityloop/snapshot";
import type { KeyChange, SessionData } from "@sanityloop/core";

/** A storage record — one line per mutation. `{ t, change }` — change = the core's KeyChange. */
export interface StorageRecord {
  t: number;
  change: KeyChange;
}

/** THE tape contract — format-agnostic. Any backend implements it. */
export interface Storage {
  append(record: StorageRecord): void;
  replay(): unknown[] | Promise<unknown[]>;
  size(): number;
  clear(): void | Promise<void>;
}

/** What the light status card carries: the flat queryable summary + a version. */
export interface StateCard extends AgentSnapshot {
	version: number;
}

/** What a resume rebuilds from the tape — the data layer, ready to merge() back in. */
export interface RestoredSession {
  /** Rebuilt data-layer state (profile keys `model`/`tools` excluded — the consumer re-attaches them). */
  data: Partial<SessionData>;
  records: number;
}

/** The session-storage extension point — one contract, any backend. */
export interface SessionStorage {
	/** Short human label — the capability text ("jsonl (sessions/meow)", "memory", ...). */
	readonly label: string;
	/** The tape — append-only mutation history (the core contract). */
	readonly log: Storage;
	/** Refresh the light status card (async — debounce-friendly). */
	writeStatus(snapshot: AgentSnapshot): void;
	/** The landing write — must survive process.exit. */
	writeStatusSync(snapshot: AgentSnapshot): void;
	/** Read the card back (null when none / torn). */
	readStatus(): StateCard | null;
	/** Resume: replay the tape → rebuild the session payload (null when empty). */
	restore(): Promise<RestoredSession | null>;
	/** Flush pending writes (before exit / uninstall). */
	flush(): Promise<void>;
}

/**
 * The generic resume rebuild: replay ANY tape (`{ t, change }` records), apply
 * the KeyChanges to a fresh mirror, return the session payload. Shared by every
 * provider whose tape replays changes — the provider only picks the tape + where
 * the card lives. Lifecycle keys (loopState, stats, pendingAwaits...) are NOT on
 * the tape — restore rehydrates them from the snapshot card via merge().
 */
/**
 * The generic resume rebuild: replay ANY tape (`{ t, change }` records), apply
 * the KeyChanges to a fresh data mirror, return it for `merge()`. Shared by every
 * provider whose tape replays changes — the provider only picks the tape + where
 * the card lives. Profile keys (model/tools) are NEVER rehydrated — the consumer
 * re-attaches them at construction. The tape is the exact state at the last flush.
 */
export async function restoreFromTape(
  log: Storage,
): Promise<RestoredSession | null> {
  const records = (await log.replay()) as { t: number; change: KeyChange }[];
  if (records.length === 0) return null;
  const mirror: Partial<SessionData> = {
    cwd: ".",
    messages: [],
    stats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    state: {},
    loopState: "idle",
    runState: "none",
    pendingAwaits: [],
    pendingQuestions: [],
    currentAction: undefined,
    tickPlan: [],
    lastResponse: -1,
  };
  for (const record of records) {
    try {
      applyKeyChange(mirror as Record<string, unknown>, record.change);
    } catch {
      // a change that can't apply to the mirror — skip, keep going
    }
  }
  return { data: mirror, records: records.length };
}

/** Apply ONE KeyChange to the restore mirror. Array delete = splice (replay-shift). */
function applyKeyChange(mirror: Record<string, unknown>, change: KeyChange): void {
  const rootKey = change.key;
  // model/tools are PROFILE (code) — never serialized, re-attached by the consumer
  if (rootKey === "model" || rootKey === "tools") return;
  const segs = change.path.split(".").filter(Boolean);
  if (segs.length < 1 || segs[0] !== rootKey) return;
  let node: unknown = segs.length === 1 ? mirror : mirror[rootKey];
  for (let i = 1; i < segs.length - 1; i++) {
    if (node === null || node === undefined || typeof node !== "object") return;
    const seg = segs[i];
    const cur = (node as Record<string, unknown>)[seg];
    if (cur === undefined || cur === null) {
      if (/^\d+$/.test(seg)) return; // can't auto-create array holes
      const created: Record<string, unknown> = {};
      (node as Record<string, unknown>)[seg] = created;
      node = created;
    } else {
      node = cur;
    }
  }
  if (node === null || node === undefined || typeof node !== "object") return;
  const leaf = segs[segs.length - 1];
  if (Array.isArray(node)) {
    const idx = Number(leaf);
    if (Number.isInteger(idx)) {
      if (change.op === "delete") (node as unknown[]).splice(idx, 1);
      else (node as unknown[])[idx] = change.value;
      return;
    }
  }
  if (change.op === "delete") delete (node as Record<string, unknown>)[leaf];
  else (node as Record<string, unknown>)[leaf] = change.value;
}
