// ============================================================================
// sanity/src/filter-bus.ts — the filter queue + direct meta-callbacks
// ============================================================================
// THE WHOLE PROTOCOL — four lines, verbatim, the spec everything serves:
//   1. loop goes tick brrr          (supervisor, 10ms, never gated)
//   2. input filter populates pending inputs
//   3. supervisor sees pending input → awaits it fully BEFORE anything else
//   4. input removes the downstream blocking pending await → worker resumes
//
// TWO LOOPS, one flag, zero guards:
//   SUPERVISOR — drains inputs (awaited inline: quick-processors contract),
//   flushes streams, launches/resumes the WORKER, performs teardown. It never
//   consults worker state to do its own job.
//   WORKER — one linear awaited pipeline (gates → provider → batch → commits).
//   Between steps it checks pendingAwaits: asks present → save position,
//   parkNow, exit. The answer arrives through the SUPERVISOR, clears the
//   await, and the supervisor relaunches the worker from the saved position.
//   There are no locks inside processing — a park is the worker NOT RUNNING.
//   Lock inversion is unwritable by construction.
//
// FILTERS — the WordPress-style bus. THE AGENT IS INJECTED at construction and
// handed to every filter as `(agent, event)`: the WHOLE god object — mutate
// directly (state, messages, pendingAwaits, anything), observed → KeyChange →
// everything downstream. No return-merge dance: mutate `this`, be done.
//
// - throw/reject → skip + log + handlerError; the queue NEVER rejects, so a
//   floating caller can never explode
// - STOP is ONLY abort — nothing else stops the loop
//
// onFilter / onCycle — DIRECT meta-callbacks, NOT filters. Observability +
// the reorganization points.
//
// CYCLE ≠ FILTER. A cycle is defined when a message is being added — message
// list manipulated = new cycle, because the next model call will be with new
// data. Queues rebuild at cycle start.
//
// THREE COMMANDS — three lifetimes:
//   disable → out for ALL future cycles (until enable)
//   enable  → back in
//   remove  → gone from the RECORD entirely (until addFilter again)
// ============================================================================

import { EVENTS } from "./types.ts";
import type {
	CycleCallbacks,
	EventBus,
	EventPayload,
	Filter,
	FilterMetaCallbacks,
	GodObject,
} from "./types.ts";

/** A filter firing events recursively deeper than this = a loop, not a hook. */
const MAX_CHAIN_DEPTH = 32;

interface ChainJob {
	event: string;
	queue: Filter[];
	payload?: Omit<EventPayload, "type">;
	registry: boolean;
	depth: number;
}

export class FilterBus implements EventBus {
	/** The REGISTRY — filters as they were added. Never mutated by disable. */
	private registry = new Map<string, Filter[]>();
	/** Disabled filter ids — out of future queues until enabled. */
	private disabled = new Set<string>();
	/** The queue for the CURRENT cycle — rebuilt per cycle. */
	private cycleQueues = new Map<string, Filter[]>();
	/** Direct meta-callbacks — NOT filters, cannot self-trigger. */
	private onFilterCallbacks: FilterMetaCallbacks[] = [];
	private onCycleCallbacks: CycleCallbacks[] = [];
	/** >0 while a chain runs — events fired inside a filter are its CHILDREN
	 * (WordPress nesting): captured and drained right after their trigger. */
	private active = 0;
	/** Child jobs captured from inside a running chain. */
	private spawned: ChainJob[] = [];

	/** The agent this bus serves — injected once, handed to every filter as `this`. */
	private readonly agent: GodObject;
	constructor(agent: GodObject) {
		this.agent = agent;
	}

	// ==========================================================================
	// Registry — the record
	// ==========================================================================

	/** Register a filter. ALWAYS an object. Ids must be unique — they are the
	 * sole handle for remove/disable. */
	add(filter: Filter): this {
		for (const [event, chain] of this.registry) {
			if (chain.some((f) => f.id === filter.id)) {
				throw new Error(
					`[sanity] filter id "${filter.id}" is already registered on event "${event}". ` +
					`Filter ids must be unique (add once, delete once) — use a distinct id or removeFilter first.`,
				);
			}
		}
		const chain = this.registry.get(filter.event) ?? [];
		chain.push(filter);
		chain.sort((a, b) => a.priority - b.priority);
		this.registry.set(filter.event, chain);
		this.emitAttached(filter);
		return this;
	}

	/** REMOVE — yeet out of the RECORD entirely. Until addFilter again. */
	remove(event: string, id: string): boolean {
		const chain = this.registry.get(event);
		if (!chain) return false;
		const idx = chain.findIndex((f) => f.id === id);
		if (idx === -1) return false;
		chain.splice(idx, 1);
		this.disabled.delete(id);
		this.emitDetached(event, id);
		return true;
	}

	/** DISABLE — out of ALL future queues until enable. */
	disable(event: string, id: string): boolean {
		if (!this.registry.get(event)?.some((f) => f.id === id)) return false;
		this.disabled.add(id);
		return true;
	}

	/** ENABLE — put a disabled filter back in future queues. */
	enable(event: string, id: string): boolean {
		return this.disabled.delete(id);
	}

	isDisabled(event: string, id: string): boolean {
		return this.disabled.has(id);
	}

	has(event: string): boolean {
		return (this.registry.get(event)?.length ?? 0) > 0;
	}

	// ==========================================================================
	// Direct meta-callbacks — onFilter / onCycle
	// ==========================================================================

	onFilter(cb: FilterMetaCallbacks): this {
		this.onFilterCallbacks.push(cb);
		return this;
	}

	onCycle(cb: CycleCallbacks): this {
		this.onCycleCallbacks.push(cb);
		return this;
	}

	private emitAttached(filter: Filter): void {
		for (const cb of this.onFilterCallbacks) {
			try { cb.attached?.(filter); } catch (err) { console.error("[sanity] onFilter.attached threw:", err); }
		}
	}
	private emitDetached(event: string, id: string): void {
		for (const cb of this.onFilterCallbacks) {
			try { cb.detached?.(event, id); } catch (err) { console.error("[sanity] onFilter.detached threw:", err); }
		}
	}
	private emitBefore(filter: Filter): void {
		for (const cb of this.onFilterCallbacks) {
			try { cb.before?.(filter, this.agent); } catch (err) { console.error("[sanity] onFilter.before threw:", err); }
		}
	}
	private emitAfter(filter: Filter): void {
		for (const cb of this.onFilterCallbacks) {
			try { cb.after?.(filter, this.agent); } catch (err) { console.error("[sanity] onFilter.after threw:", err); }
		}
	}
	private emitCycleStart(): void {
		for (const cb of this.onCycleCallbacks) {
			try { cb.start?.(this.cycleQueues, this.agent); } catch (err) { console.error("[sanity] onCycle.start threw:", err); }
		}
	}
	private emitCycleEnd(): void {
		for (const cb of this.onCycleCallbacks) {
			try { cb.end?.(this.agent); } catch (err) { console.error("[sanity] onCycle.end threw:", err); }
		}
	}

	// ==========================================================================
	// The cycle — begin → run events → end
	// ==========================================================================

	/**
	 * BEGIN a cycle. Rebuilds ALL queues fresh (registry − disabled) and fires
	 * onCycle.start — the whole-queue reorganization point.
	 */
	beginCycle(): this {
		this.cycleQueues = new Map();
		for (const [event, fs] of this.registry) {
			this.cycleQueues.set(event, fs.filter((f) => !this.disabled.has(f.id)));
		}
		this.emitCycleStart();
		return this;
	}

	/** END the cycle — fires onCycle.end, clears the cycle queues. */
	endCycle(): this {
		this.emitCycleEnd();
		this.cycleQueues = new Map();
		return this;
	}

	/** The current cycle's queue for an event (mutable — splice here mid-cycle). */
	queueFor(event: string): Filter[] {
		return this.cycleQueues.get(event) ?? [];
	}

	/** The registry, for inspection. */
	registrySnapshot(): Map<string, Filter[]> {
		return new Map(this.registry);
	}

	/** Disabled ids, for inspection. */
	disabledSnapshot(): string[] {
		return [...this.disabled];
	}

	// ==========================================================================
	// RUN — the awaited chain. THE one primitive.
	// ==========================================================================
	//
	//   await bus.run("beforeTool", payload)
	//
	// Sequential by priority. Filter N settles fully before N+1 starts.
	// Children (events fired inside a filter) drain depth-first right after
	// their trigger — before the next sibling. NEVER rejects: per-filter
	// failures go to handlerError, the queue always completes. Safe to float
	// (`void bus.run(...)`), better to await.

	/** Run one event against the CURRENT cycle's queue. */
	run(event: string, payload?: Omit<EventPayload, "type">): Promise<void> {
		return this.runQueue(
			event,
			this.cycleQueues.get(event) ?? [],
			payload,
			false,
			0,
		);
	}

	/** Run an event against the REGISTRY directly (minus disabled) — the
	 * control lane: reaches listeners ANY time, mid-cycle or post-cycle. */
	runFromRegistry(event: string, payload?: Omit<EventPayload, "type">): Promise<void> {
		const queue =
			this.registry.get(event)?.filter((f) => !this.disabled.has(f.id)) ?? [];
		return this.runQueue(event, queue, payload, true, 0);
	}

	private async runQueue(
		event: string,
		queue: Filter[],
		payload: Omit<EventPayload, "type"> | undefined,
		registry: boolean,
		depth: number,
	): Promise<void> {
		if (queue.length === 0) return;
		if (depth > MAX_CHAIN_DEPTH) {
			console.error(
				`[sanity] chain depth exceeded (${MAX_CHAIN_DEPTH}) on "${event}" — ` +
					`a filter is firing events recursively. Skipped.`,
			);
			return;
		}
		this.active++;
		try {
			for (const filter of queue) {
				this.emitBefore(filter);
				const argPayload = { type: event, ...payload } as EventPayload;
				try {
					await filter.fn(this.agent, argPayload); // ← THE await. Line 244, avenged forever.
				} catch (err) {
					this.handleFilterError(err, filter, event, depth);
				}
				// children THIS filter fired — depth-first, inline, before the
				// next sibling starts (WordPress do_action-inside-do_action)
				while (this.spawned.length > 0) {
					const child = this.spawned.shift()!;
					await this.runQueue(child.event, child.queue, child.payload, child.registry, depth + 1);
				}
				this.emitAfter(filter);
			}
		} finally {
			this.active--;
		}
	}

	/** Filter isolation: skip + log, pipeline continues. Observable via handlerError.
	 * Guarded: a handlerError filter that throws cannot re-fire itself. */
	private handleFilterError(err: unknown, filter: Filter, event: string, depth: number): void {
		console.error(`[sanity] filter "${filter.id}" on "${event}" threw:`, err);
		if (event !== EVENTS.handlerError) {
			void this.runFromRegistry(EVENTS.handlerError, {
				type: EVENTS.handlerError,
				error: err,
				filterId: filter.id,
				event,
			});
		}
	}
}
