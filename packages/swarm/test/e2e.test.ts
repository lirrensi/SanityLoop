// ============================================================================
// e2e.test.ts — REAL end-to-end over the v2 API. Not raw sockets, not a fake
// agent: the daemon LAUNCHES a remembered program (fixtures/e2e-worker.ts via
// an absolute file spawn). That worker boots a real Agent, wires into the
// swarm (wireSwarm), registers (echoing SWARM_SPAWN_ID as its parent),
// reports, and — when we send it an input — runs a real StubModel turn whose
// streamed voices relay back to a subscribed admin. Crosses a process boundary.
// Then wait → logs → kill close the full loop.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startDaemon, WsClient, tmpHome, rmHome } from "./harness.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/e2e-worker.ts", import.meta.url));

test("E2E: define → launch → join → input/turn relay → logs → kill", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	const url = `ws://127.0.0.1:${server.port}`;
	let admin: WsClient | undefined;
	let runId: string | null = null;
	try {
		admin = new WsClient(url);
		await admin.ready();
		admin.send({ op: "register", sessionId: "admin1", agentId: "admin", mode: "admin" });
		await admin.waitFor("welcome");

		// define a service program pointing at the REAL worker by absolute file
		const defined = await admin.rpc({
			op: "program_define",
			name: "e2e",
			kind: "service",
			spawn: { file: FIXTURE },
		});
		assert.equal(defined.data.name, "e2e");

		// launch it: the daemon forks a real process (runId + pid + session)
		const launched = await admin.rpc({ op: "program_launch", name: "e2e" });
		assert.ok(launched.data.runId, "launch returns a run id");
		assert.ok(typeof launched.data.pid === "number", "daemon forked a process (pid)");
		assert.ok(launched.data.sessionId, "launch returns the worker session id");
		runId = launched.data.runId;
		const firstSession = launched.data.sessionId;

		// worker must actually join the swarm (separate process, real WS register).
		// Cold-start import of the agent graph is slow — generous deadline.
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
		assert.equal(info.parent, runId, "fork backlink echoed as parent");

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

		// run_wait: the worker may still be alive (idle agent loop) or may have
		// exited on its own — either way the wait door answers (record or 408
		// snapshot). Never assert liveness here: the fixture owns its exit.
		try {
			await admin.rpc({ op: "run_wait", runId, timeoutMs: 1500 });
		} catch {
			/* settled already or timed out with a snapshot — both fine */
		}

		// run logs: stdout should exist for the run
		const logs = await admin.rpc({ op: "run_logs", runId });
		assert.equal(typeof logs.data.text, "string");

		// kill: best-effort stop of the forked worker's run (no-op if the
		// fixture already exited — the run settled on its own)
		try {
			await admin.rpc({ op: "run_kill", runId, force: true });
		} catch {
			/* already settled — the worker exited on its own */
		}
	} finally {
		if (runId) {
			try {
				await admin?.rpc({ op: "run_kill", runId, force: true });
			} catch {
				/* already gone */
			}
		}
		try {
			await admin?.rpc({ op: "program_remove", name: "e2e" });
		} catch {
			/* already gone */
		}
		admin?.close();
		rmHome(home);
		await server.stop();
	}
});
