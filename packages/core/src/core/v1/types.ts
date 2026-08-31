// ============================================================================
// sanity/types.ts — THE UNIVERSAL LAYER
// ============================================================================
// The promise. Static, stable, understood by our own framework. The ONLY thing
// that never changes.
//
// EXTENSIBILITY RULE:
// - You import default types, or you write your own interface right in YOUR file.
// - Custom component (e.g. message format v2)? Keep everything, change a couple
//   parameters — define additional fields by extending the default interface IN
//   YOUR FILE. Imported just the same, just has the new fields.
// - If a type is imported by two different components → it lives here.
// - If a type is only used by one file → it stays there.
// ============================================================================

// ============================================================================
// MESSAGES — the ID-addressable slot array (the universal layer of the loop)
// ============================================================================

/** Every message type has TWO flavors: simple + compound. Identified by `type`. */
export type MessageType =
  | "system"
  | "user"
  | "assistant"
  | "toolCall"
  | "toolResult"
  | "system-compound"
  | "user-compound"
  | "assistant-compound"
  | "toolCall-compound"
  | "toolResult-compound"
  // open: custom types are strings, the core never needs to know their meaning
  | (string & {});

/** Simple flavor — standardized array of text blocks (LangChain-style content parts). */
export type TextBlock = { type: "text"; content: string };

/** Compound flavor — an array of objects, each with a unique ID + content. */
export type FragmentBlock = { id: string; content: string };

/** ToolCall / ToolResult two-face: what the model sees + everything else for us. */
export interface ToolFace {
  /** Stuff that goes INTO THE MODEL as the answer. */
  answer: string;
  /** Custom compound — every bit of information, errors, traces, structured. */
  stored: unknown;
}

/**
 * The toolResult execution RESULT — what the run produced. On the message
 * it can be `null` = catastrophic failure (no result at all); the harness
 * still feeds the model a synthetic answer.
 */
export interface ToolResultContent {
  /** What the MODEL sees — always present when content exists. */
  answer: string;
  /** For us, raw verbatim — any shape, optional. */
  stored?: unknown;
  /** Additive failure flag — absent = success, `error: true` = failure. */
  error?: boolean;
  /** Optional detail for the orchestrator — separate from `answer`. */
  errorMessage?: string;
}
export interface BaseMessage {
  /** UNIQUE ID. Runtime messages: randomly generated. Synthetic: YOU specify it. */
  id: string;
  /** In context calculation or not. Present in history either way. */
  enabled: boolean;
  /** The type — decides the content shape. */
  type: MessageType;
  /** When WE committed this message to history (ms epoch). Agent-stamped at the COMMIT point. Distinct from MessageStats.timestamp (provider-reported). Between them, validators/transformers may run. Never collapse them. */
  committedAt?: number;
}

/** Simple-flavor content: array of text blocks. */
export interface SimpleContent {
  content: TextBlock[];
}

/** Compound-flavor content: array of addressable fragments. */
export interface CompoundContent {
  content: FragmentBlock[];
}

/** Tool-flavored content: the two-face. */
export interface ToolContent {
  content: ToolFace;
}

/**
 * The message slot. Content shape depends on type:
 * - simple types (system/user/assistant): `TextBlock[]`
 * - compound types (*-compound): `FragmentBlock[]`
 * - tool types (toolCall: `ToolFace`; toolResult: `ToolResultContent`)
 * - null: a message with no payload (catastrophic tool failure)
 * - custom: whatever you define in your own interface
 */
export interface Message extends BaseMessage {
  content: TextBlock[] | FragmentBlock[] | ToolFace | ToolResultContent | null;
  /** Per-call stats. Populated by agent.recordStats(). */
  stats?: MessageStats;
}

/**
 * A toolResult message — harness metadata (toolCallId/toolName) at the root,
 * the execution result in content. content: null = catastrophic failure.
 */
export interface ToolResultMessage extends Message {
  /** Harness metadata — which call this result answers. NOT part of the result. */
  toolCallId: string;
  /** Harness metadata — which tool produced this. NOT part of the result. */
  toolName: string;
  /** The execution RESULT — null = failed horribly, no result at all. */
  content: ToolResultContent | null;
}

// ---- extension example (lives in YOUR file, not here) ----
// export interface MessageV2 extends Message {
//   content: [...];            // keep everything, change a couple parameters
//   version: 2;                // add new fields
// }

// ============================================================================
// INPUT — the universal signal envelope
// ============================================================================

/**
 * "Something happened." No hardcoded types in core — known types are just filters
 * wearing hats: prompt, prompt_peer, abort, command, ui. The filter assigns
 * behavior; disable the filter = disable the capability.
 */
export interface Input {
  /** The type. Sender declares it as metadata; filters assign behavior. */
  type: string;
  /**
   * Whether this input should be stored / added to history.
   * Default: undefined = the receiver's default (for message-bearing inputs
   * that means store). Set `store: false` to opt out. This is a REQUEST, not
   * a contract — the receiving filter decides what it does.
   */
  store?: boolean;
  /**
   * async: true → fire-and-forget, fully independent of the loop (UI/telemetry
   * chatter). The loop never waits and never wakes for it.
   * async: false/undefined → loop-relevant. Sync barrier: ALL pending sync
   * inputs are drained — each through its full filter chain — before the loop
   * continues anything.
   */
  async?: boolean;
  /** ...arbitrary per-type payloads (a message-bearing input carries its own). */
  [key: string]: unknown;
}

// ============================================================================
// STATE — loopState × runState (the introspectable truth)
// ============================================================================

/** loopState — SMALL, CLOSED. What logic gates on.
 * "terminated" = THE OFF SWITCH ran: the heartbeat itself has stopped and
 * run() resolves. Deader than aborted — an aborted agent still ticks
 * silently forever; a terminated one does not tick at all. */
export type LoopState = "idle" | "running" | "awaiting" | "stopped" | "aborted" | "errored" | "terminated";

/** runState — MANY, OPEN. The introspectable truth. Extensions can add states. */
export type RunState =
  | "none"
  | "accepting"
  | "queued"
  | "buildingRequest"
  | "awaitingProvider"
  | "generating"
  | "evaluating"
  | "awaitingApproval"
  | "executingTool"
  | "committing"
  | "stopping"
  // open: extensions may add (e.g. "compacting")
  | (string & {});

/** `stop` — one signal, four worlds. */
export type StopReason = "completed" | "aborted" | "error" | "awaiting";

/** What a parked loop is waiting on. */
export type WaitsFor = "input" | "tool" | "agent" | "timer" | (string & {});

/**
 * A pending await — the loop parks while the array is non-empty.
 * The array is SHARED across plugins: separation is by convention — `type` is the
 * plugin-namespaced rendezvous key ("ask-question/question", "loop-control/doom").
 * A plugin listens to its own input types and owns finding + resolving ONLY its
 * own awaits (by type prefix), leaving other plugins' awaits alone.
 *
 * `id` is OPTIONAL — only when the creator must address ONE specific await
 * (e.g. the tool call id). `schema` describes what an answer looks like.
 *
 * PURE JSON: matching lives in the filter that issued the await (it knows how
 * to match inputs to its awaits at runtime). Restore a session without the
 * resolving filter = you're fucked, by design.
 */
export interface PendingAwait {
  /** Plugin-namespaced kind/channel — the ONLY separation. "ask-question/question", "permission". */
  type: string;
  /** OPTIONAL per-instance key — set only when addressing ONE await (e.g. the tool call id). */
  id?: string;
  /** What an answer looks like — the filter matches inputs against this. */
  schema?: unknown;
  /** Optional helper — when this await was created (diagnosis: old vs fresh). */
  createdAt?: number;
  /** Open — any extra keys the issuing plugin needs. */
  [key: string]: unknown;
}

/**
 * A pending QUESTION — the async twin of PendingAwait. Same rendezvous shape
 * (type + optional id + schema), but it NEVER gates: the loop doesn't look at
 * it. Inert state with an answer path — rendered by whoever reads
 * `pendingQuestions`.
 * Answering = a filter matches an input by ref, calls removePendingQuestion,
 * then acts. Restore without the resolving filter = same rule as awaits.
 */
export interface PendingQuestion {
  /** Plugin-namespaced kind/channel — same convention as awaits. */
  type: string;
  /** OPTIONAL per-instance key — when the creator must address ONE question. */
  id?: string;
  /** What an answer looks like — the filter matches inputs against this. */
  schema?: unknown;
  /** Optional helper — when this question was created. */
  createdAt?: number;
  /** Open — any extra keys the issuing plugin needs. */
  [key: string]: unknown;
}
// ============================================================================
// FILTERS — the WordPress-style bus
// ============================================================================

/** The event ID a filter hooks. One of the 33 core events, or a custom one. */
export type EventName = string;

/**
 * A filter. ALWAYS an object. `fn` receives THE GOD OBJECT — the agent itself,
 * `this`, passed everywhere, full access to every field and method. MUTATION IS
 * DIRECT: write `agent.state.foo`, `agent.messages`, `agent.pendingAwaits`,
 * `agent.activity`... anything — the observer catches it → KeyChange →
 * everything downstream. No return-merge dance: mutate `this`, be done.
 *
 * ASYNC IS THE LAW: `fn` returns a Promise, ALWAYS. The bus awaits each filter
 * sequentially — filter N settles fully before filter N+1 starts (WordPress,
 * with waiting). Any async work (API calls, IO) inside a filter just works.
 * - Reject/throw = loop continues, skip + log + fires handlerError (observable).
 * - Veto / stop / park = mutation: push a pendingAwait, remove a tool call,
 *   skip/disable this filter, or call agent.abort()/stop()/pause().
 *   A pendingAwait PAUSES the whole chain in place — nothing behind it runs
 *   until it clears; then the sequence resumes. Abort/pause CANCEL it.
 * - Explicit stop is ONLY abort.
 */
export interface Filter {
  /** The event this filter hooks. */
  event: EventName;
  /** Unique filter ID. */
  id: string;
  /** Priority — lower runs first. Sequential by priority, always. */
  priority: number;
  /** The function. Receives the god object + the per-event payload. Mutate directly.
   * MANDATORY async — the bus awaits it; a sync body is just a resolved promise. */
  fn: (agent: GodObject, event?: EventPayload) => Promise<void>;
}

// ============================================================================
// THE CYCLE — per-cycle mutable state + the discard command
// ============================================================================

/** Mutable cycle state — shared across one cycle. `agent.endCycle()` sets it. */
export interface CycleState {
  /** A filter requested this cycle end — skip the commit, start the next iteration. */
  ended: boolean;
}

// ============================================================================
// THE BUS SURFACE — the raw emit layer. `agent.emit()` is the friendly door;
// the bus itself is here for anyone who wants the raw dispatch.
// ============================================================================

/** The emit surface of the filter bus. `run` NEVER rejects — per-filter
 * failures route to handlerError, so floating a call (`void bus.run`) is safe. */
export interface EventBus {
  /** Run one event against the CURRENT cycle's queue, awaited sequentially. */
  run(event: string, payload?: Omit<EventPayload, "type">): Promise<void>;
  /** Run against the REGISTRY directly (minus disabled) — the control lane:
   * reaches listeners ANY time, mid-cycle or post-cycle. */
  runFromRegistry(event: string, payload?: Omit<EventPayload, "type">): Promise<void>;
  /** Has any filter registered for this event? */
  has(event: string): boolean;
}

/** Direct meta-callbacks — watch/control the machinery, NOT filters. */
export interface FilterMetaCallbacks {
  /** Before a filter runs — the surgical per-filter reorganization point. */
  before?(filter: Filter, agent: GodObject): void;
  /** After a filter runs. */
  after?(filter: Filter, agent: GodObject): void;
  /** When a filter is attached to the registry. */
  attached?(filter: Filter): void;
  /** When a filter is removed from the registry. */
  detached?(event: string, id: string): void;
}

/** Cycle-level callbacks — the whole-queue reorganization points. */
export interface CycleCallbacks {
  /** Queue constructed for this cycle → rearrange ANYTHING here. */
  start?(queues: Map<string, Filter[]>, agent: GodObject): void;
  /** Cycle done → cleanup / accounting. */
  end?(agent: GodObject): void;
}

/**
 * The per-event payload — the granular facts a filter was called with.
 * TRANSIENT: read-only, never serialized, never on the tape, never restored.
 * Everything here is also reachable via ctx/agent; the arg is convenience +
 * necessity (per-instance identity like WHICH call a beforeTool is gating).
 */
export interface EventPayload {
  /** The event that fired. */
  type: string;
  /** Open — per-event fields: call, tool, error, reason, usage, ... */
  [key: string]: unknown;
}

/** Which phase of the loop a failure came from. */
export type ErrorSource = "provider" | "tool" | "loop";

/**
 * The rich `error` event payload — raw facts the core stamps, structured facts
 * the adapter/tool attaches to the thrown error. Classification (retryable?
 * fallback? swap model?) is the FILTER's call — the core forwards everything
 * it knows; the 2-arg filter interface hands it all over as `event`.
 */
export interface ErrorFacts {
  /** The original throw — ALWAYS present. */
  error: unknown;
  /** Human-readable message (Error.message or String(err)). */
  message: string;
  /** Which phase failed. */
  source: ErrorSource;
  /** error.name, when it was a real Error (and not the default "Error"). */
  name?: string;
  /** A graceful stop was in flight when the failure hit. */
  stopRequested?: boolean;
  /** The abort controller had already fired. */
  aborted?: boolean;
  /** Adapter/tool-authored structured facts, forwarded verbatim: reason, code, status, retryable, truncated... */
  [key: string]: unknown;
}

// ============================================================================
// THE GOD OBJECT — session (data) + profile (code)
// ============================================================================

/** Serialized session state — pure JSON, patchable, replayable. */
export interface Session {
  id: string;
  /** Pointer to the code profile (not the code itself). */
  agentId: string;
  /** The agent's one-line description — what it does. Static. */
  description?: string;
  /** The LIVE state string — natural language, plugin-written. Survives restore. */
  activity: string;
  /** The working directory — first-class, tools rely on it. Inherited from where the agent runs. */
  cwd: string;
  /** Model reference — the code side loads the adapter. Open: provider, etc. */
  model: { modelId: string; [key: string]: unknown };
  /** The payload builder — THE truth. */
  messages: Message[];
  /** Tokens, cost, latency, context usage. */
  stats: Stats;
  /** Plugin playground — arbitrary JSON, every tool can write here. */
  state: Record<string, unknown>;
  /** The loop's lifecycle. */
  loopState: LoopState;
  /** The loop's current execution. */
  runState: RunState;
  /** Serialized → resume parked work. */
  pendingAwaits: PendingAwait[];
  /** Serialized → pending questions survive pause/crash (state is truth). */
  pendingQuestions: PendingQuestion[];
  /** What's in flight at pause. */
  currentAction: unknown;
  /** Index of the last message the provider has answered — owed work is derived from it. */
  lastResponse: number;
}

/** The agent code — NEVER serialized, reloaded from the profile. */
export interface Profile {
  tools: Tool[];
  filters: Filter[];
  model: ModelContract;
}
// ============================================================================
// PLUGINS — named batches of registrations with a lifecycle
// ============================================================================
// A plugin is a bundle of filters/tools/state that installs and uninstalls as
// one unit. install() receives the whole god object and registers everything
// under `${plugin.id}/` (the id IS the namespace). uninstall() is REQUIRED —
// a plugin that can't leave cleanly isn't a plugin. No new mechanism: plugins
// are just addFilter/addTool with a lifecycle wrapper.
export type InstallStep = (agent: GodObject) => void | Promise<void>;

/**
 * The install surface. A single function (classic) OR a record of named steps
 * the harness runs sequentially (extendable). The union is fully backward
 * compatible: every existing single-function plugin keeps working unchanged.
 * A subclass spreads the base's `install` record and overrides / nulls
 * individual keys — no copying the whole body. (Convention, not enforced: a
 * step may do anything an install does — filters, tools, inputs, capabilities,
 * declared events, web servers.)
 */
export type InstallSpec = InstallStep | Record<string, InstallStep | null | undefined>;

export interface Plugin {
  /** Unique id — also the namespace: registrations live under `${id}/name`. */
  id: string;
  /** Universal ids this plugin NEEDS installed first — checked before install(). */
  requires?: string[];
  /**
   * Register everything: filters, tools, state keys. Runs once.
   * SYNC BY PREFERENCE — do async setup (servers, connections, remote config)
   * in a FACTORY that returns the plugin; install() then only wires tools that
   * close over the running resource. A step may return a Promise (install()
   * awaits it), but that is a BAD PATTERN — see agent.install for the factory
   * idiom.
   */
  install: InstallSpec;
  /** REQUIRED — remove everything install added (by prefix). */
  uninstall(agent: GodObject): void;
}

/**
 * A plugin could not be installed (a `requires` dep is missing, or the graph
 * cycles) or could not be uninstalled (others still depend on it).
 *
 * kind: "missing"  — installing: `requires` names something not installed.
 *       "cycle"    — installing: the requires graph loops back on itself.
 *       "in-use"   — uninstalling: still required by the ids in `related`.
 */
export class PluginDependencyError extends Error {
  readonly kind: "missing" | "cycle" | "in-use";
  readonly pluginId: string;
  /** Missing dep(s) (missing/cycle) or blocking dependents (in-use). */
  readonly related: string[];
  constructor(kind: "missing" | "cycle" | "in-use", pluginId: string, related: string[], chain?: string[]) {
    const path = chain && chain.length > 1 ? ` (${chain.join(" → ")})` : "";
    let msg: string;
    if (kind === "missing") {
      msg = `[sanity] plugin "${pluginId}" requires "${related.join('", "')}", which is not installed${path}. Install the dependency first: agent.install(dep) BEFORE agent.install(plugin).`;
    } else if (kind === "cycle") {
      msg = `[sanity] plugin dependency cycle detected${path}. The graph must be acyclic.`;
    } else {
      msg = `[sanity] cannot uninstall plugin "${pluginId}" — still required by ["${related.join('", "')}"]. Uninstall those first.`;
    }
    super(msg);
    this.name = "PluginDependencyError";
    this.kind = kind;
    this.pluginId = pluginId;
    this.related = related;
  }
}

// ============================================================================
// DECLARED REGISTRIES — three core-owned, id-keyed manifests the agent carries
// ============================================================================
// The agent carries three read-mostly registries, all id-keyed Maps. These are the
// public contract surface: each plugin (or the core) declares what it provides,
// expects, or produces. Inputs + events describe payloads (Zod schema); capabilities
// are coarse identity (id + required description). Built-in core events come pre-
// populated at construction; custom entries come from plugins via add/delete methods.
// NOT state — these are the agent's PROMISE. A stranger dashboard, UI, or peer plugin
// reads them and trusts what they say. The state map stays the wild-west playground.

/** A declared INPUT — what a plugin ACCEPTS. The schema IS the data. */
export interface DeclaredInput {
  id: string;
  /** Zod schema. Loose-typed to keep core decoupled from Zod. */
  schema: unknown;
  description?: string;
}

/** A declared CAPABILITY — coarse identity, plugin-authored, required description. */
export interface DeclaredCapability {
  id: string;
  description: string;
}

/** A declared EVENT — what a plugin PRODUCES. Built-ins (the 38 core events) are pre-loaded. */
export interface DeclaredEvent {
  id: string;
  description?: string;
}


/** The runtime god object — session data + attached profile. */
export interface GodObject extends Session {
  tools: Tool[];
  filters: Filter[];
  /** TRANSIENT — current tick's working memory + `currentEvent`. Observed, NEVER stored. */
  transient: Record<string, unknown>;
  // ---- registration surface (the attach API — plugins, filters, tools) ----
  addFilter(filter: Filter): this;
  removeFilter(event: string, id: string): boolean;
  disableFilter(event: string, id: string): boolean;
  enableFilter(event: string, id: string): boolean;
  addTool(tool: Tool): this;
  removeTool(name: string): boolean;
  updateTool(name: string, updates: Partial<Pick<Tool, "description" | "inputSchema" | "outputSchema" | "executionMode" | "hidden">>): boolean;
  /** The tools the PROVIDER sees — everything except `hidden`. Hidden tools stay
   * callable (execute runs) but never reach context. Model adapters MUST build
   * their wire list from this, never from `tools` directly. */
  visibleTools(): Tool[];
  model: ModelContract;
  /** The loop hands this to the model so it can emit stream events. */
  streamSink?: StreamSink;
  /** The abort signal — the model checks it between chunks. */
  abortSignal?: AbortSignal;

  // ---- plugins (named batches of registrations, observable) ----
  install(plugin: Plugin): Promise<this>;
  uninstall(pluginId: string): boolean;
  readonly plugins: Plugin[];

  // ---- generic loop control (type-blind: the core does not interpret inputs) ----
  /** HARD KILL — abort the in-flight turn (fires beforeAbort → abort). */
  abort(reason?: string): void;
  /** SOFT — finish the current step, stop doing anything next. */
  stop(): void;
  /** Stop the loop after the current message commits. */
  pause(): void;
  /** THE OFF SWITCH — stops the HEART: aborts anything in flight (an idle
   * agent dies quietly — no fake abort events), both loops break at their
   * next beat, and run() RESOLVES. The only thing that ends run().
   * Idempotent; fire-and-forget safe (a defensive catch logs late loop
   * crashes instead of surfacing unhandled rejections). */
  terminate(reason?: string): Promise<void>;
  /** The halt states — READ (and mutated by the core's own stop()/pause()/abort()).
   * The chain checks these before EVERY filter: set = nothing behind runs. */
  readonly stopRequested: boolean;
  readonly pauseRequested: boolean;
  /** Wake — the pure "keep going" SIGNAL. Sets wakeRequested only; the eternal
   * heartbeat notices next tick. Never starts a loop, never flips state. */
  wake(): void;
  /** THE TWO CLOCKS — loop 1 supervisor + loop 2 worker. Runs until
   * terminate() (the one sanctioned break) or process shutdown; RESOLVES on
   * terminate. Flags (aborted/errored/stopped) change what ticks DO
   * (usually: nothing); nothing else changes whether the loops run.
   *
   * LAUNCH POSTURE — startState:
   *   (omitted)      seeded transcript counts as demand: if history ends in
   *                  unanswered work, turn #0 fires immediately.
   *   "idle"         born-landed: clocks tick but the machine waits, as if it
   *                  already arrived at a conclusion. The first real poke —
   *                  an input draining or wake() — arms the loop permanently.
   *                  The TUI/server posture: open first, run when life arrives. */
  run(opts?: { startState?: "idle" }): Promise<void>;
  /** THE LITERAL BLOCK FLAG — set by loop 1, read by loop 2 every beat. True
   * while inputs drain or pending awaits pin the worker. Observable, never
   * written by the worker itself. */
  readonly blocked: boolean;
  /** The message in the pipeline right now (about to be added / just added). */
  currentTurn?: Message;
  /** The input being processed right now. */
  currentInput?: Input;
  /** Request the current cycle end — skip the commit, run again. */
  endCycle(): void;
  /** The raw emit surface — WordPress `do_action`. `emit()` is the friendly door. */
  readonly bus: EventBus;
  /** Fire a custom event on the shared bus — plugins announce their own lifecycle
   * (compaction/start, plan/updated, cron/tick...). `publish` = land in the observed
   * transient (currentEvent → patched → live visibility). Default true. */
  emit(event: string, payload?: EventPayload, publish?: boolean): void;
  /** Write the LIVE activity string — natural language, plugin-authored. Observed → tape → dashboard. */
  setActivity(text: string): void;
  /** Park a pending await — the loop holds its breath at blocking boundaries. */
  park(awaitItem: PendingAwait): void;
  /** Add a pending QUESTION — non-blocking, pure state. */
  addPendingQuestion(q: PendingQuestion): void;
  /** Remove a pending question by id. */
  removePendingQuestion(id: string): void;
  /** Write session state — observed → patched. */
  setState(key: string, value: unknown): void;
  /** Change the working directory — observed → patched. */
  setCwd(path: string): void;
  /** Direct meta-callbacks — watch/control the machinery, NOT filters. */
  onFilter(cb: FilterMetaCallbacks): this;
  /** Cycle-level callbacks — the whole-queue reorganization points. */
  onCycle(cb: CycleCallbacks): this;
  /** Observable: is there anything for the machine to do? */
  readonly hasWork: boolean;
  /** True while a turn is in flight (started, not landed). */
  readonly inTurn: boolean;
  /** The ONLY door for inputs — sync = SIGINT (processed immediately at arrival). */
  input(input: Input): void;
  /** The pending queues — observable (a UI can render "N pending, M async"). */
  readonly pendingInputs: { sync: Input[]; async: Input[] };
  /** Total ticks executed — the heartbeat counter. */
  readonly ticks: number;
  /** The last tick's action plan — observable: "what did the machine decide". */
  readonly tickPlan: string[];
  /** What's in flight right now. */
  readonly inFlight: { provider: boolean; tools: boolean };
  // ---- declared registries (the core promise — three id-keyed Maps) ----
  addDeclaredInput(entry: DeclaredInput): void;
  removeDeclaredInput(id: string): boolean;
  listDeclaredInputs(): DeclaredInput[];
  getDeclaredInput(id: string): DeclaredInput | undefined;
  /** Capabilities REQUIRE a description — that's the contract. */
  addDeclaredCapability(entry: DeclaredCapability): void;
  removeDeclaredCapability(id: string): boolean;
  listDeclaredCapabilities(): DeclaredCapability[];
  getDeclaredCapability(id: string): DeclaredCapability | undefined;
  /** Built-in events (the 38 from EVENTS) are pre-loaded; add/delete manage the rest. */
  addDeclaredEvent(entry: DeclaredEvent): void;
  removeDeclaredEvent(id: string): boolean;
  listDeclaredEvents(): DeclaredEvent[];
  getDeclaredEvent(id: string): DeclaredEvent | undefined;
  /**
   * MASS MERGE — write the whole god object silently (restore / checkpoint /
   * sync-apply). `fn` receives the observed data container, manipulates it
   * (or returns a NEW one), returns it. NO patches fire — the diff is
   * swallowed; NO tape. ONE `merged` event announces it; listeners re-read
   * the object on it. Universal: any key, any count, no field lists.
   *
   * GOTCHA: merge() re-wraps the container in a FRESH Proxy. NEVER cache a
   * reference into `state`/`messages`/`transient` (e.g. `const st =
   * agent.state`) across a merge — the cached ref points at the OLD container
   * and silently goes stale (patches stop, data is orphaned). Hold KEYS, not
   * the container, and re-read through the agent on `merged`.
   */
  merge(fn: (data: SessionData) => SessionData): void;
}

// ============================================================================
// STATS — the STANDARD interface every model call reports, every consumer reads
// ============================================================================
/** A single cost bucket — what the provider returns per category. All in the same currency (USD by default). */
export interface UsageCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	/** Open — provider-specific extras (subscription credit, per-request fees, ...). */
	[key: string]: number | undefined;
}
/**
 * MessageStats — THE unified per-call stats object. One shape.
 * Lives on each Message (assistant + toolResult). The session-wide `Stats` is a
 * recalculation that walks all messages and sums / takes-latest of these fields.
 *
 * Standard fields for the universal basics. Open index for everything else
 * providers want to stamp (native_tokens_reasoning, generation_id, usage_data, ...).
 *
 * Inspired by OpenRouter, pi-ai, and the SDK's "lego" philosophy: name the things
 * everyone agrees on, leave the rest open for the provider to claim.
 */
export interface MessageStats {
	// ===== Tokens (Pi-style) — universal, every provider emits something here =====
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	// ===== Cost — universal, every priced provider emits this =====
	cost: UsageCost;
	// ===== Telemetry (per-call performance) — open, providers vary =====
	/** Time to first token (ms). */
	ttftMs?: number;
	/** Total call duration (ms). */
	durationMs?: number;
	/** Tokens per second (output / duration). */
	tps?: number;
	/** Time spent stalled mid-stream (ms). */
	stallsMs?: number;
	/** Provider-reported round-trip latency (ms). */
	latencyMs?: number;
	/** Multi-hop router latency (OpenRouter etc., ms). */
	routerLatencyMs?: number;
	/** What the provider's price card SAYS this should cost — drift tracking. */
	listPrice?: UsageCost;
	// ===== Identity — open, useful for "which model answered this" =====
	/** API type (chat_completions / responses / completions / ...). */
	api?: string;
	/** Provider id (anthropic / openai / google / openrouter / ...). */
	provider?: string;
	/** Model id (claude-sonnet-4-5 / gpt-4o / ...). */
	model?: string;
	/** Stop reason (stop / toolUse / length / error / aborted). */
	stopReason?: string;
	/** Provider's per-call id (OpenRouter gen-...). */
	generationId?: string;
	// ===== Timing — provider-reported =====
	/** When the generation library says the call completed (ms epoch). NOT our commit time. */
	timestamp?: number;
	// ===== Open — everything provider-specific that doesn't fit the standard slots =====
	// reasoning tokens, image tokens, audio tokens, search results, fetches, byok flags,
	// app/origin tags, request IDs, credit pool ids, region, etc. — anything goes.
	[key: string]: unknown;
}
/**
 * The agent's `stats` — MessageStats + the derived context fill ratio.
 * This is a RECALCULATION of all message stats, not the source of truth.
 * The agent's `recordStats(stats)` is the only legitimate writer — it stamps the
 * per-call stats onto the current message, then recomputes the totals.
 */
export interface Stats extends MessageStats {
	/** Context usage as a 0..1 ratio of latest input / maxContext. Derived. */
	contextUsage?: number;
}
/** Fresh empty MessageStats — every numeric field 0, cost zeros, nothing optional. */
export function emptyStats(): MessageStats {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
/** Fresh empty Stats — totals zero, contextUsage unset. */
export function emptySessionStats(): Stats {
	return { ...emptyStats() };
}
/**
 * Per-call telemetry keys that must NEVER be summed across calls. `tps` is a
 * rate, `latencyMs`/`ttftMs`/`durationMs`/`stallsMs`/`routerLatencyMs` are
 * per-call measurements. The session totals keep the LATEST call's values
 * (agent.recordStats overlays them after the additive pass).
 */
export const PER_CALL_TELEMETRY_KEYS = [
	"ttftMs",
	"durationMs",
	"tps",
	"stallsMs",
	"latencyMs",
	"routerLatencyMs",
] as const;

/**
 * Pure accumulation: `totals` += `stats`. Numeric fields sum; per-call identity /
 * telemetry fields are NOT touched (callers handle "latest wins" themselves for those).
 * Open-index fields: numeric ones sum, everything else leaves alone.
 */
export function addStats(totals: MessageStats, stats: MessageStats): void {
	totals.input += stats.input;
	totals.output += stats.output;
	totals.cacheRead += stats.cacheRead;
	totals.cacheWrite += stats.cacheWrite;
	totals.totalTokens += stats.totalTokens;
	totals.cost.input += stats.cost.input;
	totals.cost.output += stats.cost.output;
	totals.cost.cacheRead += stats.cost.cacheRead;
	totals.cost.cacheWrite += stats.cost.cacheWrite;
	totals.cost.total += stats.cost.total;
	// Sum numeric extension fields (custom token totals, extra cost buckets, ...).
	// Per-call telemetry (tps/latency/timing) is DELIBERATELY excluded — summing a
	// rate or a per-call latency is nonsense; recordStats overlays the latest instead.
	for (const k of Object.keys(stats)) {
		if (k === "input" || k === "output" || k === "cacheRead" || k === "cacheWrite" || k === "totalTokens" || k === "cost") continue;
		if ((PER_CALL_TELEMETRY_KEYS as readonly string[]).includes(k)) continue;
		const v = stats[k as keyof MessageStats];
		if (typeof v === "number") {
			const cur = totals[k as keyof MessageStats];
			totals[k] = (typeof cur === "number" ? cur : 0) + v;
		}
	}
}

// ============================================================================
// MODEL — one object, one function, stream as the knob
// ============================================================================

/**
 * The model contract. The agent internally does `this.model.callNextTurn(this)`.
 * The class does everything inside:
 * 1. take messages from context, transform to what the API accepts (prepareMessages)
 * 2. make the call, receive, return
 * 3. return the normal message — what the runtime expects, always
 *
 * Streaming: if `stream` is true, the model emits STREAM events through the
 * `onStream` callback as deltas arrive (visibility + early-abort). The loop
 * forwards them to the bus. Then it returns the full TurnResult for the READY
 * phase. If not streaming, everything lands in the READY phase.
 */
export interface ModelContract {
  /** API TYPE, not provider: "chat_completions" | "responses" | ... */
  api: string;
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  /** The runtime's knob — reads this to decide how to call and adjust. */
  stream: boolean;
  /** The context window — the compaction trigger reads this. */
  maxContext?: number;
  /** Runtime params — plain mutable fields, swap anytime, by any hook. */
  temperature?: number;
  maxOutputTokens?: number;
  [key: string]: unknown;

  /** THE function the runtime calls. Receives the WHOLE context. */
  callNextTurn(ctx: GodObject): Promise<TurnResult>;
}

/** A stream event emitted by the model — forwarded to the bus by the loop. */
export type StreamEvent =
  | { type: "streamStarted" }
  | { type: "textDelta"; delta: string }
  | { type: "textEnd" }
  | { type: "thinkingDelta"; delta: string }
  | { type: "thinkingEnd" }
  | { type: "toolcallDelta"; delta: string };

/** The loop hands this to the model so it can emit stream events. */
export interface StreamSink {
  emit(ev: StreamEvent): void;
}

/** What callNextTurn returns — streaming parts, then the final message. */
export interface TurnResult {
  /** Streaming parts, if streamed. */
  parts?: unknown[];
  /** The final message — with all necessary components: stats, parts, etc. */
  message: Message;
  stats: MessageStats;
  stopReason: string;
  /** Provider extras, untouched, for debugging only. */
  raw?: unknown;
}

// ============================================================================
// TOOLS — the boring four blocks
// ============================================================================

/** Tool result: answer (for them) + stored (for us) + error (the additive flag). */
export interface ToolResult {
  /** What the MODEL sees. */
  answer: string;
  /** Everything else — errors, traces, structured. RAW: stored verbatim,
   * never transformed by the core. Any shape: object, array, string, undefined. */
  stored?: unknown;
  /** Additive failure flag — set `error: true` when the tool failed.
   * Absent/undefined = success. The answer still flows to the model either way —
   * the loop never blocks. Orchestrators check `error === true`. The core also
   * stamps it on its own synthesized failures (throw/unknown/disabled). */
  error?: boolean;
  /** Optional structured detail for the orchestrator — separate from `answer`
   * (which is the model-adapted text). Tool-authored. */
  errorMessage?: string;
}

export interface Tool {
  /** The ONLY thing the model sees as an identifier. */
  name: string;
  /** When/when-not to call — the model's instructions. */
  description: string;
  /** Parameters — everything else is optional. */
  inputSchema: JsonSchema;
  /** Optional output schema — useful for structured-output mode. */
  outputSchema?: JsonSchema;
  /** Optional execution mode. */
  executionMode?: "sequential" | "parallel";
  /** One-liner for the tool menu — what this tool does at a glance (pi's promptSnippet). */
  promptSnippet?: string;
  /** Behavioral rules merged into the system prompt — when to use/avoid, how
   * to call (pi's promptGuidelines). Aggregate with extras/tool-prompt. */
  promptGuidelines?: string[];
  /** CUSTOM VALIDATOR — when present, it REPLACES the default JSON-Schema wall.
   * Receives the raw call params, returns human-readable problems (empty = valid).
   * Use it for zod/ajv/hand-rolled strictness the cheap wall can't express. */
  validate?: (params: unknown) => string[];
  /**
   * NON-DESTRUCTIVE off-switch (item 16). Stays in context, stays callable,
   * but execute is skipped → "this tool is currently disabled". Cache-clean.
   * Add/remove = destructive (changes the wire prompt). Disable = light switch.
   */
  disabled?: boolean;
  /**
   * VISIBILITY AXIS — independent from `disabled`. Hidden tools stay in the
   * registry and are FULLY CALLABLE (execute runs when the name is matched),
   * but they are EXCLUDED from the context sent to the provider
   * (`agent.visibleTools()` is the wire list). Use with a tool_search /
   * progressive-disclosure extra: the model discovers hidden tools by name,
   * then calls them. The 2×2 matrix with `disabled`:
   *   visible + enabled  = normal tool (in context, callable)
   *   visible + disabled = in context, execute skipped (current disableTool)
   *   hidden  + enabled  = not in context, but callable if name matched
   *   hidden  + disabled = not in context AND execute skipped (dormant)
   */
  hidden?: boolean;

  /** The side effect. Receives params + the ENTIRE god object. Sync or async. */
  execute(params: unknown, agent: GodObject): Promise<ToolResult> | ToolResult;
}

// ============================================================================
// MISC SHARED
// ============================================================================

/** JSON Schema — boring, standard, everywhere. */
export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  [key: string]: unknown;
};

/**
 * A KEY CHANGE — the universal delta. Produced O(1) at the moment of mutation by the
 * path-tracking observer Proxy: NO diff, NO serialization. The trap knows the top-level
 * key, the exact dotted path, the op and the NEW value. The previous value is deliberately
 * NOT included — that was the whole-object diff's cost, and nothing needs it.
 */
export interface KeyChange {
  /** Top-level SessionData key — "messages" | "state" | "loopState" | ... */
  key: string;
  /** Exact mutation site, dotted — "state.foo" | "messages.3.content.1.content" */
  path: string;
  /** What happened at that path. `value` = the NEW value (set only). */
  op: "set" | "delete";
  value?: unknown;
}

/**
 * The observed god-object data — ONE container the Proxy observer watches whole.
 * Every mutation of ANY field produces a KeyChange → the `patched` event.
 * `merge()` swaps this wholesale, silently.
 */
export interface SessionData {
  /** The session's own name — self-identifying. Observed → taped → restored. */
  id: string;
  /** Pointer to the code profile (not the code itself) — what kind of agent this is. */
  agentId: string;
  cwd: string;
  /** The agent's one-line description — what it does. Static, constructor-set. */
  description?: string;
  /** The LIVE state string — natural language, plugin-written ("waiting 5:00 until next
   * trigger"). Updated on meaningful change, not per tick. Observed → taped → restored. */
  activity: string;
  model: ModelContract;
  messages: Message[];
  stats: Stats;
  state: Record<string, unknown>;
  /** TRANSIENT — the current tick's working memory + `currentEvent`. Observed, NEVER stored. */
  transient: Record<string, unknown>;
  loopState: LoopState;
  runState: RunState;
  pendingAwaits: PendingAwait[];
  pendingQuestions: PendingQuestion[];
  currentAction: unknown;
  tools: Tool[];
  tickPlan: string[];
  lastResponse: number;
}

// ============================================================================
// THE 39 CORE EVENTS (constants — loop-emitted, guaranteed, versioned)
// ============================================================================

export const EVENTS = {
  // ---- loop lifecycle (15) ----
  beforeAgentStart: "beforeAgentStart",
  agentStart: "agentStart",
  agentEnd: "agentEnd",
  // the true ending — the loop has fully landed (idle or awaiting);
  // nothing will happen until input. Fires AFTER beforeRunEnd.
  agentSettled: "agentSettled",
  turnStart: "turnStart",
  // one cycle = one model round-trip; cycleEnd fires after each completed
  // cycle (assistant response committed, or tool batch committed).
  cycleEnd: "cycleEnd",
  // a cycle was DISCARDED without committing anything (endCycle veto, or a
  // stop mid-cycle). Consecutive discards = a stuck filter — loop-control's
  // spin-guard counts these.
  cycleDiscarded: "cycleDiscarded",
  turnEnd: "turnEnd",
  beforeStop: "beforeStop",
  stop: "stop",
  beforeAbort: "beforeAbort",
  abort: "abort",
  beforeRunEnd: "beforeRunEnd",
  error: "error",
  handlerError: "handlerError",

  // ---- input (2) — the input channel is ORTHOGONAL to messages: received = the decision
  // point; processed = the side effects (and their KeyChanges) are observable. Whether
  // messages result is the filter's call — announced by the MESSAGE channel, not here. ----
  inputReceived: "inputReceived",
  inputProcessed: "inputProcessed",
  // ---- messages (5) — the ADD lifecycle: beforeMessageAdd = modify-before-insert,
  // messageAdded = log/recalc after. Fires for EVERY loop-driven addition (model
  // commits AND input-driven inserts). Mutation events (messageUpdate/fragmentUpdate/
  // messageRemoved) come from the observer. ----
  beforeMessageAdd: "beforeMessageAdd",
  messageUpdate: "messageUpdate",
  messageAdded: "messageAdded",
  messageRemoved: "messageRemoved",
  // compound-fragment level update — our own stuff, its own event
  fragmentUpdate: "fragmentUpdate",

  // ---- tool (6) ----
  beforeTool: "beforeTool",
  afterTool: "afterTool",
  toolStart: "toolStart",
  // a TOOL'S DEFINITION changed — schema/description updated, enabled/disabled.
  // (progress during a long tool = the tool's own custom events, not this)
  toolUpdate: "toolUpdate",
  toolEnd: "toolEnd",
  // the tool LIST mutated at runtime (add/remove)
  toolListChanged: "toolListChanged",

  // ---- output stream (6) ----
  streamStarted: "streamStarted",
  textDelta: "textDelta",
  textEnd: "textEnd",
  thinkingDelta: "thinkingDelta",
  thinkingEnd: "thinkingEnd",
  toolcallDelta: "toolcallDelta",

  // ---- provider boundary (2) ----
  beforeProviderRequest: "beforeProviderRequest",
  afterProviderResponse: "afterProviderResponse",

  // ---- generic (2) ----
  /** THE universal delta — fires for EVERY god-object key change (any field, any depth). */
  patched: "patched",
  /** A silent mass merge just happened (restore/checkpoint/sync) — re-read on it. */
  merged: "merged",
  usage: "usage",
} as const;

export type CoreEvent = (typeof EVENTS)[keyof typeof EVENTS];
