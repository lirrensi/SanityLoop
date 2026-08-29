// ============================================================================
// rest.test.ts — the second door. Exercises the REST adapter + bearer auth by
// hitting the live daemon's HTTP port with fetch.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { startDaemon, WsClient, tmpHome, rmHome } from "./harness.ts";

test("REST: health/workers/events/history + input/control routing; bad control action 400", async () => {
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

		const workers = await (await fetch(base + "/workers")).json();
		assert.ok(workers.find((r: any) => r.sessionId === "w1"));

		const one = await (await fetch(base + "/workers/w1")).json();
		assert.equal(one.sessionId, "w1");

		const events = await (await fetch(base + "/workers/w1/events?limit=10")).json();
		assert.ok(events.events.length >= 1);

		const hist = await (await fetch(base + "/history")).json();
		assert.ok(hist.find((r: any) => r.sessionId === "w1"));

		const inP = w.waitFor("input");
		const inRes = await fetch(base + "/workers/w1/input", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ type: "input_followup", text: "rest" }),
		});
		assert.equal(inRes.status, 200);
		assert.deepEqual((await inP).body, { type: "input_followup", text: "rest" });

		const ctrlP = w.waitFor("control");
		const ctrlRes = await fetch(base + "/workers/w1/control", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "pause" }),
		});
		assert.equal(ctrlRes.status, 200);
		assert.equal((await ctrlP).action, "pause");

		const bad = await fetch(base + "/workers/w1/control", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "nope" }),
		});
		assert.equal(bad.status, 400);
	} finally {
		w?.close();
		rmHome(home);
		await server.stop();
	}
});

test("REST auth: 401 without token, 200 peer, 403 peer on admin route, 200 admin (404 on unknown template)", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home, tokens: { admin: "A", peer: "P" } });
	const base = `http://127.0.0.1:${server.port}/api/v1`;
	try {
		const noAuth = await fetch(base + "/workers");
		assert.equal(noAuth.status, 401);

		const peerOk = await fetch(base + "/workers", { headers: { authorization: "Bearer P" } });
		assert.equal(peerOk.status, 200);

		// peer hitting the admin-only POST /workers
		const peerOnAdmin = await fetch(base + "/workers", {
			method: "POST",
			headers: { authorization: "Bearer P", "content-type": "application/json" },
			body: JSON.stringify({ template: "x" }),
		});
		assert.equal(peerOnAdmin.status, 403);

		// admin: authorized, routes to create → unknown template → 404 (not 403)
		const adminCreate = await fetch(base + "/workers", {
			method: "POST",
			headers: { authorization: "Bearer A", "content-type": "application/json" },
			body: JSON.stringify({ template: "x" }),
		});
		assert.equal(adminCreate.status, 404);
	} finally {
		rmHome(home);
		await server.stop();
	}
});
