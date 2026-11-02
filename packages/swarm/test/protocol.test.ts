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
