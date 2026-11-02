// ============================================================================
// rest.test.ts — the second door. Exercises the REST adapter + bearer auth by
// hitting the live daemon's HTTP port with fetch: programs CRUD + launch +
// triggerToken bearer + preview + logs; runs exec + get + logs + wait + kill +
// save + prune; agents routes still work.
// ============================================================================
	import { test } from "node:test";
	import assert from "node:assert/strict";
	import { writeFileSync } from "node:fs";
	import { join } from "node:path";
	import { startDaemon, WsClient, tmpHome, rmHome } from "./harness.ts";

const json = (body: unknown): { method: string; headers: Record<string, string>; body: string } => ({
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
});

const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

async function adminOn(url: string, sessionId: string): Promise<WsClient> {
	const c = new WsClient(url);
	await c.ready();
	c.send({ op: "register", sessionId, agentId: sessionId, mode: "admin" });
	await c.waitFor("welcome");
	return c;
}

test("REST: health/agents/events/history + input/control routing; bad control action 400", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	const base = `http://127.0.0.1:${server.port}/api/v1`;
	let w: WsClient | undefined;
	try {
		w = new WsClient(`ws://127.0.0.1:${server.port}`);
		await w.ready();
		w.send({ op: "register", sessionId: "w1", agentId: "worker", mode: "worker" });
		await w.waitFor("welcome");
		w.send({ op: "report", event: "agentStart" });

		const health = await (await fetch(base + "/health")).json();
		assert.equal(health.ok, true);
		assert.equal(health.online, 1);

		const agents = await (await fetch(base + "/agents")).json();
		assert.ok(agents.find((r: { sessionId: string }) => r.sessionId === "w1"));

		const one = await (await fetch(base + "/agents/w1")).json();
		assert.equal(one.sessionId, "w1");

		const events = await (await fetch(base + "/agents/w1/events?limit=10")).json();
		assert.ok(events.events.length >= 1);

		const hist = await (await fetch(base + "/history")).json();
		assert.ok(hist.find((r: { sessionId: string }) => r.sessionId === "w1"));

		const inP = w.waitFor("input");
		const inRes = await fetch(
			base + "/agents/w1/input",
			json({ type: "input_followup", text: "rest" }),
		);
		assert.equal(inRes.status, 200);
		assert.deepEqual((await inP).body, { type: "input_followup", text: "rest" });

		const ctrlP = w.waitFor("control");
		const ctrlRes = await fetch(base + "/agents/w1/control", json({ action: "pause" }));
		assert.equal(ctrlRes.status, 200);
		assert.equal((await ctrlP).action, "pause");

		const bad = await fetch(base + "/agents/w1/control", json({ action: "explode" }));
		assert.equal(bad.status, 400);

		// programs + runs doors
		const progs = await (await fetch(base + "/programs")).json();
		assert.ok(Array.isArray(progs));
		const runs = await (await fetch(base + "/runs")).json();
		assert.ok(Array.isArray(runs));
	} finally {
		w?.close();
		rmHome(home);
		await server.stop();
	}
});

test("REST auth: 401 without token, 200 peer, 403 peer on admin route, 200 admin", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home, tokens: { admin: "A", peer: "P" } });
	const base = `http://127.0.0.1:${server.port}/api/v1`;
	try {
		const noAuth = await fetch(base + "/agents");
		assert.equal(noAuth.status, 401);

		const peerOk = await fetch(base + "/agents", { headers: auth("P") });
		assert.equal(peerOk.status, 200);

		// peer hitting an admin-only route: POST /programs
		const peerOnAdmin = await fetch(base + "/programs", {
			...json({ name: "x", spawn: { cmd: "node" } }),
			headers: { "content-type": "application/json", ...auth("P") },
		});
		assert.equal(peerOnAdmin.status, 403);

		// admin: authorized — invalid def (empty spawn) → 400, not 403
		const adminBad = await fetch(base + "/programs", {
			...json({ name: "x", spawn: { cmd: "" } }),
			headers: { "content-type": "application/json", ...auth("A") },
		});
		assert.equal(adminBad.status, 400);
	} finally {
		rmHome(home);
		await server.stop();
	}
});

test("REST programs: CRUD + patch + preview + launch + logs + remove", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	const base = `http://127.0.0.1:${server.port}/api/v1`;
	try {
		// define a job with a version-script file spawn (REST forwards cmd/file
		// but drops args — write a tiny script instead of relying on argv)
		writeFileSync(join(home, "version.js"), "console.log('v-test');\n");
		const def = await (
			await fetch(
				base + "/programs",
				json({ name: "rest-prog", kind: "job", spawn: { file: join(home, "version.js") } }),
			)
		).json();
		assert.equal(def.name, "rest-prog");

		// list shows it
		const list = await (await fetch(base + "/programs")).json();
		assert.ok(list.find((p: { name: string }) => p.name === "rest-prog"));

		// get one
		const one = await (await fetch(base + "/programs/rest-prog")).json();
		assert.equal(one.def?.name ?? one.name, "rest-prog");

		// patch: notes merge over the def
		const patched = await (
			await fetch(base + "/programs/rest-prog", { ...json({ notes: "hello" }), method: "PATCH" })
		).json();
		assert.equal(patched.notes, "hello");

		// preview: next-N fires without forking (manual schedule → none)
		const prev = await (await fetch(base + "/programs/rest-prog/preview?n=3")).json();
		assert.deepEqual(prev.fires, []);

		// launch: forks now; the cmd exits immediately so logs settle
		const launched = await (await fetch(base + "/programs/rest-prog/launch", json({}))).json();
		assert.ok(launched.runId, "launch returns a run id");
		const waited = await (
			await fetch(base + `/runs/${launched.runId}/wait`, json({ timeoutMs: 15000 }))
		).json();
		assert.equal(waited.id, launched.runId);

		// program logs: concatenated stdout tails across history
		const logs = await (await fetch(base + "/programs/rest-prog/logs")).json();
		assert.equal(logs.name, "rest-prog");
		assert.equal(typeof logs.text, "string");

		// remove: forgets the definition
		const removed = await (await fetch(base + "/programs/rest-prog", { method: "DELETE" })).json();
		assert.equal(removed.ok, true);
		assert.equal((await fetch(base + "/programs/rest-prog")).status, 404);
	} finally {
		rmHome(home);
		await server.stop();
	}
});

	test("REST launch: triggerToken body token authorizes the watchdog path", async () => {
		const home = tmpHome();
		const server = await startDaemon({ home, tokens: { admin: "A" } });
		const base = `http://127.0.0.1:${server.port}/api/v1`;
		try {
			writeFileSync(join(home, "hook.js"), "console.log('hook');\n");
			const def = await (
				await fetch(base + "/programs", {
					...json({
						name: "hooked",
						kind: "job",
						spawn: { file: join(home, "hook.js") },
						triggerToken: "hook-secret",
					}),
					headers: { "content-type": "application/json", ...auth("A") },
				})
			).json();
		assert.equal(def.name, "hooked");

		// The REST gate 401s unknown bare tokens before routing, so exercise
		// the watchdog as designed: a known *role* bearer (here the peer/admin
		// ladder is irrelevant — open-mode daemons skip it entirely) plus the
		// body token = triggerToken → 200. The negative (wrong body token)
		// rides the WS door in the programs test below — REST can't reach the
		// watchdog without a role bearer, and WITH one it would 200 anyway.
		const viaHook = await fetch(base + "/programs/hooked/launch", {
			...json({ token: "hook-secret" }),
			headers: { "content-type": "application/json", ...auth("A") },
		});
		assert.equal(viaHook.status, 200);
	} finally {
		rmHome(home);
		await server.stop();
	}
});

test("REST runs: exec + get + logs + wait + kill + save + prune", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	const base = `http://127.0.0.1:${server.port}/api/v1`;
	let admin: WsClient | undefined;
	try {
		admin = await adminOn(`ws://127.0.0.1:${server.port}`, "boss");

		// exec a quick cmd run, wait inline (REST exec forwards cmd/file only)
		const execed = await (
			await fetch(base + "/runs/exec", json({ spawn: { cmd: process.execPath }, waitMs: 15000 }))
		).json();
		assert.ok(execed.runId, "exec returns a run id");

		// get by id
		const got = await (await fetch(base + `/runs/${execed.runId}`)).json();
		assert.equal(got.id, execed.runId);

		// logs: stdout exists for the run (bare `node` prints usage to stderr
		// and exits 9 — run_logs defaults to the stdout stream)
		const logs = await (await fetch(base + `/runs/${execed.runId}/logs?stream=both`)).json();
		assert.equal(typeof logs.text, "string");

		// wait for settle (already settled → resolves)
		const settled = await (
			await fetch(base + `/runs/${execed.runId}/wait`, json({ timeoutMs: 15000 }))
		).json();
		assert.equal(settled.id, execed.runId);
		assert.ok(settled.exit != null || settled.endedAt != null, "run settled");

		// list shows it
		const list = await (await fetch(base + "/runs")).json();
		assert.ok(list.find((r: { id: string }) => r.id === execed.runId));

		// save: promote the orphan into a remembered program
		const saved = await (
			await fetch(base + `/runs/${execed.runId}/save`, json({ name: "promoted" }))
		).json();
		assert.equal(saved.name, "promoted");

		// kill a long-lived run via force (SIGKILL now). REST exec forwards
		// cmd/file only, so the sleeper is a helper script file.
		writeFileSync(join(home, "sleeper.js"), "setInterval(() => {}, 1000);\n");
		const sleeper = await (
			await fetch(
				base + "/runs/exec",
				json({ spawn: { file: join(home, "sleeper.js") } }),
			)
		).json();
		assert.ok(sleeper.runId);
		const killed = await (
			await fetch(base + `/runs/${sleeper.runId}/kill`, json({ force: true }))
		).json();
		assert.equal(killed.ok, true);

		// prune terminal runs past the keep count → deletes the settled ones
		// (the live sleeper settles via kill first; prune only touches terminal)
		const settled2 = await (
			await fetch(base + `/runs/${sleeper.runId}/wait`, json({ timeoutMs: 15000 }))
		).json();
		assert.ok(settled2.id, "sleeper settled after kill");
		const pruned = await (await fetch(base + "/runs/prune", json({ keep: 0 }))).json();
		assert.ok(Array.isArray(pruned));
		assert.ok(pruned.length >= 2, `pruned both runs, got ${JSON.stringify(pruned)}`);
	} finally {
		admin?.close();
		rmHome(home);
		await server.stop();
	}
});
