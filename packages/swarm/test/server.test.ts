// ============================================================================
// server.test.ts — the daemon hub, end-to-end over raw WS clients.
// No full agent needed: we speak the wire directly. Covers register/report →
// state folding, peer query + talk, listen-relay, role permissions, and the
// token gate.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { startDaemon, WsClient, tmpHome, rmHome } from "./harness.ts";

test("open daemon: register/report folds state; peer list/get/events/listen/input/control/broadcast; worker denied list", async () => {
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

		const listRes = await p.rpc({ op: "list" });
		const rows = listRes.data as any[];
		const w1 = rows.find((r: any) => r.sessionId === "w1");
		assert.ok(w1, "w1 in registry");
		assert.equal(w1.state, "error");
		assert.equal(w1.stats.errors, 1);

		const getRes = await p.rpc({ op: "get", sessionId: "w1" });
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
		const get2 = await p.rpc({ op: "get", sessionId: "w1" });
		assert.equal(get2.data.state, "paused");

		// broadcast
		const bP = w.waitFor("input");
		await p.rpc({ op: "broadcast", body: { type: "input_followup", text: "all" } });
		const bFrame = await bP;
		assert.deepEqual(bFrame.body, { type: "input_followup", text: "all" });

		// worker is NOT allowed to list
		const forbidden = await w
			.rpc({ op: "list" })
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

test("token gate: correct token welcomed, wrong/missing token rejected + socket closed", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home, tokens: { admin: "A", peer: "P" } });
	const url = `ws://127.0.0.1:${server.port}`;
	const clients: WsClient[] = [];
	try {
		// admin, correct
		const a = new WsClient(url);
		clients.push(a);
		await a.ready();
		a.send({ op: "register", sessionId: "a1", agentId: "admin", mode: "admin", token: "A" });
		assert.equal((await a.waitFor("welcome")).sessionId, "a1");

		// admin, wrong → error + close
		const bad = new WsClient(url);
		clients.push(bad);
		await bad.ready();
		const badClosed = new Promise<boolean>((res) => bad.ws.on("close", () => res(true)));
		bad.send({ op: "register", sessionId: "bad", agentId: "admin", mode: "admin", token: "WRONG" });
		const errFrame = await bad.waitFor("error").catch(() => null);
		assert.ok(errFrame && /unauthorized/.test(errFrame.error));
		assert.equal(await badClosed, true);

		// peer, correct
		const pe = new WsClient(url);
		clients.push(pe);
		await pe.ready();
		pe.send({ op: "register", sessionId: "p1", agentId: "peer", mode: "peer", token: "P" });
		assert.equal((await pe.waitFor("welcome")).sessionId, "p1");

		// peer, missing token when tokens configured → rejected
		const p2 = new WsClient(url);
		clients.push(p2);
		await p2.ready();
		const p2Closed = new Promise<boolean>((res) => p2.ws.on("close", () => res(true)));
		p2.send({ op: "register", sessionId: "p2", agentId: "peer", mode: "peer" });
		const err2 = await p2.waitFor("error").catch(() => null);
		assert.ok(err2 && /unauthorized/.test(err2.error));
		assert.equal(await p2Closed, true);

		// worker, no token when tokens configured → rejected (option A: every
		// door now requires a token, no anonymous baseline — not even worker)
		const wk = new WsClient(url);
		clients.push(wk);
		await wk.ready();
		const wkClosed = new Promise<boolean>((res) => wk.ws.on("close", () => res(true)));
		wk.send({ op: "register", sessionId: "wk1", agentId: "worker", mode: "worker" });
		const wkErr = await wk.waitFor("error").catch(() => null);
		assert.ok(wkErr && /unauthorized/.test(wkErr.error));
		assert.equal(await wkClosed, true);
	} finally {
		for (const c of clients) c.close();
		rmHome(home);
		await server.stop();
	}
});
