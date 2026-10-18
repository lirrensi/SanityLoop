// scripts/verify.ts — THE ONE COMMAND. `npm run verify` runs every tier and
// prints the board: docs → typecheck → unit → e2e → templates → live (opt-in).
// Exit 0 = everything green (skips are honest, never silent). Exit 1 = red.
//
//   npm run verify                  everything runnable here (live tiers skip without keys)
///  npm run verify -- --tier=unit    only unit (comma: docs,type,unit,e2e,templates,live)
//   npm run verify -- --with-live    attempt live tiers (needs keys / local model)
//   npm run verify -- --json         machine output only
//
// Tiers never fake: a tier that cannot run reports SKIP + reason. The JSON
// report lands at .agents/reports/verify-latest.json (docs point AT it —
// counts are never hardcoded in prose again).
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface TierResult {
    tier: string;
    status: "pass" | "fail" | "skip";
    tests: number;
    pass: number;
    fail: number;
    skipped: number;
    ms: number;
    detail: string;
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const NODE_FLAGS = ["--experimental-strip-types", "--experimental-transform-types"];
const args = process.argv.slice(2);
const onlyTiers = new Set(
    (args.find((a) => a.startsWith("--tier="))?.slice("--tier=".length).split(",") ?? []).map((s) => s.trim()).filter(Boolean),
);
const withLive = args.includes("--with-live");
const jsonOnly = args.includes("--json");

function run(cmd: string, cmdArgs: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; shell?: boolean } = {}): Promise<{ code: number; out: string; ms: number; timedOut: boolean }> {
    const t0 = Date.now();
    const { promise, resolve } = Promise.withResolvers<{ code: number; out: string; ms: number; timedOut: boolean }>();
    const child = spawn(cmd, cmdArgs, {
        cwd: opts.cwd ?? ROOT,
        env: { ...process.env, ...opts.env },
        stdio: ["ignore", "pipe", "pipe"],
        shell: opts.shell ?? false,
    });
    let out = "";
    let timedOut = false;
    const timer = opts.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, opts.timeoutMs)
        : undefined;
    timer?.unref?.();
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    child.on("error", (e) => resolve({ code: 1, out: out + String(e), ms: Date.now() - t0, timedOut }));
    child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, out, ms: Date.now() - t0, timedOut });
    });
    return promise;
}

/** Failing test names + their first assertion line (enough to aim the fix). */
function failingDetail(out: string): string {
    const lines = out.split("\n");
    const hits: string[] = [];
    for (let i = 0; i < lines.length && hits.length < 10; i++) {
        const m = /^✖ (.+) \(\d[\d.,]*m?s\)$/.exec(lines[i].trim());
        if (!m || m[1].endsWith(".ts")) continue;
        let body = "";
        for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
            const t = lines[j].trim();
            if (/^(AssertionError|Error|TypeError|RangeError)/.test(t)) { body = t.slice(0, 160); break; }
        }
        hits.push(body !== "" ? `${m[1]}\n    ${body}` : m[1]);
    }
    return hits.join("\n");
}

/** Parse node:test's `ℹ tests/pass/fail/skipped` summary lines (all shards). */
function parseCounts(out: string): { tests: number; pass: number; fail: number; skipped: number } {
    const acc = { tests: 0, pass: 0, fail: 0, skipped: 0 };
    for (const line of out.split("\n")) {
        const m = /^ℹ (tests|pass|fail|skipped) (\d+)/.exec(line.trim());
        if (m) acc[m[1] as keyof typeof acc] += Number(m[2]);
    }
    return acc;
}

async function tierType(): Promise<TierResult> {
    const t0 = Date.now();
    const r = await run("node", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--noEmit"], { timeoutMs: 300_000 });
    return {
        tier: "type", ms: Date.now() - t0, tests: 0, pass: 0, fail: 0, skipped: 0,
        status: r.code === 0 ? "pass" : "fail",
        detail: r.code === 0 ? "tsc clean" : r.out.split("\n").filter((l) => l.includes("error TS")).slice(0, 5).join("\n"),
    };
}

async function tierUnit(): Promise<TierResult> {
    const t0 = Date.now();
    const r = await run(NPM, ["run", "test", "--silent"], { timeoutMs: 900_000, shell: process.platform === "win32" });
    const c = parseCounts(r.out);
    const failing = failingDetail(r.out);
    return {
        tier: "unit", ms: Date.now() - t0, tests: c.tests, pass: c.pass, fail: c.fail, skipped: c.skipped,
        status: c.fail > 0 || r.code !== 0 ? "fail" : "pass",
        detail: c.fail > 0 ? failing : `${c.pass}/${c.tests} pass${c.skipped > 0 ? `, ${c.skipped} skipped` : ""}`,
    };
}

async function tierE2e(): Promise<TierResult> {
    const t0 = Date.now();
    // Opt-in files (*.optin.test.ts) are the LIVE tier's job — excluding them
    // here so a keyed run doesn't execute them twice (double API burn).
    const files = readdirSync(join(ROOT, "test", "e2e"))
        .filter((f) => f.endsWith(".test.ts") && !f.endsWith(".optin.test.ts"))
        .map((f) => join("test", "e2e", f));
    const r = await run("node", [...NODE_FLAGS, "--test", "--test-force-exit", ...files], { timeoutMs: 900_000 });
    const c = parseCounts(r.out);
    const failing = failingDetail(r.out);
    return {
        tier: "e2e", ms: Date.now() - t0, tests: c.tests, pass: c.pass, fail: c.fail, skipped: c.skipped,
        status: c.fail > 0 ? "fail" : "pass",
        detail: c.fail > 0 ? failing : `${c.pass}/${c.tests} pass${c.skipped > 0 ? `, ${c.skipped} skipped (opt-in)` : ""}`,
    };
}

async function localModelUrl(): Promise<string | undefined> {
    const candidates = [
        process.env.SANITYLOOP_LOCAL_URL,
        "http://localhost:18080/v1",
        "http://localhost:58080/v1",
    ].filter(Boolean) as string[];
    for (const base of candidates) {
        try {
            const ctl = new AbortController();
            const timer = setTimeout(() => ctl.abort(), 3000);
            const res = await fetch(`${base}/models`, { signal: ctl.signal });
            clearTimeout(timer);
            if (res.ok) return base;
        } catch { /* next */ }
    }
    return undefined;
}

async function tierTemplates(): Promise<TierResult> {
    const t0 = Date.now();
    const notes: string[] = [];
    let pass = 0;
    let fail = 0;
    // simple-agent: the stub lifecycle — ALWAYS runnable, must exit 0.
    const simple = await run("node", [...NODE_FLAGS, "templates/simple-agent.ts"], { timeoutMs: 120_000 });
    if (simple.code === 0 && !simple.timedOut) {
        pass++;
        notes.push("simple-agent(stub): exit 0");
    } else {
        fail++;
        notes.push(`simple-agent(stub): FAILED (code=${simple.code} timedOut=${simple.timedOut})`);
    }
    // template-agent: the copyable composition — needs a brain. Local model
    // when reachable, else an honest skip (never fake-green).
    const local = await localModelUrl();
    const key = process.env.SANITYLOOP_E2E_KEY ?? process.env.OPENAI_API_KEY;
    if (local !== undefined) {
        const r = await run("node", [...NODE_FLAGS, "templates/template-agent.ts"], {
            timeoutMs: 180_000,
            env: {
                OPENAI_API_KEY: key ?? "dummy-local",
                OPENAI_BASE_URL: local,
                SANITYLOOP_MODEL: process.env.SANITYLOOP_E2E_MODEL ?? "local",
            },
        });
        if (r.code === 0 && !r.timedOut) {
            pass++;
            notes.push(`template-agent(local ${local}): exit 0`);
        } else {
            fail++;
            notes.push(`template-agent(local ${local}): FAILED (code=${r.code} timedOut=${r.timedOut}) ${r.out.slice(-300)}`);
        }
    } else {
        notes.push("template-agent: SKIP (no local model at :18080/:58080, no SANITYLOOP_LOCAL_URL)");
    }
    return {
        tier: "templates", ms: Date.now() - t0, tests: pass + fail, pass, fail,
        skipped: local === undefined ? 1 : 0,
        status: fail > 0 ? "fail" : "pass",
        detail: notes.join("\n"),
    };
}

async function tierLive(): Promise<TierResult> {
    const t0 = Date.now();
    const key = process.env.SANITYLOOP_E2E_KEY ?? process.env.OPENAI_API_KEY;
    const realworld = process.env.SANITYLOOP_MCP_REALWORLD === "1";
    if (!withLive && !key && !realworld) {
        return {
            tier: "live", ms: Date.now() - t0, tests: 0, pass: 0, fail: 0, skipped: 2,
            status: "skip", detail: "SKIP (no SANITYLOOP_E2E_KEY/OPENAI_API_KEY, no SANITYLOOP_MCP_REALWORLD=1 — pass --with-live to attempt)",
        };
    }
    const notes: string[] = [];
    let pass = 0;
    let fail = 0;
    let skipped = 0;
    if (key !== undefined || withLive) {
        const env: Record<string, string> = {};
        if ((process.env.SANITYLOOP_E2E_BASE_URL ?? "") === "" && key === undefined) {
            // --with-live without a key: try the local model as the provider
            const local = await localModelUrl();
            if (local !== undefined) {
                env.SANITYLOOP_E2E_KEY = "dummy-local";
                env.SANITYLOOP_E2E_BASE_URL = local;
                env.SANITYLOOP_E2E_MODEL = "local";
                notes.push(`provider probe via local model ${local}`);
            }
        }
        if (key !== undefined || env.SANITYLOOP_E2E_KEY !== undefined) {
            const r = await run("node", [...NODE_FLAGS, "--test", "--test-force-exit", "test/e2e/real-provider.optin.test.ts"], {
                timeoutMs: 900_000, env,
            });
            const c = parseCounts(r.out);
            pass += c.pass;
            fail += c.fail;
            skipped += c.skipped;
            notes.push(`real-provider: ${c.pass}/${c.tests} pass${c.fail > 0 ? ` FAIL:${c.fail}` : ""}`);
        } else {
            skipped += 1;
            notes.push("real-provider: SKIP (no key, no local model)");
        }
    } else {
        skipped += 1;
        notes.push("real-provider: SKIP (no key)");
    }
    if (realworld || withLive) {
        const r = await run("node", [...NODE_FLAGS, "--test", "--test-force-exit", "test/e2e/mcp-realworld.optin.test.ts"], {
            timeoutMs: 900_000, env: realworld ? {} : { SANITYLOOP_MCP_REALWORLD: "1" },
        });
        const c = parseCounts(r.out);
        pass += c.pass;
        fail += c.fail;
        skipped += c.skipped;
        notes.push(`mcp-realworld: ${c.pass}/${c.tests} pass${c.skipped > 0 ? `, ${c.skipped} skipped` : ""}${c.fail > 0 ? ` FAIL:${c.fail}` : ""}`);
    } else {
        skipped += 1;
        notes.push("mcp-realworld: SKIP (SANITYLOOP_MCP_REALWORLD!=1)");
    }
    return {
        tier: "live", ms: Date.now() - t0, tests: pass + fail + skipped, pass, fail, skipped,
        status: fail > 0 ? "fail" : "pass",
        detail: notes.join("\n"),
    };
}

async function tierDocs(): Promise<TierResult> {
    const t0 = Date.now();
    const r = await run("node", [...NODE_FLAGS, "scripts/docs.ts", "--strict"], { timeoutMs: 120_000 });
    const lines = r.out.trim().split("\n").filter(Boolean);
    const board = lines.slice(-1)[0] ?? "";
    const failing = lines.filter((l) => l.startsWith("✖")).slice(0, 8).join("\n");
    return {
        tier: "docs", ms: Date.now() - t0, tests: 0, pass: 0, fail: 0, skipped: 0,
        status: r.code === 0 ? "pass" : "fail",
        detail: r.code === 0 ? board : failing !== "" ? failing : r.out.slice(-500),
    };
}

const TIERS: Array<{ name: string; run: () => Promise<TierResult> }> = [
    { name: "docs", run: tierDocs },
    { name: "type", run: tierType },
    { name: "unit", run: tierUnit },
    { name: "e2e", run: tierE2e },
    { name: "templates", run: tierTemplates },
    { name: "live", run: tierLive },
];

const results: TierResult[] = [];
for (const t of TIERS) {
    if (onlyTiers.size > 0 && !onlyTiers.has(t.name)) continue;
    if (!jsonOnly) process.stdout.write(`… ${t.name} ─────────────────────────────────\n`);
    const r = await t.run();
    results.push(r);
    if (!jsonOnly) {
        const icon = r.status === "pass" ? "✔" : r.status === "fail" ? "✖" : "﹣";
        process.stdout.write(`${icon} ${t.name}: ${r.detail.split("\n")[0]} (${(r.ms / 1000).toFixed(1)}s)\n`);
        for (const line of r.detail.split("\n").slice(1)) process.stdout.write(`  ${line}\n`);
    }
}

const totals = results.reduce((a, r) => ({ tests: a.tests + r.tests, pass: a.pass + r.pass, fail: a.fail + r.fail, skipped: a.skipped + r.skipped }), { tests: 0, pass: 0, fail: 0, skipped: 0 });
const failed = results.filter((r) => r.status === "fail").map((r) => r.tier);
const report = {
    at: new Date().toISOString(),
    node: process.version,
    tiers: results,
    totals,
    green: failed.length === 0,
};
mkdirSync(join(ROOT, ".agents", "reports"), { recursive: true });
writeFileSync(join(ROOT, ".agents", "reports", "verify-latest.json"), JSON.stringify(report, null, 2) + "\n");

if (jsonOnly) {
    console.log(JSON.stringify(report, null, 2));
} else {
    const ms = results.reduce((a, r) => a + r.ms, 0);
    console.log("──────────────────────────────────────────────");
    console.log(
        failed.length === 0
            ? `✔ VERIFY GREEN — ${totals.pass}/${totals.tests} pass, ${totals.skipped} skipped (${(ms / 1000).toFixed(0)}s total)`
            : `✖ VERIFY RED — tiers failing: ${failed.join(", ")} (${totals.fail} failures, ${(ms / 1000).toFixed(0)}s total)`,
    );
    console.log("report: .agents/reports/verify-latest.json");
}
process.exit(failed.length === 0 ? 0 : 1);
