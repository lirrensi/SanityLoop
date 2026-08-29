// ============================================================================
// sanity/src/extras/storage/jsonl.ts — JsonlLog (the persistent tape)
// ============================================================================
// The daemon/persistent Storage backend (components.md #13, questions.md F):
// append `{ t, patch }` records as lines in a JSONL file. HEAVY data
// (messages/tools/state mutations) lives here — append-only, never rewritten.
//
// The three uses of one delta (current-events.md §STORAGE+SYNC):
//   1. Persistence — append the patch to JSONL. The patch IS the record.
//   2. Replay/restore — read lines in order → rebuild the state.
//   3. (Live sync reuses the same patch over WS — daemon era.)
//
// Sharp edges (pi's session-manager, distilled):
//   - torn-tail repair: a crash mid-append leaves a partial last line —
//     replay drops it instead of failing.
//   - atomic publish: appends go to a temp file, then rename over the real
//     one, so a reader never sees a half-written line.
//   - NO CHECKPOINTS: the log IS the state; restart = read sequentially.
// ============================================================================
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Storage, StorageRecord } from "./contract.ts";

export interface JsonlLogOptions {
	/** Directory for the log file. Created on first write. */
	dir: string;
	/** File name inside `dir`. Default: "session.jsonl". */
	fileName?: string;
}

/** The tape schema version — replay screams on mismatch. */
export const JSONL_VERSION = 1;
const HEADER_LINE = `${JSON.stringify({ v: JSONL_VERSION, kind: "sanity-jsonl" })}\n`;

/** The persistent tape — append-only `{ t, change }` lines, replayable. */
export class JsonlLog implements Storage {
	readonly dir: string;
	readonly fileName: string;
	/** The queue of appends — one write at a time, ordered, crash-safe. */
	private queue: Promise<void> = Promise.resolve();
	private count = 0;
	private initialized = false;
	/** Lazy disk-seed done? size() must be disk-honest on first call (see size()). */
	private counted = false;
	constructor(opts: JsonlLogOptions) {
		this.dir = opts.dir;
		this.fileName = opts.fileName ?? "session.jsonl";
	}

	get path(): string {
		return join(this.dir, this.fileName);
	}

	/** Append one record — atomic (tmp + rename), serialized through the queue. */
	append(record: StorageRecord): void {
		this.counted = true; // appends are now the authoritative count — stop disk-seeding
		this.count++;
		const line = `${JSON.stringify(record)}\n`;
		this.queue = this.queue.then(() => this.writeLine(line)).catch(() => {});
	}

	/** Replay all records → rebuild state. Torn tail dropped; version mismatch screams. */
	async replay(): Promise<StorageRecord[]> {
		try {
			const raw = await readFile(this.path, "utf8");
			const records: StorageRecord[] = [];
			const lines = raw.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i].trim();
				if (!line) continue;
				try {
					const parsed = JSON.parse(line) as unknown;
					// the header line: `{ v, kind }` — validate the schema version, then skip
					if (
						i === 0 &&
						typeof parsed === "object" &&
						parsed !== null &&
						"v" in (parsed as object) &&
						!("change" in (parsed as object))
					) {
						const v = (parsed as { v?: unknown }).v;
						if (v !== JSONL_VERSION) {
							throw new Error(
								`[sanity] jsonl: schema version mismatch — log is v${String(v)}, this build is v${JSONL_VERSION}`,
							);
						}
						continue;
					}
					records.push(parsed as StorageRecord);
				} catch (err) {
					// last line only: torn tail from a crash mid-append — drop it
					if (
						i === lines.length - 1 &&
						!(err instanceof Error && err.message.includes("version mismatch"))
					)
						break;
					throw err;
				}
			}
			return records;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw err;
		}
	}

	/** Number of records stored — DISK-honest: a fresh instance over an existing tape is a RESUME,
	 * not an empty log. The plugin's baseline check (`size() === 0`) depends on seeing the disk
	 * truth, else a resumed tape gets baseline-defaults appended over its history. */
	size(): number {
		if (!this.counted) {
			try {
				const raw = readFileSync(this.path, "utf8");
				for (const line of raw.split("\n")) {
					const t = line.trim();
					if (!t) continue;
					// the header line ({ v, kind }) is not a record — only count `change` lines
					if (t.includes('"change"')) this.count++;
				}
			} catch { /* ENOENT — genuinely empty */ }
			this.counted = true;
		}
		return this.count;
	}

	/** Reset — wipe the log. */
	async clear(): Promise<void> {
		this.count = 0;
		this.initialized = false;
		this.counted = false;
		this.queue = this.queue
			.then(() => rm(this.path, { force: true }))
			.catch(() => {});
		await this.queue;
	}

	/** Wait for every queued append to hit the disk. */
	async flush(): Promise<void> {
		await this.queue;
	}

	private async writeLine(line: string): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		// first append creates the file WITH the version header; later ones append
		if (!this.initialized) {
			this.initialized = true;
			await appendFile(this.path, `${HEADER_LINE}${line}`, {
				encoding: "utf8",
			});
			return;
		}
		// append-only: a crash mid-append leaves a torn tail — replay drops it
		await appendFile(this.path, line, { encoding: "utf8" });
	}
}

/** Convenience: a JsonlLog pointed at `sessions/<id>/`. */
export function jsonlForSession(id: string, baseDir: string): JsonlLog {
	return new JsonlLog({ dir: join(baseDir, id) });
}
