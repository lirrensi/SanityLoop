// ============================================================================
// test/e2e/fixtures/mcp-realworld-driver.ts — OUR adapter vs REAL MCP CONFIG.
// ============================================================================
// Reads the user's opencode.json (override: SANITYLOOP_OPENCODE_CONFIG), takes
// its literal `mcp` section, and feeds it to @sanityloop/mcp unchanged (local
// entries only). Then a scripted stub model makes REAL calls through the loop:
//
//   1. playwright_browser_navigate → http://localhost:58080  (real Chromium,
//      real HTTP against the live llama.cpp frontend)
//   2. playwright_browser_snapshot → the page's accessibility tree, over wire
//   3. skill-store <search/list>   → real query against the real registry
//
// Remote (url) entries are honestly reported as NOT SUPPORTED (stdio-only
// adapter today) — no pretending. Exit code = verdict.

import { Agent, SimpleModel, EVENTS } from "@sanityloop/core";
import type { GodObject, ToolResult } from "@sanityloop/core";
import { createDefaultInputs } from "@sanityloop/inputs";
import { createMcp } from "@sanityloop/mcp";
import type { McpConfig } from "@sanityloop/mcp";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OC_CONFIG =
    process.env.SANITYLOOP_OPENCODE_CONFIG ?? join(homedir(), ".config", "opencode", "opencode.json");

const story: string[] = [];
function log(line: string): void {
    story.push(line);
    console.log(line);
}

// ---- the REAL config, parsed ----
const raw = JSON.parse(readFileSync(OC_CONFIG, "utf8")) as {
    mcp?: Record<
        string,
        { type?: string; command?: string[]; url?: string; enabled?: boolean }
    >;
};
const declared = raw.mcp ?? {};
log(`[smoke] opencode declares ${Object.keys(declared).length} mcp servers: ${Object.keys(declared).join(", ")}`);

// ---- convert: local → command array; remote → url (+ headers if declared).
// Dead remote entries degrade to failed status — that's the honest truth, not
// a skip. Force-enable everything: this is a TEST drive. ----
const cfg: McpConfig = {};
for (const [name, entry] of Object.entries(declared)) {
    if (entry.url) {
        log(`[smoke] ${name}: REMOTE (${entry.url})`);
        cfg[name] = {
            url: entry.url,
            ...(entry as { headers?: Record<string, string> }).headers,
        };
        continue;
    }
    if (!entry.command) {
        log(`[smoke] ${name}: no command or url — SKIPPED`);
        continue;
    }
    cfg[name] = { command: entry.command };
}
if (Object.keys(cfg).length === 0) {
    console.error("[smoke] nothing to connect to");
    process.exit(1);
}

const mcp = createMcp(cfg);
await mcp.init(60_000);
for (const [k, v] of Object.entries(mcp.status))
    log(
        `[mcp:status] ${k}=${JSON.stringify(v.status)}${v.status === "connected" ? ` tools=${v.tools.length}` : ""}`,
    );
for (const t of mcp.tools) log(`[mcp:tool] ${t.name}`);

// ---- pick the real targets from what ACTUALLY showed up ----
const pick = (re: RegExp): string | undefined =>
    mcp.tools.map((t) => t.name).find((n) => re.test(n));
const NAV = pick(/^playwright_browser_navigate$/);
const SNAP = pick(/^playwright_browser_snapshot$/);
const STORE = pick(/^skill_store_(search|list)_skills$/);

// ---- the agent ----
const model = new SimpleModel({
    api: "chat_completions",
    modelId: "stub",
    stream: false,
    maxContext: 128_000,
});
let turn = 0;
const STATS = {
    input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function toolCall(name: string, parameters: unknown) {
    return {
        message: {
            id: `rt-${crypto.randomUUID().slice(0, 8)}`,
            enabled: true,
            type: "toolCall",
            content: {
                answer: "",
                stored: [{ id: `c-${turn}`, type: "function", name, parameters }],
            },
        },
        stats: STATS,
        stopReason: "tool_calls" as const,
    };
}

model.callNextTurn = async () => {
    turn++;
    const seq: Array<[string | undefined, unknown]> = [
        [NAV, { url: "http://localhost:58080/" }],
        [SNAP, {}],
        [STORE, STORE?.includes("search") ? { query: "memory", limit: 3 } : {}],
    ];
    if (turn <= seq.length) {
        const [name, params] = seq[turn - 1];
        if (!name) return { ...toolCall("noop_missing_tool", {}), stopReason: "tool_calls" as const };
        return toolCall(name, params);
    }
    return {
        message: {
            id: `rt-${crypto.randomUUID().slice(0, 8)}`,
            enabled: true,
            type: "assistant",
            content: [{ type: "text", content: "real-world smoke complete" }],
        },
        stats: STATS,
        stopReason: "stop" as const,
    };
};

const agent = new Agent({
    model,
    agentId: "mcp-realworld",
    messages: [
        {
            id: "system", enabled: true, type: "system-compound",
            content: [{ id: "agent.md", content: "Real-world MCP rig." }],
        },
    ],
});
agent.install(createDefaultInputs());
agent.install(mcp.getPlugin());

agent.addFilter({
    event: EVENTS.afterTool,
    id: "log-results",
    priority: 0,
    fn: async (_a, ev) => {
        const p = ev as unknown as {
            call?: { name?: string };
            result?: Pick<ToolResult, "answer" | "error">;
        };
        const ans = p?.result?.answer ?? "";
        log(
            `[tool:${p?.call?.name}] error=${!!p?.result?.error} len=${ans.length}\n--- answer head ---\n${ans.slice(0, 700)}\n--- end head ---`,
        );
    },
});

log("[smoke] starting");
agent.run();
agent.input({ type: "input_followup", text: "drive the real servers" });

setTimeout(async () => {
    log(`[smoke] final loopState=${agent.loopState} turns=${turn}`);
    let ok = true;
    const need = (cond: boolean | undefined, what: string) => {
        if (!cond) { ok = false; console.log(`[smoke] MISSING: ${what}`); }
    };
    need(/\[mcp:status\] playwright="connected" tools=\d+/.test(story.join("\n")),
        "playwright-mcp connected");
    need(/\[mcp:status\] skill-store="connected" tools=\d+/.test(story.join("\n")),
        "skill-store connected");
    if (NAV) need(/\[tool:playwright_browser_navigate\] error=false/.test(story.join("\n")),
        "navigate succeeded");
    if (SNAP) need(/\[tool:playwright_browser_snapshot\] error=false/.test(story.join("\n")),
        "snapshot succeeded");
    if (STORE) need(new RegExp(`\\[tool:${STORE.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\] error=false`).test(story.join("\n")),
        "skill-store call succeeded");

    console.log(`[smoke] self-check ok=${ok}`);
    process.exit(ok ? 0 : 1);
}, 25_000);

void ({} as GodObject); // keep the type import honest
