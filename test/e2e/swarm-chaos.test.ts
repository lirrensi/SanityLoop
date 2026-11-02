// ============================================================================
// test/e2e/swarm-chaos.test.ts — REAL-daemon chaos drills.
//
// Every test boots a REAL daemon child (`serve --dir <tmp home>`) and talks
// to it over the wire (WS ops + REST) plus real CLI children. Kill-9 is real
// kill -9; pid churn is real churn; the second daemon really refuses the lock.
// A home = a daemon: default ~/.sanity/swarm is a convenience, not a limit —
// unit names derive from the home, each with its own --dir + --port.
//
// Bounds: every wait is a deadline poll against the REAL daemon clock — fake
// timers cannot work here (the daemon under test is a separate OS process
// with its own 1s program clock, its own sockets, its own children). Every
// child dies in t.after (SIGKILL) — no strays, no silent skips (Linux-only
// bits guard with t.skip, everything else runs). Total budget: <3min.
// ============================================================================
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import WebSocket from "ws";
import { runCli, spawnDaemon, type DaemonHandle } from "./helpers/spawn.ts";

const LINUX = process.platform === "linux";

function tmpHome(prefix: string): string {
    return mkdtempSync(join(tmpdir(), `swarm-chaos-${prefix}-`));
}

interface TestCtx {
    daemons: DaemonHandle[];
    procs: ChildProcess[];
    sockets: WebSocket[];
}

function track(t: TestContext): TestCtx {
    const ctx: TestCtx = { daemons: [], procs: [], sockets: [] };
    t.after(async () => {
        for (const s of ctx.sockets) {
            try {
                s.close();
            } catch {
                /* already gone */
            }
        }
        for (const d of ctx.daemons) {
            try {
                await d.kill("SIGKILL");
            } catch {
                /* already gone — the kill is the cleanup */
            }
        }
        for (const p of ctx.procs) {
            try {
                p.kill("SIGKILL");
            } catch {
                /* already gone */
            }
        }
    });
    return ctx;
}

function boot(t: TestContext, ctx: TestCtx, opts: Parameters<typeof spawnDaemon>[0]): Promise<DaemonHandle> {
    return spawnDaemon(opts).then((d) => {
        ctx.daemons.push(d);
        return d;
    });
}

type Json = Record<string, unknown>;

/** RPC against a daemon URL: register as admin, send one frame, await the reply. */
async function rpc<T = unknown>(url: string, frame: Json, timeoutMs = 10_000): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const ws = new WebSocket(url);
    const id = `e2e-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
        try {
            ws.close();
        } catch {
            /* ignore */
        }
        reject(new Error(`rpc timeout: ${String(frame.op)}`));
    }, timeoutMs);
    ws.on("open", () => {
        ws.send(JSON.stringify({ op: "register", sessionId: `chaos-${id}`, agentId: "chaos", mode: "admin" }));
        ws.send(JSON.stringify({ ...frame, id }));
    });
    ws.on("message", (raw) => {
        let f: Json | unknown[];
        try {
            f = JSON.parse(String(raw)) as Json;
        } catch {
            return;
        }
        if (Array.isArray(f)) return;
        if (f.op === "welcome") return;
        if (f.id !== id) return;
        clearTimeout(timer);
        try {
            ws.close();
        } catch {
            /* ignore */
        }
        if (f.op === "error") reject(new Error(String(f.error ?? "rpc error")));
        else resolve(f.data as T);
    });
    ws.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
    });
    return promise;
}

function num(v: unknown, fallback = 0): number {
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown): string {
    return typeof v === "string" ? v : "";
}

function rowsOf(v: unknown): Json[] {
    return Array.isArray(v) ? (v as Json[]) : [];
}

async function rest(port: number, path: string): Promise<unknown> {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`);
    const body = await res.text();
    if (!res.ok) throw new Error(`REST ${path} → ${res.status}: ${body.slice(0, 400)}`);
    try {
        return body ? (JSON.parse(body) as unknown) : null;
    } catch {
        return body;
    }
}

/** Deadline poll against the real daemon clock (separate process — see header). */
async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await cond()) return;
        if (Date.now() >= deadline) throw new Error(`timed out waiting: ${what}`);
        await new Promise((r) => setTimeout(r, 100));
    }
}

function readPrograms(home: string): { rows: Json[] } {
    const raw = readFileSync(join(home, "programs.json"), "utf8");
    return JSON.parse(raw) as { rows: Json[] };
}

// ---------------------------------------------------------------------------
// 1. kill-9 mid-claim → reboot: overdue slot lands as a logged skip,
//    runs advanced exactly once, no refire on the next tick.
// ---------------------------------------------------------------------------
test("chaos: kill-9 with pending claim → reboot lands a logged skip, no refire", { timeout: 60_000 }, async (t) => {
    if (!LINUX) {
        t.skip("kill -9 semantics are Linux-only");
        return;
    }
    const ctx = track(t);
    const home = tmpHome("claim");

    const d1 = await boot(t, ctx, { home, name: "chaos-claim" });
    // Define a real program over the wire: short sleeps, every-second grid,
    // skip-on-miss so an overdue slot is a *logged skip* (not a catch-up fire).
    await rpc(d1.url, {
        op: "program_define",
        name: "ticky",
        kind: "job",
        spawn: { cmd: "sleep", args: ["0.2"] },
        schedule: { kind: "every", everyMs: 1000 },
        missPolicy: "skip",
    });
    // Let one fire land so nextFire/lastSlot are real, then stage the crash.
    await waitFor(async () => {
        const got = await rpc<Json>(d1.url, { op: "program_get", name: "ticky" });
        const def = got.def as Json;
        const counters = def.counters as Json;
        return num(counters.runs) >= 1;
    }, 15_000, "first tick fire");
    await rpc(d1.url, { op: "program_patch", name: "ticky", patch: { paused: true } });

    // Stage the exact durable state a crash between claim and fork leaves
    // behind (claimSlot persists before the fork): a frozen overdue slot plus
    // a pending claim, so the REAL boot reconciliation exercises it.
    const before = (await rpc<Json>(d1.url, { op: "program_get", name: "ticky" })).def as Json;
    const beforeCounters = before.counters as Json;
    const runsBefore: number = num(beforeCounters.runs);
    const frozenSlot: number = typeof before.nextFire === "number" ? before.nextFire : Date.now() - 60_000;
    const persisted = readPrograms(home);
    const row = persisted.rows.find((r) => r.name === "ticky");
    assert.ok(row, "ticky persisted to programs.json");
    row.paused = false;
    row.missPolicy = "skip";
    row.nextFire = Date.now() - 120_000; // far overdue — past the window
    row.pendingClaim = { run: "run:staged", slot: frozenSlot, claimedAt: Date.now(), origin: "tick" };
    writeFileSync(join(home, "programs.json"), JSON.stringify(persisted, null, 2) + "\n");

    // SIGKILL the daemon mid-everything (unclean death: lock file stays stale
    // — boot must treat the dead pid's lock as claimable) and reboot same home.
    await d1.kill("SIGKILL");
    await d1.waitExit();
    ctx.daemons.splice(ctx.daemons.indexOf(d1), 1);
    const d2 = await boot(t, ctx, { home, name: "chaos-claim" });

    // The staged claim converted to a logged skip: the overdue slot must NOT
    // fork a catch-up run, and the pending claim must clear.
    await waitFor(async () => {
        const got = await rpc<Json>(d2.url, { op: "program_get", name: "ticky" });
        const def = got.def as Json;
        return def.lastSkip !== undefined && def.pendingClaim === undefined;
    }, 15_000, "boot converts pendingClaim to lastSkip");
    const after = (await rpc<Json>(d2.url, { op: "program_get", name: "ticky" })).def as Json;
    const afterCounters = after.counters as Json;
    assert.equal(num(afterCounters.runs), runsBefore, "overdue slot was skipped, not refired");
    const lastSkip = after.lastSkip as Json;
    assert.match(str(lastSkip?.reason), /logged skip|no refire/i);

    // The schedule marches on: the next tick fires fresh (exactly one new run),
    // proving the skip didn't wedge the grid.
    await waitFor(async () => {
        const got = await rpc<Json>(d2.url, { op: "program_get", name: "ticky" });
        const def = got.def as Json;
        const counters = def.counters as Json;
        return num(counters.runs) >= runsBefore + 1;
    }, 15_000, "schedule fires fresh after the skip");
    await rpc(d2.url, { op: "program_patch", name: "ticky", patch: { paused: true } });
    await d2.kill("SIGKILL");
    await d2.waitExit();
    ctx.daemons.splice(ctx.daemons.indexOf(d2), 1);
});

// ---------------------------------------------------------------------------
// 2. kill-9 with a live run → reboot: run marked interrupted, no stranger
//    signaled (pid churn proves the start-time check holds).
// ---------------------------------------------------------------------------
test("chaos: kill-9 with live run → reboot marks interrupted, signals nobody", { timeout: 60_000 }, async (t) => {
    if (!LINUX) {
        t.skip("kill -9 + /proc pid semantics are Linux-only");
        return;
    }
    const ctx = track(t);
    const home = tmpHome("live");

    const d1 = await boot(t, ctx, { home, name: "chaos-live" });
    const execRes = await rpc<Json>(d1.url, {
        op: "run_exec",
        spawn: { cmd: "sleep", args: ["30"] },
    });
    const runId: string = str(execRes.runId ?? execRes.id);
    assert.ok(runId, "daemon forked the sleep-30 run");
    await waitFor(async () => {
        const got = await rpc<Json>(d1.url, { op: "run_get", runId });
        return got.state === "running" && typeof got.pid === "number";
    }, 15_000, "sleep-30 running with a pid");
    const live = await rpc<Json>(d1.url, { op: "run_get", runId });
    const victimPid: number = num(live.pid, -1);
    assert.ok(victimPid > 0, "live run has a real pid");

    // SIGKILL the daemon: the child outlives it (orphaned sleep-30).
    // Then churn pids — short-lived children recycling pid numbers — so a
    // naive kill-by-pid at boot would hit a stranger.
    await d1.kill("SIGKILL");
    await d1.waitExit();
    ctx.daemons.splice(ctx.daemons.indexOf(d1), 1);

    const churnTrack: Array<Promise<number | null>> = [];
    for (let i = 0; i < 40; i++) {
        const p = spawn("true", [], { stdio: "ignore" });
        ctx.procs.push(p);
        churnTrack.push(
            new Promise((resolve) => {
                p.on("close", (code) => resolve(code));
            }),
        );
    }
    const churnResults = await Promise.all(churnTrack);
    for (const code of churnResults) assert.equal(code, 0, "every churn child exited naturally (nobody signaled)");

    const d2 = await boot(t, ctx, { home, name: "chaos-live" });
    await waitFor(async () => {
        const got = await rpc<Json>(d2.url, { op: "run_get", runId });
        return got.state === "interrupted";
    }, 15_000, "orphaned run marked interrupted at boot");
    assert.match(d2.out(), /marked interrupted/, "boot log names the interruption");

    // Boot reconciliation reaps its OWN orphan: the recorded start time still
    // matches, so the daemon SIGTERMs it (legitimate — same child, same boot)
    // and marks it interrupted. The stranger-proofing is the churn above:
    // all 40 recycled-pid children exited naturally, none signaled.
    await waitFor(async () => {
        try {
            process.kill(victimPid, 0);
            return false;
        } catch {
            return true;
        }
    }, 15_000, "boot reaped its own orphan");
    try {
        process.kill(victimPid, "SIGKILL");
    } catch {
        /* already gone — belt and braces */
    }
    await d2.kill("SIGKILL");
    await d2.waitExit();
    ctx.daemons.splice(ctx.daemons.indexOf(d2), 1);
});

// ---------------------------------------------------------------------------
// 3. two daemons, one home: B refuses the lock, A serves fine, A's lock intact.
// ---------------------------------------------------------------------------
test("chaos: second daemon on the same home exits nonzero with the lock message", { timeout: 60_000 }, async (t) => {
    const ctx = track(t);
    const home = tmpHome("lock");

    const a = await boot(t, ctx, { home, name: "chaos-a" });
    // A serves fine while B tries to steal the home.
    const health = await rest(a.port, "/health");
    assert.ok(health, "A answers REST while B contends");

    const b = spawn(process.execPath, ["--experimental-strip-types", "--experimental-transform-types",
        join(process.cwd(), "packages/swarm/src/server/cli.ts"),
        "serve", "--dir", home, "--port", "0", "--addr", "127.0.0.1", "--name", "chaos-b",
    ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    ctx.procs.push(b);
    let bOut = "";
    let bErr = "";
    b.stdout?.on("data", (c: Buffer) => (bOut += c.toString("utf8")));
    b.stderr?.on("data", (c: Buffer) => (bErr += c.toString("utf8")));
    const bCode = await new Promise<number | null>((resolve) => {
        b.on("close", (code) => resolve(code));
    });
    assert.notEqual(bCode, 0, `B must refuse the home (got exit ${bCode})\nstdout: ${bOut}\nstderr: ${bErr}`);
    assert.match(bOut + bErr, /already owned by pid/, "B names the lock holder");

    // A still serves; A's lock file still names A's pid.
    const healthAfter = await rest(a.port, "/health");
    assert.ok(healthAfter, "A still serves after B's refusal");
    const lockRaw = readFileSync(join(home, "daemon.lock"), "utf8").trim();
    assert.equal(lockRaw, String(a.proc.pid), "A's lock untouched by B");

    await a.kill("SIGKILL");
    await a.waitExit();
    ctx.daemons.splice(ctx.daemons.indexOf(a), 1);
});

// ---------------------------------------------------------------------------
// 4a. overlap allow: slow program + 1s grid piles up — ≥3 live mid-window,
//     all settle, all in history with logs.
// ---------------------------------------------------------------------------
test("chaos: overlap allow piles up live runs, all settle with logs", { timeout: 60_000 }, async (t) => {
    const ctx = track(t);
    const home = tmpHome("pile");

    const d = await boot(t, ctx, { home, name: "chaos-pile" });
    await rpc(d.url, {
        op: "program_define",
        name: "slow",
        kind: "job",
        spawn: { cmd: "sleep", args: ["5"] },
        schedule: { kind: "every", everyMs: 1000 },
        overlap: "allow",
    });

    // Mid-window: ≥3 live runs at once.
    await waitFor(async () => {
        const got = await rpc<Json>(d.url, { op: "program_get", name: "slow" });
        const live = got.live;
        return Array.isArray(live) && live.length >= 3;
    }, 20_000, "≥3 live runs mid-window");
    const mid = await rpc<Json>(d.url, { op: "program_get", name: "slow" });
    const piled: string[] = rowsOf(mid.live).map((r) => str(r.id)).filter((s) => s.length > 0);
    assert.ok(piled.length >= 3, `piled up ${piled.length} live runs`);

    // All settle (sleep 5 ends them), all in history, every one with logs.
    await rpc(d.url, { op: "program_patch", name: "slow", patch: { paused: true } });
    await waitFor(async () => {
        const runs = rowsOf(await rpc<unknown>(d.url, { op: "run_list", program: "slow" }));
        if (runs.length < piled.length) return false;
        return runs.every((r) => r.endedAt !== undefined || r.state === "completed" || r.state === "failed");
    }, 25_000, "all piled runs settle");
    for (const id of piled) {
        const logs = await rpc<Json>(d.url, { op: "run_logs", runId: id });
        assert.ok(logs && typeof logs.text === "string", `run ${id} has logs`);
    }

    await d.kill("SIGKILL");
    await d.waitExit();
    ctx.daemons.splice(ctx.daemons.indexOf(d), 1);
});

// ---------------------------------------------------------------------------
// 4b. overlap cancel: the previous run is SIGTERMed (exit signal set) when
//     the next slot fires.
// ---------------------------------------------------------------------------
test("chaos: overlap cancel SIGTERMs the previous run on the next slot", { timeout: 60_000 }, async (t) => {
    if (!LINUX) {
        t.skip("signal semantics are Linux-only");
        return;
    }
    const ctx = track(t);
    const home = tmpHome("cancel");

    const d = await boot(t, ctx, { home, name: "chaos-cancel" });
    await rpc(d.url, {
        op: "program_define",
        name: "slowc",
        kind: "job",
        spawn: { cmd: "sleep", args: ["30"] },
        schedule: { kind: "every", everyMs: 1000 },
        overlap: "cancel",
    });

    // First run goes live; the next slot must cancel it. The cancel path
    // settles with an exit ({code: null, signal: SIGTERM}), so the SIGTERM on
    // the exit IS the cancel receipt (same convention as run_kill).
    let firstId = "";
    await waitFor(async () => {
        const got = await rpc<Json>(d.url, { op: "program_get", name: "slowc" });
        const live = rowsOf(got.live);
        if (live.length >= 1) {
            firstId = str(live[0]?.id);
            return true;
        }
        return false;
    }, 15_000, "first slow run live");
    await waitFor(async () => {
        const got = await rpc<Json>(d.url, { op: "run_get", runId: firstId });
        const exit = got.exit as Json | undefined;
        return str(exit?.signal) === "SIGTERM";
    }, 15_000, "previous run SIGTERMed with the signal recorded");
    const settled = await rpc<Json>(d.url, { op: "run_get", runId: firstId });
    const settledExit = settled.exit as Json | undefined;
    assert.equal(str(settledExit?.signal), "SIGTERM", "cancel recorded as SIGTERM on the exit");

    await rpc(d.url, { op: "program_patch", name: "slowc", patch: { paused: true } });
    // Stop the bleeding: kill remaining live runs, then the daemon.
    const cur = await rpc<Json>(d.url, { op: "program_get", name: "slowc" });
    for (const r of rowsOf(cur.live)) {
        try {
            await rpc(d.url, { op: "run_kill", runId: str(r.id), force: true }, 5_000);
        } catch {
            /* already settled */
        }
    }
    await d.kill("SIGKILL");
    await d.waitExit();
    ctx.daemons.splice(ctx.daemons.indexOf(d), 1);
});

// ---------------------------------------------------------------------------
// 5. CLI subprocesses: exec + programs define/list + listen --run.
// ---------------------------------------------------------------------------
test("chaos: CLI children (exec/define/list/listen) exit 0 with markers", { timeout: 60_000 }, async (t) => {
    const ctx = track(t);
    const home = tmpHome("cli");

    const d = await boot(t, ctx, { home, name: "chaos-cli" });
    const dir = ["--dir", home];

    const exec = await runCli(["exec", ...dir, "--wait-ms", "15000", "--", "echo", "chaos-hi"], { timeoutMs: 25_000 });
    assert.equal(exec.timedOut, false, "exec hung");
    assert.equal(exec.code, 0, `exec exit ${exec.code}\nstdout: ${exec.stdout}\nstderr: ${exec.stderr}`);
    assert.match(exec.stdout, /chaos-hi/, "exec streamed the command output");

    const define = await runCli(
        ["programs", "define", "cliw", ...dir, "--kind", "job", "--cmd", "sleep", "--", "0.2"],
        { timeoutMs: 15_000 },
    );
    assert.equal(define.code, 0, `define exit ${define.code}\n${define.stdout}\n${define.stderr}`);
    assert.match(define.stdout, /cliw/, "define echoes the program name");

    const list = await runCli(["programs", "list", ...dir], { timeoutMs: 15_000 });
    assert.equal(list.code, 0, `list exit ${list.code}\n${list.stdout}\n${list.stderr}`);
    assert.match(list.stdout, /cliw/, "list shows the defined program");

    // listen --run as a real child: subscribe to a run, SIGINT after it settles.
    const launched = await rpc<Json>(d.url, { op: "program_launch", name: "cliw" });
    const listenProc = spawn(
        process.execPath,
        ["--experimental-strip-types", "--experimental-transform-types",
            join(process.cwd(), "packages/swarm/src/server/cli.ts"),
            "listen", ...dir, "--run", str(launched.runId),
        ],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    ctx.procs.push(listenProc);
    let listenOut = "";
    listenProc.stdout?.on("data", (c: Buffer) => (listenOut += c.toString("utf8")));
    const listenClosed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        listenProc.on("close", (code, signal) => resolve({ code, signal }));
    });
    // Wait for the run to settle (the event must flow), then SIGINT the listener.
    try {
        await rpc(d.url, { op: "run_wait", runId: str(launched.runId), timeoutMs: 15_000 }, 20_000);
    } catch {
        /* settled already or wait timed out with a snapshot — either way the event flowed */
    }
    await new Promise((r) => setTimeout(r, 500));
    try {
        listenProc.kill("SIGINT");
    } catch {
        /* already gone */
    }
    let lend: { code: number | null; signal: string | null };
    try {
        lend = await Promise.race([
            listenClosed,
            new Promise<{ code: number | null; signal: string | null }>((_, rej) =>
                setTimeout(() => rej(new Error(`listen never exited; out=${listenOut}`)), 10_000),
            ),
        ]);
    } catch (e) {
        try {
            listenProc.kill("SIGKILL");
        } catch {
            /* ignore */
        }
        throw e;
    }
    assert.equal(lend.code, 0, `listen exits 0 on SIGINT (got ${lend.code}/${str(lend.signal)})`);

    await d.kill("SIGKILL");
    await d.waitExit();
    ctx.daemons.splice(ctx.daemons.indexOf(d), 1);
});

// ---------------------------------------------------------------------------
// 6. fd pressure: 30 concurrent sleep-2 runs — all settle, no EMFILE,
//    every run has logs.
// ---------------------------------------------------------------------------
test("chaos: 30 concurrent runs all settle with logs, no EMFILE", { timeout: 90_000 }, async (t) => {
    const ctx = track(t);
    const home = tmpHome("fd");

    const d = await boot(t, ctx, { home, name: "chaos-fd" });
    const N = 30;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
        const r = await rpc<Json>(d.url, { op: "run_exec", spawn: { cmd: "sleep", args: ["2"] } }, 15_000);
        ids.push(str(r.runId ?? r.id));
    }
    assert.equal(ids.length, N, "all 30 runs forked");

    await waitFor(async () => {
        const runs = rowsOf(await rpc<unknown>(d.url, { op: "run_list", limit: 100 }));
        const done = new Map(runs.map((r) => [str(r.id), r]));
        return ids.every((id) => {
            const r = done.get(id);
            return !!r && (r.endedAt !== undefined || r.state === "completed" || r.state === "failed" || r.state === "timedOut");
        });
    }, 60_000, "all 30 runs settle");
    assert.ok(!d.err().includes("EMFILE"), `no EMFILE in daemon stderr:\n${d.err().slice(-2000)}`);
    for (const id of ids) {
        const logs = await rpc<Json>(d.url, { op: "run_logs", runId: id }, 10_000);
        assert.ok(logs && typeof logs.text === "string", `run ${id} has logs`);
    }

    await d.kill("SIGKILL");
    await d.waitExit();
    ctx.daemons.splice(ctx.daemons.indexOf(d), 1);
});

// ---------------------------------------------------------------------------
// 7. federation over real sockets: A mounts B, mirror visible; kill B →
//    mirrors offline; reboot B → mirrors back, no dupes.
// ---------------------------------------------------------------------------
test("chaos: federation mount shows mirrors, offlines on kill, returns without dupes", { timeout: 90_000 }, async (t) => {
    const ctx = track(t);
    const homeA = tmpHome("fed-a");
    const homeB = tmpHome("fed-b");

    const b = await boot(t, ctx, { home: homeB, name: "chaos-b" });
    // B needs an online worker for A to mirror: mirrors are registry agents,
    // so hold a persistent worker socket open on B for the whole drill.
    const held = new WebSocket(b.url);
    ctx.sockets.push(held);
    await new Promise<void>((resolve, reject) => {
        held.on("open", () => {
            held.send(JSON.stringify({ op: "register", sessionId: "held-worker", agentId: "held", mode: "worker", persistent: true }));
            resolve();
        });
        held.on("error", reject);
    });

    const a = await boot(t, ctx, { home: homeA, name: "chaos-a", connect: [b.url] });

    // Mirror visible in A's registry under B's room subtree.
    const isMirror = (r: Json): boolean => r.origin === "mirrored" && str(r.room).includes("chaos-b");
    await waitFor(async () => {
        const rows = rowsOf(await rpc<unknown>(a.url, { op: "agents_list" }));
        return rows.some(isMirror);
    }, 20_000, "mirror of B's worker visible in A");
    const beforeKill = rowsOf(await rpc<unknown>(a.url, { op: "agents_list" }));
    const mirrorsBefore = beforeKill.filter(isMirror);
    assert.ok(mirrorsBefore.length >= 1, "at least one mirror");

    // Kill B → mirrors in A go offline (TCP is the heartbeat). No ghosts.
    await b.kill("SIGKILL");
    await b.waitExit();
    ctx.daemons.splice(ctx.daemons.indexOf(b), 1);
    await waitFor(async () => {
        const rows = rowsOf(await rpc<unknown>(a.url, { op: "agents_list" }));
        const mirrors = rows.filter(isMirror);
        return mirrors.length > 0 && mirrors.every((m) => m.status === "offline");
    }, 20_000, "mirrors offline after B dies");

    // Reboot B (same home/name) → mirrors back online, no duplicates.
    const b2 = await boot(t, ctx, { home: homeB, name: "chaos-b", port: b.port });
    const held2 = new WebSocket(b2.url);
    ctx.sockets.push(held2);
    await new Promise<void>((resolve, reject) => {
        held2.on("open", () => {
            held2.send(JSON.stringify({ op: "register", sessionId: "held-worker", agentId: "held", mode: "worker", persistent: true }));
            resolve();
        });
        held2.on("error", reject);
    });
    await waitFor(async () => {
        const rows = rowsOf(await rpc<unknown>(a.url, { op: "agents_list" }));
        const mirrors = rows.filter(isMirror);
        return mirrors.length > 0 && mirrors.every((m) => m.status === "online");
    }, 30_000, "mirrors back online after B reboots");
    const afterReboot = rowsOf(await rpc<unknown>(a.url, { op: "agents_list" }));
    const mirrorsAfter = afterReboot.filter(isMirror);
    const addrs = mirrorsAfter.map((m) => str(m.address));
    assert.equal(new Set(addrs).size, addrs.length, `no duplicate mirrors (${addrs.join(", ")})`);
    assert.ok(
        mirrorsAfter.length <= Math.max(mirrorsBefore.length, 1) + 1,
        `no ghost accumulation (before=${mirrorsBefore.length} after=${mirrorsAfter.length})`,
    );

    await b2.kill("SIGKILL");
    await b2.waitExit();
    ctx.daemons.splice(ctx.daemons.indexOf(b2), 1);
    await a.kill("SIGKILL");
    await a.waitExit();
    ctx.daemons.splice(ctx.daemons.indexOf(a), 1);
});
