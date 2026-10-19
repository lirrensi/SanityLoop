// ============================================================================
// e2e.test.ts — REAL end-to-end. Not raw sockets, not a fake agent: the daemon
// STARTS a real named process (fixtures/e2e-worker.ts) via its process API.
// That worker boots a real Agent, wires into the swarm (wireSwarm), registers
// (echoing SWARM_SPAWN_ID as its parent), reports, and — when we send it an
// input — runs a real StubModel turn whose streamed voices relay back to a
// subscribed admin. Crosses a process boundary.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { startDaemon, WsClient, tmpHome, rmHome } from "./harness.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/e2e-worker.ts", import.meta.url));

test("E2E: daemon starts a REAL process that joins, reports, receives input and runs a turn (voices relay back)", async () => {
	const home = tmpHome();
	// the fixture imports bare @sanityloop/* — ESM resolves from the FILE's
	// ancestors, so the agent file must stay inside the repo tree (a tmp-home
	// copy can never resolve them). The manifest points at it by absolute path.
	const tdir = join(home, "templates");
	mkdirSync(tdir, { recursive: true });
	writeFileSync(join(tdir, "e2e-worker.json"), JSON.stringify({ id: "e2e-worker", file: FIXTURE }));

	const server = await startDaemon({ home, templatesDir: tdir });
	const url = `ws://127.0.0.1:${server.port}`;
	let admin: WsClient | undefined;
	let started: { name: string; sessionId: string; pid?: number } | null = null;
	try {
		admin = new WsClient(url);
		await admin.ready();
		admin.send({ op: "register", sessionId: "admin1", agentId: "admin", mode: "admin" });
		await admin.waitFor("welcome");

		// start a REAL worker process through the daemon's process API
		const startRes = await admin.rpc({ op: "proc_start", name: "e2e", from: "e2e-worker" });
		started = startRes.data;
		assert.ok(started && typeof started.pid === "number", "daemon forked a process (name + pid)");
		assert.equal(started.name, "e2e");
		const firstSession = started.sessionId;

		// worker must actually join the swarm (separate process, real WS register).
		// cold-start import of the agent graph is slow on Windows — generous deadline.
		// NOTE: the fixture resolves @sanityloop/* through the daemon-home
		// node_modules junction; a missing junction = MODULE_NOT_FOUND (pre-existing).
		const joinDeadline = Date.now() + 30000;
		let info: { status: string; agentId: string; mode: string; parent?: string } | null = null;
		while (Date.now() < joinDeadline) {
			info = server.api.agents.get(firstSession);
			if (info && info.status === "online") break;
			await new Promise((r) => setTimeout(r, 50));
		}
		assert.ok(info, "worker appeared in the registry");
		assert.equal(info.status, "online");
		assert.equal(info.agentId, "e2e-worker");
		assert.equal(info.mode, "worker");
		assert.equal(info.parent, "e2e", "fork backlink echoed as parent");

		// (A well-behaved worker stays idle until it receives input, so it reports
		// nothing at boot. The proof of the reporting pipeline is below: after we
		// send it an input, its voices must relay back to a subscribed admin.)

		// subscribe to the worker's voices
		await admin.rpc({ op: "listen", sessionId: firstSession, on: true });

		// send a REAL followup input → worker receives it, runs a turn, streams back
		const relayed = admin.waitFor("event");
		await admin.rpc({ op: "input", target: firstSession, body: { type: "input_followup", text: "ping" } });
		const ev = await relayed;
		assert.ok(ev && ev.target === firstSession, "received a relayed swarm/event for our worker");
		assert.ok(
			["agentStart", "turnEnd", "agentSettled", "textDelta", "cycleEnd"].includes(ev.event),
			`worker actually ran a cycle in response to input (event=${ev.event})`,
		);
	} finally {
		if (started?.name) {
			try {
				await admin?.rpc({ op: "proc_stop", name: started.name });
			} catch {
				/* already gone */
			}
		}
		admin?.close();
		rmHome(home);
		await server.stop();
	}
});
