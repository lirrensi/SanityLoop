// ============================================================================
// sanity/src/extras/question/index.ts — ask the user anything (awaiting/park)
// ============================================================================
// The SECOND face of the awaiting primitive (permission asks allow/deny; this
// asks ANYTHING). The model calls the `question` tool with N bundled questions;
// a beforeTool gate parks the batch (pendingAwait), the loop lands in `awaiting`
// and fires stop — a channel (terminal by default, or your own `ask` callback)
// renders the questions, the human answers, and an input resolves the park.
// The call is PRE-RESOLVED (executeOne's preResolved path) — the tool itself
// never runs; the answer text lands as the toolResult, the same turn continues.
//
// The full loop: model calls question → gate parks (beforeTool, blocks:true) →
// stop(awaiting) → ask() renders + reads → agent.input({type:"question-answer",
// ref, answers}) → resolver pops the await + preResolves the call → the loop
// resumes the SAME turn at the toolExec boundary → toolResult committed → the
// model sees "User has answered your questions: …" and continues.
//
// Borrowed from opencode (tool/question.ts + question/schema.ts):
//   - questions bundle: { question, header?, options:[{label,description}], multiple?, custom? }
//   - answers: string[][] (selected labels per question, in order)
//   - result text: `User has answered your questions: "q"="a". You can now continue...`
// Channels override `ask` (TUI/API/REST) — default is a terminal form.
// ============================================================================
import { createInterface } from "node:readline";
import { EVENTS } from "@sanityloop/core";
import type { ToolCallRecord } from "@sanityloop/core";
import type { GodObject, Plugin } from "@sanityloop/core";
import { removeFiltersByPrefix } from "@sanityloop/util";

/** One option in a question. */
export interface QuestionOption {
    /** Display text (1-5 words, concise). */
    label: string;
    /** Explanation of the choice. */
    description?: string;
}

/** One question — opencode-shaped. */
export interface QuestionPrompt {
    /** The complete question. */
    question: string;
    /** Very short label (max 30 chars). */
    header?: string;
    /** Available choices. */
    options?: QuestionOption[];
    /** Allow selecting multiple options. */
    multiple?: boolean;
    /** Allow a typed custom answer (default true). */
    custom?: boolean;
}

export interface QuestionToolOptions {
    /** Tool name (default "question"). */
    name?: string;
    /**
     * The UI adapter — HOW to ask the human. Omit = NO rendering at all: the
     * loop parks awaiting (pure state) and the answer must arrive via
     * agent.input({ type: "question-answer", ref, answers }) from whatever
     * channel exists (TUI, REST, supervisor, another agent). The mechanism
     * and the renderer are separate — this callback is just one optional
     * answerer. Receives the pending questions (bundled), must resolve with
     * answers in order: string[][] — one string[] per question (selected
     * labels, or the typed custom text).
     */
    ask?: (agent: GodObject, questions: QuestionPrompt[]) => Promise<string[][]>;
}

/** The pending await schema this plugin parks with. `type` = "ask-question/question"; this is the answer shape. */
export interface QuestionAwaitSchema {
    tool: string;
    questions: QuestionPrompt[];
}

function formatAnswers(
    questions: QuestionPrompt[],
    answers: string[][],
): string {
    const parts = questions.map((q, i) => {
        const a = answers[i] ?? [];
        return `"${q.question}"=${a.length ? a.join(", ") : "Unanswered"}`;
    });
    return `User has answered your questions: ${parts.join(", ")}. You can now continue with the user's answers in mind.`;
}

/** The terminal form — an explicit adapter: createQuestionTool({ ask: terminalAsk }). */
export async function terminalAsk(
    _agent: GodObject,
    questions: QuestionPrompt[],
): Promise<string[][]> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const letters = "abcdefghijklmnopqrstuvwxyz";
    const answers: string[][] = [];
    const askOne = (q: QuestionPrompt): Promise<string[]> =>
        new Promise((resolve) => {
            const head = q.header ? `[${q.header}] ` : "";
            process.stdout.write(`\n? ${head}${q.question}\n`);
            if (q.options && q.options.length > 0) {
                q.options.forEach((o, i) => {
                    process.stdout.write(
                        `   ${letters[i]}) ${o.label}${o.description ? ` — ${o.description}` : ""}\n`,
                    );
                });
                const hint = q.multiple ? "letters, comma-separated (a,c)" : "letter";
                rl.question(
                    `   answer (${hint}${q.custom === false ? "" : ", or type your own"}): `,
                    (line) => {
                        const picked = line
                            .split(/[\s,]+/)
                            .filter(Boolean)
                            .map((p) => {
                                const li = letters.indexOf(p.toLowerCase());
                                return li >= 0 && q.options![li] ? q.options![li].label : p;
                            });
                        resolve(q.multiple ? picked : picked.slice(0, 1));
                    },
                );
            } else {
                rl.question(`? ${head}${q.question} `, (line) =>
                    resolve(line.trim() ? [line.trim()] : []),
                );
            }
        });
    for (const q of questions) answers.push(await askOne(q));
    rl.close();
    return answers;
}

/** The question plugin — gate (park) + ask (stop) + resolver (input) + cleanup. */
export function createQuestionTool(opts: QuestionToolOptions = {}): Plugin {
    const toolName = opts.name ?? "question";
    // NO default ask — omit it and the loop parks awaiting renderer-free; the answer
    // must arrive via agent.input({ type: "question-answer", ref, answers }) from
    // whatever channel exists. Wire an adapter (e.g. terminalAsk) to auto-prompt.
    const ask = opts.ask;
    let askInFlight = false;

    return {
        id: "ask-question",
        install(agent) {
            // the tool — normally NEVER executes: the gate pre-resolves every call
            agent.addTool({
                name: toolName,
                description:
                    `Ask the user one or more questions. Use this for clarification, confirmation, or decisions ` +
                    `before continuing. The user is prompted, the loop parks until they answer, and their answers ` +
                    `are returned. Bundle multiple questions into ONE call. Options render as a,b,c choices.`,
                inputSchema: {
                    type: "object",
                    properties: {
                        questions: {
                            type: "array",
                            description: "Questions to ask, in order.",
                            items: {
                                type: "object",
                                properties: {
                                    question: {
                                        type: "string",
                                        description: "The complete question.",
                                    },
                                    header: {
                                        type: "string",
                                        description: "Very short label (max 30 chars).",
                                    },
                                    options: {
                                        type: "array",
                                        description: "Available choices (a, b, c…).",
                                        items: {
                                            type: "object",
                                            properties: {
                                                label: {
                                                    type: "string",
                                                    description: "Display text (1-5 words).",
                                                },
                                                description: {
                                                    type: "string",
                                                    description: "Explanation of the choice.",
                                                },
                                            },
                                        },
                                    },
                                    multiple: {
                                        type: "boolean",
                                        description: "Allow selecting multiple options.",
                                    },
                                    custom: {
                                        type: "boolean",
                                        description: "Allow a typed custom answer (default true).",
                                    },
                                },
                            },
                        },
                    },
                    required: ["questions"],
                },
                async execute() {
                    // the gate pre-resolves every call — this only runs if the plugin's
                    // gate is absent (taking the tool alone), so say so, error-as-result
                    return {
                        answer:
                            `[question] the ${toolName} tool requires the question plugin's gate to ask the user. ` +
                            `Install createQuestionTool() — the tool itself never executes.`,
                        error: true,
                        errorMessage: "question plugin gate not installed",
                    };
                },
            });

            // ---- GATE (beforeTool, blocks:true): park every question call ----
            agent.addFilter({
                event: EVENTS.beforeTool,
                id: "question/gate",
                priority: 100,
                fn: async (agent) => {
                    const stored = (
                        agent.currentTurn?.content as { stored?: ToolCallRecord[] } | undefined
                    )?.stored;
                    if (!stored) return;
                    for (const call of stored) {
                        if (call.name !== toolName) continue;
                        if (call.preResolved) continue;
                        if (agent.pendingAwaits.some((a) => a.id === call.id)) continue; // already parked
                        const questions =
                            (call.parameters.questions as QuestionPrompt[]) ?? [];
                        const schema: QuestionAwaitSchema = {
                            tool: toolName,
                            questions,
                        };
                        agent.pendingAwaits.push({ type: "ask-question/question", id: call.id, schema }); // park = push (the loop checks at blocks boundaries)
                    }
                },
            });

            // ---- ASK (stop): IF an adapter is wired, render + collect answers on park ----
            if (ask) {
                agent.addFilter({
                    event: EVENTS.stop,
                    id: "question/ask",
                    priority: 50,
                    fn: async (agent) => {
                        if (agent.loopState !== "awaiting") return;
                        const qAwaits = agent.pendingAwaits.filter(
                            (a) => a.type === "ask-question/question",
                        );
                        if (qAwaits.length === 0 || askInFlight) return;
                        askInFlight = true;
                        void (async () => {
                            try {
                                const questions = qAwaits.flatMap(
                                    (a) => (a.schema as QuestionAwaitSchema).questions,
                                );
                                let answers: string[][];
                                try {
                                    answers = await ask(agent, questions);
                                } catch {
                                    answers = questions.map(() => []); // ask failed → "Unanswered", never hang
                                }
                                // distribute back per await (each await may carry N questions)
                                let idx = 0;
                                for (const a of qAwaits) {
                                    const n = (a.schema as QuestionAwaitSchema).questions.length;
                                    const slice = answers.slice(idx, idx + n);
                                    idx += n;
                                    agent.input({
                                        type: "question-answer",
                                        ref: a.id,
                                        answers: slice,
                                    });
                                }
                            } finally {
                                askInFlight = false;
                            }
                        })();
                    },
                });
            }

            // ---- RESOLVER (inputReceived): match question-answer inputs → pop + preResolve ----
            agent.addFilter({
                event: EVENTS.inputReceived,
                id: "question/answer",
                priority: 100,
                fn: async (agent) => {
                    const input = agent.currentInput as
                        | { type?: string; ref?: string; answers?: string[][] }
                        | undefined;
                    if (
                        input?.type !== "question-answer" ||
                        typeof input.ref !== "string"
                    )
                        return;
                    const idx = agent.pendingAwaits.findIndex((a) => a.id === input.ref);
                    if (idx < 0) return; // unknown/unparked ref — someone else's business
                    // capture the questions BEFORE popping — the schema lives on the await
                    const schema = agent.pendingAwaits[idx].schema as QuestionAwaitSchema;
                    agent.pendingAwaits.splice(idx, 1);
                    const qs = schema?.questions ?? [];
                    // preResolve the call so the batch commits the answer without executing
                    for (const msg of agent.messages) {
                        const stored = (
                            msg.content as { stored?: ToolCallRecord[] } | undefined
                        )?.stored;
                        if (!stored) continue;
                        const call = stored.find((c) => c.id === input.ref);
                        if (call) {
                            call.preResolved = {
                                answer: formatAnswers(qs, input.answers ?? []),
                                stored: { answers: input.answers ?? [] },
                            };
                        }
                    }
                },
            });

            // ---- CLEANUP (beforeAbort): drop parked question awaits — no hang on the next run ----
            agent.addFilter({
                event: EVENTS.beforeAbort,
                id: "question/cleanup",
                priority: 100,
                fn: async (agent) => {
                    const kept = agent.pendingAwaits.filter(
                        (a) => a.type !== "ask-question/question",
                    );
                    agent.pendingAwaits.splice(0, agent.pendingAwaits.length, ...kept);
                },
            });

            agent.addDeclaredCapability({
                id: "ask-question",
                description: "ask the user anything (awaiting/park/resume)",
            });
        },
        uninstall(agent) {
            agent.removeTool(toolName);
            removeFiltersByPrefix(agent, "question/");
            agent.removeDeclaredCapability("ask-question");
        },
    };
}
