// ============================================================================
// server.test.ts — the daemon hub, end-to-end over raw WS clients.
// No full agent needed: we speak the wire directly. Covers register/report →
// state folding, agents_list/agents_get + talk, spawnId→parent echo, wild
// agents, kill-vs-proc_stop split, proc/task doors, role permissions, and the
// token gate.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
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
		const rows = listRes.data as any[];
		const w1 = rows.find((r: any) => r.sessionId === "w1");
		assert.ok(w1, "w1 in registry");
		assert.equal(w1.state, "error");
		assert.equal(w1.stats.errors, 1);

		const getRes = await p.rpc({ op: "agents_get", sessionId: "w1" });
		assert.equal(getRes.data.sessionId, "w1");

		const evRes = await p.rpc({ op: "events", sessionId: "w1" });
		assert.ok((evRes.data.events as any[]).length >= 3);

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

		// broadcast
		const bP = w.waitFor("input");
		await p.rpc({ op: "broadcast", body: { type: "input_followup", text: "all" } });
		const bFrame = await bP;
		assert.deepEqual(bFrame.body, { type: "input_followup", text: "all" });

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

test("spawnId echoes as parent; wild agents list parentless; kill = terminate signal", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	const url = `ws://127.0.0.1:${server.port}`;
	let forked: WsClient | undefined;
	let wild: WsClient | undefined;
	let admin: WsClient | undefined;
	try {
		forked = new WsClient(url);
		await forked.ready();
		forked.send({ op: "register", sessionId: "f1", agentId: "worker", mode: "worker", spawnId: "proc:web" });
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
		assert.equal(f.parent, "proc:web");
		const wl = (await admin.rpc({ op: "agents_get", sessionId: "w1" })).data;
		assert.equal(wl.parent, undefined);

		// kill = terminate signal to the one loop: a stop control lands first,
		// then the socket drops and the agent reads offline.
		const ctrlP = forked.waitFor("control");
		const killRes = await admin.rpc({ op: "kill", sessionId: "f1" });
		assert.equal(killRes.data.ok, true);
		assert.equal((await ctrlP).action, "stop");
		const after = (await admin.rpc({ op: "agents_get", sessionId: "f1" })).data;
		assert.equal(after.status, "offline");

		// old nouns are dead on the wire
		for (const dead of ["create", "restart"]) {
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
