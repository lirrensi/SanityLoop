// ============================================================================
// e2e.test.ts — REAL end-to-end. Not raw sockets, not a fake agent: the daemon
// SPAWNS an actual worker process (fixtures/e2e-worker.ts) via its spawner.
// That worker boots a real Agent, wires into the swarm (wireSwarm), registers,
// reports, and — when we send it an input — runs a real StubModel turn whose
// streamed voices relay back to a subscribed admin. Crosses a process boundary.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { startDaemon, WsClient, tmpHome, rmHome } from "./harness.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/e2e-worker.ts", import.meta.url));

test("E2E: daemon spawns a REAL worker that joins, reports, receives input and runs a turn (voices relay back)", async () => {
	const home = tmpHome();
	const tdir = join(home, "templates");
	mkdirSync(tdir, { recursive: true });
	copyFileSync(FIXTURE, join(tdir, "e2e-worker.ts"));
	writeFileSync(join(tdir, "e2e-worker.json"), JSON.stringify({ id: "e2e-worker", file: "e2e-worker.ts" }));

	const server = await startDaemon({ home, templatesDir: tdir });
	const url = `ws://127.0.0.1:${server.port}`;
	let admin: WsClient | undefined;
	let created: any = null;
	try {
		admin = new WsClient(url);
		await admin.ready();
		admin.send({ op: "register", sessionId: "admin1", agentId: "admin", mode: "admin" });
		await admin.waitFor("welcome");

		// spawn a REAL worker process through the daemon's spawner
		const createRes = await admin.rpc({ op: "create", template: "e2e-worker" });
		created = createRes.data;
		assert.ok(created.sessionId && typeof created.pid === "number", "daemon spawned a worker (sessionId + pid)");
		const sid = created.sessionId;

		// worker must actually join the swarm (separate process, real WS register)
		let info: any = null;
		const joinDeadline = Date.now() + 10000;
		while (Date.now() < joinDeadline) {
			info = server.api.get(sid);
			if (info && info.status === "online") break;
			await new Promise((r) => setTimeout(r, 50));
		}
		assert.ok(info, "worker appeared in the registry");
		assert.equal(info.status, "online");
		assert.equal(info.agentId, "e2e-worker");
		assert.equal(info.mode, "worker");

		// (A well-behaved worker stays idle until it receives input, so it reports
		// nothing at boot. The proof of the reporting pipeline is below: after we
		// send it an input, its voices must relay back to a subscribed admin.)

		// subscribe to the worker's voices
		await admin.rpc({ op: "listen", sessionId: sid, on: true });

		// send a REAL followup input → worker receives it, runs a turn, streams back
		const relayed = admin.waitFor("event");
		await admin.rpc({ op: "input", target: sid, body: { type: "input_followup", text: "ping" } });
		const ev = await relayed;
		assert.ok(ev && ev.target === sid, "received a relayed swarm/event for our worker");
		assert.ok(
			["agentStart", "turnEnd", "agentSettled", "textDelta", "cycleEnd"].includes(ev.event),
			`worker actually ran a cycle in response to input (event=${ev.event})`,
		);
	} finally {
		if (created?.sessionId) {
			try {
				await admin?.rpc({ op: "kill", sessionId: created.sessionId });
			} catch {
				/* already gone */
			}
		}
		admin?.close();
		rmHome(home);
		await server.stop();
	}
});
