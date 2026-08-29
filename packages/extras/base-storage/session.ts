// ============================================================================
// sanity/src/extras/storage/session.ts — the folder-backed session provider
// ============================================================================
// ONE implementation of the SessionStorage contract: a session DIRECTORY with
// the heavy tape + the light card. The tape format is YOUR choice — this
// provider is parameterized by any `Storage` (JsonlLog, PlainTextLog, ...);
// the card is the shared `state.json` writer.
//
//   sessions/meow/
//     session.jsonl   ← the tape (whatever Storage you plugged in)
//     state.json      ← the light status card (agentSnapshot + version)
//
// Path semantics (decided): you pick how the session continues.
//   { path: "sessions/meow" }       static folder  → SAME session each run (resume)
//   { path: "sessions/{uuid}" }     random folder  → persistence, no explicit resume
//   MemorySessionStorage            memory         → no persistence at all
//
// The version screams: the card carries a schema version; mismatch throws.
// ============================================================================
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EVENTS, type GodObject, type KeyChange, type Plugin, type ToolCallRecord, type ToolResultMessage } from "@sanityloop/core";
import { agentSnapshot } from "@sanityloop/snapshot";
import { removeFiltersByPrefix } from "@sanityloop/util";
import { JsonlLog } from "./jsonl.ts";
import {
	restoreFromTape,
	type RestoredSession,
	type SessionStorage,
	type StateCard,
} from "./contract.ts";

/** The tape records ONLY restore-relevant keys — ephemeral churn (tickPlan/runState) stays off-disk. */
const TAPE_KEYS = new Set([
  "id",
  "agentId",
  "messages",
  "state",
  "stats",
  "loopState",
  "pendingAwaits",
  "pendingQuestions",
  "currentAction",
  "lastResponse",
  "capabilities",
  "cwd",
  "description",
  "activity",
]);

/** The state card schema version — readStateCard screams on mismatch. */
export const STATE_VERSION = 1;

/** Resolve the session directory: a `{uuid}` token → a fresh folder each run. */
export function resolveSessionDir(path: string): string {
	if (path.includes("{uuid}")) {
		return path.replace("{uuid}", crypto.randomUUID());
	}
	return path;
}

/** The state card path inside a session dir. */
export function stateCardPath(dir: string): string {
	return join(dir, "state.json");
}

/** Read the card — throws on schema version mismatch (it screams). */
export function readStateCard(dir: string): StateCard | null {
	const path = stateCardPath(dir);
	if (!existsSync(path)) return null;
	let parsed: Partial<StateCard>;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StateCard>;
	} catch {
		return null; // torn/corrupt card — the tape is the truth, restore still works
	}
	if (parsed.version !== STATE_VERSION) {
		throw new Error(
			`[sanity] state.json: schema version mismatch — card is v${String(parsed.version)}, this build is v${STATE_VERSION}`,
		);
	}
	return parsed as StateCard;
}

/** Write the card — atomic (tmp + rename): a reader never sees a half file. */
export async function writeStateCard(
	dir: string,
	snapshot: StateCard | Omit<StateCard, "version">,
): Promise<void> {
	await mkdir(dir, { recursive: true });
	const card: StateCard = { version: STATE_VERSION, ...snapshot };
	const target = stateCardPath(dir);
	const tmp = `${target}.tmp`;
	await writeFile(tmp, `${JSON.stringify(card, null, 2)}\n`, "utf8");
	await rename(tmp, target).catch(() => {
		// Windows rename-over-existing can race; fall back to a direct write
		renameSync(tmp, target);
	});
}

/** Sync variant for the landing write — guaranteed on disk before process.exit. */
export function writeStateCardSync(
	dir: string,
	snapshot: StateCard | Omit<StateCard, "version">,
): void {
	mkdirSync(dir, { recursive: true });
	const card: StateCard = { version: STATE_VERSION, ...snapshot };
	const target = stateCardPath(dir);
	const tmp = `${target}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(card, null, 2)}\n`, "utf8");
	try {
		renameSync(tmp, target);
	} catch {
		writeFileSync(target, `${JSON.stringify(card, null, 2)}\n`, "utf8");
	}
}

export interface DirSessionOptions {
	/** The session directory (static → resume; contains `{uuid}` → fresh each run). */
	path: string;
	/** The tape backend — JsonlLog, PlainTextLog, or any Storage impl. */
	log: StorageLike;
}

/** Duck-typed Storage (flush is optional on the interface). */
interface StorageLike {
	append(record: unknown): void;
	replay(): unknown[] | Promise<unknown[]>;
	size(): number;
	clear(): void | Promise<void>;
	flush?(): Promise<void>;
}

/**
 * The folder-backed SessionStorage: the tape (whatever Storage you plugged)
 * + the light state.json card, both in one directory. Swap the tape format by
 * passing a different Storage; swap the whole backend by writing a new
 * SessionStorage (e.g. a SQLite connection).
 */
export class DirSessionStorage implements SessionStorage {
	readonly dir: string;
	readonly log: StorageLike;
	private readonly labelText: string;

	constructor(opts: DirSessionOptions) {
		this.dir = resolveSessionDir(opts.path);
		this.log = opts.log;
		this.labelText = `session-storage: ${this.dir}`;
	}

	get label(): string {
		return this.labelText;
	}

	writeStatus(snapshot: Parameters<SessionStorage["writeStatus"]>[0]): void {
		void writeStateCard(this.dir, snapshot);
	}

	writeStatusSync(
		snapshot: Parameters<SessionStorage["writeStatusSync"]>[0],
	): void {
		writeStateCardSync(this.dir, snapshot);
	}

	readStatus(): StateCard | null {
		return readStateCard(this.dir);
	}

	async restore(): Promise<RestoredSession | null> {
		// the tape buffers appends asynchronously — flush so restore reads EVERYTHING
		// written so far (the cookbook exam caught this: write → restore → nothing).
		await this.log.flush?.();
		return restoreFromTape(this.log as never);
	}

	async flush(): Promise<void> {
		await this.log.flush?.();
	}
}

export interface SessionStoragePluginOptions {
	/** Debounce for mid-session card rewrites. Default 250ms. */
	debounceMs?: number;
}

/**
 * THE generic session plugin — consumes ONLY the SessionStorage contract.
 * Writes the light card on meaningful moments (every cycle, always at the
 * landing). Works identically for jsonl, plain-text, memory, sqlite, whatever:
 * swap the provider, nothing else moves.
 */
export function createSessionStoragePlugin(
	storage: SessionStorage,
	opts: SessionStoragePluginOptions = {},
): Plugin {
	const debounceMs = opts.debounceMs ?? 250;
	const id = "session-storage";
	return {
		id,
		install(agent) {
			// BASELINE — the observer only taped mutations AFTER construction; the initial
			// data layer (messages, lastResponse, ...) would be missing from a fresh tape.
			// Snapshot it once at first install; restore = baseline + deltas. A resumed tape
			// (size > 0) skips — its deltas keep flowing on top of the old history.
			if (storage.log.size() === 0) {
			const baseline: Array<[string, unknown]> = [
				["id", agent.id],
				["agentId", agent.agentId],
				["cwd", agent.cwd],
					["description", agent.description],
					["activity", agent.activity],
					["messages", agent.messages],
					["stats", agent.stats],
					["state", agent.state],
					["loopState", agent.loopState],
					["pendingAwaits", agent.pendingAwaits],
					["pendingQuestions", agent.pendingQuestions],
					["currentAction", agent.currentAction],
					["capabilities", agent.listDeclaredCapabilities()],
					["lastResponse", agent.lastResponse],
				];
				for (const [key, value] of baseline) {
					if (TAPE_KEYS.has(key)) {
						storage.log.append({ t: Date.now(), change: { key, path: key, op: "set", value } });
					}
				}
			}
			let timer: ReturnType<typeof setTimeout> | undefined;
			const schedule = () => {
				if (timer) clearTimeout(timer);
				timer = setTimeout(() => {
					timer = undefined;
					storage.writeStatus(agentSnapshot(agent));
				}, debounceMs);
			};

			// every model round-trip → refresh the card (debounced)
			agent.addFilter({
				event: EVENTS.cycleEnd,
				id: `${id}/card`,
				priority: 99,
				fn: async (ctx) => {
					schedule();
				},
			});
			// the landing → the FINAL card, synchronously (survives process.exit)
			agent.addFilter({
				event: EVENTS.stop,
				id: `${id}/card-final`,
				priority: 99,
				fn: async (ctx) => {
					storage.writeStatusSync(agentSnapshot(agent));
				},
			});
			// THE TAPE — append every restore-relevant KeyChange. Append-only, no overwrites,
			// one JSONL line per mutation; the flush is debounced by the queue, not by us.
			agent.addFilter({
				event: EVENTS.patched,
				id: `${id}/tape`,
				priority: 99,
				fn: async (ctx, event) => {
					const change = event?.change as KeyChange | undefined;
					if (change && TAPE_KEYS.has(change.key)) {
						storage.log.append({ t: Date.now(), change });
					}
				},
			});
				agent.addDeclaredCapability({ id, description: storage.label });
			},
			uninstall(agent) {
				removeFiltersByPrefix(agent, `${id}/`);
				agent.removeDeclaredCapability(id);
			void storage.flush();
		},
	};
}

/**
 * Rehydrate a restored session into a fresh agent. The profile (model/tools) is
 * YOURS — the tape never carries code, the constructor already attached them.
 * Silent merge: ONE `merged` event, no tape records.
 */
export function applyRestored(agent: GodObject, restored: RestoredSession): void {
  const data = { ...restored.data };
  delete data.model;
  delete data.tools; // profile — the consumer's Agent constructor already attached them
  // Legacy tapes (pre-identity-serialization) carry no id/agentId — keep the
  // constructor's values rather than wiping identity with undefined.
  if (!data.id) delete data.id;
  if (!data.agentId) delete data.agentId;
  agent.merge((d) => {
    Object.assign(d, data);
    return d;
  });
}

/**
 * THE CRASH HEAL (at-most-once with healing). If the tape ends with an OWED
 * toolCall and NO pending asks — the process crashed mid-batch, not parked —
 * the tools that never ran must NOT auto-execute on resume. Every call must
 * match a result, so every MISSING call gets `preResolved` as an error
 * "not executed — crashed". Calls whose result already committed are left
 * alone: the batch SKIPS them (their result is already in history).
 * The worker then commits the healed results synthetically (no tool executes),
 * the transcript is whole, and the model sees exactly what happened and can
 * decide next (re-request, skip, ask) itself.
 *
 * The PARKED case (pendingAwaits present) is deliberately untouched: the ask
 * is a general QUESTION (permission is one use). Its answer was never seen by
 * anyone — the side effect it would have triggered never ran in this process —
 * so the question must be RE-PRESENTED and the batch runs fresh after the answer.
 *
 * Runs on RAW restored data BEFORE agent.merge() — the silent window — so the
 * healing writes no events and breaks no "restore is silent" guarantee.
 */
function healPartialBatch(data: { messages?: unknown[]; pendingAwaits?: unknown[]; lastResponse?: number }): void {
	const messages = data.messages;
	if (!Array.isArray(messages) || messages.length === 0) return;
	// find the LAST toolCall — its batch may be the one the crash interrupted
	let toolIdx = -1;
	let toolCall: { content?: { stored?: ToolCallRecord[] } } | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { type?: string };
		if (m?.type === "toolCall") { toolIdx = i; toolCall = messages[i] as typeof toolCall; break; }
	}
	if (toolIdx === -1 || !toolCall) return;
	// answered? lastResponse advances ONLY on assistant/custom commits — if it
	// points AT or past the toolCall, a message after it already closed the turn.
	const lr = typeof data.lastResponse === "number" ? data.lastResponse : -1;
	if (lr >= toolIdx) return;
	if (Array.isArray(data.pendingAwaits) && data.pendingAwaits.length > 0) return; // parked — re-ask
	const calls = toolCall.content?.stored ?? [];
	if (calls.length === 0) return;

	const byCall = new Map<string, ToolResultMessage>();
	for (const m of messages) {
		const msg = m as ToolResultMessage;
		if (msg.type === "toolResult") byCall.set(msg.toolCallId, msg);
	}

	let healed = 0;
	for (const call of calls) {
		if (call.preResolved) continue; // already decided
		if (byCall.has(call.id)) continue; // already committed — the batch skips it
		// HEAL — never ran; the side effect must not fire after a crash
		healed++;
		call.preResolved = {
			answer: `Tool ${call.name} was not executed: the process crashed before it ran.`,
			error: true,
			errorMessage: "not executed — process crashed before it ran",
		};
	}
	if (healed > 0) {
		// The transcript is honest — the model sees exactly what happened via
		// the synthetic error results. (No event here: restore stays SILENT.)
	}
}

/** One call, both sides: a DirSessionStorage + its plugin (+ a restore helper). */
export interface JsonlSession {
  dir: string;
  storage: DirSessionStorage;
  plugin: Plugin;
  /** Replay the tape into a fresh agent and continue the session. True = restored. */
  restoreInto(agent: GodObject): Promise<boolean>;
}

/** The JSON-folder session — the default persistent provider. */
export function jsonlSession(
	path: string,
	opts: SessionStoragePluginOptions = {},
): JsonlSession {
	const dir = resolveSessionDir(path);
	const storage = new DirSessionStorage({ path, log: new JsonlLog({ dir }) });
	return {
		dir,
		storage,
		plugin: createSessionStoragePlugin(storage, opts),
		restoreInto: async (agent) => {
			const restored = await storage.restore();
			if (!restored) return false;
			healPartialBatch(restored.data); // CRASH HEAL — raw data, silent window
			applyRestored(agent, restored);
			return true;
		},
	};
}

export { restoreFromTape };
export type { RestoredSession, SessionStorage, StateCard } from "./contract.ts";
