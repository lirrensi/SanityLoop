// ============================================================================
// sanity/src/extras/todo/index.ts — model-managed todo list (pi's flavor, state{} storage)
// ============================================================================
// Pi's todo EXTENSION (coding-agent/examples/extensions/todo.ts) re-homed into
// the Sanity convention: the list lives in `state.todos`, not the transcript.
//
//   - ONE tool, INCREMENTAL actions (pi, not opencode's full-list rewrite):
//       todo { action: "list" | "add" | "toggle" | "clear", text?, id? }
//   - Todo = { id, text, done } — ids monotonic, reset on clear (max+1 derivation,
//     so the counter needs no second state key; ids never collide because only
//     `clear` removes items).
//   - The model's in-context view = each action's call + result (the `list`
//     action shows the full list on demand — the model asks when it needs it).
//   - `state.todos` is the DURABLE truth: the patched observer fires on every
//     write (a UI renders it reactively), storage persists it with the session,
//     and it SURVIVES compaction — unlike opencode, where the list rides the
//     conversation and a compact can eat it.
//
// Answer text mirrors pi: "Added todo #1: fix types", "[x] #1: fix types",
// "Cleared 2 todos", errors as result-text (never throws).
// ============================================================================
import type { GodObject, Plugin, ToolResult } from "@sanityloop/core";

export interface TodoItem {
    id: number;
    text: string;
    done: boolean;
}

export type TodoAction = "list" | "add" | "toggle" | "clear";

export interface TodoParams {
    action: TodoAction;
    /** Required for add. */
    text?: string;
    /** Required for toggle. */
    id?: number;
}

/** The state key this plugin owns. */
export const TODO_STATE_KEY = "todos";

/** Current list + the next id, derived (max+1 — ids only vanish on clear). */
function readTodos(state: Record<string, unknown>): TodoItem[] {
    const raw = state[TODO_STATE_KEY];
    return Array.isArray(raw) ? (raw as TodoItem[]) : [];
}
function nextId(todos: TodoItem[]): number {
    return todos.reduce((m, t) => Math.max(m, t.id), 0) + 1;
}
function listText(todos: TodoItem[]): string {
    return todos.length
        ? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
        : "No todos";
}

/** The tool — reads/writes state.todos, pi's answer texts. */
function runTodo(
    action: TodoAction,
    params: TodoParams,
    agent: GodObject,
): ToolResult {
    const todos = readTodos(agent.state);
    switch (action) {
        case "list":
            return { answer: listText(todos), stored: { action, todos: [...todos] } };
        case "add": {
            if (!params.text) {
                return {
                    answer: "Error: text required for add",
                    stored: { action, todos: [...todos], error: "text required" },
                };
            }
            const item: TodoItem = {
                id: nextId(todos),
                text: params.text,
                done: false,
            };
            agent.state[TODO_STATE_KEY] = [...todos, item];
            return {
                answer: `Added todo #${item.id}: ${item.text}`,
                stored: { action, todos: [...todos, item] },
            };
        }
        case "toggle": {
            if (params.id === undefined) {
                return {
                    answer: "Error: id required for toggle",
                    stored: { action, todos: [...todos], error: "id required" },
                };
            }
            const target = todos.find((t) => t.id === params.id);
            if (!target) {
                return {
                    answer: `Todo #${params.id} not found`,
                    stored: {
                        action,
                        todos: [...todos],
                        error: `#${params.id} not found`,
                    },
                };
            }
            const next = todos.map((t) =>
                t.id === params.id ? { ...t, done: !t.done } : t,
            );
            agent.state[TODO_STATE_KEY] = next;
            const now = next.find((t) => t.id === params.id)!;
            return {
                answer: `Todo #${now.id} ${now.done ? "completed" : "uncompleted"}`,
                stored: { action, todos: next },
            };
        }
        case "clear": {
            const count = todos.length;
            agent.state[TODO_STATE_KEY] = [];
            return {
                answer: `Cleared ${count} todos`,
                stored: { action, todos: [] },
            };
        }
        default:
            return {
                answer: `Unknown action: ${action}`,
                stored: {
                    action: "list",
                    todos: [...todos],
                    error: `unknown action: ${action}`,
                },
            };
    }
}

/** The todo plugin — one tool, incremental actions, state.todos storage. */
export function createTodoTool(): Plugin {
    return {
        id: "todo",
        install(agent) {
            agent.addTool({
                name: "simple-todo",
                description:
                    `Manage a todo list for the current session (tracked in session state, survives compaction). ` +
                    `Actions: list (show all), add (text: the task), toggle (id: flip done), clear (remove all). ` +
                    `Use for multi-step work — add items as you discover them, toggle done as each finishes. ` +
                    `Call list to refresh the current state before updating.`,
                inputSchema: {
                    type: "object",
                    properties: {
                        action: {
                            type: "string",
                            enum: ["list", "add", "toggle", "clear"],
                            description: "What to do.",
                        },
                        text: {
                            type: "string",
                            description: "Task text (required for add).",
                        },
                        id: {
                            type: "number",
                            description: "Todo id (required for toggle).",
                        },
                    },
                    required: ["action"],
                },
                execute(
                    params: unknown,
                    ctx: GodObject,
                ): Promise<ToolResult> | ToolResult {
                    const p = (params ?? {}) as TodoParams;
                    return runTodo(p.action, p, ctx);
                },
            });
            agent.addDeclaredCapability({
                id: "simple-todo",
                description: "model-managed todo list (state.todos, pi-flavored actions)",
            });
        },
        uninstall(agent) {
            agent.removeTool("todo");
            agent.removeDeclaredCapability("simple-todo");
            delete agent.state[TODO_STATE_KEY];
        },
    };
}
