// ============================================================================
// packages/test-kit/nightmare-model.ts — the provider you absolutely hate.
// ============================================================================
// A scripted chaos transport for SimpleModel: drops, disconnects, broken
// streams, garbage tool calls, hostile finish reasons. Deterministic — a QUEUE
// of per-attempt behaviors, no randomness unless you script it. Built for the
// generic stability suite: the loop must survive everything here and still
// land, commit, or die LOUDLY (never hang, never corrupt, never half-commit).
//
// Two doors:
//   new NightmareModel(script)          — a SimpleModel whose transport IS the
//                                         chaos (fetchImpl). Retry loop, stream
//                                         assembly, finish validation all run
//                                         for real. THIS is the stability door.
//   nightmareTransport(script, log?)    — the bare fetchImpl for custom models.
//
// Behaviors are per-ATTEMPT (each retry pops the next): script N nightmares
// then a clean completion and assert the loop rode through. Attempt count,
// request bodies, and abort delivery are all observable for assertions.

import { SimpleModel } from "@sanityloop/core";
import type { SimpleModelOptions } from "@sanityloop/core";

/** One scripted attempt. First match wins; omit a stage to behave there. */
export interface NightmareAttempt {
    /** Fail the fetch itself: "timeout" (never settles until abort), "reset"
     * (TypeError, connection reset), "dns" (TypeError, unresolvable host). */
    transport?: "timeout" | "reset" | "dns";
    /** Answer with an HTTP error instead of a completion. */
    http?: { status: number; body?: string };
    /** Non-stream body corruption (stream:false): "garbage" (not JSON),
     * "empty" ({} — no choices), "no-choice" ({choices:[]}), "null-content"
     * (content:null + no tool calls), "missing-finish" (no finish_reason). */
    body?: "garbage" | "empty" | "no-choice" | "null-content" | "missing-finish";
    /** Stream corruption (stream:true): "cut" (socket dies mid-chunks),
     * "garbage-chunk" (one unparseable SSE line mid-stream, then clean end),
     * "no-done" (chunks then EOF without [DONE]), "done-hang" ([DONE] then the
     * socket STAYS OPEN — reader must still terminate), "empty-stream"
     * (immediate EOF, zero chunks). */
    stream?: "cut" | "garbage-chunk" | "no-done" | "done-hang" | "empty-stream";
    /** Emit tool calls from hell (non-stream, or appended after stream text):
     * "unknown-tool" (name matches nothing), "bad-json" (arguments not JSON),
     * "no-id" (missing call id), "dup-id" (two calls, same id), "empty-name".
     * Combine with finish:"tool_calls". */
    toolCalls?: "unknown-tool" | "bad-json" | "no-id" | "dup-id" | "empty-name";
    /** Override the finish_reason on the final message/chunk. */
    finish?: string;
    /** Clean-attempt text (default "nightmare survived"). */
    text?: string;
    /** Extra latency before this attempt responds (ms). */
    latencyMs?: number;
}

export interface NightmareRequest {
    url: string;
    body: Record<string, unknown>;
    attempt: number;
}

/** A NightmareModel: SimpleModel + scripted chaos transport. */
export class NightmareModel extends SimpleModel {
    /** Attempts consumed so far (== fetch calls made). */
    attempts = 0;
    /** Every request body, in attempt order — assert what the loop sent. */
    requests: NightmareRequest[] = [];
    /** Attempts that observed an abort signal while in flight. */
    abortedAttempts: number[] = [];
    private queue: NightmareAttempt[];

    constructor(script: NightmareAttempt[] = [], opts: Partial<SimpleModelOptions> = {}) {
        super({
            api: "chat_completions",
            modelId: "nightmare-001",
            stream: false,
            // stability runs must be FAST: tiny backoffs unless overridden
            retryDelayMs: 5,
            retryMaxDelayMs: 20,
            ...opts,
        });
        this.queue = [...script];
        const serve: typeof fetch = async (url, init) => this.serve(url, init);
        this.fetchImpl = serve;
    }

    /** Attempts still scripted (0 = clean completions from here on). */
    get remaining(): number {
        return this.queue.length;
    }

    private async serve(url: unknown, init: unknown): Promise<Response> {
        const attempt = ++this.attempts;
        const { signal, body } = init as { signal?: AbortSignal; body?: unknown };
        let parsed: Record<string, unknown> = {};
        try {
            parsed = JSON.parse(String(body ?? "{}")) as Record<string, unknown>;
        } catch { /* chaos bodies stay raw */ }
        this.requests.push({ url: String(url), body: parsed, attempt });
        if (signal?.aborted) {
            this.abortedAttempts.push(attempt);
            throw new DOMException("aborted", "AbortError");
        }
        const step = this.queue.shift() ?? {};
        if (step.latencyMs) await sleep(step.latencyMs, signal, () => this.abortedAttempts.push(attempt));
        if (signal?.aborted) {
            this.abortedAttempts.push(attempt);
            throw new DOMException("aborted", "AbortError");
        }
        // --- transport hell ---
        if (step.transport === "reset") throw new TypeError("fetch failed: connection reset by peer");
        if (step.transport === "dns") throw new TypeError("fetch failed: getaddrinfo ENOTFOUND nightmare.invalid");
        if (step.transport === "timeout") {
            await hangUntilAbort(signal);
            this.abortedAttempts.push(attempt);
            throw new DOMException("aborted", "AbortError");
        }
        // --- http hell ---
        if (step.http) {
            return new Response(step.http.body ?? `{"error":"nightmare ${step.http.status}"}`, {
                status: step.http.status,
                headers: { "Content-Type": "application/json" },
            });
        }
        const stream = parsed.stream === true;
        // --- body hell (non-stream) ---
        if (!stream && step.body) return nightmareBody(step.body, step);
        // --- stream hell ---
        if (stream) return nightmareStream(step, signal, () => this.abortedAttempts.push(attempt));
        // --- the town at the end of the nightmare: a clean completion ---
        return cleanCompletion(step);
    }
}

/** The bare transport for custom models: same queue semantics, your own model. */
export function nightmareTransport(
    script: NightmareAttempt[] = [],
    log?: { requests?: NightmareRequest[]; abortedAttempts?: number[] },
): typeof fetch {
    const inner = new NightmareModel(script, { stream: true });
    if (log?.requests) inner.requests = log.requests;
    if (log?.abortedAttempts) inner.abortedAttempts = log.abortedAttempts;
    return inner.fetchImpl!;
}

// ---------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------

function nightmareBody(kind: NonNullable<NightmareAttempt["body"]>, step: NightmareAttempt): Response {
    const json = (v: unknown): Response =>
        new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
    switch (kind) {
        case "garbage":
            return new Response("{{{{ not json at all", { status: 200 });
        case "empty":
            return json({});
        case "no-choice":
            return json({ choices: [] });
        case "null-content":
            return json({ choices: [{ message: { content: null }, finish_reason: step.finish ?? "stop" }] });
        case "missing-finish":
            return json({ choices: [{ message: { content: step.text ?? "no finish, still text" } }] });
    }
}

function toolCallPayload(kind: NonNullable<NightmareAttempt["toolCalls"]>): unknown[] {
    switch (kind) {
        case "unknown-tool":
            return [{ id: "call-ghost", type: "function", function: { name: "definitely_not_a_tool", arguments: "{}" } }];
        case "bad-json":
            return [{ id: "call-bad", type: "function", function: { name: "echo", arguments: "{oops" } }];
        case "no-id":
            return [{ type: "function", function: { name: "echo", arguments: "{}" } }];
        case "dup-id":
            return [
                { id: "call-dup", type: "function", function: { name: "echo", arguments: "{}" } },
                { id: "call-dup", type: "function", function: { name: "echo", arguments: "{}" } },
            ];
        case "empty-name":
            return [{ id: "call-noname", type: "function", function: { name: "", arguments: "{}" } }];
    }
}

function cleanCompletion(step: NightmareAttempt): Response {
    const toolCalls = step.toolCalls ? toolCallPayload(step.toolCalls) : undefined;
    return new Response(
        JSON.stringify({
            choices: [{
                message: {
                    content: toolCalls ? "" : (step.text ?? "nightmare survived"),
                    ...(toolCalls ? { tool_calls: toolCalls } : {}),
                },
                finish_reason: step.finish ?? (toolCalls ? "tool_calls" : "stop"),
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
    );
}

function sse(lines: string[]): string {
    return lines.map((l) => `data: ${l}\n\n`).join("");
}

function nightmareStream(step: NightmareAttempt, signal: AbortSignal | undefined, onAbort: () => void): Response {
    const text = step.text ?? "streamed survival";
    const finish = step.finish ?? "stop";
    const head = sse([
        JSON.stringify({ choices: [{ delta: { content: text.slice(0, Math.ceil(text.length / 2)) } }] }),
    ]);
    const tail = (fr: string): string =>
        sse([
            JSON.stringify({ choices: [{ delta: { content: text.slice(Math.ceil(text.length / 2)) } }] }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: fr }] }),
        ]) + "data: [DONE]\n\n";
    const kind = step.stream;
    let payload: string;
    let hangAfterDone = false;
    let cutAfterHead = false;
    switch (kind) {
        case "cut":
            // head chunk, then the socket DIES: reader.read() rejects with a
            // TypeError — the retryable mid-stream death (a clean EOF would
            // just assemble partial text, no retry)
            payload = head;
            cutAfterHead = true;
            break;
        case "garbage-chunk":
            payload = head + "data: {{{nope\n\n" + tail(finish);
            break;
        case "no-done":
            payload = head + sse([JSON.stringify({ choices: [{ delta: { content: "tail" }, finish_reason: finish }] })]);
            break;
        case "done-hang":
            payload = head + tail(finish);
            hangAfterDone = true;
            break;
        case "empty-stream":
            payload = "";
            break;
        default:
            payload = head + tail(finish);
            break;
    }
    const bytes = new TextEncoder().encode(payload);
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            // chunked delivery: split mid-chunk to exercise the line buffer
            const mid = Math.max(1, Math.floor(bytes.length / 3));
            controller.enqueue(bytes.slice(0, mid));
            const rest = (): void => {
                if (signal?.aborted) {
                    onAbort();
                    controller.error(new DOMException("aborted", "AbortError"));
                    return;
                }
                if (cutAfterHead) {
                    controller.error(new TypeError("fetch failed: socket hang up mid-stream"));
                    return;
                }
                controller.enqueue(bytes.slice(mid));
                if (hangAfterDone) {
                    // close after a beat so reads END (a real hang would need
                    // the abort path — covered by transport:timeout).
                    const t = setTimeout(() => controller.close(), 10);
                    signal?.addEventListener("abort", () => {
                        clearTimeout(t);
                        onAbort();
                        controller.error(new DOMException("aborted", "AbortError"));
                    }, { once: true });
                    return;
                }
                controller.close();
            };
            // async second half: abort can land between chunks
            setTimeout(rest, 0);
        },
        cancel() {
            onAbort();
        },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

// ---------------------------------------------------------------------------
// async helpers (abort-aware, no dangling timers)
// ---------------------------------------------------------------------------

function sleep(ms: number, signal: AbortSignal | undefined, onAbort: () => void): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", fire);
            resolve();
        }, ms);
        const fire = (): void => {
            clearTimeout(timer);
            onAbort();
            resolve();
        };
        if (signal?.aborted) fire();
        else signal?.addEventListener("abort", fire, { once: true });
    });
}

function hangUntilAbort(signal: AbortSignal | undefined): Promise<void> {
    if (!signal) return new Promise(() => {}); // no signal = hangs forever (caller's problem)
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
