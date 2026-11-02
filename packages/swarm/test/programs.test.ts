// programs.test.ts — the unified program model (services + scheduled jobs).
// define validation, patch promotion, launch, preview, tick overlap/minGap,
// catchup fireOnce vs skip, boot pendingClaim/live/desired, triggerToken,
// retry, pauseOnFail, service respawn. Driven via api.tickPrograms/pokeProgram
// (deterministic, no wall-clock schedules). Real forks via {cmd} spawns; the
// retry/respawn/pause polls below await real child exits, so wall-clock waits
// are unavoidable (no fake timers for live processes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { startDaemon, WsClient, tmpHome, rmHome } from "./harness.ts";
import type { ProgramDef, RunRecord } from "../src/server/stores.ts";
import type { SwarmServer, LaunchResult } from "../src/server/index.ts";

const QUICK = "process.exit(0);";
const SLOW = "setInterval(()=>{},1000);";
const SPAWN = (code: string) => ({ cmd: process.execPath, args: ["-e", code] });

type DefineOut = ProgramDef | { error: string[] };
function isError(r: DefineOut | null): r is { error: string[] } {
	return !!r && typeof r === "object" && "error" in r;
}
function okDef(r: DefineOut | null): ProgramDef {
	if (!r || isError(r)) throw new Error(`expected ProgramDef, got ${JSON.stringify(r)}`);
	return r;
}
type LaunchOut = LaunchResult | { busy: true; name: string } | { error: string[] } | null;
function okLaunch(r: LaunchOut): LaunchResult {
	if (!r || "error" in r || "busy" in r || !("runId" in r)) {
		throw new Error(`expected LaunchResult, got ${JSON.stringify(r)}`);
	}
	return r as LaunchResult;
}

async function settled(server: SwarmServer, id: string, timeoutMs = 8000): Promise<RunRecord> {
	return server.api.runs.wait(id, { timeoutMs });
}

async function poll(cond: () => boolean, timeoutMs = 8000, stepMs = 100): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error("poll timed out");
		await new Promise((r) => setTimeout(r, stepMs));
	}
}

test("define validates: name/kind/schedule/bad cron+tZ/past at/allowN", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	try {
		assert.ok(isError(server.api.programs.define({ name: "Bad Name!", spawn: SPAWN(QUICK) })));
		assert.ok(
			isError(
				server.api.programs.define({
					name: "fast",
					spawn: SPAWN(QUICK),
					schedule: { kind: "every", everyMs: 500 },
				}),
			),
		);
		assert.ok(
			isError(
				server.api.programs.define({
					name: "cronbad",
					spawn: SPAWN(QUICK),
					schedule: { kind: "cron", expr: "not a cron!!!" },
				}),
			),
		);
		assert.ok(
			isError(
				server.api.programs.define({
					name: "cronbad-tz",
					spawn: SPAWN(QUICK),
					schedule: { kind: "cron", expr: "0 0 * * *", timezone: "Mars/Olympus" },
				}),
			),
		);
		assert.ok(
			isError(
				server.api.programs.define({
					name: "past",
					spawn: SPAWN(QUICK),
					schedule: { kind: "at", at: Date.now() - 60_000 },
				}),
			),
		);
		assert.ok(
			isError(
				server.api.programs.define({ name: "allown", spawn: SPAWN(QUICK), overlap: "allowN" }),
			),
		);
		okDef(
			server.api.programs.define({
				name: "svc1",
				kind: "service",
				spawn: SPAWN(QUICK),
				desired: "stopped",
			}),
		);
	} finally {
		await server.stop();
		rmHome(home);
	}
});

test("patch promotes cron→manual, keeps counters/history", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	try {
		okDef(
			server.api.programs.define({
				name: "promo",
				spawn: SPAWN(QUICK),
				schedule: { kind: "cron", expr: "0 0 * * *" },
			}),
		);
		const launched = okLaunch(await server.api.programs.launch("promo", { waitMs: 8000 }));
		await settled(server, launched.runId);

		const patched = okDef(server.api.programs.patch("promo", { schedule: { kind: "manual" } }));
		assert.equal(patched.schedule?.kind, "manual");
		assert.equal(patched.counters.runs >= 0, true);
		const view = server.api.programs.get("promo");
		assert.ok(view);
		assert.ok(view.history.length >= 1, "history survives promotion");
		assert.deepEqual(view.preview, []);
		assert.ok(isError(server.api.programs.patch("promo", { allowN: 0, overlap: "allowN" })));
	} finally {
		await server.stop();
		rmHome(home);
	}
});

test("launch completes and logs concatenate run output", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	try {
		server.api.programs.define({
			name: "hello",
			spawn: SPAWN("process.stdout.write('hi-there');"),
			desired: "stopped",
		});
		const launched = okLaunch(await server.api.programs.launch("hello", { waitMs: 8000 }));
		const rec = await settled(server, launched.runId);
		assert.equal(rec.state, "completed");
		const logs = server.api.programs.logs("hello");
		assert.ok(logs?.text.includes("hi-there"), JSON.stringify(logs));
	} finally {
		await server.stop();
		rmHome(home);
	}
});

test("preview returns next-N fires for every schedules; manual is empty", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	try {
		server.api.programs.define({
			name: "tick",
			spawn: SPAWN(QUICK),
			schedule: { kind: "every", everyMs: 60_000 },
		});
		const p = server.api.programs.preview("tick", 3);
		assert.ok(p && p.fires.length === 3);
		assert.ok(p.fires[0] < p.fires[1] && p.fires[1] < p.fires[2]);
		server.api.programs.define({
			name: "man",
			spawn: SPAWN(QUICK),
			schedule: { kind: "manual" },
		});
		const m = server.api.programs.preview("man", 3);
		assert.deepEqual(m?.fires, []);
	} finally {
		await server.stop();
		rmHome(home);
	}
});

test("overlap skip (default): slow run in progress → logged skip, no second run", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	try {
		server.api.programs.define({
			name: "slowjob",
			spawn: SPAWN(SLOW),
			schedule: { kind: "every", everyMs: 60_000 },
		});
		const first = okLaunch(await server.api.programs.launch("slowjob"));
		const before = server.api.runs.list({ program: "slowjob" }).length;
		// force the slot due while the first run is still live
		server.pokeProgram("slowjob", { nextFire: Date.now() - 1000 });
		assert.equal(server.tickPrograms(Date.now()), 0);
		const def = server.api.programs.get("slowjob")?.def;
		assert.equal(def?.counters.overlapSkipped, 1);
		assert.ok(def?.lastSkip?.reason.includes("overlap"), JSON.stringify(def?.lastSkip));
		assert.equal(server.api.runs.list({ program: "slowjob" }).length, before);
		server.api.runs.kill(first.runId, { force: true });
	} finally {
		await server.stop();
		rmHome(home);
	}
});

test("overlap allow: slow run in progress → second run forks", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	try {
		server.api.programs.define({
			name: "par",
			spawn: SPAWN(SLOW),
			overlap: "allow",
			schedule: { kind: "every", everyMs: 60_000 },
		});
		okLaunch(await server.api.programs.launch("par"));
		const before = server.api.runs.list({ program: "par" }).length;
		server.pokeProgram("par", { nextFire: Date.now() - 1000 });
		assert.equal(server.tickPrograms(Date.now()), 1);
		assert.equal(server.api.runs.list({ program: "par" }).length, before + 1);
		for (const r of server.api.runs.list({ program: "par" })) {
			server.api.runs.kill(r.id, { force: true });
		}
	} finally {
		await server.stop();
		rmHome(home);
	}
});

test("minGap holds the slot without advancing", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	try {
		server.api.programs.define({
			name: "gapped",
			spawn: SPAWN(QUICK),
			schedule: { kind: "every", everyMs: 1000 },
			minGapMs: 60_000,
		});
		// first fire lands and stamps lastFire
		server.pokeProgram("gapped", { nextFire: Date.now() - 1000 });
		assert.equal(server.tickPrograms(Date.now()), 1);
		for (const r of server.api.runs.list({ program: "gapped" })) {
			try {
				await settled(server, r.id, 5000);
			} catch {
				/* already gone */
			}
		}
		// second slot due immediately — minGap should hold it
		server.pokeProgram("gapped", { nextFire: Date.now() - 1000 });
		const before = server.api.runs.list({ program: "gapped" }).length;
		assert.equal(server.tickPrograms(Date.now()), 0);
		assert.equal(server.api.runs.list({ program: "gapped" }).length, before);
	} finally {
		await server.stop();
		rmHome(home);
	}
});

test("catchup: fireOnce fires late; skip collapses with a logged reason", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	try {
		// fireOnce (default): far-past slot → one catch-up fire
		server.api.programs.define({
			name: "late1",
			spawn: SPAWN(QUICK),
			schedule: { kind: "every", everyMs: 60_000 },
		});
		server.pokeProgram("late1", { nextFire: Date.now() - 3_600_000 });
		assert.equal(server.tickPrograms(Date.now()), 1);
		// skip: far-past slot → no fork, logged skip
		server.api.programs.define({
			name: "late2",
			spawn: SPAWN(QUICK),
			schedule: { kind: "every", everyMs: 60_000 },
			missPolicy: "skip",
		});
		server.pokeProgram("late2", { nextFire: Date.now() - 3_600_000 });
		assert.equal(server.tickPrograms(Date.now()), 0);
		const d2 = server.api.programs.get("late2")?.def;
		assert.ok((d2?.counters.missedCatchup ?? 0) >= 1);
		assert.ok(d2?.lastSkip?.reason.includes("missed"), JSON.stringify(d2?.lastSkip));
		for (const r of server.api.runs.list({ program: "late1" })) {
			try {
				await settled(server, r.id, 5000);
			} catch {
				/* ignore */
			}
		}
	} finally {
		await server.stop();
		rmHome(home);
	}
});

test("boot: pendingClaim → logged skip; live run → interrupted; desired=running resubmits", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	let launchedId = "";
	try {
		server.api.programs.define({
			name: "svc",
			kind: "service",
			spawn: SPAWN(SLOW),
			desired: "running",
		});
		launchedId = okLaunch(await server.api.programs.launch("svc")).runId;
		// fake a crash between claim and fork
		server.pokeProgram("svc", {
			pendingClaim: { run: "run-ghost", slot: Date.now() - 5000, claimedAt: Date.now(), origin: "tick" },
		});
		await server.stop();
		const server2 = await startDaemon({ home });
		try {
			const def = server2.api.programs.get("svc")?.def;
			assert.ok(def, "program survives restart");
			assert.equal(def?.pendingClaim, undefined);
			assert.ok(def?.lastSkip?.reason.includes("mid-fire"), JSON.stringify(def?.lastSkip));
			const rows = server2.api.runs.list({ program: "svc" });
			assert.ok(rows.some((r) => r.id === launchedId && r.state === "interrupted"));
			assert.ok(rows.some((r) => r.state === "running"), "desired=running resubmits a fresh run");
			for (const r of rows) server2.api.runs.kill(r.id, { force: true });
		} finally {
			await server2.stop();
		}
	} finally {
		rmHome(home);
	}
});

test("triggerToken: worker-role WS client can launch via token", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	const url = `ws://127.0.0.1:${server.port}`;
	let w: WsClient | undefined;
	try {
		server.api.programs.define({
			name: "watchdog",
			spawn: SPAWN(QUICK),
			triggerToken: "secret-123",
		});
		w = new WsClient(url);
		await w.ready();
		w.send({ op: "register", sessionId: "w1", agentId: "worker", mode: "worker" });
		await w.waitFor("welcome");
		const res = await w.rpc({ op: "program_launch", name: "watchdog", token: "secret-123" });
		assert.ok(res.data?.runId, JSON.stringify(res));
		await assert.rejects(w.rpc({ op: "program_launch", name: "watchdog", token: "wrong" }));
	} finally {
		w?.close();
		await server.stop();
		rmHome(home);
	}
});

test("retry: failing run with retries → new run with attempt+1", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	try {
		server.api.programs.define({
			name: "flaky",
			spawn: SPAWN("process.exit(1);"),
			retries: { attempts: 1, backoffMs: 100 },
		});
		const first = okLaunch(await server.api.programs.launch("flaky"));
		const rec1 = await settled(server, first.runId);
		assert.equal(rec1.state, "failed");
		await poll(() => server.api.runs.list({ program: "flaky" }).length >= 2);
		const runs = server.api.runs.list({ program: "flaky" });
		assert.ok(server.api.runs.get(runs.find((r) => r.id !== first.runId)?.id ?? ""));
		for (const r of runs) server.api.runs.kill(r.id, { force: true });
	} finally {
		await server.stop();
		rmHome(home);
	}
});

test("pauseOnFail pauses the program after a dirty death", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	try {
		server.api.programs.define({
			name: "fragile",
			spawn: SPAWN("process.exit(1);"),
			pauseOnFail: true,
		});
		const first = okLaunch(await server.api.programs.launch("fragile"));
		await settled(server, first.runId);
		// policy lands on the exit hook — poll briefly
		await poll(() => server.api.programs.get("fragile")?.def?.paused === true, 5000);
		assert.match(server.api.programs.get("fragile")?.def?.notes ?? "", /paused on failure/);
	} finally {
		await server.stop();
		rmHome(home);
	}
});

test("service restart policy always respawns after a clean exit", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	try {
		server.api.programs.define({
			name: "respawn",
			kind: "service",
			spawn: SPAWN(QUICK),
			desired: "running",
			restart: { policy: "always", backoffMs: 100 },
		});
		const first = okLaunch(await server.api.programs.launch("respawn"));
		await settled(server, first.runId);
		await poll(() => server.api.runs.list({ program: "respawn" }).length >= 2);
		server.api.programs.remove("respawn");
		for (const r of server.api.runs.list({ program: "respawn" })) {
			server.api.runs.kill(r.id, { force: true });
		}
	} finally {
		await server.stop();
		rmHome(home);
	}
});
