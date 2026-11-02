// ============================================================================
// protocol.test.ts — pure unit tests for the wire types + parseFrame, plus the
// role-permission gate (PERMS) exercised live over WS: a worker cannot
// program_define, a peer cannot either, an admin can.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	parseFrame,
	DEFAULT_PORT,
	STREAM_EVENTS,
	LIFECYCLE_EVENTS,
	CONTROL_ACTIONS,
} from "../src/protocol.ts";
import { startDaemon, WsClient, tmpHome, rmHome } from "./harness.ts";

test("parseFrame accepts the v2 ops", () => {
	for (const op of [
		"register",
		"report",
		"ping",
		"agents_list",
		"agents_get",
		"listen",
		"events",
		"history",
		"templates",
		"input",
		"control",
		"drop",
		"broadcast",
		"program_define",
		"program_patch",
		"program_launch",
		"program_remove",
		"program_list",
		"program_get",
		"program_preview",
		"program_logs",
		"run_exec",
		"run_get",
		"run_list",
		"run_logs",
		"run_wait",
		"run_kill",
		"run_signal",
		"run_save",
		"run_prune",
		"run_restart",
	]) {
		assert.equal(parseFrame(JSON.stringify({ op }))?.op, op, op);
	}
});

test("parseFrame rejects non-objects and unparseable text", () => {
	assert.equal(parseFrame("123"), null);
	assert.equal(parseFrame('"hi"'), null);
	assert.equal(parseFrame("not json at all"), null);
});

test("parseFrame rejects missing/empty op", () => {
	assert.equal(parseFrame(JSON.stringify({ foo: 1 })), null);
	assert.equal(parseFrame(JSON.stringify({ op: "" })), null);
});

test("constants are sane", () => {
	assert.equal(DEFAULT_PORT, 5317);
	assert.ok(STREAM_EVENTS.includes("textDelta"));
	assert.ok(LIFECYCLE_EVENTS.includes("agentStart"));
	assert.ok(LIFECYCLE_EVENTS.includes("error"));
	assert.deepEqual([...CONTROL_ACTIONS], ["stop", "abort", "pause", "wake", "shutdown", "reset"]);
});

test("PERMS: worker cannot program_define/run_exec; peer cannot program_define; admin can", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	const url = `ws://127.0.0.1:${server.port}`;
	let worker: WsClient | undefined;
	let peer: WsClient | undefined;
	let admin: WsClient | undefined;
	try {
		worker = new WsClient(url);
		await worker.ready();
		worker.send({ op: "register", sessionId: "w1", agentId: "worker", mode: "worker" });
		await worker.waitFor("welcome");

		const wDef = await worker
			.rpc({ op: "program_define", name: "nope", spawn: { cmd: "node" } })
			.then(() => null)
			.catch((e: Error) => e.message);
		assert.match(wDef ?? "", /forbidden/);

		const wExec = await worker
			.rpc({ op: "run_exec", spawn: { cmd: "node" } })
			.then(() => null)
			.catch((e: Error) => e.message);
		assert.match(wExec ?? "", /forbidden/);

		peer = new WsClient(url);
		await peer.ready();
		peer.send({ op: "register", sessionId: "p1", agentId: "peer", mode: "peer" });
		await peer.waitFor("welcome");

		const pDef = await peer
			.rpc({ op: "program_define", name: "nope", spawn: { cmd: "node" } })
			.then(() => null)
			.catch((e: Error) => e.message);
		assert.match(pDef ?? "", /forbidden/);

		// peer keeps its own doors
		const list = await peer.rpc({ op: "agents_list" });
		assert.ok(Array.isArray(list.data));

		admin = new WsClient(url);
		await admin.ready();
		admin.send({ op: "register", sessionId: "a1", agentId: "admin", mode: "admin" });
		await admin.waitFor("welcome");

		const defined = await admin.rpc({
			op: "program_define",
			name: "perm",
			spawn: { cmd: "node" },
		});
		assert.equal(defined.data.name, "perm");
		const removed = await admin.rpc({ op: "program_remove", name: "perm" });
		assert.equal(removed.data.ok, true);
	} finally {
		worker?.close();
		peer?.close();
		admin?.close();
		rmHome(home);
		await server.stop();
	}
});

test("run watchers: listen runId → event runCompleted; re-listen same session → no dup; unknown run → error", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	const url = `ws://127.0.0.1:${server.port}`;
	let admin: WsClient | undefined;
	try {
		admin = new WsClient(url);
		await admin.ready();
		admin.send({ op: "register", sessionId: "watcher1", agentId: "a", mode: "admin" });
		await admin.waitFor("welcome");
		// detached fork: no wait — the terminal event arrives as a pushed frame.
		const execed = await admin.rpc({
			op: "run_exec",
			spawn: { cmd: process.execPath, args: ["-e", "process.exit(0);"] },
		});
		const runId: string = execed.data.runId;
		assert.ok(runId, "exec returns a run id");
		// unknown run → error frame (rpc rejects).
		await assert.rejects(admin.rpc({ op: "listen", runId: "run-deadbeef", on: true }), /unknown run/);
		// subscribe to the run; settle lands as event runCompleted.
		const sub = await admin.rpc({ op: "listen", runId, on: true });
		assert.equal(sub.data.runId, runId);
		const ev = await admin.waitFor("event");
		assert.equal(ev.target, runId);
		assert.equal(ev.event, "runCompleted");
		assert.equal(ev.payload?.runId, runId);
		assert.equal(ev.payload?.exit?.code, 0);
		// Hermes session boundary: re-listen with the same sessionId replays
		// nothing — completion was already delivered (notified). The replay (if
		// any) is sent before the listen result, so by the time rpc resolves
		// the backlog already holds it. Absence needs a genuine window —
		// deterministic time control cannot prove a negative here.
		await admin.rpc({ op: "run_wait", runId, timeoutMs: 8000 });
		await admin.rpc({ op: "listen", runId, on: true });
		const { promise: gate, resolve: noDup } = Promise.withResolvers<null>();
		const timer = setTimeout(() => noDup(null), 400);
		const dup = await Promise.race([admin.waitFor("event").then((f) => f), gate]);
		clearTimeout(timer);
		assert.equal(dup, null, "no duplicate terminal event for the notified session");
		// program watchers: listen on the program name → next run settles → event.
		const defined = await admin.rpc({
			op: "program_define",
			name: "watchprog",
			kind: "job",
			spawn: { cmd: process.execPath, args: ["-e", "process.exit(0);"] },
			schedule: { kind: "manual" },
		});
		assert.ok(defined.data?.name, "program defined");
		await assert.rejects(admin.rpc({ op: "listen", program: "nope-missing", on: true }), /unknown program/);
		await admin.rpc({ op: "listen", program: "watchprog", on: true });
		const launched = await admin.rpc({ op: "program_launch", name: "watchprog" });
		const pev = await admin.waitFor("event");
		assert.equal(pev.target, launched.data.runId);
		assert.equal(pev.event, "runCompleted");
		assert.equal(pev.payload?.program, "watchprog");
	} finally {
		admin?.close();
		await server.stop();
		rmHome(home);
	}
});
