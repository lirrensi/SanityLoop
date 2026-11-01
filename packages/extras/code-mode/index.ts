// ============================================================================
// packages/extras/code-mode/index.ts — the code-mode plugin.
// ============================================================================
// One tool (`code`) + retained py/js kernels + per-cell stubs from the live
// registry. OMP chassis, SanityLoop seams:
//
//   tool    code({ language: "py"|"js", code, timeout?, reset? })
//           executionMode "sequential" — one kernel = one stdin; parallel
//           evals would race the same heap.
//   kernel  subprocess per session+cwd+language, NDJSON control (fd 0),
//           frames (fd 1), returns (fd 3). No timers in the runner.
//   bridge  every guest call re-enters beforeTool → schema → execute →
//           toolEnd (call-tool.ts). Budget 50, recursion block.
//   clock   budget (pausable on every bridge RPC) + absolute ceiling.
//   output  50 KiB head+tail, spill to tmpdir, path in `stored`.
//   state   pure memory default; persistDir opts into a py dill sidecar.
//           Kernel heap is NEVER taped — crash-resume = kernel gone.
//
// %magics: standalone %cells are rejected host-side with actionable text
// (v1 installs nothing, loads nothing). % inside a multi-line cell is a
// kernel syntax error, not magic.
//
// No core edits. The missing agent.callTool() seam is PROPOSED, not
// implemented — call-tool.ts is its plugin-local body.
// ============================================================================

import { Tool, type GodObject, type JsonSchema, type Plugin, type ToolResult, type ToolType } from "@sanityloop/core";
import { buildCatalog } from "./catalog.ts";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, resolveCellTimeoutMs } from "./clock.ts";
import { CODE_MODE_BUDGET } from "./stubs.ts";
import { KernelRegistry, TRANSIENT_KEY, type CodeModeOptions } from "./registry.ts";

export type { CodeModeOptions, CellOutcome, CellStatus, KernelSnapshot, RestartReason } from "./registry.ts";
export type { CodeLanguage } from "./protocol.ts";

const MAGIC_RE = /^%([A-Za-z]+)(?:[ \t]+([\s\S]*))?$/;

function magicRejection(cell: string): ToolResult | undefined {
    const trimmed = cell.trim();
    if (!trimmed.startsWith("%")) return undefined;
    if (trimmed.includes("\n")) return undefined; // multi-line: kernel syntax error, not magic
    const m = MAGIC_RE.exec(trimmed);
    const name = m?.[1] ?? "?";
    if (name === "bun") {
        return { answer: "[code-mode] %bun is a package-install magic. v1 installs nothing: use the bash tool for dependency changes (npm i / bun add).", error: true, errorMessage: "magic_rejected" };
    }
    if (name === "pip") {
        return { answer: "[code-mode] %pip is not available: cells cannot install packages. Use the bash tool.", error: true, errorMessage: "magic_rejected" };
    }
    if (name === "load") {
        return { answer: "[code-mode] %load is not available in v1: pass the code directly.", error: true, errorMessage: "magic_rejected" };
    }
    if (name === "environment") {
        return { answer: "[code-mode] %environment is not available in v1.", error: true, errorMessage: "magic_rejected" };
    }
    return { answer: `[code-mode] unknown magic "%${name}" — percent commands are not part of v1.`, error: true, errorMessage: "magic_rejected" };
}

const inputSchema: JsonSchema = {
    type: "object",
    properties: {
        language: { type: "string", enum: ["py", "js"], description: 'Kernel language. "js" cells also accept TS (annotation-stripping only: no enum/namespace/parameter-properties).' },
        code: { type: "string", minLength: 1, description: "The cell source. Top-level await works; the trailing expression is echoed. Variables, imports and definitions persist across cells until reset/timeout/crash." },
        timeout: { type: "number", minimum: 1, maximum: 3600, description: "Cell budget in seconds (default 60, clamp 1–3600). Counts ONLY the cell's own work — tool calls, gate waits and sub-agent waits pause the clock. The absolute ceiling always applies." },
        reset: { type: "boolean", description: "Kill the kernel and start fresh before running this cell. All prior state is gone." },
    },
    required: ["language", "code"],
};

export interface CodePluginView {
    kernels(): Array<{ key: string; interp: string; generation: number; busy: boolean; cellsRun: number }>;
}

/** Build the code tool bound to one registry. Exported for tests. */
export function createCodeTool(registry: KernelRegistry, opts: CodeModeOptions = {}): ToolType {
    void opts;
    return Tool.define({
        name: "code",
        description:
            "Execute Python/JS code in a persistent per-session kernel. One cell per call; top-level state persists across cells. " +
            "Call tools from code: Python `await tools.read(path=\"…\")`, JS/TS `await tools.read({ path: \"…\" })`. " +
            `Every call returns { answer, error? }; at most ${CODE_MODE_BUDGET} calls per cell. ` +
            "A cell's last expression is echoed (sync cells). A cell that uses top-level `await` runs in an async wrapper — echo a value there with `return expr;`, and note its top-level `const`/`let` are local to that cell; assign without declaring (`rows = await ...`) to keep them. " +
            "Cell timeout counts only the cell's own work — sub-agent waits pause it. " +
            "On error, retry only the failed step; earlier steps may have taken effect. Kernel-loss notice means reload setup.",
        promptSnippet: "Run Python/JS code in a persistent kernel; call tools from code",
        promptGuidelines: [
            "one cell per code call; state persists across cells until reset/timeout/crash",
            "call tools as await tools.<name>(...) — never shell out to reimplement a tool",
            "on InvalidToolInput, fix the call shape; do not retry the same shape twice",
            "a kernel-restarted notice means all prior variables are gone — redefine them",
        ],
        executionMode: "sequential",
        inputSchema,
        execute: async (rawParams, agent): Promise<ToolResult> => {
            const params = (rawParams ?? {}) as { language?: unknown; code?: unknown; timeout?: unknown; reset?: unknown };
            if (params.language !== "py" && params.language !== "js") {
                return { answer: `code: invalid language '${String(params.language)}' — must be "py" or "js".`, error: true, errorMessage: "invalid_language" };
            }
            if (typeof params.code !== "string" || params.code.length === 0) {
                return { answer: "code: missing required string parameter \"code\".", error: true, errorMessage: "missing_code" };
            }
            // %magic gate (host-side, before any kernel work).
            const magic = magicRejection(params.code);
            if (magic) return magic;

            const resolved = resolveCellTimeoutMs(params.timeout);
            if (typeof resolved === "object") {
                return { answer: resolved.error, error: true, errorMessage: "invalid_timeout" };
            }
            let clampedNotice = "";
            if (typeof params.timeout === "number" && Number.isFinite(params.timeout)) {
                const wantMs = Math.round(params.timeout * 1000);
                if (wantMs < MIN_TIMEOUT_MS) clampedNotice = `[code-mode] timeout clamped from ${params.timeout}s to 1s.\n`;
                else if (wantMs > MAX_TIMEOUT_MS) clampedNotice = `[code-mode] timeout clamped from ${params.timeout}s to 3600s.\n`;
            }

            if (params.reset === true) {
                await registry.reset(agent, params.language, "reset");
            }
            const outcome = await registry.runCell(agent, {
                language: params.language,
                code: params.code,
                timeoutMs: resolved,
            });
            const answer = clampedNotice.length > 0 ? `${clampedNotice}${outcome.answer}` : outcome.answer;
            return {
                answer,
                error: outcome.status === "ok" ? undefined : true,
                errorMessage: outcome.status === "ok" ? undefined : outcome.status,
                stored: {
                    language: outcome.language,
                    status: outcome.status,
                    generation: outcome.generation,
                    kernelRestarted: outcome.kernelRestarted,
                    ...(outcome.restartReason !== undefined ? { restartReason: outcome.restartReason } : {}),
                    durationMs: outcome.durationMs,
                    pausedMs: outcome.pausedMs,
                    calls: outcome.calls,
                    truncated: outcome.truncated,
                    ...(outcome.fullOutputPath !== undefined ? { fullOutputPath: outcome.fullOutputPath } : {}),
                },
            };
        },
    });
}

/** Build the catalog system-prompt block from the live registry. The host
 * splices it like tool-prompt: after install, push it into messages; the
 * block is rebuilt per cell from the same snapshot as the stubs. */
export function buildCodeModePromptPart(agent: GodObject, opts: CodeModeOptions = {}): { id: string; enabled: boolean; type: "system"; content: Array<{ type: "text"; content: string }> } {
    const catalog = buildCatalog(
        agent.visibleTools().filter((t) => t.name !== "code"),
        { pinned: opts.pinned },
    );
    const text = [
        "## Code mode",
        "",
        "You write code in a `code` cell; the code calls tools. Each cell runs in a persistent kernel: Python `await tools.read(path=\"…\")`, JS/TS `await tools.read({ path: \"…\" })`.",
        "",
        "Every call returns `{ answer, error? }`. Omitted optional arguments are omitted (Python: leave the default; TS: pass `undefined`).",
        "",
        catalog.text,
        "",
        "Invalid arguments raise InvalidToolInput with the host's exact errors and the expected signature. Fix the call; do not retry the same shape twice.",
    ].join("\n");
    return {
        id: "code-mode-prompt",
        enabled: true,
        type: "system",
        content: [{ type: "text", content: text }],
    };
}

export function createCodeMode(options: CodeModeOptions = {}): Plugin & { view: CodePluginView } {
    let registry: KernelRegistry | null = null;
    let abortListener: (() => void) | null = null;

    const view: CodePluginView = {
        kernels: () => registry?.snapshots().map((s) => ({ key: s.key, interp: s.interp, generation: s.generation, busy: s.busy, cellsRun: s.cellsRun })) ?? [],
    };

    return {
        id: "code-mode",
        view,
        install(agent) {
            registry = new KernelRegistry(options);
            agent.transient[TRANSIENT_KEY] = registry;
            abortListener = () => void registry?.disposeAll("abort");
            agent.abortSignal.addEventListener("abort", abortListener);
            agent.addTool(createCodeTool(registry, options));
            agent.addDeclaredCapability({ id: "code", description: `persistent Python/JS kernels, ${CODE_MODE_BUDGET} tool calls per cell` });
        },
        uninstall(agent) {
            if (abortListener) agent.abortSignal.removeEventListener("abort", abortListener);
            abortListener = null;
            void registry?.disposeAll("abort");
            registry = null;
            delete agent.transient[TRANSIENT_KEY];
            agent.removeTool("code");
            agent.removeDeclaredCapability("code");
        },
    };
}

export { buildCatalog, searchCatalog } from "./catalog.ts";
export { buildStubs, CODE_MODE_BUDGET as CELL_BUDGET } from "./stubs.ts";
export { createToolCaller } from "./call-tool.ts";
export { DEFAULT_TIMEOUT_MS };
