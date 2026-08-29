// ============================================================================
// packages/extras/subagents/index.ts — agents as tools + THE AGENT-MANAGER.
// ============================================================================
// A sub-agent is NOT a concept. It is an Agent nobody ran yet.
//
// ── MODE 1: agentAsTool(builder) ────────────────────────────────────────────
// One-shot tool: invoke builder → fresh pristine agent (full ritual) → run →
// land → collect final → TERMINATE → { answer }. No persistence by design.
//
// ── MODE 2: createSubAgents({...}) ─────────────────────────────────────────
// THE AGENT-MANAGER: persistent sub-agents that stay alive across sends.
// Four tools (the mode dial shapes which exist):
//   spawn { sub, text, context?, background? }  create an instance — id generated,
//                                     ALWAYS returned. background:false blocks
//                                     till the reply; true = fire-and-forget.
//   await { id? }                     collect one / settle the world. Dumb, patient.
//   steer { id, text? | stop? | terminate? }   write to ONE instance. NEVER blocks.
//                                     text: delivered (running → inserted, idle →
//                                     kickstarts, queued → seed pile). stop: gentle
//                                     freeze + inspection, resumable. terminate: 💀.
//   list  {}                          family portrait: id · kind · state · snippet.
//
// MODE DIAL: "sync" → spawn(blocking)+list · "async" → spawn(always bg)+await+
// steer+list · "both" (default) → everything, spawn carries background?.
//
// CONCURRENCY: manager-level cap on BACKGROUND runs (FIFO queue, auto-start).
// Sync spawns bypass it (they block the caller anyway).
//
// TIMEOUT: optional budget for BLOCKING sends — same union as agentAsTool.
//
// ── THE PENDING LAW ────────────────────────────────────────────────────────
// ONE TYPE = ONE OWNER = ONE RESOLVING LOOP. A child's parked await NEVER
// wears its native type on the parent. Escalation wraps it:
//   parent.pendingAwaits += { type: "subagents/pending", id: "sub:<id>:<ref>" }
// answered ONLY via  input({ type: "subagents/answer", id, … })  — the manager
// translates to the inner plugin's vocabulary and delivers DOWN; the sub's own
// filter splices its own await. Gates stay home; only wrappers travel.
//   onPending: "escalate" → the above (upstream answers through ITS door)
//              fn(subId, item) → Input  → auto: manager answers by itself
//              undefined                → local: frozen + visible, manual steer
// Independent from swarm: swarm = multi-process hypervisor. This = one process.
// ============================================================================

import { Agent, EVENTS, Tool } from "@sanityloop/core";
import type {
    GodObject,
    Input,
    JsonSchema,
    Message,
    PendingAwait,
    Plugin,
    ToolResult,
    ToolType,
} from "@sanityloop/core";

// ============================================================================
// SHARED PIECES
// ============================================================================

/** The builder — create + decorate + return an UN-RUN agent. */
export type AgentBuilder = () => Agent;

export interface AgentAsToolOptions {
    /** The tool name the PARENT model sees (e.g. "researcher"). */
    name: string;
    /** What the sub is FOR — this is what the parent reads to decide. */
    description: string;
    /** THE BUILDER — must return a pristine (never-run) Agent. */
    agent: AgentBuilder;
    /** Default: { prompt: string } required. */
    inputSchema?: JsonSchema;
    /**
     * Deadline for ONE call. Bare number → GRACEFUL. Object form:
     * { ms, mode: "graceful"|"hard", graceMs? }. Absent = unbounded.
     * Validated loudly at wrap time. No ceiling is ever imposed.
     */
    timeout?: TimeoutSpec;
}

export type TimeoutSpec = number | {
    ms: number;
    mode: "graceful" | "hard";
    /** Graceful only — how long stop() gets before we abort anyway. Default 2000. */
    graceMs?: number;
};

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function userMessage(prompt: string): Message {
    return {
        id: `user-${crypto.randomUUID().slice(0, 8)}`,
        enabled: true,
        type: "user",
        committedAt: Date.now(),
        content: [{ type: "text", content: prompt }],
    };
}

/** One message → one readable transcript line (text only — never the raw wire shape). */
function transcriptLine(m: Message): string {
    const role = m.type === "toolCall" ? "tool call" : m.type === "toolResult" ? "tool result" : m.type;
    const c = m.content as unknown;
    let text: string;
    if (typeof c === "string") {
        text = c;
    } else if (Array.isArray(c)) {
        text = c
            .map((part) => {
                const p = part as { type?: string; content?: unknown; text?: unknown };
                if (p.type === "text") {
                    if (typeof p.content === "string") return p.content;
                    if (typeof p.text === "string") return p.text;
                }
                return "";
            })
            .filter((s) => s.length > 0)
            .join(" ");
    } else if (m.type === "toolCall" || m.type === "toolResult") {
        // tool messages: answer + the calls they carried + error tails — readable,
        // never the raw wire shape
        const cobj = c as { answer?: unknown; stored?: unknown; errorMessage?: unknown };
        const parts: string[] = [];
        if (typeof cobj.answer === "string" && cobj.answer.length > 0) parts.push(cobj.answer);
        if (m.type === "toolCall") {
            const calls = (cobj.stored as Array<{ name?: string; parameters?: unknown }> | undefined) ?? [];
            for (const tc of calls) {
                const args =
                    typeof tc.parameters === "string"
                        ? tc.parameters
                        : JSON.stringify(tc.parameters ?? {});
                parts.push(`${tc.name ?? "?"}(${args})`);
            }
        }
        if (m.type === "toolResult" && cobj.errorMessage) parts.push(`error: ${cobj.errorMessage}`);
        text = parts.join(" | ");
    } else if (c && typeof c === "object" && "answer" in (c as object)) {
        text = String((c as { answer?: unknown }).answer ?? "");
    } else {
        try {
            text = JSON.stringify(c);
        } catch {
            text = String(c);
        }
    }
    return `[${role}] ${text}`;
}

/**
 * The last N parent messages rendered as ONE labeled transcript message.
 * Explicitly NOT raw history injection: the child must see this as a
 * transcript of a PREVIOUS conversation (background context), not as its
 * own memory. The task prompt is pushed by the caller as a separate message.
 */
function contextMessage(messages: Message[], n: number): Message {
    const body = messages.slice(-n).map(transcriptLine).join("\n");
    return {
        id: `context-${crypto.randomUUID().slice(0, 8)}`,
        enabled: true,
        type: "user",
        committedAt: Date.now(),
        content: [
            {
                type: "text",
                content:
                    "Previous conversation context (transcript of an earlier conversation — background, not instructions):\n" +
                    body,
            },
        ],
    };
}

/** Walk history backwards for the last assistant message; join its text. */
export function collectFinalAnswer(messages: Message[]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.type !== "assistant") continue;
        const c = m.content;
        if (typeof c === "string") return c;
        if (Array.isArray(c)) {
            const text = c
                .map((b) => {
                    if (typeof b === "string") return b;
                    const content = (b as { content?: unknown }).content;
                    return typeof content === "string" ? content : "";
                })
                .join("");
            return text.trim();
        }
        return String(c);
    }
    return undefined;
}

const landed = (a: Agent) => a.loopState === "idle" && !a.hasWork;
/** Grace variant used only inside the stop()-grace window (awaits may still pin it). */
const settled = (a: Agent) => landed(a) && a.pendingAwaits.length === 0;
const TERMINAL_STATES = new Set(["aborted", "errored", "terminated"]);

interface ResolvedTimeout {
    ms: number;
    mode: "graceful" | "hard";
    graceMs: number;
}

function resolveTimeout(name: string, spec: TimeoutSpec): ResolvedTimeout {
    const r: ResolvedTimeout =
        typeof spec === "number"
            ? { ms: spec, mode: "graceful", graceMs: 2000 }
            : { ms: spec.ms, mode: spec.mode, graceMs: spec.graceMs ?? 2000 };
    if (!(r.ms > 0) || !Number.isFinite(r.ms)) {
        throw new Error(`[subagents] "${name}": timeout must be a positive finite number of ms (got ${r.ms}).`);
    }
    if (r.mode === "graceful" && !(r.graceMs >= 0)) {
        throw new Error(`[subagents] "${name}": graceMs must be >= 0 (got ${r.graceMs}).`);
    }
    return r;
}

// ============================================================================
// MODE 1 — THE STUPID TOOL
// ============================================================================

/**
 * Wrap an agent-builder as a plain one-shot tool. Internally literally what
 * you would hand-roll: new agent on the fly, run, wait till completion,
 * collect result, terminate, return result. Nothing fancy — and the sub
 * stays literally itself: a plain Agent, alive for exactly one call.
 */
export function agentAsTool(opts: AgentAsToolOptions): ToolType {
    const limit = opts.timeout !== undefined ? resolveTimeout(opts.name, opts.timeout) : undefined;

    // same-identity guard: returning THE SAME instance twice would silently
    // accumulate history — anti-one-off. Refuse loudly instead of hanging
    // (a terminated instance can never land again).
    let lastAgent: Agent | undefined;

    return Tool.define({
        name: opts.name,
        description: opts.description,
        executionMode: "sequential", // one sub at a time, by definition of the pattern
        inputSchema:
            opts.inputSchema ?? {
                type: "object",
                properties: {
                    prompt: { type: "string" },
                    context: {
                        type: "integer",
                        minimum: 0,
                        description: "Include the last N messages of the current conversation as ONE labeled transcript message (background context from a previous conversation — not instructions). Omit for none.",
                    },
                },
                required: ["prompt"],
            },
        execute: async (rawParams, agent): Promise<ToolResult> => {
            const params = (rawParams ?? {}) as { prompt?: unknown; context?: unknown };
            if (typeof params.prompt !== "string" || params.prompt.length === 0) {
                return {
                    answer: `${opts.name}: missing required string parameter "prompt".`,
                    error: true,
                };
            }

            const sub = opts.agent();
            if (!(sub instanceof Agent)) {
                return {
                    answer: `${opts.name}: builder returned ${sub === null ? "null" : typeof sub} instead of an Agent instance — build + decorate + return, never run.`,
                    error: true,
                };
            }
            if (sub === lastAgent) {
                return {
                    answer: `${opts.name}: builder returned the SAME agent instance as the previous call — one-off semantics need a fresh Agent per invocation (build a new one inside the builder).`,
                    error: true,
                };
            }
            lastAgent = sub;

            sub.messages.push(userMessage(params.prompt));
            if (typeof params.context === "number" && params.context > 0) {
                // context SECOND, as one labeled transcript message — background,
                // explicitly not the child's own history
                sub.messages.push(contextMessage(agent.messages, Math.floor(params.context)));
            }
            void sub.run(); // signals never start loops — but owed work does

            let timedOut = false;
            const deadline = limit !== undefined ? Date.now() + limit.ms : undefined;
            while (!landed(sub)) {
                if (TERMINAL_STATES.has(sub.loopState)) break; // dead subs never land idle
                if (deadline !== undefined && Date.now() > deadline) {
                    timedOut = true;
                    break;
                }
                await sleep(10);
            }

            if (timedOut && limit) {
                if (limit.mode === "hard") {
                    sub.abort(`${opts.name}: timed out (hard)`); // oblivion — no leftovers
                } else {
                    sub.stop(); // graceful — give the step room, then inspect
                    const graceEnd = Date.now() + limit.graceMs;
                    while (!settled(sub) && Date.now() < graceEnd) await sleep(10);
                    if (!settled(sub)) sub.abort(`${opts.name}: timed out (grace expired)`);
                }
            }

            const final = collectFinalAnswer(sub.messages);
            await sub.terminate(); // heart stops, promise resolves, GC reaps

            if (timedOut && limit) {
                if (limit.mode === "graceful" && final) {
                    // the crumb is worth more than the complaint — deliver it
                    return {
                        answer: final,
                        stored: {
                            subId: sub.id,
                            timedOut: true,
                            timeoutMode: "graceful",
                            messages: sub.messages.length,
                            stats: sub.stats,
                        },
                    };
                }
                return {
                    answer:
                        `${opts.name}: timed out after ${limit.ms}ms (${limit.mode})` +
                        (limit.mode === "graceful" && !final ? " — stopped gracefully, nothing produced." : "."),
                    error: true,
                    stored: { subId: sub.id, timedOut: true, timeoutMode: limit.mode, loopState: sub.loopState },
                };
            }
            if (final === undefined) {
                return {
                    answer: `${opts.name}: sub-agent ended in "${sub.loopState}" without producing an assistant reply.`,
                    error: true,
                    stored: { subId: sub.id, loopState: sub.loopState, messages: sub.messages.length },
                };
            }
            return {
                answer: final,
                stored: { subId: sub.id, messages: sub.messages.length, stats: sub.stats },
            };
        },
    });
}

// ============================================================================
// MODE 2 — THE AGENT-MANAGER
// ============================================================================

/** One registry entry — a KIND of sub-agent. */
export interface SubEntry {
    /** Registry handle. Omitted → read from fn.name (anonymous fns refuse loudly). */
    id?: string;
    /** What this kind is FOR — creation-time only, baked into the spawn tool. */
    description?: string;
    build: AgentBuilder;
}

export type SubEntryLike = SubEntry | AgentBuilder;

/** How a parked child await surfaces upstream (THE PENDING LAW — see header). */
export type OnPending =
    /** ESCALATE — flows up, up, up to the TOP loop: a proxy await lands in the
     * parent's OWN pendingAwaits (type "subagents/pending"), the top loop is
     * BLOCKED, and whoever answers the top's awaits (human/upstream) answers
     * this through the singular interface: input({ type:"subagents/answer", id }). */
    | "escalate"
    /** ORCHESTRATE — flows up to the ORCHESTRATOR (host code), not the top loop.
     * The top loop is NOT blocked; the ask surfaces via the `onAsk` callback
     * and the orchestrator decides by calling manager.respond(askId, input). */
    | "orchestrate"
    /** AUTO — the manager inspects and answers by itself via this fn.
     * No upstream noise at all. */
    | ((subId: string, item: PendingAwait) => Input | Promise<Input>)
    /** LOCAL — frozen + visible (list/control show it), nothing automatic. */
    | undefined;

/** An ask surfaced to the orchestrator in "orchestrate" mode. */
export interface SubAgentAsk {
    /** The handle for manager.respond(askId, input). */
    id: string;
    subId: string;
    kind: string;
    description: string;
    item: PendingAwait;
}

export interface CreateSubAgentsOptions {
    /** Cap on concurrent BACKGROUND runs. FIFO queue beyond it. Default 4. */
    concurrency?: number;
    /** Budget for BLOCKING (spawn-sync / awaited) waits. Absent = unbounded. */
    timeout?: TimeoutSpec;
    /** The tool-shape dial. Default "both". */
    mode?: "sync" | "async" | "both";
    /** THE PENDING LAW. Default undefined (local). */
    onPending?: OnPending;
    /** ORCHESTRATE hook — called when a sub parks and onPending === "orchestrate".
     * The orchestrator decides and answers via manager.respond(ask.id, input). */
    onAsk?: (ask: SubAgentAsk) => void;
    /** Translators for answering foreign gate families in escalate/auto flows.
     * Built-ins exist for "ask-question/question" and "loop-control/doom". */
    answerBuilders?: Record<string, (item: PendingAwait, raw: unknown) => Input>;
    /** The kinds — entries or bare builders (id read from fn.name). */
    subs: SubEntryLike[];
    /** Tool name overrides. Defaults: sub_spawn / sub_await / sub_steer / sub_list. */
    names?: Partial<Record<"spawn" | "await" | "steer" | "list", string>>;
}

const PROXY_TYPE = "subagents/pending";
const ANSWER_TYPE = "subagents/answer";

/** One line of the family portrait — `list` output / host introspection. */
export interface SubAgentInstanceInfo {
    id: string;
    kind: string;
    description: string;
    state: string;
    lastMessage?: string;
}

/** The manager object: a Plugin (installable) plus the small host API. */
export interface SubAgentsManager extends Plugin {
    instances(): SubAgentInstanceInfo[];
    close(id: string): Promise<boolean>;
    closeAll(): Promise<number>;
    /** ORCHESTRATE answering door — deliver an answer input down to the sub
     * that surfaced the given ask (see onAsk). Returns false for unknown/stale asks. */
    respond(askId: string, input: Input): boolean;
    tools: Record<string, ToolType>;
}

interface SendOutcome {
    ok: boolean;
    reply?: string;
    error?: string;
}

interface Deferred {
    promise: Promise<SendOutcome>;
    resolve: (o: SendOutcome) => void;
}

function defer(): Deferred {
    let resolve!: Deferred["resolve"];
    const promise = new Promise<SendOutcome>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

interface SubInstance {
    id: string;
    kind: string;
    description: string;
    agent: Agent;
    started: boolean;
    queued: boolean;
    usedSlot: boolean;
    send?: Deferred;
    /** Await items already surfaced (proxied or auto-handled) — identity-keyed. */
    handled: Set<PendingAwait>;
}

/** Built-in translators for OUR OWN extras' gate families. */
const BUILT_IN_ANSWER_BUILDERS: Record<string, (item: PendingAwait, raw: unknown) => Input> = {
    "ask-question/question": (item, raw) => {
        const r = (raw ?? {}) as { answer?: unknown; answers?: unknown };
        let answers = r.answers ?? r.answer;
        if (typeof answers === "string") answers = [[answers]];
        else if (Array.isArray(answers) && (answers.length === 0 || typeof answers[0] === "string")) {
            answers = [answers as string[]];
        }
        return { type: "question-answer", ref: item.id!, answers } as Input;
    },
    "loop-control/doom": (item, raw) => {
        const r = (raw ?? {}) as { decision?: string; approved?: boolean };
        const decision = r.decision ?? (r.approved === false ? "stop" : "continue");
        return { type: "loop-control-doom-answer", ref: item.id!, decision } as Input;
    },
};

/**
 * THE AGENT-MANAGER — persistent sub-agents + four tools. See the header for
 * the whole doctrine. Returns an object that IS a Plugin (spread it into
 * agent.install) plus a small host API (instances/close/closeAll/tools).
 */
export function createSubAgents(opts: CreateSubAgentsOptions): SubAgentsManager {
    const mode = opts.mode ?? "both";
    const concurrency = opts.concurrency ?? 4;
    const limit = opts.timeout !== undefined ? resolveTimeout("manager", opts.timeout) : undefined;
    const onPending = opts.onPending;
    const names = { spawn: "sub_spawn", await: "sub_await", steer: "sub_steer", list: "sub_list", ...(opts.names ?? {}) };

    if (!Array.isArray(opts.subs) || opts.subs.length === 0) {
        throw new Error("[subagents] `subs` must be a non-empty array of builders/entries.");
    }

    // ---- registry: kinds ----
    const kinds = new Map<string, { description: string; build: AgentBuilder }>();
    for (const raw of opts.subs) {
        const entry: SubEntry = typeof raw === "function" ? { build: raw } : raw;
        let id = entry.id;
        if (!id && typeof raw === "function" && raw.name) id = raw.name;
        if (!id) {
            throw new Error("[subagents] bare builder has no name — give the function a name or set entry.id.");
        }
        if (kinds.has(id)) {
            throw new Error(`[subagents] duplicate kind id "${id}" — ids are unique handles.`);
        }
        kinds.set(id, { description: entry.description ?? "", build: entry.build });
    }

    // ---- runtime state ----
    const instances = new Map<string, SubInstance>();
    const counters = new Map<string, number>();
    const queue: Array<{ inst: SubInstance; prompt: string; context?: number }> = [];
    let activeBackground = 0;
    const proxyById = new Map<string, { inst: SubInstance; item: PendingAwait }>();
    /** ORCHESTRATE mode: asks surfaced to the host, waiting for respond(). */
    const orchestrated = new Map<string, { inst: SubInstance; item: PendingAwait }>();
    let parent: GodObject | undefined;
    const parentFilters: Array<{ event: string; id: string }> = [];

    // ---- plumbing ----
    const stateOf = (inst: SubInstance): string => {
        if (inst.queued) return "queued";
        return inst.agent.loopState;
    };

    const releaseProxy = (proxyId: string): void => {
        const rec = proxyById.get(proxyId);
        if (!rec) return;
        proxyById.delete(proxyId);
        if (parent) {
            const arr = parent.pendingAwaits;
            const idx = arr.findIndex((w) => w.type === PROXY_TYPE && w.id === proxyId);
            if (idx !== -1) arr.splice(idx, 1);
        }
    };

    const releaseAllProxies = (inst: SubInstance): void => {
        for (const [proxyId, rec] of [...proxyById]) {
            if (rec.inst === inst) releaseProxy(proxyId);
        }
        for (const [askId, rec] of [...orchestrated]) {
            if (rec.inst === inst) orchestrated.delete(askId);
        }
    };

    const deliver = (inst: SubInstance, input: Input): void => {
        // ASYNC lane — rides the microtask sideband straight through the block
        // into the registry chains where the sub's own resolvers live.
        inst.agent.input({ ...input, async: true } as Input);
    };

    const pump = (): void => {
        while (queue.length > 0 && activeBackground < concurrency) {
            const next = queue.shift()!;
            next.inst.queued = false;
            startRun(next.inst, next.prompt, true, next.context);
        }
    };

    const freeSlot = (inst: SubInstance): void => {
        if (inst.usedSlot) {
            inst.usedSlot = false;
            activeBackground--;
        }
        pump();
    };

    /** Reconcile an instance after ANY lifecycle beat (its own stop-event). */
    const reconcile = (inst: SubInstance): void => {
        const a = inst.agent;
        if (TERMINAL_STATES.has(a.loopState)) {
            inst.send?.resolve({ ok: false, error: `sub ended in "${a.loopState}"` });
            inst.send = undefined;
            releaseAllProxies(inst);
            freeSlot(inst);
            return;
        }
        if (landed(a)) {
            inst.send?.resolve({ ok: true, reply: collectFinalAnswer(a.messages) ?? "" });
            inst.send = undefined;
            freeSlot(inst);
            return;
        }
        if (a.loopState === "awaiting") {
            // THE PENDING LAW
            for (const item of a.pendingAwaits) {
                if (inst.handled.has(item)) continue;
                inst.handled.add(item);
                if (onPending === "escalate") {
                    escalateItem(inst, item);
                } else if (onPending === "orchestrate") {
                    orchestrateItem(inst, item);
                } else if (typeof onPending === "function") {
                    void (async () => {
                        try {
                            const answer = await onPending(inst.id, item);
                            deliver(inst, answer);
                        } catch (err) {
                            console.warn(`[subagents] auto-decide failed for ${inst.id}:`, err);
                            inst.handled.delete(item); // allow a retry on the next park beat
                        }
                    })();
                }
                // undefined (local) → frozen + visible; nobody automatic.
            }
            // self-heal: proxies/asks whose inner await vanished (resolved some way) → release
            for (const [proxyId, rec] of [...proxyById]) {
                if (rec.inst === inst && !a.pendingAwaits.includes(rec.item)) releaseProxy(proxyId);
            }
            for (const [askId, rec] of [...orchestrated]) {
                if (rec.inst === inst && !a.pendingAwaits.includes(rec.item)) orchestrated.delete(askId);
            }
        }
    };

    const escalateItem = (inst: SubInstance, item: PendingAwait): void => {
        if (!parent) return; // not installed yet — cannot surface anywhere
        // idempotence: an active proxy for the SAME inner ask already on the
        // board → do not double-surface it (resume re-fires park walls; a real
        // gate preResolves/keeps its await object, but foreign gates may not).
        for (const rec of proxyById.values()) {
            if (rec.inst === inst && rec.item.id !== undefined && rec.item.id === item.id) return;
        }
        const proxyId = `sub:${inst.id}:${item.id ?? crypto.randomUUID().slice(0, 8)}`;
        proxyById.set(proxyId, { inst, item });
        // THE LAW: the child's gate NEVER wears its native type here.
        parent.pendingAwaits.push({ type: PROXY_TYPE, id: proxyId, schema: null, subId: inst.id });
    };

    /** ORCHESTRATE — surface the ask to the host; the top loop stays unblocked. */
    const orchestrateItem = (inst: SubInstance, item: PendingAwait): void => {
        if (!opts.onAsk) return; // nobody listening — sub stays frozen + visible
        const askId = `ask:${inst.id}:${item.id ?? crypto.randomUUID().slice(0, 8)}`;
        orchestrated.set(askId, { inst, item });
        opts.onAsk({
            id: askId,
            subId: inst.id,
            kind: inst.kind,
            description: inst.description,
            item,
        });
    };

    /** ORCHESTRATE answering door — deliver an answer input down to the asker. */
    const respondToAsk = (askId: string, input: Input): boolean => {
        const rec = orchestrated.get(askId);
        if (!rec) return false;
        orchestrated.delete(askId);
        deliver(rec.inst, input);
        return true;
    };

    const watchFilterId = (inst: SubInstance) => `subagents/watch/${inst.id}`;

    const attachWatcher = (inst: SubInstance): void => {
        inst.agent.addFilter({
            event: EVENTS.stop,
            id: watchFilterId(inst),
            priority: 0,
            fn: async () => {
                reconcile(inst);
            },
        });
    };

    const startRun = (inst: SubInstance, prompt: string, useSlot: boolean, contextN?: number): void => {
        inst.started = true;
        inst.queued = false;
        if (useSlot) {
            inst.usedSlot = true;
            activeBackground++;
        }
        inst.send = defer();
        inst.agent.messages.push(userMessage(prompt));
        if (contextN !== undefined && contextN > 0) {
            // context SECOND, as one labeled transcript message — background,
            // explicitly not the child's own history
            inst.agent.messages.push(contextMessage(parent?.messages ?? [], Math.floor(contextN)));
        }
        void inst.agent.run(); // owed work starts the heart
    };

    /** Blocking wait on an instance's current send, honoring the manager budget. */
    const awaitSettled = async (inst: SubInstance): Promise<SendOutcome> => {
        const d = inst.send;
        if (!d) {
            // already settled (or never had a send) — snapshot truth
            if (TERMINAL_STATES.has(inst.agent.loopState)) {
                return { ok: false, error: `sub ended in "${inst.agent.loopState}"` };
            }
            return { ok: true, reply: collectFinalAnswer(inst.agent.messages) ?? "" };
        }
        if (!limit) return d.promise;
        let settledOut = false;
        const p = d.promise.then((v) => {
            settledOut = true;
            return v;
        });
        if (limit.mode === "hard") {
            const killer = setTimeout(() => inst.agent.abort(`${names.spawn}: timed out (hard)`), limit.ms);
            try {
                return await p;
            } finally {
                clearTimeout(killer);
            }
        }
        const stopper = setTimeout(() => inst.agent.stop(), limit.ms);
        const killer = setTimeout(() => inst.agent.abort(`${names.spawn}: timed out (grace expired)`), limit.ms + limit.graceMs);
        try {
            return await p;
        } finally {
            clearTimeout(stopper);
            clearTimeout(killer);
        }
    };

    /** Dumb, patient settle for ANY instance state — queued, running, or owed work. */
    const waitForSettled = async (inst: SubInstance): Promise<SendOutcome> => {
        // queued → wait until a slot frees and it actually starts
        while (inst.queued || !inst.started) {
            if (TERMINAL_STATES.has(inst.agent.loopState)) {
                return { ok: false, error: `ended in "${inst.agent.loopState}"` };
            }
            await sleep(10);
        }
        if (inst.send) return awaitSettled(inst);
        // started, no active send: steer follow-ups may have created owed work
        while (!landed(inst.agent)) {
            if (TERMINAL_STATES.has(inst.agent.loopState)) {
                return { ok: false, error: `ended in "${inst.agent.loopState}"` };
            }
            await sleep(10);
        }
        return { ok: true, reply: collectFinalAnswer(inst.agent.messages) ?? "" };
    };

    const spawnInstance = (kind: string): SubInstance => {
        const entry = kinds.get(kind);
        if (!entry) {
            throw new Error(
                `[subagents] unknown kind "${kind}". Known: ${[...kinds.keys()].join(", ")}`,
            );
        }
        const n = (counters.get(kind) ?? 0) + 1;
        counters.set(kind, n);
        const id = `${kind}-${n}`;
        const agent = entry.build();
        if (!(agent instanceof Agent)) {
            throw new Error(`[subagents] kind "${kind}": builder must return an Agent instance.`);
        }
        const inst: SubInstance = {
            id,
            kind,
            description: entry.description,
            agent,
            started: false,
            queued: false,
            usedSlot: false,
            handled: new Set(),
        };
        attachWatcher(inst);
        instances.set(id, inst);
        return inst;
    };

    // ---- the four tools ----
    const tools: Record<string, ToolType> = {};
    const kindListText = [...kinds.entries()]
        .map(([id, k]) => `  - ${id}${k.description ? `: ${k.description}` : ""}`)
        .join("\n");

    // -- spawn --
    {
        const baseProps = {
            sub: { type: "string", description: `Which kind of sub-agent. One of:\n${kindListText}` },
            text: { type: "string", description: "The task for this instance." },
            context: {
                type: "integer",
                minimum: 0,
                description: "Include the last N messages of the current conversation as ONE labeled transcript message (background context from a previous conversation — not instructions). Omit for none.",
            },
        } as const;
        let description: string;
        let inputSchema: JsonSchema;
        if (mode === "sync") {
            description = "Spawn a persistent specialist sub-agent and wait for its reply. It stays alive — follow-ups go through the same instance.";
            inputSchema = { type: "object", properties: baseProps, required: ["sub", "text"] };
        } else if (mode === "async") {
            description = "Spawn a persistent specialist sub-agent in the background. Returns its id immediately; collect results with await.";
            inputSchema = { type: "object", properties: baseProps, required: ["sub", "text"] };
        } else {
            description = "Spawn a persistent specialist sub-agent. Blocking by default; background: true for fire-and-forget.";
            inputSchema = {
                type: "object",
                properties: {
                    ...baseProps,
                    background: {
                        type: "boolean",
                        description:
                            "false/omitted: block until this request completes and return the reply. true: fire-and-forget — returns the instance id immediately; collect later via await.",
                    },
                },
                required: ["sub", "text"],
            };
        }
        tools["spawn"] = Tool.define({
            name: names.spawn,
            description,
            executionMode: "sequential",
            inputSchema,
            execute: async (rawParams): Promise<ToolResult> => {
                const p = (rawParams ?? {}) as { sub?: unknown; text?: unknown; background?: unknown; context?: unknown };
                if (typeof p.sub !== "string" || !kinds.has(p.sub)) {
                    return { answer: `spawn: unknown sub kind "${String(p.sub)}". Known: ${[...kinds.keys()].join(", ")}.`, error: true };
                }
                if (typeof p.text !== "string" || p.text.length === 0) {
                    return { answer: `spawn: missing required string parameter "text".`, error: true };
                }
                const wantBackground = mode === "async" ? true : mode === "sync" ? false : p.background === true;
                const contextN = typeof p.context === "number" && p.context > 0 ? Math.floor(p.context) : undefined;
                const inst = spawnInstance(p.sub);

                if (!wantBackground) {
                    startRun(inst, p.text, false, contextN);
                    const outcome = await awaitSettled(inst);
                    if (outcome.ok) {
                        return { answer: outcome.reply || "(empty reply)", stored: { id: inst.id } };
                    }
                    return { answer: `${inst.id}: ${outcome.error}`, error: true, stored: { id: inst.id } };
                }

                if (activeBackground >= concurrency) {
                    inst.queued = true;
                    queue.push({ inst, prompt: p.text, context: contextN });
                    return { answer: `Queued ${inst.id} (concurrency limit reached). It starts automatically as slots free.`, stored: { id: inst.id, queued: true } };
                }
                startRun(inst, p.text, true, contextN);
                return { answer: `Started ${inst.id} in the background. Collect with ${names.await}.`, stored: { id: inst.id, queued: false } };
            },
        });
    }

    // -- await --  (sync mode has no background work, so no await)
    if (mode !== "sync") {
        tools["await"] = Tool.define({
            name: names.await,
            description:
                "Wait for background sub-agents to finish. With id: block until THAT one settles and return its result. Without id: block until ALL running/queued instances settle and return every result.",
            executionMode: "sequential",
            inputSchema: {
                type: "object",
                properties: {
                    id: { type: "string", description: "Optional instance id. Omit = wait for all." },
                },
            },
            execute: async (rawParams): Promise<ToolResult> => {
                const p = (rawParams ?? {}) as { id?: unknown };
                if (p.id !== undefined && typeof p.id !== "string") {
                    return { answer: `${names.await}: "id" must be a string.`, error: true };
                }
                const targets: SubInstance[] =
                    p.id !== undefined
                        ? [instances.get(p.id)].filter((i): i is SubInstance => i !== undefined)
                        : [...instances.values()].filter((i) => i.queued || !TERMINAL_STATES.has(i.agent.loopState));
                if (targets.length === 0) {
                    return {
                        answer: p.id !== undefined
                            ? `${names.await}: unknown instance "${p.id}".`
                            : `${names.await}: nothing is running.`,
                        error: p.id !== undefined,
                        stored: { ids: [...instances.keys()] },
                    };
                }
                const outcomes = await Promise.all(
                    targets.map(async (t) => ({ t, out: await waitForSettled(t) })),
                );
                const lines = outcomes.map(({ t, out }) =>
                    out.ok
                        ? `${t.id}: ${out.reply || "(empty reply)"}`
                        : `${t.id}: ERROR — ${out.error}`,
                );
                const anyError = outcomes.some((o) => !o.out.ok);
                return {
                    answer: lines.join("\n\n"),
                    error: anyError || undefined,
                    stored: { ids: outcomes.map((o) => o.t.id) },
                };
            },
        });
    }

    // -- steer --  (sync mode has no background/continuation work, so no steer)
    const snippet = (a: Agent): string => {
        const last = a.messages.at(-1);
        if (!last) return "(no messages)";
        const c = last.content;
        const text = typeof c === "string" ? c : Array.isArray(c)
            ? c.map((b) => (typeof b === "string" ? b : String((b as { content?: unknown }).content ?? ""))).join("")
            : JSON.stringify(c);
        return text.length > 80 ? `${text.slice(0, 77)}…` : text;
    };

    if (mode !== "sync") {
        const steerProps: NonNullable<JsonSchema["properties"]> = {
            id: { type: "string", description: "Which instance." },
            text: { type: "string", description: "Message to deliver. Never blocks: running → inserted; idle → kickstarts; queued → joins its seed pile." },
            stop: { type: "boolean", description: "Gently freeze after the current step (resumable via another steer)." },
            terminate: { type: "boolean", description: "Kill permanently. There is no resume from this." },
        };
        tools["steer"] = Tool.define({
            name: names.steer,
            description:
                "Send to ONE sub-agent instance. Exactly one intent per call: deliver text (never blocks), stop (gentle freeze + status), or terminate (permanent).",
            executionMode: "sequential",
            inputSchema: { type: "object", properties: steerProps, required: ["id"] },
            execute: async (rawParams): Promise<ToolResult> => {
                const p = (rawParams ?? {}) as { id?: unknown; text?: unknown; stop?: unknown; terminate?: unknown };
                if (typeof p.id !== "string") return { answer: `${names.steer}: missing "id".`, error: true };
                const inst = instances.get(p.id);
                if (!inst) return { answer: `${names.steer}: unknown instance "${p.id}".`, error: true };
                const intents =
                    (typeof p.text === "string" && p.text.length > 0 ? 1 : 0) +
                    (p.stop === true ? 1 : 0) +
                    (p.terminate === true ? 1 : 0);
                if (intents !== 1) {
                    return { answer: `${names.steer}: exactly one intent per call — text XOR stop XOR terminate.`, error: true };
                }
                const a = inst.agent;

                if (p.terminate === true) {
                    await a.terminate();
                    releaseAllProxies(inst);
                    freeSlot(inst);
                    return { answer: `${inst.id} terminated.`, stored: { id: inst.id, action: "terminate" } };
                }
                if (p.stop === true) {
                    if (TERMINAL_STATES.has(a.loopState)) {
                        return { answer: `${inst.id} already ended ("${a.loopState}") — nothing to stop.`, stored: { id: inst.id, action: "stop" } };
                    }
                    a.stop();
                    const graceEnd = Date.now() + 2000;
                    while (!settled(a) && Date.now() < graceEnd) await sleep(10);
                    return {
                        answer: `${inst.id} stopped gently. State: "${a.loopState}". Last: "${snippet(a)}"`,
                        stored: { id: inst.id, action: "stop", loopState: a.loopState },
                    };
                }
                // deliver text
                const text = p.text as string;
                if (TERMINAL_STATES.has(a.loopState)) {
                    return { answer: `${inst.id} ended ("${a.loopState}") — cannot accept messages.`, error: true };
                }
                a.messages.push(userMessage(text));
                const where = !inst.started
                    ? "joined its seed pile (starts with its first run)"
                    : a.loopState === "awaiting"
                        ? "delivered — the instance is parked on a pending matter; it consumes this after that resolves"
                        : landed(a)
                            ? "will kickstart its next turn"
                            : "inserted into the live conversation";
                return { answer: `${inst.id} ← message ${where}.`, stored: { id: inst.id, action: "text" } };
            },
        });
    }

    // -- list --
    {
        tools["list"] = Tool.define({
            name: names.list,
            description:
                "Overview of every sub-agent instance: id · kind · state · last-message snippet. Use after context loss to find who exists and who is doing what.",
            executionMode: "sequential",
            inputSchema: { type: "object", properties: {} },
            execute: async (): Promise<ToolResult> => {
                if (instances.size === 0) return { answer: "No sub-agent instances exist." };
                const lines = [...instances.values()].map((i) =>
                    `[${stateOf(i)}] ${i.id} · ${i.kind} — ${i.description || "(no description)"} · last: "${snippet(i.agent)}"`,
                );
                return { answer: lines.join("\n"), stored: { count: instances.size } };
            },
        });
    }

    // ---- plugin shell ----
    const closeOne = async (id: string): Promise<boolean> => {
        const inst = instances.get(id);
        if (!inst) return false;
        await inst.agent.terminate();
        releaseAllProxies(inst);
        freeSlot(inst);
        return true;
    };
    const closeEverything = async (): Promise<number> => {
        let n = 0;
        for (const inst of instances.values()) {
            if (TERMINAL_STATES.has(inst.agent.loopState)) continue;
            await inst.agent.terminate();
            n++;
        }
        for (const proxyId of [...proxyById.keys()]) releaseProxy(proxyId);
        orchestrated.clear();
        queue.length = 0;
        return n;
    };

    const plugin: SubAgentsManager = {
        id: "subagents",
        install(agent) {
            parent = agent;
            for (const t of Object.values(tools)) agent.addTool(t);
            if (onPending === "escalate") {
                const answerFilterId = "subagents/proxy-answer";
                agent.addFilter({
                    event: EVENTS.inputReceived,
                    id: answerFilterId,
                    priority: 100,
                    fn: async (ag) => {
                        const input = ag.currentInput as { type?: string; id?: string } | undefined;
                        if (input?.type !== ANSWER_TYPE || typeof input.id !== "string") return;
                        const rec = proxyById.get(input.id);
                        if (!rec) return; // not ours — someone else's business
                        const inner = rec.item;
                        const builder =
                            opts.answerBuilders?.[inner.type] ?? BUILT_IN_ANSWER_BUILDERS[inner.type];
                        if (!builder) {
                            console.warn(
                                `[subagents] no answer builder for gate type "${inner.type}" (${input.id}) — proxy kept; provide answerBuilders or answer locally via steer.`,
                            );
                            return;
                        }
                        const translated = builder(inner, input);
                        releaseProxy(input.id);
                        deliver(rec.inst, translated);
                    },
                });
                parentFilters.push({ event: EVENTS.inputReceived, id: answerFilterId });
                const cleanupId = "subagents/proxy-cleanup";
                agent.addFilter({
                    event: EVENTS.beforeAbort,
                    id: cleanupId,
                    priority: 50, // BEFORE native sweeps would matter — proxies are ours alone
                    fn: async () => {
                        for (const proxyId of [...proxyById.keys()]) releaseProxy(proxyId);
                    },
                });
                parentFilters.push({ event: EVENTS.beforeAbort, id: cleanupId });
            }
            agent.addDeclaredCapability({
                id: "subagents",
                description: "persistent sub-agent manager (spawn/await/steer/list)",
            });
        },
        uninstall(agent) {
            for (const t of Object.values(tools)) agent.removeTool(t.name);
            for (const f of parentFilters) agent.removeFilter(f.event, f.id);
            parentFilters.length = 0;
            agent.removeDeclaredCapability("subagents");
            void closeEverything();
            parent = undefined;
        },

        instances() {
            return [...instances.values()].map((i) => ({
                id: i.id,
                kind: i.kind,
                description: i.description,
                state: stateOf(i),
                lastMessage: snippet(i.agent),
            }));
        },
        async close(id: string) {
            return closeOne(id);
        },
        async closeAll() {
            return closeEverything();
        },
        respond(askId: string, input: Input) {
            return respondToAsk(askId, input);
        },
        tools,
    };

    return plugin;
}
