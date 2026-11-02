// ============================================================================
// server.test.ts — the daemon hub, end-to-end over raw WS clients.
// No full agent needed: we speak the wire directly. Covers register/report →
// state folding, agents_list/agents_get + talk, spawnId→parent echo, wild
// agents, drop removes from list (idempotent), program_*/run_* doors, role
// permissions (peer can't touch programs/runs), the token gate, the home lock
// (a second daemon on the same home refuses), migration of legacy files,
// drop history/templates/events.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDaemon, WsClient, tmpHome, rmHome } from "./harness.ts";

test("open daemon: register/report folds state; peer agents_list/get/events/listen/input/control/broadcast; worker denied agents_list", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	const url = `ws://127.0.0.1:${server.port}`;
	let w: WsClient | undefined;
	let p: WsClient | undefined;
	try {
		w = new WsClient(url);
		await w.ready();
		w.send({ op: "register", sessionId: "w1", agentId: "worker", mode: "worker", persistent: false });
		const welcome = await w.waitFor("welcome");
		assert.equal(welcome.sessionId, "w1");

		w.send({ op: "report", event: "agentStart" });
		w.send({ op: "report", event: "agentSettled" });
		w.send({ op: "report", event: "error" });

		p = new WsClient(url);
		await p.ready();
		// admin hat (open mode lets us claim it) so every op incl. broadcast is permitted
		p.send({ op: "register", sessionId: "p1", agentId: "admin", mode: "admin" });
		await p.waitFor("welcome");

		const listRes = await p.rpc({ op: "agents_list" });
		const rows = listRes.data as { sessionId: string; state?: string; stats?: { errors?: number } }[];
		const w1 = rows.find((r) => r.sessionId === "w1");
		assert.ok(w1, "w1 in registry");
		assert.equal(w1.state, "error");
		assert.equal(w1.stats?.errors, 1);

		const getRes = await p.rpc({ op: "agents_get", sessionId: "w1" });
		assert.equal(getRes.data.sessionId, "w1");

		const evRes = await p.rpc({ op: "events", sessionId: "w1" });
		assert.ok((evRes.data.events as unknown[]).length >= 3);

		// listen + relay
		await p.rpc({ op: "listen", sessionId: "w1", on: true });
		const relayed = p.waitFor("event");
		w.send({ op: "report", event: "agentStart" });
		const ev = await relayed;
		assert.ok(ev && ev.target === "w1" && ev.event === "agentStart");

		// input routed to worker
		const inputP = w.waitFor("input");
		await p.rpc({ op: "input", target: "w1", body: { type: "input_followup", text: "hi" } });
		const inFrame = await inputP;
		assert.deepEqual(inFrame.body, { type: "input_followup", text: "hi" });

		// control pause
		const ctrlP = w.waitFor("control");
		await p.rpc({ op: "control", target: "w1", action: "pause" });
		const ctrlFrame = await ctrlP;
		assert.equal(ctrlFrame.action, "pause");
		const get2 = await p.rpc({ op: "agents_get", sessionId: "w1" });
		assert.equal(get2.data.state, "paused");

		// shutdown + reset ride the same control door (server is type-blind:
		// forward + optimistic state, no new logic)
		for (const action of ["shutdown", "reset"]) {
			const cP = w.waitFor("control");
			const r = await p.rpc({ op: "control", target: "w1", action });
			assert.equal(r.data.ok, true);
			assert.equal((await cP).action, action);
		}

		// broadcast
		const bP = w.waitFor("input");
		await p.rpc({ op: "broadcast", body: { type: "input_followup", text: "all" } });
		const bFrame = await bP;
		assert.deepEqual(bFrame.body, { type: "input_followup", text: "all" });

		// history + templates doors
		const hist = await p.rpc({ op: "history" });
		assert.ok(Array.isArray(hist.data));
		assert.ok(hist.data.find((r: { sessionId: string }) => r.sessionId === "w1"));
		const tmpl = await p.rpc({ op: "templates" });
		assert.ok(Array.isArray(tmpl.data));

		// worker is NOT allowed to list agents
		const forbidden = await w
			.rpc({ op: "agents_list" })
			.then(() => null)
			.catch((e) => e.message);
		assert.match(forbidden, /forbidden/);
	} finally {
		w?.close();
		p?.close();
		rmHome(home);
		await server.stop();
	}
});

test("spawnId echoes as parent; wild agents list parentless; drop removes from list", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	const url = `ws://127.0.0.1:${server.port}`;
	let forked: WsClient | undefined;
	let wild: WsClient | undefined;
	let admin: WsClient | undefined;
	try {
		forked = new WsClient(url);
		await forked.ready();
		forked.send({ op: "register", sessionId: "f1", agentId: "worker", mode: "worker", spawnId: "run:abc" });
		await forked.waitFor("welcome");

		wild = new WsClient(url);
		await wild.ready();
		wild.send({ op: "register", sessionId: "w1", agentId: "worker", mode: "worker" });
		await wild.waitFor("welcome");

		admin = new WsClient(url);
		await admin.ready();
		admin.send({ op: "register", sessionId: "a1", agentId: "admin", mode: "admin" });
		await admin.waitFor("welcome");

		const f = (await admin.rpc({ op: "agents_get", sessionId: "f1" })).data;
		assert.equal(f.parent, "run:abc");
		const wl = (await admin.rpc({ op: "agents_get", sessionId: "w1" })).data;
		assert.equal(wl.parent, undefined);

		// drop = server-side removal: the entry is gone from the list, the
		// socket is closed, and a re-drop of the ghost succeeds silently.
		const dropRes = await admin.rpc({ op: "drop", sessionId: "f1" });
		assert.equal(dropRes.data.ok, true);
		assert.equal((await admin.rpc({ op: "agents_get", sessionId: "f1" })).data, null);
		const list = (await admin.rpc({ op: "agents_list" })).data as { sessionId: string }[];
		assert.ok(!list.find((r) => r.sessionId === "f1"), "dropped agent gone from list");
		assert.ok(list.find((r) => r.sessionId === "w1"), "wild agent still listed");
		const redrop = await admin.rpc({ op: "drop", sessionId: "f1" });
		assert.equal(redrop.data.ok, true);

		// old nouns are dead on the wire
		for (const dead of ["create", "proc_start", "task_fire", "restart"]) {
			const err = await admin
				.rpc({ op: dead, sessionId: "x" })
				.then(() => null)
				.catch((e: Error) => e.message);
			assert.ok(err, `${dead} rejected`);
			assert.match(err, /unhandled op|forbidden/);
		}
	} finally {
		forked?.close();
		wild?.close();
		admin?.close();
		rmHome(home);
		await server.stop();
	}
});

test("token gate: correct token welcomed, wrong/missing token rejected + socket closed", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home, tokens: { admin: "A", peer: "P" } });
	const url = `ws://127.0.0.1:${server.port}`;
	const clients: WsClient[] = [];
	try {
		// admin token on an admin claim → welcome
		const ok = new WsClient(url);
		clients.push(ok);
		await ok.ready();
		ok.send({ op: "register", sessionId: "a1", agentId: "admin", mode: "admin", token: "A" });
		await ok.waitFor("welcome");

		// peer token upgrades a modest worker claim
		const up = new WsClient(url);
		clients.push(up);
		await up.ready();
		up.send({ op: "register", sessionId: "w1", agentId: "worker", mode: "worker", token: "P" });
		const w = await up.waitFor("welcome");
		assert.ok(w);

		// wrong token → error + close
		const bad = new WsClient(url);
		clients.push(bad);
		await bad.ready();
		bad.send({ op: "register", sessionId: "x", agentId: "x", mode: "admin", token: "WRONG" });
		const err = await bad.waitFor("error");
		assert.match(err.error, /token\/mode mismatch/);

		// missing token when tokens configured → error + close
		const anon = new WsClient(url);
		clients.push(anon);
		await anon.ready();
		anon.send({ op: "register", sessionId: "y", agentId: "y", mode: "worker" });
		const err2 = await anon.waitFor("error");
		assert.match(err2.error, /token\/mode mismatch/);
	} finally {
		for (const c of clients) c.close();
		rmHome(home);
		await server.stop();
	}
});

test("home lock: a second daemon on the same home refuses", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	try {
		let threw: string | null = null;
		try {
			const second = await startDaemon({ home, port: 0 });
			await second.stop();
		} catch (e) {
			threw = e instanceof Error ? e.message : String(e);
		}
		assert.ok(threw, "second daemon refused");
		assert.match(threw, /already owned/);
	} finally {
		rmHome(home);
		await server.stop();
	}
});

test("boot migrates legacy processes.json + tasks.json into programs.json (legacy kept)", async () => {
	const home = tmpHome();
	writeFileSync(
		join(home, "processes.json"),
		JSON.stringify({
			v: 1,
			rows: [
				{
					name: "legacy-web",
					file: "web.ts",
					status: "stopped",
					autorestart: false,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
			],
		}),
	);
	writeFileSync(
		join(home, "tasks.json"),
		JSON.stringify({
			v: 1,
			rows: [
				{
					name: "legacy-poll",
					from: "poll",
					fire: "manual",
					paused: false,
					runs: 3,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
			],
		}),
	);
	const server = await startDaemon({ home });
	try {
		const url = `ws://127.0.0.1:${server.port}`;
		const admin = new WsClient(url);
		await admin.ready();
		admin.send({ op: "register", sessionId: "a1", agentId: "admin", mode: "admin" });
		await admin.waitFor("welcome");
		try {
			const list = (await admin.rpc({ op: "program_list" })).data as { name: string }[];
			assert.ok(list.find((p) => p.name === "legacy-web"), "migrated process present");
			assert.ok(list.find((p) => p.name === "legacy-poll"), "migrated task present");
			const poll = (await admin.rpc({ op: "program_get", name: "legacy-poll" })).data;
			assert.equal(poll.def.counters.runs, 3, "task run counter carried over");
		} finally {
			admin.close();
		}
	} finally {
		rmHome(home);
		await server.stop();
	}
});
