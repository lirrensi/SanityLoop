// ============================================================================
// sanity/src/agent.ts — the Agent class: the heartbeat
// ============================================================================
// THE LOOP IS A RENDER PASS, exactly like React: the god object is the state,
// and each tick is a pure derivation — read the object, build a priority-ordered
// action list, execute it. There is NO phase enum, NO switch of states; the
// object dictates everything, including how the next tick runs.
//
//   while (!terminated) { await sleep(10); tick(); }  ← the ONLY await in the machine
//
//   P0 drain-inputs   sync inputs = SIGINT — processed first, every tick
//   P1 teardown       terminal — the world ends, the driver breaks
//   P2 flush-stream   buffered stream micro-events → visibility + early abort
//   P3 poll-provider  in-flight provider call (polled, never awaited)
//   P4 poll-tools     in-flight tool batch (polled, never awaited)
//   P5 advance        turn is live, nothing in flight → one synchronous step
//   P6 start-turn     no turn, work owed → begin one
//   P7 go-idle        nothing at all → park the loop, keep breathing
//
// TURN vs CYCLE (the two granularities, per the docs):
//   TURN  = one exchange: input → final answer → landing. turnStart fires once
//          (first cycle of the turn), turnEnd once (at the graceful landing).
//          The turn parks (awaiting) and resumes; steer/followup land per its
//          lifecycle.
//   CYCLE = one model round-trip: openCycle (filter queue rebuild) → provider
//          call → commit → tool batch → cycleEnd → closeCycle. The commit is
//          BREAKPOINT #1 (truth freezes, the next API call sees new data);
//          BREAKPOINT #2 is the worker's park checkpoint (awaits pend between
//          wall steps → save position, exit; an answer resumes it).
//
// INPUT: the async mechanism — and ONLY that. The core has no idea what an
// input MEANS. `agent.input()` is the door; SYNC inputs are the SIGINT
// (drained at the top of every supervisor tick, block raised, chains awaited
// fully before anything else). ASYNC inputs are fire-and-forget chatter.
// Filters assign meaning; the default input vocabulary lives in extras/inputs.ts.
//
// Runs until terminate() (the off switch) or process shutdown. Idles in
// 'idle', waiting for the next input signal.
// ============================================================================

import { FilterBus } from "./filter-bus.ts";
import type {
    CycleState,
    ErrorFacts,
    ErrorSource,
    EventName,
    Filter,
    GodObject,
    Input,
    LoopState,
    Message,
    ModelContract,
    KeyChange,
    EventPayload,
    PendingAwait,
    PendingQuestion,
    Plugin,
    SessionData,
    Stats,
    StreamEvent,
    StreamSink,
    Tool,
    ToolResult,
    ToolResultMessage,
    TurnResult,
    MessageStats,
    DeclaredCapability,
    DeclaredEvent,
    DeclaredInput,
} from "./types.ts";
import { EVENTS, PER_CALL_TELEMETRY_KEYS, PluginDependencyError, addStats, emptySessionStats } from "./types.ts";
import { validateToolArgs } from "./tool.ts";

/**
 * SEALED-PHASE DEFERRAL — events in this set fire NORMALLY except while the
 * tool batch executes (sealed): then they park in THE LANE (held) and drain at
 * the seams (closeCycle / land), AFTER toolResults commit. DATA, not code —
 * extend freely; control events (fromRegistry) are NEVER deferred.
 */
const SEALED_DEFER_EVENTS = new Set<EventName>([
    EVENTS.toolUpdate,
    EVENTS.toolListChanged,
]);

export interface AgentOptions {
    model: ModelContract;
    messages?: Message[];
    /** Restored session state — resume passes what `restoreSession` rebuilt. */
    state?: Record<string, unknown>;
    tools?: Tool[];
    /** The profile's agentId — pointer to this definition for resume. */
    agentId?: string;
    /** The session's own name — omit for a fresh randomUUID. Assigning post-construction is observed + taped (fork = copy artifact + re-key). */
    id?: string;
    /** The agent's one-line description — what it does. Optional. */
    description?: string;
    /** The working directory — defaults to where the agent runs (process.cwd()). */
    cwd?: string;
}

/** The alive tick — how often the run() loop wakes to check inputs + work. */
const TICK_MS = 10;

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}


/**
 * The tool return contract — a ToolResult object, ALWAYS. The core
 * normalizes every possible return so the loop can never break on a
 * misbehaving tool:
 *   - a valid ToolResult passes through untouched
 *   - null/undefined (no return) → a synthesized error result
 *   - a non-object (string/number/...) → a synthesized error result
 *   - a result without a string `answer` → a synthesized error result
 * DELIBERATE null is NOT a skip — skipping would break the
 * every-call-gets-an-answer insurance. Skips live in filters
 * (preResolved), never in returns.
 */
function normalizeToolResult(raw: unknown, name: string): ToolResult {
    if (raw === null || raw === undefined) {
        const kind = raw === null ? "null" : "undefined";
        return {
            answer: `Tool ${name} returned ${kind} instead of a result object — this is a tool bug. The tool must always return { answer, ... }.`,
            error: true,
            errorMessage: "tool returned no result object",
            stored: { returned: kind },
        };
    }
    if (typeof raw !== "object") {
        return {
            answer: `Tool ${name} returned ${typeof raw} instead of a result object — this is a tool bug. The tool must always return { answer, ... }.`,
            error: true,
            errorMessage: `tool returned ${typeof raw}`,
            stored: { returned: raw },
        };
    }
    const r = raw as ToolResult;
    if (typeof r.answer !== "string") {
        return {
            answer: `Tool ${name} returned a result without a string "answer" field — this is a tool bug. answer is what the model sees.`,
            error: true,
            errorMessage: "result missing string answer",
            stored: { returned: raw },
        };
    }
    return r;
}

/**
 * A stored tool call inside a toolCall message's two-face `stored` list.
 * THE CANONICAL SHAPE — clean and provider-agnostic:
 *   { id, type: "function", name, parameters }
 * The wire fuckery (OpenAI's `function: { name, arguments }` with JSON-string
 * arguments, provider-specific type names) lives in the TRANSFORM, never here.
 */
export interface ToolCallRecord {
    id: string;
    /**
     * The tool type — "function" in the canonical form, but OPEN: custom types
     * are strings (like MessageType). Create your own fucked up custom type.
     */
    type: "function" | (string & {});
    name: string;
    parameters: Record<string, unknown>;
    /** A filter pre-resolved this call's outcome BEFORE the batch executes — the
     * result is PREDETERMINED: a denial, a cached result, or crash-healing.
     * `error` is a SEPARATE dimension — denial/heal = true; a cache hit omits it. */
    preResolved?: { answer: string; stored?: unknown; error?: boolean; errorMessage?: string };
}

/**
 * The Agent class. The file imports raw classes, wires them, runs.
 * `agent.run()` runs until terminate() (the off switch) or process shutdown.
 *
 * THE EXTENSION CONTRACT — two doors, no fork:
 *   COMPOSITION (99%): the filter bus + plugins + declared registries + custom
 *     tools/models/inputs. Build anything by adding behaviors; the core never
 *     changes.
 *   INHERITANCE (the override seam): every meaningful machine method below is
 *     `protected` — step(), providerStep(), land(), parkNow(), the loops, the
 *     derivations. Import the class, extend it, override ONE seam, call super
 *     for the rest. The plumbing (observer/proxy, event internals) stays private.
 *   VERSIONING: the public GodObject surface + these protected seams are
 *     semi-contractual — stable across minors, changed only on a major.
 */
export class Agent implements GodObject {
    // ---- identity (OBSERVED — the session knows its own name; taped, restored, forkable) ----
    get id(): string {
        return this.data.id;
    }
    set id(v: string) {
        this.data.id = v;
    }
    get agentId(): string {
        return this.data.agentId;
    }
    set agentId(v: string) {
        this.data.agentId = v;
    }
    // ---- THE OBSERVED GOD-OBJECT DATA ----
    // ONE container the diff observer watches whole: every mutation of ANY field
    // ONE container the Proxy observer watches whole: every mutation of ANY field
    // produces a KeyChange → the `patched` event (the universal delta). The public
    private data: SessionData = {
        id: "",
        agentId: "default",
        cwd: ".",
        description: undefined,
        activity: "",
        model: undefined as unknown as ModelContract,
        messages: [],
        stats: emptySessionStats(),
        state: {},
        transient: {},
        loopState: "idle",
        runState: "none",
        pendingAwaits: [],
        pendingQuestions: [],
        currentAction: undefined,
        tools: [],
        tickPlan: [],
        lastResponse: -1,
    };

    // ---- session accessors (the GodObject surface — read/write through the container) ----
    get cwd(): string { return this.data.cwd; }
    set cwd(v: string) { this.data.cwd = v; }
    get description(): string { return this.data.description ?? ""; }
    set description(v: string) { this.data.description = v; }
    get activity(): string { return this.data.activity; }
    set activity(v: string) { this.data.activity = v; }
    get model(): ModelContract { return this.data.model; }
    set model(v: ModelContract) { this.data.model = v; }
    get messages(): Message[] { return this.data.messages; }
    set messages(v: Message[]) { this.data.messages = v; }
    get stats(): Stats { return this.data.stats; }
    set stats(v: Stats) { this.data.stats = v; }
    get state(): Record<string, unknown> { return this.data.state; }
    set state(v: Record<string, unknown>) { this.data.state = v; }
    get transient(): Record<string, unknown> { return this.data.transient; }
    set transient(v: Record<string, unknown>) { this.data.transient = v; }
    get loopState(): LoopState { return this.data.loopState; }
    set loopState(v: LoopState) { this.data.loopState = v; }
    get runState(): string { return this.data.runState; }
    set runState(v: string) { this.data.runState = v; }
    get pendingAwaits(): PendingAwait[] { return this.data.pendingAwaits; }
    set pendingAwaits(v: PendingAwait[]) { this.data.pendingAwaits = v; }
    get pendingQuestions(): PendingQuestion[] { return this.data.pendingQuestions; }
    set pendingQuestions(v: PendingQuestion[]) { this.data.pendingQuestions = v; }
    get currentAction(): unknown { return this.data.currentAction; }
    set currentAction(v: unknown) { this.data.currentAction = v; }
    get tools(): Tool[] { return this.data.tools; }
    set tools(v: Tool[]) { this.data.tools = v; }
    get tickPlan(): string[] { return this.data.tickPlan; }
    set tickPlan(v: string[]) { this.data.tickPlan = v; }
    get lastResponse(): number { return this.data.lastResponse; }
    set lastResponse(v: number) { this.data.lastResponse = v; }

    /** Write the LIVE activity string — natural language, plugin-authored ("waiting 5:00 until
     * next trigger", "running git status"). Call on meaningful change, not per tick. Observed →
     * patched → tape → dashboard. */
    setActivity(text: string): void {
        this.data.activity = text;
    }
    // ---- profile (code, never serialized) ----
    filters: Filter[] = [];
    /** Installed plugins by id — the extension storage. */
    private pluginMap = new Map<string, Plugin>();
    /** ---- declared registries (private Maps — the agent's contract surface) ---- */
    private declaredInputs: Map<string, DeclaredInput> = new Map();
    private declaredCapabilities: Map<string, DeclaredCapability> = new Map();
    /** Built-in core events (the 38 from EVENTS) — `delete` is a no-op on them. */
    private declaredEvents: Map<string, DeclaredEvent> = new Map();
    private coreEventIds: Set<string> = new Set(Object.values(EVENTS));
    // ---- machinery ----
    /** The filter bus — also exposes the listener layer. */
    bus: FilterBus;
    /** The loop hands this to the model — stream events buffer, flush at the next tick. */
    streamSink: StreamSink = {
        emit: (ev: StreamEvent) => this.streamBuffer.push(ev),
    };
    /** The abort controller — abort() fires it; the model checks it. */
    abortController = new AbortController();

    // ---- internal state ----
    /** The input being processed right now — public, the position. */
    currentInput: Input | undefined;
    /** The message in the pipeline right now — public, the position. */
    currentTurn: Message | undefined;
    private cycleState: CycleState = { ended: false };
    /**
     * THE TURN PIPELINE — one named stage. The WORKER walks it linearly with
     * plain awaits; a park saves position here (currentAction) and the
     * supervisor relaunches the worker when the awaits clear.
     *
     *   IDLE       nothing in flight
     *   GATING     per-call beforeTool gates, cursor = calls[gateCursor]
     *   EXECUTING  gates done, tool batch awaited inline
     *   PROVIDER   the money call awaited inline
     */
    private phase: "IDLE" | "GATING" | "EXECUTING" | "PROVIDER" = "IDLE";
    /** Position within the gate sequence — meaningful while phase === "GATING". */
    private gateCursor = 0;
    /** THE BLOCK FLAG — literal. Loop 1 sets it; loop 2 reads it every beat.
     * True while inputs drain OR pending awaits pin the worker. Observable,
     * debuggable, never written by the worker itself. */
    private _blocked = false;
    /** Teardown fires ONCE per terminal — after that the ticks sit still
     * (or END entirely, under terminate()). */
    private tornDown = false;
    /** Stream micro-events buffered by the model — flushed at the next tick. */
    private streamBuffer: StreamEvent[] = [];
    /** Index of the last message the provider answered — owed work is derived from it (in the container). */
    // lastResponse lives in `data` — the accessor above is the surface.
    /** wake() while idle → the machine starts a turn (compaction, follow-up drain). */
    private wakeRequested = false;
    /** LAUNCH GATE — run({startState:"idle"}) disarms it: the SEEDED transcript
     *  no longer counts as demand (born-landed — the machine wakes as if it
     *  already arrived at a conclusion). The first real poke from outside —
     *  an input actually draining, or wake() — arms it permanently; from that
     *  moment the ordinary derivation rules apply, unchanged. Observable via
     *  the launch posture: armed=false + owedResponse=true ⇒ "waiting on purpose". */
    private armed = true;
    /** The bus cycle is open (beginCycle ran, endCycle not yet). */
    private cycleOpen = false;
    /** turnStart has fired for the current turn — fires ONCE, not per cycle. */
    private turnStartFired = false;
    /** The halt states — GodObject exposes them readonly; the chain checks
     * them before EVERY filter (CANCEL rule). Set via stop()/pause()/abort(). */
    stopRequested = false;
    pauseRequested = false;
    /** Sync inputs awaiting the barrier drain — ALL processed before the loop continues. */
    private pendingSync: Input[] = [];
    /** Async inputs — fire-and-forget, drained independently, never block the loop. */
    private pendingAsync: Input[] = [];
    /** True while run() is the active driver (the endless loop owns waking). */
    private runDriven = false;
    /** THE OFF SWITCH — set by terminate(); both loops check it every beat and
     * exit when true. The ONLY thing that ends run(). */
    private terminated = false;
    /** The stored two-clocks promise — terminate() returns it, so callers can
     * await an actually-dead agent instead of a flag flip. */
    private runPromise: Promise<void> | undefined;
    /** A turn has begun (first turnStart) and not yet landed — the mid-turn signal. */
    private startedTurn = false;
    /** Total ticks executed — the heartbeat counter. (NOT observed — 100/sec would drown the stream.) */
    ticks = 0;

    // ---- the universal delta: ONE diff-free observer over the whole container ----
    /** raw → wrapped proxy (child paths cached per target) — the observer's WeakMap. */
    private observed = new WeakMap<object, object>();
    /** proxy → raw — merge() needs the SILENT side (mutations without traps). */
    private rawByProxy = new WeakMap<object, object>();
    private pendingEvents: { event: EventName; messageId?: string; fragmentId?: string; message?: Message; change?: KeyChange }[] = [];

    constructor(opts: AgentOptions) {
        this.id = opts.id ?? crypto.randomUUID();
        this.agentId = opts.agentId ?? "default";
        this.description = opts.description ?? "";
        this.activity = "";
        this.cwd = opts.cwd ?? (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.() ?? ".";
        this.model = opts.model;
        this.messages = opts.messages ?? [];
        this.state = opts.state ?? {};
        // THE LAW — run() CALCULATES NOTHING. It starts with whatever messages
        // exist, whatever their structure, and calls immediately. lastResponse
        // begins at -1: no message is pre-answered, so any non-empty array is
        // work on the very first tick. The ONLY opt-out is run({ startState:
        // "idle" }) — arrives idle and does not tick.
        this.lastResponse = -1;
        // Fail loudly on duplicate tool names in the creation array — same
        // invariant as addTool, since this bulk path bypasses it. A backend
        // template passing two tools of the same name must not silently win.
        const creationTools = opts.tools ?? [];
        const seenToolNames = new Set<string>();
        for (const t of creationTools) {
            if (seenToolNames.has(t.name)) {
                throw new Error(
                    `[sanity] tool name "${t.name}" is duplicated in the creation tools array. ` +
                    `Tool names must be unique (add once, delete once).`,
                );
            }
            seenToolNames.add(t.name);
        }
        this.tools = creationTools;
        this.bus = new FilterBus(this);
        this.data = this.observe(this.data, ""); // the path-tracking observer wraps the whole container

        // Pre-populate declared events with the 38 core events — they exist before any plugin loads.
        for (const id of Object.values(EVENTS)) {
            this.declaredEvents.set(id, { id });
        }
    }

    // ==========================================================================
    // Public API — the file wires these
    // ==========================================================================

    /** Register a filter. ALWAYS an object. */
    addFilter(filter: Filter): this {
        // bus.add throws on a duplicate id — run it BEFORE we mutate
        // this.filters, so a rejection leaves the two arrays in sync.
        this.bus.add(filter);
        this.filters.push(filter);
        return this;
    }

    /** Remove a filter by id. */
    removeFilter(event: string, id: string): boolean {
        const idx = this.filters.findIndex((f) => f.id === id && f.event === event);
        if (idx !== -1) this.filters.splice(idx, 1);
        return this.bus.remove(event, id);
    }

    /** DISABLE — out of the queue for all future cycles until enable. */
    disableFilter(event: string, id: string): boolean {
        return this.bus.disable(event, id);
    }

    /** ENABLE — put a disabled filter back in future cycles. */
    enableFilter(event: string, id: string): boolean {
        return this.bus.enable(event, id);
    }

    // ---- plugins: named batches of registrations with a lifecycle ----

    // ---- declared registries (the core promise — three id-keyed Maps) ----

    /** Declare an INPUT — what a plugin ACCEPTS (id-keyed, Zod schema = the value). */
    addDeclaredInput(entry: DeclaredInput): void {
        if (!entry.id) return;
        // id is the unique handle — a duplicate would silently clobber another
        // plugin's (or a built-in's) declared promise, so refuse loudly.
        if (this.declaredInputs.has(entry.id)) {
            throw new Error(
                `[sanity] declared input id "${entry.id}" already registered. ` +
                `Declared ids must be unique (add once, delete once) — use a distinct id or removeDeclaredInput first.`,
            );
        }
        this.declaredInputs.set(entry.id, entry);
    }

    /** Remove a declared input by id. */
    removeDeclaredInput(id: string): boolean {
        return this.declaredInputs.delete(id);
    }

    /** Snapshot of declared inputs. */
    listDeclaredInputs(): DeclaredInput[] {
        return Array.from(this.declaredInputs.values());
    }

    /** Look up a declared input. */
    getDeclaredInput(id: string): DeclaredInput | undefined {
        return this.declaredInputs.get(id);
    }

    /** Declare a CAPABILITY — coarse identity, description REQUIRED. */
    addDeclaredCapability(entry: DeclaredCapability): void {
        if (!entry.id || !entry.description) return;
        if (this.declaredCapabilities.has(entry.id)) {
            throw new Error(
                `[sanity] declared capability id "${entry.id}" already registered. ` +
                `Declared ids must be unique (add once, delete once) — use a distinct id or removeDeclaredCapability first.`,
            );
        }
        this.declaredCapabilities.set(entry.id, entry);
    }

    /** Remove a declared capability by id. */
    removeDeclaredCapability(id: string): boolean {
        return this.declaredCapabilities.delete(id);
    }

    /** Snapshot of declared capabilities. */
    listDeclaredCapabilities(): DeclaredCapability[] {
        return Array.from(this.declaredCapabilities.values());
    }

    /** Look up a declared capability. */
    getDeclaredCapability(id: string): DeclaredCapability | undefined {
        return this.declaredCapabilities.get(id);
    }

    /** Declare an EVENT — what a plugin PRODUCES. */
    addDeclaredEvent(entry: DeclaredEvent): void {
        if (!entry.id) return;
        // id is the unique handle — a duplicate (incl. a built-in core event)
        // would silently clobber the declaration, so refuse loudly.
        if (this.declaredEvents.has(entry.id)) {
            throw new Error(
                `[sanity] declared event id "${entry.id}" already registered. ` +
                `Declared ids must be unique (add once, delete once) — use a distinct id or removeDeclaredEvent first.`,
            );
        }
        this.declaredEvents.set(entry.id, entry);
    }

    /** Remove a custom event by id. No-op on built-in core events. */
    removeDeclaredEvent(id: string): boolean {
        if (this.coreEventIds.has(id)) return false;
        return this.declaredEvents.delete(id);
    }

    /** Snapshot of declared events (built-ins + custom). */
    listDeclaredEvents(): DeclaredEvent[] {
        return Array.from(this.declaredEvents.values());
    }

    /** Look up a declared event. */
    getDeclaredEvent(id: string): DeclaredEvent | undefined {
        return this.declaredEvents.get(id);
    }

    /** Installed plugins — observable snapshot. */
    get plugins(): Plugin[] {
        return [...this.pluginMap.values()];
    }

    /**
     * Install a plugin: runs its install(agent) — it registers everything under
     * `${plugin.id}/` — then tracks it by id. Duplicate id throws (silent replace
     * would leave zombie registrations).
     *
     * FAIL-FAST BY DESIGN: if an install step throws, the error propagates and the
     * plugin is NOT tracked. We do NOT roll back partial registrations — plugins
     * are expected not to fail; a half-installed agent is a wiring bug that must
     * scream, not a state we quietly unwind. Uninstall what you registered when you
     * are the one handling your own failure.
     */
    install(plugin: Plugin): this {
        if (this.pluginMap.has(plugin.id)) {
            throw new Error(`[sanity] plugin '${plugin.id}' already installed`);
        }
        this.assertInstallable(plugin);
        const spec = plugin.install;
        if (typeof spec === "function") {
            spec.call(plugin, this);
        } else {
            // Modular form: run each named step sequentially, as if one body.
            // Stable key order = insertion order. Null/undefined steps are
            // skipped — a subclass can null a key to drop a base step.
            for (const key of Object.keys(spec)) {
                const step = spec[key];
                if (typeof step === "function") step.call(plugin, this);
            }
        }
        this.pluginMap.set(plugin.id, plugin);
        return this;
    }

    /** Uninstall a plugin by id: its uninstall() removes everything it registered. */
    uninstall(pluginId: string): boolean {
        const plugin = this.pluginMap.get(pluginId);
        if (!plugin) return false;
        const dependents = [...this.pluginMap.values()]
            .filter((p) => p.id !== pluginId && p.requires?.includes(pluginId))
            .map((p) => p.id);
        if (dependents.length > 0) {
            throw new PluginDependencyError("in-use", pluginId, dependents);
        }
        plugin.uninstall(this);
        this.pluginMap.delete(pluginId);
        return true;
    }

    /**
     * Dependency guard: every id in `requires` must already be installed
     * (transitively), and the graph must stay acyclic. Throws
     * PluginDependencyError BEFORE anything gets registered — a failed install
     * leaves the agent untouched. With strict requires a cycle is structurally
     * self-blocking (each member fails "missing" first); this walk is the
     * safety net for future batch installs.
     */
    private assertInstallable(plugin: Plugin): void {
        const root = plugin.id;
        const visiting = new Set<string>();
        const walk = (id: string, path: string[]): { cycle: boolean; chain: string[] } | null => {
            if (id === root) return { cycle: true, chain: [...path, id] };
            const dep = this.pluginMap.get(id);
            if (!dep) return { cycle: false, chain: [...path, id] };
            if (visiting.has(id)) return { cycle: true, chain: [...path, id] };
            visiting.add(id);
            for (const next of dep.requires ?? []) {
                const r = walk(next, [...path, id]);
                if (r) return r;
            }
            visiting.delete(id);
            return null;
        };
        for (const req of plugin.requires ?? []) {
            const r = walk(req, [root]);
            if (r) {
                throw new PluginDependencyError(
                    r.cycle ? "cycle" : "missing",
                    root,
                    [r.chain[r.chain.length - 1]],
                    r.chain,
                );
            }
        }
    }
    /** Attach a direct meta-callback — watch/control the machinery, NOT a filter. */
    onFilter(cb: Parameters<FilterBus["onFilter"]>[0]): this {
        this.bus.onFilter(cb);
        return this;
    }

    /** Attach a cycle-level callback — the whole-queue reorganization point. */
    onCycle(cb: Parameters<FilterBus["onCycle"]>[0]): this {
        this.bus.onCycle(cb);
        return this;
    }

    // ---- tools: the mutable array ----

    /** Register a tool. Fires toolListChanged (the LIST changed). */
    addTool(tool: Tool): this {
        // Tool names MUST be unique — they are the sole handle for
        // removeTool / updateTool. A duplicate would be ambiguous to address
        // (remove/update only match the first), so we refuse loudly.
        if (this.tools.some((t) => t.name === tool.name)) {
            throw new Error(
                `[sanity] tool name "${tool.name}" is already registered. ` +
                `Tool names must be unique (add once, delete once) — use a distinct name or removeTool first.`,
            );
        }
        this.tools.push(tool);
        this.fire(EVENTS.toolListChanged, { added: tool.name }, true);
        return this;
    }

    /** Remove a tool — DESTRUCTIVE (changes the wire prompt, cache-busts). */
    removeTool(name: string): boolean {
        const i = this.tools.findIndex((t) => t.name === name);
        if (i === -1) return false;
        this.tools.splice(i, 1);
        this.fire(EVENTS.toolListChanged, { removed: name }, true);
        return true;
    }

    /**
     * Update a tool's DEFINITION in place (schema / description / executionMode).
     * Fires toolUpdate — the per-tool definition-changed event.
     * Cache-friendly: same name, same presence, changed guts.
     */
    updateTool(name: string, updates: Partial<Pick<Tool, "description" | "inputSchema" | "outputSchema" | "executionMode" | "hidden">>): boolean {
        const t = this.tools.find((t) => t.name === name);
        if (!t) return false;
        Object.assign(t, updates);
        this.fire(EVENTS.toolUpdate, { toolName: name, updates }, true);
        return true;
    }

    /** Disable a tool — NON-DESTRUCTIVE (stays in prompt, execute is a no-op). */
    disableTool(name: string): boolean {
        const t = this.tools.find((t) => t.name === name);
        if (!t) return false;
        t.disabled = true;
        this.fire(EVENTS.toolUpdate, { toolName: name, disabled: true }, true);
        return true;
    }

    /** Enable a previously disabled tool. */
    enableTool(name: string): boolean {
        const t = this.tools.find((t) => t.name === name);
        if (!t) return false;
        t.disabled = false;
        this.fire(EVENTS.toolUpdate, { toolName: name, disabled: false }, true);
        return true;
    }

    /** The tools the PROVIDER sees — everything except `hidden`. Hidden tools
     * stay callable (execute runs when the name is matched) but never reach
     * context. Model adapters build their wire list from this, NEVER from
     * `tools` directly. */
    visibleTools(): Tool[] {
        return this.tools.filter((t) => !t.hidden);
    }

    /** HIDE — out of context (the wire prompt), but still callable by name.
     * DESTRUCTIVE from the provider's view: the visible tool set changed, so
     * this cache-busts (toolListChanged), like add/remove. */
    hideTool(name: string): boolean {
        const t = this.tools.find((t) => t.name === name);
        if (!t) return false;
        if (t.hidden) return true; // already hidden — no change, no event
        t.hidden = true;
        this.fire(EVENTS.toolListChanged, { hidden: name }, true);
        return true;
    }

    /** SHOW — back into context. Cache-busts (toolListChanged) when it changes. */
    showTool(name: string): boolean {
        const t = this.tools.find((t) => t.name === name);
        if (!t) return false;
        if (!t.hidden) return true; // already visible — no change, no event
        t.hidden = false;
        this.fire(EVENTS.toolListChanged, { shown: name }, true);
        return true;
    }

    // ---- control signals ----
    // THE DOCTRINE: aborted is the HARD stop (terminal — kills the controller,
    // nothing survives). stopped is the GENTLE request (a flag only — the
    // worker lands at the next natural boundary; never terminal). idle is the
    // NATURAL CONCLUSION — never requested, derived when the loop is exhausted.
    // terminated is THE OFF SWITCH — the heartbeat itself ends and run()
    // resolves (ephemeral/temporary agents). Everything else keeps ticking.

    /**
     * HARD KILL — terminal. Aborts the controller (in-flight model/bash/streams
     * get the signal), clears the resume position, lands in `aborted` forever.
     * The heart KEEPS BEATING (silent ticks) — this kills the turn, not the loop.
     */
    abort(reason = "aborted"): void {
        if (this.isTerminal()) return; // aborted/errored/terminated — dead is dead
        this.fire(EVENTS.beforeAbort, { reason }, true);
        this.abortController.abort();
        this.currentAction = undefined;
        this.fire(EVENTS.abort, { reason }, true);
        this.loopState = "aborted";
    }

    /**
     * THE OFF SWITCH — the only thing that ends run(). abort() kills the turn
     * but the heart keeps beating (process-lifetime agents); terminate() stops
     * the heart: fires the abort family IF anything is in flight (an idle
     * agent dies QUIETLY — no fake abort events in the stream), stamps
     * `terminated`, both loops break at their next beat (≤1 quantum), and
     * run() RESOLVES.
     *
     * Fire-and-forget safe: `void agent.terminate()` needs no listener — a
     * defensive catch logs any late loop crash instead of surfacing an
     * unhandled rejection. Await it when you need the join point ("the corpse
     * is cold — the temp agent is reaped, proceed").
     *
     * Idempotent. Dead stays dead: run() after terminate() resolves
     * immediately without starting anything. State is NOT wiped — the
     * post-mortem stays inspectable (state is truth).
     */
    terminate(reason = "terminated"): Promise<void> {
        if (this.terminated) return this.runPromise ?? Promise.resolve();
        this.terminated = true;
        this.runDriven = true; // a terminated agent can never be driven again
        // In-flight work gets the real kill: signal + event family + terminal
        // stamp. Idle/quiet agents skip it — terminating must not fabricate
        // beforeAbort/abort noise for a turn that never existed.
        if (this.hasWorkerWork() || this.pendingSync.length > 0) {
            this.abort(reason);
        }
        this.loopState = "terminated";
        // fire-and-forget insurance: nobody holding the promise must never
        // mean an unhandled rejection if a loop crashes mid-death.
        this.runPromise?.catch((err) =>
            console.error("[sanity] loop crashed while terminating:", err),
        );
        return this.runPromise ?? Promise.resolve();
    }

    /** GENTLE request — a flag only. No controller abort, no stream kill:
     * in-flight tools finish, then the worker lands at the next boundary.
     * Observable as `stopped` while landing; NEVER terminal (lands → idle). */
    stop(): void {
        this.stopRequested = true;
    }

    /** GENTLE request, same family as stop() — finish the current message,
     * land after it commits. Also observable as `stopped`. NEVER terminal. */
    pause(): void {
        this.pauseRequested = true;
    }

    // ---- state (patched writes) ----

    /** Write session state — the container diff catches it → a `patched` broadcast. */
    setState(key: string, value: unknown): void {
        this.state[key] = value;
    }

    /**
     * Change the working directory. First-class: cwd lives in the observed
     * container, so the diff catches it → a `/cwd` patch on the `patched` stream.
     * Running tools keep their cwd; the NEXT call sees it.
     */
    setCwd(path: string): void {
        this.cwd = path;
    }

    /** Park helper — push a pending await. The loop checks at blocks boundaries. */
    park(awaitItem: PendingAwait): void {
        this.pendingAwaits.push(awaitItem);
    }

    /** Add a pending QUESTION — non-blocking, pure state. The loop never gates on it.
     * Rendered by whoever reads `pendingQuestions` (diff/patched carries the change).
     * Answering = a filter matches an input by ref → removePendingQuestion → acts. */
    addPendingQuestion(q: PendingQuestion): void {
        this.pendingQuestions.push(q);
    }
    /** Remove a pending question by id — the answering filter calls this after matching. */
    removePendingQuestion(id: string): void {
        const arr = this.pendingQuestions;
        const idx = arr.findIndex((q) => q.id === id);
        if (idx !== -1) arr.splice(idx, 1);
    }
    /** Wake — the pure "keep going" SIGNAL. No input object, no drain, no filters,
     * no message: sets wakeRequested, which the supervisor consumes as the
     * start-turn trigger (compaction, follow-up drain). A signal never starts a
     * loop and never touches state beyond the flag — the eternal heartbeat
     * notices next tick, or whenever a host starts one (agent.run()). */
    wake(): void {
        this.wakeRequested = true;
        this.armed = true; // a poke is a statement: live signals count now
    }

    /**
     * THE TWO CLOCKS. Starts loop 1 (the signal supervisor) and loop 2 (the
     * worker) — both `while(!terminated){ sleep; check }`, coordinated ONLY
     * through the literal `blocked` flag + derived loopState.
     * THE LAW: no break, ever — EXCEPT terminate(). Flags
     * (aborted/errored/stopped) change what ticks DO (usually: nothing);
     * nothing changes whether the loops run — except the off switch, which
     * flips them to exit and RESOLVES this promise. Without terminate() the
     * clocks are eternal; shutdown happens at the APP layer (process.exit /
     * host teardown).
     *
     * The sleeps are pure CPU breathers — the awaits inside are the real
     * suspension. The promise is stored: terminate() hands it back so hosts
     * can await a genuinely-dead agent.
     */
    async run(opts?: { startState?: "idle" }): Promise<void> {
        if (this.runDriven || this.terminated) return this.runPromise;
        if (opts?.startState === "idle") this.armed = false;
        // THE LAW — a DEFAULT run() with ZERO messages is a HARD ERROR, not a
        // silent idle: run() is a work call, and an empty array is a wiring bug
        // that must scream. An idle-start (startState:"idle") may legitimately
        // boot empty — it ignores everything until manually kicked (input,
        // follow-up, wake).
        if (this.messages.length === 0 && opts?.startState !== "idle") {
            throw new Error(
                "[sanity] run() with zero messages — no system prompt, no user message, nothing to send. Seed messages before run().",
            );
        }
        this.runDriven = true;
        this.runPromise = (async () => {
            await Promise.all([this.loop1(), this.loop2()]);
        })();
        return this.runPromise;
    }

    /** THE BLOCK FLAG — the literal, observable, debuggable truth. */
    get blocked(): boolean {
        return this._blocked;
    }

    /** Park-blocked: a saved position exists and its ask isn't answered yet. */
    protected parkBlocked(): boolean {
        return this.currentAction !== undefined && this.pendingAwaits.length > 0;
    }

    /**
     * Send an input — THE SIGNAL DOOR, and nothing else. A signal may produce
     * side-effects (a filter pushes a message) or nothing at all. It does NOT
     * start loops and does NOT flip state: if no heartbeat is running, the
     * signal simply sits in the queue until the host starts one (agent.run()).
     * SYNC inputs are the interrupt: drained at the very top of the next
     * supervisor tick (≤1 quantum), block raised so the worker stands down
     * until their chains settle. ASYNC inputs are fire-and-forget: queued to a
     * microtask sideband, never wake or block anything.
     */
    input(input: Input): void {
        if (input.async === true) {
            this.pendingAsync.push(input);
            queueMicrotask(() => this.drainPendingAsync());
            return;
        }
        this.pendingSync.push(input);
    }

    /** True while a turn is in flight (first turnStart ran, loop not landed). */
    get inTurn(): boolean {
        return this.startedTurn;
    }

    /** The pending queues — observable (a UI can render "N pending, M async"). */
    get pendingInputs(): { sync: Input[]; async: Input[] } {
        return { sync: [...this.pendingSync], async: [...this.pendingAsync] };
    }


    /**
     * THE ASYNC QUEUE. Fire-and-forget: drained independently on a microtask,
     * never wakes or blocks the loop, no state guarantees. UI/telemetry chatter
     * the loop doesn't care about. If its chain adds messages, the MESSAGE channel
     * announces them (messageAdded) — input itself stays orthogonal to messages.
     */
    private drainPendingAsync(): void {
        const inputs = this.pendingAsync;
        if (inputs.length === 0) return;
        this.pendingAsync = [];
        this.processAsyncSeq(inputs);
    }

    /** Async lane — sequential awaits, microtask sideband, zero loop coupling. */
    private async processAsyncSeq(inputs: Input[]): Promise<void> {
        const input = inputs.shift();
        if (!input) {
            this.currentInput = undefined;
            return;
        }
        this.currentInput = input;
        const before = this.messages.length;
        await this.bus.runFromRegistry(EVENTS.inputReceived, { input });
        // the MESSAGE channel announces whatever the chain added — input stays orthogonal
        for (let i = before; i < this.messages.length; i++) {
            const addedMsg = this.messages[i];
            await this.bus.runFromRegistry(EVENTS.messageAdded, { turn: addedMsg });
        }
        this.flushPendingEvents(); // side effects' KeyChanges broadcast
        this.fire(EVENTS.inputProcessed, { input }, true); // observable now
        await this.processAsyncSeq(inputs);
    }

    // ==========================================================================
    // LOOP 1 — THE SIGNAL SUPERVISOR. Eternal. ONE job: inputs + the block flag.
    // ==========================================================================
    // Every beat, four things, in order, then out of the way:
    //   1. sync inputs arrived? → BLOCK (literal flag), await every chain, unblock
    //   2. derive blocked: pending awaits pin the worker until answered
    //   3. derive loopState from raw state (idle/stopped/awaiting/running)
    //   4. chores: terminal → teardown (once); stream deltas → visibility; flush
    // It never asks what the worker is doing. The worker never asks why.

    /** Loop 1 — the signal supervisor. Eternal (until terminate()), no breaks, dumb by design. */
    protected async loop1(): Promise<void> {
        while (!this.terminated) {
            await sleep(TICK_MS); // CPU breather — the awaits below are the real suspension
            this.ticks++;
            this.tickPlan = [];

            // P0 — the interrupt. Block DURING processing, then unblock.
            if (this.pendingSync.length > 0) {
                this._blocked = true;
                this.tickPlan.push("drain-inputs");
                await this.drainInputs(); // every chain, fully awaited
                this._blocked = false;
            }

            // Pending awaits pin the worker forever — until an answer clears them.
            this._blocked = this.pendingAwaits.length > 0;
            if (this._blocked) this.tickPlan.push("blocked");

            // The truth, refreshed every beat.
            this.deriveLoopState();

            // Chores.
            if (this.isTerminal()) {
                if (!this.tornDown) { this.tornDown = true; this.teardown(); }
                this.flushPendingEvents();
                continue;
            }
            if (this.streamBuffer.length > 0) {
                this.tickPlan.push("flush-stream");
                this.flushStream();
            }
            this.flushPendingEvents();
        }
    }

    /** The observable truth, derived fresh every beat. Terminal (aborted/errored/terminated)
     * is terminal — never overwritten. `stopped` is transient: the gentle
     * request in flight, lands to idle. `idle` is the NATURAL CONCLUSION —
     * never requested, just what the loop is when exhausted. */
    protected deriveLoopState(): void {
        if (this.isTerminal()) return;
        if (this.pendingAwaits.length > 0) { this.loopState = "awaiting"; return; }
        if (this.stopRequested || this.pauseRequested) { this.loopState = "stopped"; return; }
        if (this.hasWorkerWork()) { this.loopState = "running"; return; }
        this.loopState = "idle";
    }

    /** Does the worker have anything to walk? Pure derivation.
     *  The seeded transcript only votes while ARMED — a disarmed launch waits
     *  for its first real poke before history can demand anything. */
    protected hasWorkerWork(): boolean {
        return (
            this.currentAction !== undefined ||
            this.startedTurn ||
            (this.armed && this.owedResponse()) ||
            this.wakeRequested
        );
    }

    // ---- P0 — the SIGINT barrier ----

    /** Process every pending sync input — each through its full filter chain,
     * ON the supervisor, awaited fully, sequentially. The worker cannot run
     * here: it only launches after this barrier completes. */
    protected async drainInputs(): Promise<boolean> {
        this.runState = "accepting";
        const inputs = this.pendingSync;
        if (inputs.length === 0) return false;
        this.pendingSync = [];
        await this.processInputSeq(inputs);
        this.armed = true; // real input landed — the waiting state is over
        return true;
    }

    /** One input at a time, each FULLY awaited — announcements inline. */
    protected async processInputSeq(inputs: Input[]): Promise<void> {
        const input = inputs.shift();
        if (!input) {
            this.currentInput = undefined;
            return;
        }
        this.currentInput = input;
        const before = this.messages.length;
        await this.bus.runFromRegistry(EVENTS.inputReceived, { input });
        // the MESSAGE channel announces any additions the input chain made —
        // input stays orthogonal; messageAdded is the add-lifecycle event
        for (let i = before; i < this.messages.length; i++) {
            const addedMsg = this.messages[i];
            await this.bus.runFromRegistry(EVENTS.messageAdded, { turn: addedMsg });
        }
        this.flushPendingEvents(); // broadcast the side effects' KeyChanges
        this.fire(EVENTS.inputProcessed, { input }, true); // state + delta observable
        await this.processInputSeq(inputs);
    }

    // ---- P1 — terminal ----

    protected teardown(): void {
        this.runState = "none";
        this.fire(EVENTS.agentEnd, {}, true);
    }

    // ---- P2 — stream micro-events ----

    protected flushStream(): void {
        const batch = this.streamBuffer;
        this.streamBuffer = [];
        this.runState = "generating";
        for (const ev of batch) {
            const event = this.streamEventName(ev.type);
            // TEMPORAL-ONLY: publish=false → the delta rides event.streamDelta (no KeyChange
            // flood, no self-feed); filters read it from the 2nd arg.
            // REGISTRY LANE: streams are temporal telemetry, not transaction
            // participants — delivery must NOT depend on cycle state. The
            // registry lane reaches listeners ANY time (mid-cycle, post-cycle,
            // parked), so a flush landing after endCycle still paints.
            this.fire(event, { streamDelta: ev }, true, false);
        }
    }

    private streamEventName(type: StreamEvent["type"]): EventName {
        switch (type) {
            case "streamStarted": return EVENTS.streamStarted;
            case "textDelta": return EVENTS.textDelta;
            case "textEnd": return EVENTS.textEnd;
            case "thinkingDelta": return EVENTS.thinkingDelta;
            case "thinkingEnd": return EVENTS.thinkingEnd;
            case "toolcallDelta": return EVENTS.toolcallDelta;
        }
    }

    // ==========================================================================
    // LOOP 2 — THE WORKER. Eternal. The literal block flag decides.
    // ==========================================================================
    // Every beat: check the flag, check the flags, then take ONE step — or
    // nothing. A park is simply the worker NOT taking a step while blocked.
    // Resume is automatic: the answer clears the await → loop 1 unblocks →
    // the next beat sees legal work and steps from the saved position.

    /** Loop 2 — the worker. Eternal (until terminate()), no breaks, the flag is the boss. */
    protected async loop2(): Promise<void> {
        while (!this.terminated) {
            await sleep(TICK_MS); // CPU breather — the awaits inside are the real suspension
            if (this._blocked) continue;         // THE literal flag — frozen until unblocked
            if (this.isTerminal()) continue;     // aborted/errored → nothing
            if (this.stopRequested || this.pauseRequested) { await this.land(); continue; }
            if (!this.hasWorkerWork()) continue; // no live cycle → nothing
            try {
                if (!this.startedTurn) this.startTurn();
                // PARK CHECKPOINT — derived each beat, pure state. parkNow fires
                // the stop family ONCE per park (parkBlocked guard stops re-fires).
                if (this.pendingAwaits.length > 0 && !this.parkBlocked()) {
                    if (!this.currentAction) {
                        const lastMsg = this.messages.at(-1);
                        this.currentAction =
                            lastMsg?.type === "toolCall" && this.phase !== "EXECUTING"
                                ? { phase: "toolExec" }
                                : { phase: "providerCall" };
                    }
                    await this.parkNow();
                    continue;
                }
                await this.step();               // ONE step, then back to sleep
                this.flushPendingEvents();
            } catch (err) {
                await this.fail(err);            // flag + chores — the clock continues
            }
        }
    }

    /** ONE pipeline step, fully awaited. Returns "continue" | "parked" | "landed". */
    protected async step(): Promise<"continue" | "parked" | "landed"> {
        // resume a parked position FIRST — never skip a gate
        if (this.currentAction) {
            if (this.pendingAwaits.length > 0) return "parked";
            const act = this.currentAction as { phase: "providerCall" | "toolExec" };
            this.currentAction = undefined;
            if (this.isTerminal()) { await this.land(); return "landed"; }
            if (act.phase === "providerCall") return await this.providerStep();
            // toolExec → fall through to gates; the cursor knows where we were
        }
        if (this.stopRequested || this.pauseRequested) { await this.land(); return "landed"; }
        if (this.cycleState.ended) this.discardCycle();

        const last = this.messages.at(-1);
        // THE OUTSTANDING BATCH — the last toolCall whose calls aren't ALL
        // committed yet. Covers BOTH shapes: last message is the toolCall
        // (fresh toolCall, batch not started) AND the tail is partial results
        // (crash-heal: the restored worker must COMMIT the missing calls —
        // never re-run the done ones).
        let batchMsg: Message | undefined;
        for (let i = this.messages.length - 1; i >= 0; i--) {
            const m = this.messages[i];
            if (m.type === "toolCall") { batchMsg = m; break; }
        }
        const committed = new Set(
            this.messages.filter((m) => m.type === "toolResult").map((m) => (m as ToolResultMessage).toolCallId),
        );
        const batchCalls = ((batchMsg?.content as { stored?: ToolCallRecord[] } | undefined)?.stored) ?? [];
        const needsBatch = batchMsg !== undefined && batchCalls.some((c) => !committed.has(c.id));
        const gatesPending = needsBatch && (this.phase === "IDLE" || this.phase === "GATING");

        if (!gatesPending && !this.owedResponse()) {
            await this.land();
            return "landed";
        }

        if (!this.cycleOpen) {
            this.runState = "buildingRequest";
            this.openCycle();
            if (!this.turnStartFired) {
                this.turnStartFired = true; // fires ONCE per turn, never per cycle
                this.fire(EVENTS.turnStart, { turn: last }, false, true, last);
            }
        }

        if (gatesPending) {
            this.runState = "executingTool";
            this.phase = "GATING";
            const content = batchMsg!.content as { answer: string; stored: unknown };
            const calls = (content.stored as ToolCallRecord[]) ?? [];
            if (this.gateCursor >= calls.length) {
                // all calls gated — issue the batch and AWAIT it wholesale
                this.gateCursor = 0;
                return await this.batchStep(batchMsg!);
            }
            const call = calls[this.gateCursor];
            // ALREADY DECIDED (denial / cached result / crash-heal) or ALREADY
            // COMMITTED (its result is in history — the batch will skip it) —
            // no gate, no ask, never re-fire.
            if (call.preResolved || committed.has(call.id)) { this.gateCursor++; return "continue"; }
            // THE WALL — the whole chain, awaited. A filter may park an ask:
            await this.bus.run(EVENTS.beforeTool, { batch: calls, call, tool: this.tools.find((t) => t.name === call.name) });
            // THIS call's gates have RUN — cursor advances whether or not the
            // ask parked us. Otherwise resume would re-fire the same gate and
            // re-ask the same question forever.
            this.gateCursor++;
            if (this.pendingAwaits.length > 0) {
                // BREAKPOINT #2 — an ask is parked mid-gates. Save position, exit.
                this.currentAction = { phase: "toolExec" };
                await this.parkNow();
                return "parked";
            }
            return "continue";
        }

        return await this.providerStep();
    }

    /** The money wall + the money call, awaited end to end. */
    protected async providerStep(): Promise<"continue" | "landed"> {
        if (this.stopRequested || this.pauseRequested) { await this.land(); return "landed"; }
        this.phase = "PROVIDER";
        this.runState = "awaitingProvider";
        // BREAKPOINT #1 wall — the whole chain, awaited. A filter may park an ask.
        await this.bus.run(EVENTS.beforeProviderRequest, { turn: this.messages.at(-1) });
        if (this.pendingAwaits.length > 0) {
            // RESUME re-fires this wall fresh (the standing contract — the world
            // may have changed while we waited for the answer).
            this.phase = "IDLE";
            this.currentAction = { phase: "providerCall" };
            await this.parkNow();
            return "continue"; // caller exits: parked
        }
        // THE MONEY CALL — awaited directly. Cancellation stays cooperative
        // through ctx.abortSignal (checked by the model between chunks).
        this.runState = "generating";
        let result: TurnResult;
        try {
            result = await this.model.callNextTurn(this);
        } catch (err) {
            await this.fail(err, "provider");
            return "landed";
        }
        if (this.isTerminal()) return "landed"; // an abort landed while generating
        // SEAM FLUSH — drain the stream buffer while the cycle is still OPEN,
        // so deltas dispatch BEFORE the commit/landing (TUI paints the reply
        // before stats). The supervisor beat remains the safety net for
        // stragglers; delivery itself is cycle-independent (registry lane).
        if (this.streamBuffer.length > 0) this.flushStream();
        this.runState = "evaluating";
        // response filters may veto (endCycle) or patch — awaited, inline
        await this.bus.run(EVENTS.afterProviderResponse, { result });
        await this.commitProviderResponse(result);
        return "continue";
    }

    /** COMMIT #1 — BREAKPOINT #1: truth freezes here; lastResponse advances (EXCEPT for toolCall). */
    protected async commitProviderResponse(result: TurnResult): Promise<void> {
        if (this.isTerminal()) return; // an abort landed while the response chains ran
        this.runState = "committing";
        if (this.cycleState.ended) { this.discardCycle(); return; } // discard, run again
        // COMMIT #1: stamp our commit time BEFORE recording stats — this is when WE add it to history.
        const message = result.message;
        message.committedAt = Date.now();
        this.messages.push(message);
        // THE public stats API: stamps stats onto message + recalculates session totals + fires EVENTS.usage.
        this.recordStats(result.stats);
        // A toolCall is answered only when its results commit — so it does NOT
        // advance here. After a mid-batch crash & restore, the toolCall stays
        // "owed" → the restored worker re-runs the gate + the batch.
        if (message.type !== "toolCall") this.lastResponse = this.messages.length - 1;
        this.fire(EVENTS.beforeMessageAdd, { turn: message }, false, true, message);
        // add-lifecycle filters decide the next move — awaited, inline
        await this.bus.run(EVENTS.messageAdded, { turn: message });
        if (this.stopRequested || this.pauseRequested) { this.discardCycle(); return; }
        if (message.type === "toolCall") {
            this.phase = "GATING"; // gates next — fresh cursor, whole batch gets gated
            this.gateCursor = 0;
            return;
        }
        // assistant/custom — the cycle ends; the worker decides next (more work? land).
        await this.bus.run(EVENTS.cycleEnd, { turn: this.messages.at(-1) });
        this.closeCycle();
    }

    /** The batch, awaited WHOLESALE. Results commit inside, in call order. */
    protected async batchStep(callMsg: Message): Promise<"continue" | "landed"> {
        if (this.stopRequested || this.pauseRequested) { await this.land(); return "landed"; }
        this.phase = "EXECUTING";
        this.runState = "executingTool";
        this.sealLock = true; // close the seal BEFORE the batch body's sync prefix
        try {
            await this.executeToolBatch(callMsg);
        } catch (err) {
            await this.fail(err, "tool");
            return "landed";
        } finally {
            this.sealLock = false;
        }
        if (this.isTerminal()) return "landed"; // an abort landed mid-batch
        this.runState = "evaluating";
        if (this.cycleState.ended) { this.discardCycle(); return "continue"; }
        if (this.stopRequested || this.pauseRequested) { this.discardCycle(); return "continue"; }
        // COMMIT #2 lives inside executeToolBatch; here the cycle ends at cycleEnd.
        await this.bus.run(EVENTS.cycleEnd, { turn: this.messages.at(-1) });
        this.closeCycle();
        this.drainLane(); // SEAM — transcript whole again, held announcements speak
        return "continue";
    }

    // ---- P6 — begin a fresh turn ----

    protected startTurn(): void {
        if (this.isTerminal() || this.startedTurn || this.currentAction) return;
        this.wakeRequested = false;
        this.loopState = "running";
        this.fire(EVENTS.beforeAgentStart, {}, true);
        this.fire(EVENTS.agentStart, {}, true);
        this.startedTurn = true;
    }

    // ---- the parking + the landing ----

    /** Park the machine: transition INTO awaiting — fires the park stop ONCE
     * (channels latch on it). Called at BREAKPOINT walls when asks pend.
     * Resume = input resolves them → supervisor relaunches the worker. */
    protected async parkNow(): Promise<void> {
        this.loopState = "awaiting";
        this.runState = "none";
        await this.bus.runFromRegistry(EVENTS.beforeStop, { loopState: this.loopState });
        await this.bus.runFromRegistry(EVENTS.stop, { loopState: this.loopState });
    }

    /** The landing — the turn's formal ending. Stop-family chains are AWAITED:
     * renderers and cleanups are guaranteed to finish before this returns. */
    protected async land(): Promise<void> {
        this.flushPendingEvents();
        this.drainLane(); // SEAM — nothing stays held through a landing
        if (this.isTerminal()) return; // teardown owns the terminal path
        if (this.cycleOpen) this.closeCycle();
        if (this.currentAction) {
            // PARKED — a future input resolves the awaits and resumes the SAME turn.
            this.loopState = "awaiting";
            this.runState = "none";
            await this.bus.runFromRegistry(EVENTS.beforeStop, { loopState: this.loopState });
            await this.bus.runFromRegistry(EVENTS.stop, { loopState: this.loopState });
            return;
        }
        // graceful end: stop(completed) → idle. Awaits still pending → park awaiting.
        const turnWasLive = this.startedTurn;
        this.phase = "IDLE"; // pipeline reset — the next turn starts clean
        this.loopState = this.pendingAwaits.length > 0 ? "awaiting" : "idle";
        this.runState = "none";
        this.startedTurn = false;
        this.turnStartFired = false;
        this.stopRequested = false;
        this.pauseRequested = false;
        if (turnWasLive) this.fire(EVENTS.turnEnd, { turn: this.messages.at(-1) }, true, true, this.messages.at(-1));
        await this.bus.runFromRegistry(EVENTS.beforeStop, { loopState: this.loopState });
        await this.bus.runFromRegistry(EVENTS.stop, { loopState: this.loopState });
        await this.bus.runFromRegistry(EVENTS.agentEnd, { loopState: this.loopState });
        await this.bus.runFromRegistry(EVENTS.beforeRunEnd, { loopState: this.loopState });
        // THE TRUE ENDING — fully landed (idle or awaiting); nothing happens until input.
        await this.bus.runFromRegistry(EVENTS.agentSettled, { loopState: this.loopState });
    }

    // ---- cycle bookkeeping ----

    protected openCycle(): void {
        this.cycleState = { ended: false };
        this.bus.beginCycle();
        this.cycleOpen = true;
    }

    protected closeCycle(): void {
        if (!this.cycleOpen) return;
        this.bus.endCycle();
        this.cycleOpen = false;
        this.drainLane(); // SEAM — transcript whole again, held announcements speak
    }

    /** A filter called endCycle() — close the cycle and reset the flag. */
    protected discardCycle(): void {
        this.closeCycle();
        this.cycleState = { ended: false };
    }

    // ---- derivation helpers ----

    /** Work owed: a message exists that the provider hasn't answered yet.
     * This IS the turn/cycle derivation — no phase counter, just the object. */
    protected owedResponse(): boolean {
        return this.messages.length - 1 > this.lastResponse;
    }

    /** Observable: is there anything for the machine to do? */
    get hasWork(): boolean {
        return this.owedResponse() || this.pendingSync.length > 0 || this.pendingAwaits.length > 0;
    }

    /** Observable: what's in flight right now? */
    get inFlight(): { provider: boolean; tools: boolean } {
        return { provider: this.runState === "generating", tools: this.runState === "executingTool" };
    }

    /** Terminal check — a method so TS can't over-narrow the mutable field.
     * terminated counts: an off-switched agent is as terminal as it gets. */
    protected isTerminal(): boolean {
        return (
            this.loopState === "aborted" ||
            this.loopState === "errored" ||
            this.loopState === "terminated"
        );
    }

    /** The tool batch: gates already ran; execute + commit results. */
    protected async executeToolBatch(callMsg: Message): Promise<void> {
        const content = callMsg.content as { answer: string; stored: unknown };
        const calls = (content.stored as ToolCallRecord[]) ?? [];
        if (calls.length === 0) return;

        // CRASH-HEAL RULE (at-most-once after restore): a call whose result is
        // already committed in history is DONE — never re-run, never re-commit.
        const committed = new Set(
            this.messages
                .filter((m) => m.type === "toolResult")
                .map((m) => (m as ToolResultMessage).toolCallId),
        );
        const todo = calls.filter((c) => !committed.has(c.id));
        if (todo.length === 0) return;

        // pi's rule: ANY sequential tool in the batch → the whole batch sequential
        const hasSequential = todo.some((c) => this.tools.find((t) => t.name === c.name)?.executionMode === "sequential");

        if (hasSequential) {
            for (const call of todo) {
                const outcome = await this.executeOne(call, callMsg);
                await this.commitToolResult(outcome);
                if (this.pauseRequested || this.stopRequested) break;
            }
        } else {
            // parallel exec, then SYNCHRONOUS sequential commit in call order
            const outcomes = await Promise.all(todo.map((call) => this.executeOne(call, callMsg)));
            for (const outcome of outcomes) {
                await this.commitToolResult(outcome);
            }
        }
    }

    /** Execute ONE call: preResolved → disabled → unknown → the real tool. */
    protected async executeOne(call: ToolCallRecord, callMsg: Message) {
        // a filter pre-resolved this call's outcome (deny, synthetic result)
        if (call.preResolved) {
            return {
                call,
                result: {
                    answer: call.preResolved.answer,
                    stored: call.preResolved.stored,
                    error: call.preResolved.error,
                    errorMessage: call.preResolved.errorMessage,
                },
            };
        }
        const tool = this.tools.find((t) => t.name === call.name);
        if (!tool) {
            return { call, result: { answer: `Unknown tool: ${call.name}`, error: true } };
        }
        if (tool.disabled) {
            return { call, result: { answer: `This tool is currently disabled: ${call.name}`, error: true } };
        }
        // THE SCHEMA WALL — arguments are validated BEFORE execution. A model
        // that hallucinates bad args gets a structured invalid_arguments result,
        // not a tool-specific crash. A tool-provided `validate` REPLACES the
        // default JSON-Schema check (the tool owns its contract fully); an empty
        // schema or a clean custom check never blocks.
        const argErrors = tool.validate
            ? (tool.validate(call.parameters) ?? [])
            : validateToolArgs(tool.inputSchema, call.parameters);
        if (argErrors.length > 0) {
            return {
                call,
                result: {
                    answer: `Invalid arguments for ${call.name}: ${argErrors.join("; ")}`,
                    error: true,
                    errorMessage: "invalid_arguments",
                    stored: { errors: argErrors },
                },
            };
        }
        this.fire(EVENTS.toolStart, { call, tool }, false, true, callMsg);
        try {
            const raw = await tool.execute(call.parameters, this);
            return { call, result: normalizeToolResult(raw, call.name) };
        } catch (err) {
            // error-as-result — the model sees the failure and self-corrects;
            // the orchestrator sees error: true + errorMessage; the trace stays
            // in stored (for us, never on the wire)
            const message = err instanceof Error ? err.message : String(err);
            const trace = err instanceof Error ? err.stack : undefined;
            return {
                call,
                result: {
                    answer: `Tool ${call.name} failed: ${message}`,
                    error: true,
                    errorMessage: message,
                    stored: trace ? { trace } : undefined,
                },
            };
        }
    }


    /** COMMIT #2 — afterTool (patch point) → push → toolEnd. Call order. */
    protected async commitToolResult(
        outcome: { call: ToolCallRecord; result: ToolResult },
    ): Promise<void> {
        const resultMsg: ToolResultMessage = {
            id: `toolresult-${crypto.randomUUID().slice(0, 8)}`,
            enabled: true,
            type: "toolResult",
            committedAt: Date.now(),
            // harness metadata — the loop's bookkeeping, NOT part of the result
            toolCallId: outcome.call.id,
            toolName: outcome.call.name,
            // the execution RESULT — what the run produced
            content: {
                answer: outcome.result.answer,
                // RAW — the tool's stored payload passes through verbatim, never spread/mutated
                stored: outcome.result.stored,
                // status — the additive failure flag, forwarded from the tool's ToolResult
                error: outcome.result.error,
                errorMessage: outcome.result.errorMessage,
            },
        };
        // afterTool = the patch point — filters rewrite the result before commit.
        // AWAITED inline: the push waits for every afterTool filter to settle,
        // then toolEnd announces the committed truth.
        await this.bus.run(EVENTS.afterTool, { call: outcome.call, result: outcome.result });
        this.messages.push(resultMsg);
        await this.bus.run(EVENTS.toolEnd, { call: outcome.call, result: outcome.result });
    }

    // ==========================================================================
    // Internals
    // ==========================================================================

    /** THE public API for stats. */
    recordStats(stats: MessageStats): void {
        const last = this.messages[this.messages.length - 1];
        if (last) last.stats = { ...stats, timestamp: stats.timestamp ?? Date.now() };
        const totals = emptySessionStats();
        let latestInput: number | undefined;
        for (const m of this.messages) {
            if (!m.stats) continue;
            addStats(totals, m.stats);
            if (typeof m.stats.input === "number") latestInput = m.stats.input;
        }
        const maxContext = this.data.model?.maxContext;
        if (maxContext && latestInput !== undefined && Number.isFinite(latestInput) && latestInput > 0) {
            totals.contextUsage = Math.min(1, latestInput / maxContext);
        }
        this.stats = totals;
        // Per-call telemetry (tps/latency/timing): LATEST CALL WINS — addStats
        // never sums these, so overlay the freshest measurement onto the totals.
        for (const k of PER_CALL_TELEMETRY_KEYS) {
            const v = stats[k];
            if (v !== undefined) (totals as Record<string, unknown>)[k] = v;
        }
        // COMPREHENSIVE payload: per-call + message + totals + delta + context. Observers get everything they need.
        this.fire(EVENTS.usage, { stats, message: last, totals, delta: stats, maxContext, contextUsage: totals.contextUsage }, true);
    }

    /** The error path: error event → abort family → errored. Adapter retries first.
     * No-ops on ANY terminal — a late error must never overwrite aborted/terminated. */
    protected async fail(err: unknown, source: ErrorSource = "loop"): Promise<void> {
        if (this.isTerminal()) return; // terminal already handled (abort / terminate / errored)
        this.fire(EVENTS.error, this.errorFacts(err, source), true);
        this.fire(EVENTS.beforeAbort, { reason: "error" }, true);
        this.fire(EVENTS.abort, { reason: "error" }, true);
        this.loopState = "errored";
        console.error(`[sanity] turn failed (agent=${this.agentId}, source=${source}, turn=${this.messages.length}):`, err);
    }

    /**
     * The rich `error` payload — raw facts the loop knows (source, stop/abort
     * state) + a normalized message/name + structured facts the adapter/tool
     * attached to the thrown error (reason, code, status, retryable, truncated...),
     * forwarded verbatim. Classification is the filter's call.
     */
    protected errorFacts(err: unknown, source: ErrorSource): ErrorFacts {
        const e = err as { name?: string; message?: string } | null;
        const facts: ErrorFacts = {
            error: err,
            message: typeof err === "string" ? err : (e?.message ?? String(err)),
            source,
        };
        if (e && typeof e.name === "string" && e.name !== "Error") facts.name = e.name;
        if (this.stopRequested) facts.stopRequested = true;
        if (this.abortController.signal.aborted) facts.aborted = true;
        // adapter/tool-authored structured facts — forwarded verbatim
        for (const k of ["reason", "code", "status", "retryable", "truncated"] as const) {
            const v = (err as Record<string, unknown> | null)?.[k];
            if (v !== undefined) facts[k] = v;
        }
        return facts;
    }
    /** Request the current cycle end — skip the commit, run again. The loop
     * orchestrator sees the flag, discards the message, starts the next iteration.
     * Filters call this on afterProviderResponse / afterTool to veto the commit.
     */
    endCycle(): void {
        this.cycleState.ended = true;
    }

    /** Fire a custom event on the shared bus — plugins announce their own lifecycle
     * (compaction/start, plan/updated, cron/tick...). WordPress `do_action(name, ...)`.
     * `publish` = land in the observed transient (currentEvent → patched → live visibility).
     */
    emit(event: EventName, payload: Omit<EventPayload, "type"> = {}, publish = true): void {
        // fromRegistry — emit must reach listeners ANY time (plugins emit outside cycles:
        // timers, install-time). WordPress do_action: registry, minus disabled.
        this.fire(event, payload, true, publish);
    }

    /**
     * THE UNIVERSAL DELTA — a path-tracking Proxy over the whole container.
     * Every mutation of ANY field (messages, state, stats, model, tools,
     * capabilities, lifecycle scalars...) fires a KeyChange `{key,path,op,value}`
     * O(1) at the moment of the set — NO diff, NO serialization, NO mirror.
     * The traps queue records + semantic events; flushPendingEvents drains them
     * at the seams. Nothing runs when no listener is attached (tracking() gate).
     */
    private observe<T extends object>(target: T, path: string): T {
        const cached = this.observed.get(target);
        if (cached) return cached as T;
        const proxy = new Proxy(target, {
            get: (t, prop, recv) => {
                // semantic removal capture — the traps can't see WHICH element splice/pop/shift
                // actually removed (V8 truncates by overwrite + delete of the last slot), so patch
                // the messages array's removers to fire messageRemoved with the RIGHT ids.
                if (path === "messages" && (prop === "splice" || prop === "pop" || prop === "shift")) {
                    return this.patchRemover(t, recv, prop as "splice" | "pop" | "shift");
                }
                const value = Reflect.get(t, prop, recv);
                if (value !== null && typeof value === "object" && this.isProxyable(value)) {
                    return this.observe(value, this.childPath(path, prop));
                }
                return value;
            },
            set: (t, prop, value, recv) => {
                // array length churn is noise — the element sets carry the real info
                if (!(Array.isArray(t) && prop === "length")) {
                    this.recordKeyChange(this.childPath(path, prop), "set", value);
                }
                return Reflect.set(t, prop, value, recv);
            },
            deleteProperty: (t, prop) => {
                // capture the removed value BEFORE the slot is gone (its id still readable)
                this.recordKeyChange(this.childPath(path, prop), "delete", Reflect.get(t, prop));
                return Reflect.deleteProperty(t, prop);
            },
        });
        this.observed.set(target, proxy);
        this.rawByProxy.set(proxy, target);
        return proxy;
    }

    private childPath(path: string, prop: string | symbol): string {
        return path ? `${path}.${String(prop)}` : String(prop);
    }

    /** Should this object be wrapped in the observer Proxy? ONLY plain objects
     * and arrays. Everything else — Map, Set, Date, RegExp, Promise, Buffer,
     * streams, and class instances with `#private` fields — is returned RAW.
     * Proxying exotic types breaks method `this` semantics ("incompatible
     * receiver") and private-field access with obscure TypeErrors. Keep
     * `state`/`transient` JSON-shaped and this never bites. */
    private isProxyable(value: object): boolean {
        if (Array.isArray(value)) return true;
        const proto = Object.getPrototypeOf(value);
        return proto === Object.prototype || proto === null;
    }

    /**
     * The messages array's removers (splice/pop/shift) — run the real mutation THROUGH
     * the proxy (traps keep the KeyChange journal honest) while capturing the
     * actually-removed ids for messageRemoved (the traps only see the truncation).
     */
    private patchRemover(t: object, recv: object, method: "splice" | "pop" | "shift") {
        const arr = t as Message[];
        const original = Array.prototype[method] as (...args: unknown[]) => unknown;
        return (...args: unknown[]): unknown => {
            const removed: Message[] = [];
            if (method === "splice") {
                const start = Math.max(0, Number(args[0]) || 0);
                const count =
                    args[1] === undefined
                        ? arr.length - start
                        : Math.min(Math.max(0, Number(args[1]) || 0), arr.length - start);
                for (let i = start; i < start + count; i++) removed.push(arr[i]);
            } else if (method === "pop") {
                if (arr.length > 0) removed.push(arr[arr.length - 1]);
            } else if (arr.length > 0) {
                removed.push(arr[0]);
            }
            const result = original.call(recv, ...args); // through the proxy → traps fire → journal stays honest
            for (const r of removed) {
                if (r.id) this.pendingEvents.push({ event: EVENTS.messageRemoved, messageId: r.id, message: r });
            }
            return result;
        };
    }

    /** Lazy gate — the observer does nothing when nobody is listening. */
    private tracking(): boolean {
        return (
            this.bus.has(EVENTS.patched) ||
            this.bus.has(EVENTS.messageUpdate) ||
            this.bus.has(EVENTS.fragmentUpdate) ||
            this.bus.has(EVENTS.messageRemoved)
        );
    }

    /** A trap fired: queue the KeyChange + route message-level semantic events. */
    private recordKeyChange(path: string, op: "set" | "delete", rawValue: unknown): void {
        if (!this.tracking()) return;
        const dot = path.indexOf(".");
        const key = dot === -1 ? path : path.slice(0, dot);
        this.pendingEvents.push({
            event: EVENTS.patched,
            change: { key, path, op, value: op === "set" ? rawValue : undefined },
        });
        this.routeMessagePath(path, op);
    }

    /**
     * Message-level semantic events, inline at the mutation (exact, not regexed
     * post-hoc). `messageRemoved` captures the id from the removed value BEFORE
     * the slot is deleted — no post-shift index guessing.
     */
    private routeMessagePath(path: string, op: "set" | "delete"): void {
        const m = /^messages\.(\d+)(?:\.(.*))?$/.exec(path);
        if (!m) return;
        // delete: messageRemoved is owned by the patched mutators (splice/pop/shift),
        // which capture the ACTUALLY-removed ids — the KeyChange delete record is queued.
        if (op === "delete") return;
        const rest = m[2];
        if (!rest) return; // whole-message set/replace — beforeMessageAdd/messageAdded own the add
        const msg = this.messages[Number(m[1])];
        if (!msg) return;
        const frag = /^content\.(\d+)(?:\.|$)/.exec(rest);
        if (frag) {
            const blocks = msg.content as unknown as { id?: string }[] | null | undefined;
            const block = Array.isArray(blocks) ? blocks[Number(frag[1])] : undefined;
            if (block?.id) {
                this.pendingEvents.push({ event: EVENTS.fragmentUpdate, messageId: msg.id, fragmentId: block.id, message: msg });
                return;
            }
        }
        this.pendingEvents.push({ event: EVENTS.messageUpdate, messageId: msg.id, message: msg });
    }

    /**
     * THE SEAM FLUSH — drains the queued KeyChanges + semantic events at the
     * logical points between phases (the same boundaries where blocks is checked).
     * The traps did the observing; this hands the batch to THE LANE.
     */
    private flushPendingEvents(): void {
        const batch = this.pendingEvents;
        this.pendingEvents = [];
        for (const ev of batch) {
            // TEMPORAL-ONLY (publish=false): the change/fragmentId ride the payload — publishing
            // here would self-feed the patched stream (each flush regenerates a transient KeyChange).
            const payload: Omit<EventPayload, "type"> =
                ev.event === EVENTS.patched ? { change: ev.change } :
                    ev.event === EVENTS.fragmentUpdate ? { turn: ev.message, fragmentId: ev.fragmentId } :
                        { turn: ev.message };
            this.lane.push({ event: ev.event, payload, fromRegistry: true, publish: false, turn: ev.message });
        }
        this.drainLane();
    }

    /** One entry of parked work — THE sanctioned shape for "not now" announcements.
     * held=true → waits for the seam (sealed-phase hazards); otherwise drains next flush. */
    private lane: Array<{
        event: EventName;
        payload: Omit<EventPayload, "type">;
        fromRegistry: boolean;
        publish: boolean;
        turn?: Message;
        held?: boolean;
    }> = [];

    /** SEAM/TICK DRAIN — the single door every parked announcement exits through.
     * Unheld entries drain NOW (live visibility mid-batch stays live); held
     * entries wait until the transcript is whole again (sealed → seam). */
    private drainLane(): void {
        if (this.lane.length === 0) return;
        const now: typeof this.lane = [];
        const later: typeof this.lane = [];
        for (const e of this.lane) (e.held && this.sealed ? later : now).push(e);
        this.lane = later;
        for (const e of now) this.fireRaw(e.event, e.payload, e.fromRegistry, e.publish, e.turn);
    }

    /** Dispatch tail — NO transient-deferral logic. Lanes drain through here. */
    private fireRaw(
        event: EventName,
        payload: Omit<EventPayload, "type">,
        fromRegistry: boolean,
        publish: boolean,
        turn?: Message,
    ): void {
        if (turn !== undefined) this.currentTurn = turn;
        if (publish) {
            // published → lands in the OBSERVED transient (KeyChange → patched → live visibility)
            this.transient = { ...this.transient, currentEvent: { type: event, ...payload } };
        }
        const argPayload = { type: event, ...payload } as EventPayload;
        if (fromRegistry) this.bus.runFromRegistry(event, argPayload);
        else this.bus.run(event, argPayload);
    }

    /**
     * Fire ONE event with its transient payload. Announcements FLOAT (void) —
     * they are quick, never reject, and nothing reads their effects afterwards.
     * Decision points that DO read effects must `await bus.run(...)` directly.
     *
     * CONTRACT: fire() starts a chain and returns at the first await.
     */
    private fire(
        event: EventName,
        payload: Omit<EventPayload, "type"> = {},
        fromRegistry = false,
        publish = true,
        turn?: Message,
    ): void {
        if (turn !== undefined) this.currentTurn = turn;
        const argPayload = { type: event, ...payload } as EventPayload;
        if (publish) {
            // published → lands in the OBSERVED transient (KeyChange → patched → live visibility)
            this.transient = { ...this.transient, currentEvent: { type: event, ...payload } };
        }
        // SEALED-PHASE DEFERRAL — mid-batch transcript hazards park in THE LANE
        // (held for the seam). The SEALED_DEFER_EVENTS whitelist is the safety:
        // control/abort events are not in it, so they NEVER defer.
        if (this.sealed && SEALED_DEFER_EVENTS.has(event)) {
            this.lane.push({ event, payload: argPayload, fromRegistry, publish, held: true });
            return;
        }
        this.fireRaw(event, argPayload, fromRegistry, publish);
    }

    /**
     * The tool batch is executing — the transcript is SEALED for mutation.
     * Anything in SEALED_DEFER_EVENTS fired now waits for the seam. The worker
     * awaits the batch directly, so the seal spans its whole body (sealLock
     * covers the batch fn's synchronous prefix, which runs before any flag).
     */
    private get sealed(): boolean {
        return this.runState === "executingTool" || this.sealLock;
    }
    private sealLock = false;

    /**
     * MASS MERGE — write the whole god object silently (restore / checkpoint /
     * sync-apply). `fn` receives the RAW container (unwrapped — mutations are
     * SILENT, NO `patched`, NO tape). ONE `merged` event announces it; listeners
     * re-read the object on it.
     */
    merge(fn: (data: SessionData) => SessionData): void {
        const raw = (this.rawByProxy.get(this.data) ?? this.data) as SessionData;
        const next = fn(raw); // the fn touches the unwrapped container — no traps fire
        this.data = this.observe(next, ""); // re-wrap (same ref = cached wrap; new ref = fresh)
        this.fire(EVENTS.merged, {}, true);
    }
}
