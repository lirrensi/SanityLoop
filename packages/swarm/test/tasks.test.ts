// ============================================================================
// tasks.test.ts — named fire-and-die definitions: define validation, fire via
// the shared fork path (task:<name>#<n> parent), pause/resume gating, the
// 60s clock tick (driven deterministically via tickTasks — no fake timers,
// the fire path forks real processes), and atomic write-through.
//
// Durable fires (phase 3): every slot is claimed (runs++ + nextFire advanced
// + persisted) BEFORE the fork — a crash can't refire. Late-within-grace
// fires late; past-grace collapses to ONE catch-up fire with a logged reason
// (never a fork storm, never silent); `trigger` is the paused-immune manual
// path with transient context and at-most-once claims.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startDaemon, WsClient, tmpHome, rmHome } from "./harness.ts";

const IDLE_TS = `setTimeout(() => process.exit(0), 500);\n`;

function seedTemplates(home: string): string {
	const tdir = join(home, "templates");
	mkdirSync(tdir, { recursive: true });
	writeFileSync(join(tdir, "idle.ts"), IDLE_TS);
	writeFileSync(join(tdir, "job.json"), JSON.stringify({ id: "job", file: "idle.ts" }));
	return tdir;
}

test("define validates: every needs everyMs, at needs at, manual needs nothing", async () => {
	const home = tmpHome();
	const tdir = seedTemplates(home);
	try {
		const server = await startDaemon({ home, templatesDir: tdir });
		assert.equal(server.api.tasks.define({ name: "bad", fire: "every" }), null);
		assert.equal(server.api.tasks.define({ name: "bad", fire: "at" }), null);
		assert.equal(server.api.tasks.define({ name: "bad2", fire: "every", everyMs: -5 }), null);
		const ok = server.api.tasks.define({ name: "poll", fire: "every", everyMs: 60_000, from: "job" })!;
		assert.equal(ok.name, "poll");
		assert.ok(typeof ok.nextFire === "number", "every schedules nextFire");
		const at = server.api.tasks.define({ name: "once", fire: "at", at: Date.now() + 3_600_000, from: "job" })!;
		assert.ok(typeof at.nextFire === "number");
		const man = server.api.tasks.define({ name: "cli", fire: "manual", from: "job" })!;
		assert.equal(man.nextFire, undefined, "manual never self-fires");
		assert.ok(existsSync(join(home, "tasks.json")), "write-through on define");
		await server.stop();
	} finally {
		rmHome(home);
	}
});

test("fire forks once via the shared path; pause gates the clock; tickTasks fires due work", async () => {
	const home = tmpHome();
	const tdir = seedTemplates(home);
	try {
		const server = await startDaemon({ home, templatesDir: tdir });
		server.api.tasks.define({ name: "poll", fire: "every", everyMs: 50, from: "job" })!;
		const f1 = (await server.api.tasks.fire("poll"))!;
		assert.equal(f1.run, 1);
		assert.ok(f1.sessionId.startsWith("swarm-"), "fresh session per fire");
		assert.ok(typeof f1.pid === "number");

		// pause gates the clock: force nextFire into the past, tick, expect nothing
		server.api.tasks.pause("poll");
		server.pokeTask("poll", { nextFire: Date.now() - 1_000 });
		assert.equal(server.tickTasks(), 0, "paused tasks never fire");

		// resume → the same overdue beat fires exactly once
		server.api.tasks.resume("poll");
		assert.equal(server.tickTasks(), 1, "due every task fires once per tick");
		const after = server.api.tasks.get("poll")!;
		assert.equal(after.runs, 2, "run counter advanced");
		await server.stop();
	} finally {
		rmHome(home);
	}
});

test("at tasks fire once then clear; task WS frames round-trip; parent stamps", async () => {
	const home = tmpHome();
	const tdir = seedTemplates(home);
	try {
		const server = await startDaemon({ home, templatesDir: tdir });
		const url = `ws://127.0.0.1:${server.port}`;
		const admin = new WsClient(url);
		await admin.ready();
		admin.send({ op: "register", sessionId: "a1", agentId: "admin", mode: "admin" });
		await admin.waitFor("welcome");
		try {
			server.api.tasks.define({ name: "once", fire: "at", at: Date.now() - 1, from: "job" })!;
			assert.equal(server.tickTasks(), 1, "overdue at task fires");
			const def = server.api.tasks.get("once")!;
			assert.equal(def.runs, 1);
			assert.equal(def.nextFire, undefined, "one-shot consumed");
			assert.equal(server.tickTasks(), 0, "no double-fire after consume");

			// WS door: task_fire returns { name, run, sessionId, pid }
			server.api.tasks.define({ name: "m", fire: "manual", from: "job" })!;
			const res = await admin.rpc({ op: "task_fire", name: "m" });
			assert.equal(res.data.name, "m");
			assert.equal(res.data.run, 1);

			// the forked child reports SWARM_SPAWN_ID as its parent once it joins.
			// (idle fixture exits fast without joining, so assert the wire shape
			// instead: a register carrying spawnId echoes it as parent.)
			const wild = new WsClient(url);
			await wild.ready();
			wild.send({ op: "register", sessionId: "w1", agentId: "worker", mode: "worker", spawnId: "task:m#1" });
			await wild.waitFor("welcome");
			const ag = (await admin.rpc({ op: "agents_get", sessionId: "w1" })).data;
			assert.equal(ag.parent, "task:m#1", "spawnId echoed as parent");
			const wild2 = new WsClient(url);
			await wild2.ready();
			wild2.send({ op: "register", sessionId: "w2", agentId: "worker", mode: "worker" });
			await wild2.waitFor("welcome");
			const ag2 = (await admin.rpc({ op: "agents_get", sessionId: "w2" })).data;
			assert.equal(ag2.parent, undefined, "wild agents list parentless");
			wild.close();
			wild2.close();
		} finally {
			admin.close();
		}
		await server.stop();
	} finally {
		rmHome(home);
	}
});

test("pause/resume/remove frames round-trip over WS", async () => {
	const home = tmpHome();
	const tdir = seedTemplates(home);
	try {
		const server = await startDaemon({ home, templatesDir: tdir });
		const url = `ws://127.0.0.1:${server.port}`;
		const admin = new WsClient(url);
		await admin.ready();
		admin.send({ op: "register", sessionId: "a1", agentId: "admin", mode: "admin" });
		await admin.waitFor("welcome");
		try {
			await admin.rpc({ op: "task_define", name: "t1", fire: "manual", from: "job" });
			await admin.rpc({ op: "task_pause", name: "t1", paused: true });
			assert.equal(server.api.tasks.get("t1")!.paused, true);
			await admin.rpc({ op: "task_resume", name: "t1" });
			assert.equal(server.api.tasks.get("t1")!.paused, false);
			const listed = (await admin.rpc({ op: "task_list" })).data;
			assert.ok(listed.find((t: { name: string }) => t.name === "t1"));
			await admin.rpc({ op: "task_remove", name: "t1" });
			assert.equal(server.api.tasks.get("t1"), null);
		} finally {
			admin.close();
		}
		await server.stop();
	} finally {
		rmHome(home);
	}
});

test("durable: pre-dispatch advance — nextFire moves before the fork lands", async () => {
	const home = tmpHome();
	const tdir = seedTemplates(home);
	try {
		const server = await startDaemon({ home, templatesDir: tdir });
		const now = Date.now();
		server.api.tasks.define({ name: "poll", fire: "every", everyMs: 3_600_000, from: "job" })!;
		server.pokeTask("poll", { nextFire: now - 1_000 });
		assert.equal(server.tickTasks(), 1, "overdue-within-grace slot claimed");
		// The claim is synchronous; the fork lands async. nextFire already
		// advanced past now even though the child may not have exited yet.
		const after = server.api.tasks.get("poll")!;
		assert.equal(after.runs, 1);
		assert.equal(after.lastSlot, now - 1_000, "fire identity stamps the due slot");
		assert.ok((after.nextFire ?? 0) > now, "nextFire advanced BEFORE the fork");
		assert.ok(after.pendingFire, "claim in flight until the fork settles");
		await server.stop();
	} finally {
		rmHome(home);
	}
});

test("durable: late-within-grace fires late; past-grace collapses to one catch-up", async () => {
	const home = tmpHome();
	const tdir = seedTemplates(home);
	try {
		const server = await startDaemon({ home, templatesDir: tdir });
		// grace = half period clamped [120s, 2h]. everyMs 600s → grace 300s.
		server.api.tasks.define({ name: "late", fire: "every", everyMs: 600_000, from: "job" })!;
		const base = Date.now();
		server.pokeTask("late", { nextFire: base - 60_000 });
		assert.equal(server.tickTasks(), 1, "60s late < 300s grace → fires late");
		const fired = server.api.tasks.get("late")!;
		assert.equal(fired.runs, 1);
		assert.equal(fired.lastCatchup, undefined, "within grace: no catch-up logged");

		// Past grace: four missed slots collapse into ONE fire with a logged reason.
		server.api.tasks.define({ name: "stale", fire: "every", everyMs: 600_000, from: "job" })!;
		server.pokeTask("stale", { nextFire: base - 2_500_000 });
		assert.equal(server.tickTasks(), 1, "past-grace → exactly one catch-up fire");
		const caught = server.api.tasks.get("stale")!;
		assert.equal(caught.runs, 1, "ONE fire, not one per missed slot");
		assert.ok(caught.lastCatchup, "the collapse is logged on the def");
		assert.ok((caught.lastCatchup?.missed ?? 0) >= 4, "miss count recorded");
		assert.ok((caught.nextFire ?? 0) > base, "schedule marches on from the catch-up");
		await server.stop();
	} finally {
		rmHome(home);
	}
});

test("durable: past-grace `at` logs a skip instead of forking a stale moment", async () => {
	const home = tmpHome();
	const tdir = seedTemplates(home);
	try {
		const server = await startDaemon({ home, templatesDir: tdir });
		const base = Date.now();
		server.api.tasks.define({ name: "once", fire: "at", at: base - 300_000, from: "job" })!;
		assert.equal(server.tickTasks(), 0, "stale one-shot never forks");
		const def = server.api.tasks.get("once")!;
		assert.equal(def.runs, 0, "no run recorded");
		assert.equal(def.at, undefined, "one-shot consumed");
		assert.ok(def.lastSkipped, "the slot is accounted — logged, never silent");
		assert.equal(def.lastSkipped?.slot, base - 300_000, "skip stamps the due slot");
		assert.equal(server.tickTasks(), 0, "no double-accounting on the next tick");
		await server.stop();
	} finally {
		rmHome(home);
	}
});

test("trigger: paused-immune manual run, transient context, schedule untouched, at-most-once", async () => {
	const home = tmpHome();
	const tdir = seedTemplates(home);
	try {
		const server = await startDaemon({ home, templatesDir: tdir });
		server.api.tasks.define({ name: "poll", fire: "every", everyMs: 3_600_000, from: "job" })!;
		const scheduled = server.api.tasks.get("poll")!.nextFire;
		server.api.tasks.pause("poll");
		// fire is refused on a paused task — the trigger door is the manual path.
		assert.equal(await server.api.tasks.fire("poll"), null, "paused fire refused — use trigger");
		const first = server.api.tasks.trigger("poll", { context: "manual sweep" });
		// The claim lands synchronously (next line), the fork settles async.
		const claimed = server.api.tasks.get("poll")!;
		assert.equal(claimed.runs, 1, "trigger claims the fire identity first");
		assert.equal(claimed.nextFire, scheduled, "trigger never moves the schedule");
		assert.ok(claimed.lastTrigger, "latest trigger recorded");
		assert.ok(claimed.pendingFire, "claim in flight until the fork settles");
		// Concurrent trigger while the claim is in flight → busy, not a double fire.
		const busy = (await server.api.tasks.trigger("poll")) as { busy: boolean; name: string };
		assert.equal(busy.busy, true, "at-most-once: second concurrent trigger refused");
		const t = (await first) as { name: string; run: number; sessionId: string };
		assert.equal(t.name, "poll");
		assert.equal(t.run, 1);
		assert.ok(t.sessionId.startsWith("swarm-"));
		const after = server.api.tasks.get("poll")!;
		assert.equal(after.runs, 1, "no double claim across the concurrent window");
		assert.equal(after.pendingFire, undefined, "fork settled — claim cleared");
		// Definition untouched: only identity + bookkeeping moved.
		assert.equal(after.everyMs, 3_600_000);
		assert.equal(after.paused, true, "still paused after a manual run");
		await server.stop();
	} finally {
		rmHome(home);
	}
});

test("trigger: WS + REST doors, transient context never stored", async () => {
	const home = tmpHome();
	const tdir = seedTemplates(home);
	try {
		const server = await startDaemon({ home, templatesDir: tdir });
		const url = `ws://127.0.0.1:${server.port}`;
		const admin = new WsClient(url);
		await admin.ready();
		admin.send({ op: "register", sessionId: "a1", agentId: "admin", mode: "admin" });
		await admin.waitFor("welcome");
		try {
			server.api.tasks.define({ name: "m", fire: "manual", from: "job" })!;
			const res = await admin.rpc({ op: "task_trigger", name: "m", context: "one-off sweep" });
			assert.equal(res.data.name, "m");
			assert.equal(res.data.run, 1);
			const def = server.api.tasks.get("m")!;
			assert.equal(def.lastTrigger?.run, 1);
			const stored = JSON.parse(readFileSync(join(home, "tasks.json"), "utf8")) as {
				rows: Array<Record<string, unknown>>;
			};
			const row = stored.rows.find((r) => r.name === "m")!;
			assert.equal(row.context, undefined, "transient context never persisted");
			assert.equal(row.prompt, undefined, "no prompt residue on the definition");

			// REST door: the same op, the same shape — sent WITHOUT awaiting
			// the WS trigger, so the two race for the one claim. Exactly one
			// wins (200), the other is refused busy (409): at-most-once
			// holds across surfaces.
			const wsSecond = admin.rpc({ op: "task_trigger", name: "m", context: "two" });
			const base = `http://127.0.0.1:${server.port}/api/v1`;
			const httpP = fetch(base + "/tasks/m/trigger", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ context: "via rest" }),
			});
			const [wsSettled, http] = await Promise.all([
				wsSecond.then(
					(r) => ({ ok: true as const, data: r.data }),
					(e: Error) => ({ ok: false as const, error: e.message }),
				),
				httpP,
			]);
			const httpBody = await http.json().catch(() => null);
			const wins = [wsSettled.ok ? "ws" : "ws-busy", http.status === 200 ? "http" : "http-busy"];
			assert.ok(
				wins.filter((w) => w === "ws" || w === "http").length === 1,
				`exactly one trigger wins across WS+REST (got ${wins.join("+")}, http=${http.status} ${JSON.stringify(httpBody)?.slice(0, 120)})`,
			);
		} finally {
			admin.close();
		}
		await server.stop();
	} finally {
		rmHome(home);
	}
});

test("durable: boot converts a crash-window pendingFire into a logged skip (never refire)", async () => {
	const home = tmpHome();
	const tdir = seedTemplates(home);
	try {
		const server = await startDaemon({ home, templatesDir: tdir });
		server.api.tasks.define({ name: "poll", fire: "every", everyMs: 3_600_000, from: "job" })!;
		// Simulate kill -9 between claim and fork: runs bumped, schedule
		// advanced past now (next slot an hour out), fork never confirmed —
		// exactly what tasks.json holds after a real crash in that window.
		const slot = Date.now() - 5_000;
		server.pokeTask("poll", {
			runs: 1,
			lastSlot: slot,
			nextFire: slot + 3_600_000,
			pendingFire: { run: 1, slot, claimedAt: Date.now(), origin: "tick" },
		});
		await server.stop();
		const server2 = await startDaemon({ home, templatesDir: tdir });
		const def = server2.api.tasks.get("poll")!;
		assert.equal(def.pendingFire, undefined, "crash window cleared at boot");
		assert.ok(def.lastSkipped, "slot accounted exactly once — as a logged skip");
		assert.equal(def.lastSkipped?.slot, slot);
		assert.equal(def.runs, 1, "no refire: the run count stands");
		assert.equal(server2.tickTasks(), 0, "nothing due: no phantom fire after reboot");
	} finally {
		rmHome(home);
	}
});
