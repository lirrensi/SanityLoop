// ============================================================================
// sanity/src/extras/storage/memory.ts — MemoryLog (the in-memory tape)
// ============================================================================
// The "memory" tier of the storage decision: no persistence, but a real tape —
// deltas in memory, replayable. Same-process resume/restore works through it.
// Core has NO storage concept anymore — this is an extras provider, chosen by
// the consumer like any other.
// ============================================================================
import type { Storage, StorageRecord } from "./contract.ts";

/** The in-memory tape — deltas in RAM, replayable. No disk, no ceremony. */
export class MemoryLog implements Storage {
	private records: StorageRecord[] = [];

	append(record: StorageRecord): void {
		this.records.push(record);
	}

	replay(): unknown[] {
		return [...this.records];
	}

	size(): number {
		return this.records.length;
	}

	clear(): void {
		this.records = [];
	}
}
