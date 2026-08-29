// ============================================================================
// test/e2e/fixtures/mcp-agent-driver.ts — the MCP vertical slice, FOR REAL.
// ============================================================================
// A production-shaped single-file agent (the SDK pattern) whose tools come
// from REAL MCP servers — both transports:
//
//   good — test/e2e/fixtures/mcp-fixture-server.ts   (stdio child, official SDK v2)
//   dead — a binary that does not exist               (spawn ENOENT → degraded status)
//   http — test/e2e/fixtures/mcp-fixture-http-server.ts (real streamable-HTTP server)
//
// The stub model scripts six model turns; every one goes through the real
// loop, the real adapter conversion, and the real JSON-RPC wire:
//
//   1. good_add(19, 23)         → "…is 42"  (real computation over the wire)
//   2. good_fail_now("because") → isError → error-as-TEXT answer, loop unblocked
//   3. good_install_extra()     → server fires tools/list_changed MID-RUN
//   4. good_bonus_time()        → the dynamically added tool is actually callable
//   5. http_mul(6, 7)           → "…is 42" over REMOTE streamable HTTP
//   6. assistant final          → clean stop
//
// Prints a greppable story for the e2e test to assert on, self-checks that
// the whole story actually happened, exits non-zero if it didn't.

import { Agent, SimpleModel, EVENTS } from "@sanityloop/core";
import type { GodObject, ToolResult } from "@sanityloop/core";
import { createDefaultInputs } from "@sanityloop/inputs";
import { createMcp } from "@sanityloop/mcp";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// ---- boot the remote HTTP fixture as its own process, learn its port ----
const httpFixture = spawn(
    process.execPath,
    [
        "--experimental-strip-types",
        "--experimental-transform-types",
        join(here, "mcp-fixture-http-server.ts"),
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
);
const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
        () => reject(new Error("http fixture never printed PORT")),
        10_000,
    );
    createInterface({ input: httpFixture.stdout! }).on("line", (line) => {
        const m = /^PORT=(\d+)$/.exec(line.trim());
        if (m) {
            clearTimeout(timer);
            resolve(Number(m[1]));
        }
    });
    httpFixture.on("exit", (code) =>
        reject(new Error(`http fixture died early (code ${code})`)),
    );
});

// ---- our own story tape: printed AND checked before exit ----
const story: string[] = [];
function log(line: string): void {
    story.push(line);
    console.log(line);
}

// ---- lifecycle steps 1+2: declare + connect (the ONLY await) ----
const mcp = createMcp({
    good: {
        command: [
            process.execPath,
            "--experimental-strip-types",
            "--experimental-transform-types",
            join(here, "mcp-fixture-server.ts"),
        ],
    },
    // a server that cannot even spawn — init must degrade, never throw
    dead: { command: ["definitely-not-a-real-binary-xyz"], timeout: 5000 },
    // REMOTE: a real streamable-HTTP MCP server over real HTTP
    http: { url: `http://127.0.0.1:${port}/mcp` },
});
await mcp.init(15_000);
for (const [k, v] of Object.entries(mcp.status))
    log(`[mcp:status] ${k}=${JSON.stringify(v)}`);

// ---- the agent ----
const model = new SimpleModel({
    api: "chat_completions",
    modelId: "stub",
    stream: false,
    maxContext: 128_000,
});

let turn = 0;
model.callNextTurn = async (agent) => {
    turn++;
    if (turn === 1) return toolCall("good_add", { a: 19, b: 23 });
    if (turn === 2)
        return toolCall("good_fail_now", { reason: "because-i-said-so" });
    if (turn === 3) return toolCall("good_install_extra", {});
    if (turn === 4) {
        // the list_changed re-list is async — wait until the dynamic tool is live
        const ok = await until(
            () => agent.tools.some((t) => t.name === "good_bonus_time"),
            3000,
        );
        log(`[driver] dynamic tool visible before call 4: ${ok}`);
        return toolCall("good_bonus_time", {});
    }
    if (turn === 5) return toolCall("http_mul", { a: 6, b: 7 });
    return {
        message: {
            id: `runtime-${crypto.randomUUID().slice(0, 8)}`,
            enabled: true,
            type: "assistant",
            content: [{ type: "text", content: "mcp gauntlet complete" }],
        },
        stats: STATS,
        stopReason: "stop",
    };
};

const agent = new Agent({
    model,
    agentId: "mcp-agent",
    messages: [
        {
            id: "system",
            enabled: true,
            type: "system-compound",
            content: [{ id: "agent.md", content: "You are an MCP test rig." }],
        },
    ],
});

// core is type-blind — the inputs extra is what gives input_followup its meaning
agent.install(createDefaultInputs());

// ---- lifecycle step 3: insert the READY tool list ----
agent.install(mcp.getPlugin());

// ---- evidence emitters ----
agent.addFilter({
    event: EVENTS.afterTool,
    id: "log-tool-result",
    priority: 0,
    fn: async (_a, ev) => {
        const p = ev as unknown as {
            call?: { name?: string };
            result?: Pick<ToolResult, "answer" | "error">;
        };
        log(
            `[tool:${p?.call?.name}] error=${!!p?.result?.error} answer=${JSON.stringify(p?.result?.answer)}`,
        );
    },
});
agent.addFilter({
    event: EVENTS.toolListChanged,
    id: "log-list-changed",
    priority: 0,
    fn: async (a: GodObject) => {
        log(
            `[filter:toolListChanged] tools now: ${a.tools.map((t) => t.name).join(", ")}`,
        );
    },
});

// ---- run ----
log("[driver] starting mcp-agent");
agent.run();
agent.input({ type: "input_followup", text: "run the mcp gauntlet" });

// ---- land: dump the truth, self-check, exit with a verdict ----
setTimeout(async () => {
    log(`\n=== state.mcp ===`);
    const mcpState = JSON.stringify(agent.state.mcp);
    log(mcpState);
    log(`[driver] final loopState=${agent.loopState} turns=${turn}`);
    log(`\n=== messages after run ===`);
    for (const m of agent.messages) {
        const content =
            typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        console.log(`  [${m.type}] ${content.slice(0, 160)}`);
    }

    let ok = true;
    const need = (cond: boolean | undefined, what: string): void => {
        if (!cond) {
            ok = false;
            console.log(`[driver] MISSING: ${what}`);
        }
    };
    const joined = story.join("\n");
    need(/\[mcp:status\] good=\{"status":"connected"/.test(joined),
        "good server connected");
    need(/"tools":\["good_add","good_fail_now","good_install_extra"\]/.test(joined),
        "namespaced tool list (server_tool)");
    need(/\[mcp:status\] dead=\{"status":"failed"/.test(joined),
        "dead server degraded to failed");
    need(/\[tool:good_add\] error=false answer=".*42"/.test(joined),
        "real sum over the wire");
    need(/\[tool:good_fail_now\] error=true answer=".*deliberate failure/.test(joined),
        "isError surfaced as error-as-text");
    need(/\[driver\] dynamic tool visible before call 4: true/.test(joined),
        "list_changed re-list landed");
    need(/\[tool:good_bonus_time\] error=false answer=".*bonus delivered/.test(joined),
        "dynamic tool callable through the loop");
    need(/\[mcp:status\] http=\{"status":"connected"/.test(joined),
        "remote http server connected");
    need(/\[tool:http_mul\] error=false answer=".*is 42"/.test(joined),
        "real product over remote streamable HTTP");
    need(/"good":\{"status":"connected"/.test(mcpState), "state.mcp.good connected");
    need(/"dead":\{"status":"failed"/.test(mcpState), "state.mcp.dead failed");
    need(/"http":\{"status":"connected"/.test(mcpState), "state.mcp.http connected");

    console.log(`[driver] self-check ok=${ok}`);
    httpFixture.kill();
    process.exit(ok ? 0 : 1);
}, 1500);

// ---- tiny helpers ----
const STATS = {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toolCall(name: string, parameters: unknown) {
    return {
        message: {
            id: `runtime-${crypto.randomUUID().slice(0, 8)}`,
            enabled: true,
            type: "toolCall",
            content: {
                answer: "",
                stored: [{ id: `call-${turn}`, type: "function", name, parameters }],
            },
        },
        stats: STATS,
        stopReason: "tool_calls",
    };
}

async function until(fn: () => boolean, ms: number): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        if (fn()) return true;
        await new Promise((r) => setTimeout(r, 25));
    }
    return fn();
}
