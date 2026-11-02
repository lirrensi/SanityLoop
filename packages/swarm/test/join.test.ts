// ============================================================================
// join.test.ts — the COUPLING: createSwarmJoin plugin driven by a fake agent
// (no real Agent/Loop needed). Verifies mode hats, report filters, admin tool
// RPC against a live daemon (program_define/launch/exec + agents/send/control/
// broadcast/listen/drop), the relayed-event emit, and token rejection.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSwarmJoin } from "../src/join/index.ts";
import type { GodObject, Plugin } from "@sanityloop/core";
import { startDaemon, WsClient, tmpHome, rmHome } from "./harness.ts";
import { STREAM_EVENTS, LIFECYCLE_EVENTS } from "../src/protocol.ts";

/** A minimal stand-in for the GodObject the join plugin needs. */
class FakeAgent {
	id: string;
	agentId: string;
	description: string;
	filters: unknown[] = [];
	tools: { name: string; execute: (p: Record<string, unknown>) => Promise<{ answer: string }> }[] = [];
	caps: { id: string }[] = [];
	emitted: { type: string; payload?: unknown }[] = [];
	inputs: unknown[] = [];
	stopped = false;
	aborted: unknown = null;
	paused = false;
	woke = false;
	constructor(id: string, agentId = id, description = "fake") {
		this.id = id;
		this.agentId = agentId;
		this.description = description;
	}
	addFilter(f: unknown) {
		this.filters.push(f);
	}
	addTool(t: { name: string; execute: (p: Record<string, unknown>) => Promise<{ answer: string }> }) {
		this.tools.push(t);
	}
	addDeclaredCapability(c: { id: string }) {
		this.caps.push(c);
	}
	removeDeclaredCapability(id: string) {
		this.caps = this.caps.filter((c) => c.id !== id);
	}
	emit(type: string, payload: unknown) {
		this.emitted.push({ type, payload });
	}
	input(body: unknown) {
		this.inputs.push(body);
	}
	stop() {
		this.stopped = true;
	}
	abort(r: unknown) {
		this.aborted = r;
	}
	pause() {
		this.paused = true;
	}
	wake() {
		this.woke = true;
	}
	install(plugin: Plugin) {
		plugin.install(this as unknown as GodObject);
	}
}

function findTool(a: FakeAgent, name: string) {
	return a.tools.find((t) => t.name === name);
}

async function waitRegistered(server: { api: { agents: { get(id: string): unknown } } }, id: string, ms = 5000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (server.api.agents.get(id)) return true;
		await new Promise((r) => setTimeout(r, 40));
	}
	return false;
}

test("worker-mode join: registers, adds report filters, exposes NO tools", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	const url = `ws://127.0.0.1:${server.port}`;
	let agent: FakeAgent;
	let plugin: Plugin | undefined;
	try {
		agent = new FakeAgent("wk1", "worker", "w");
		plugin = createSwarmJoin({ mode: "worker", server: url });
		agent.install(plugin);

		assert.equal(await waitRegistered(server, "wk1"), true);
		assert.equal(agent.tools.length, 0, "worker has no swarm tools");
		assert.equal(
			agent.filters.length,
			STREAM_EVENTS.length + LIFECYCLE_EVENTS.length,
			"report filters added for every event",
		);
		assert.ok(agent.caps.find((c) => c.id === "swarm"));
	} finally {
		if (plugin) plugin.uninstall(agent! as unknown as GodObject);
		rmHome(home);
		await server.stop();
	}
});

test("admin-mode join: tools RPC against daemon (agents + program_define/launch + run_exec/get + send/control/broadcast/listen/drop)", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	const url = `ws://127.0.0.1:${server.port}`;
	let target: WsClient | undefined;
	let agent: FakeAgent;
	let plugin: Plugin | undefined;
	try {
		target = new WsClient(url);
		await target.ready();
		target.send({ op: "register", sessionId: "target1", agentId: "worker", mode: "worker" });
		await target.waitFor("welcome");

		agent = new FakeAgent("admin1", "admin", "a");
		plugin = createSwarmJoin({ mode: "admin", server: url });
		agent.install(plugin);
		assert.equal(await waitRegistered(server, "admin1"), true);

		// agents_list
		const list = JSON.parse((await findTool(agent, "swarm_agents_list")!.execute({})).answer);
		assert.ok(Array.isArray(list));
		assert.ok(list.find((r: { sessionId: string }) => r.sessionId === "target1"));

		// agents_get
		const got = JSON.parse(
			(await findTool(agent, "swarm_agents_get")!.execute({ sessionId: "target1" })).answer,
		);
		assert.equal(got.sessionId, "target1");

		// program_define (absolute cmd spawn — no template resolution needed)
		const defined = JSON.parse(
			(await findTool(agent, "swarm_program_define")!.execute({
				name: "jt-prog",
				spawnJson: JSON.stringify({ cmd: process.execPath, args: ["--version"] }),
			})).answer,
		);
		assert.equal(defined.name, "jt-prog");

		// program_list shows it
		const plist = JSON.parse((await findTool(agent, "swarm_program_list")!.execute({})).answer);
		assert.ok(plist.find((p: { name: string }) => p.name === "jt-prog"));

		// program_launch forks it now
		const launched = JSON.parse(
			(await findTool(agent, "swarm_program_launch")!.execute({ name: "jt-prog" })).answer,
		);
		assert.ok(launched.runId, "launch returns a run id");

		// run_exec: ad-hoc fork via tools
		const execed = JSON.parse(
			(await findTool(agent, "swarm_run_exec")!.execute({
				spawnJson: JSON.stringify({ cmd: process.execPath, args: ["--version"] }),
				waitMs: 15000,
			})).answer,
		);
		assert.ok(execed.runId, "exec returns a run id");

		// run_get by id
		const rgot = JSON.parse(
			(await findTool(agent, "swarm_run_get")!.execute({ id: execed.runId })).answer,
		);
		assert.equal(rgot.id, execed.runId);

		// run_list shows both runs
		const rlist = JSON.parse((await findTool(agent, "swarm_run_list")!.execute({})).answer);
		assert.ok(rlist.find((r: { id: string }) => r.id === execed.runId));

		// send → target receives input
		const inP = target.waitFor("input");
		await findTool(agent, "swarm_send")!.execute({
			target: "target1",
			body: { type: "input_followup", text: "hey" },
		});
		assert.deepEqual((await inP).body, { type: "input_followup", text: "hey" });

		// control → target receives control
		const ctrlP = target.waitFor("control");
		await findTool(agent, "swarm_control")!.execute({ target: "target1", action: "pause" });
		assert.equal((await ctrlP).action, "pause");

		// broadcast → target receives input
		const bcP = target.waitFor("input");
		await findTool(agent, "swarm_broadcast")!.execute({
			body: { type: "input_followup", text: "all" },
		});
		assert.deepEqual((await bcP).body, { type: "input_followup", text: "all" });

		// listen → relayed swarm/event emit
		await findTool(agent, "swarm_listen")!.execute({ sessionId: "target1", on: true });
		target.send({ op: "report", event: "agentStart" });
		let got2 = false;
		const dl = Date.now() + 4000;
		while (Date.now() < dl) {
			if (agent.emitted.find((e) => e.type === "swarm/event" && (e.payload as { target?: string })?.target === "target1")) {
				got2 = true;
				break;
			}
			await new Promise((r) => setTimeout(r, 30));
		}
		assert.ok(got2, "admin received relayed swarm/event");

		// program_remove forgets the definition
		const removed = JSON.parse(
			(await findTool(agent, "swarm_program_remove")!.execute({ name: "jt-prog" })).answer,
		);
		assert.equal(removed.ok, true);

		// drop = server-side removal: the target gets a drop frame, the entry is gone
		const dropP = target.waitFor("drop");
		const dropped = JSON.parse(
			(await findTool(agent, "swarm_drop")!.execute({ sessionId: "target1" })).answer,
		);
		assert.equal(dropped.ok, true);
		assert.equal((await dropP).op, "drop");
		assert.equal(server.api.agents.get("target1"), null);
	} finally {
		if (plugin) plugin.uninstall(agent! as unknown as GodObject);
		target?.close();
		rmHome(home);
		await server.stop();
	}
});

test("join rejects a bad admin token (never registers)", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home, tokens: { admin: "A" } });
	const url = `ws://127.0.0.1:${server.port}`;
	let agent: FakeAgent;
	let plugin: Plugin | undefined;
	try {
		agent = new FakeAgent("adminX", "admin", "a");
		plugin = createSwarmJoin({ mode: "admin", server: url, token: "WRONG" });
		agent.install(plugin);
		// never appears in the registry
		assert.equal(await waitRegistered(server, "adminX", 1500), false);
		assert.equal(agent.emitted.length, 0);
	} finally {
		if (plugin) plugin.uninstall(agent as unknown as GodObject);
		rmHome(home);
		await server.stop();
	}
});

test("drop suppresses reconnect (stays gone, emits swarm/dropped)", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	const url = `ws://127.0.0.1:${server.port}`;
	// Integration test: reconnect suppression is real timer behavior against
	// the platform clock, so a genuine wait past the reconnect beat applies.
	let plugin: Plugin | undefined;
	let gone: FakeAgent | undefined;
	try {
		gone = new FakeAgent("gone1", "g", "g");
		plugin = createSwarmJoin({ mode: "worker", server: url });
		gone.install(plugin);
		assert.equal(await waitRegistered(server, "gone1"), true);
		const admin = new WsClient(url);
		await admin.ready();
		admin.send({ op: "register", sessionId: "boss", agentId: "admin", mode: "admin" });
		await admin.waitFor("welcome");
		await admin.rpc({ op: "drop", sessionId: "gone1" });
		const dl = Date.now() + 2500;
		while (Date.now() < dl) {
			if (gone.emitted.find((e) => e.type === "swarm/dropped")) break;
			await new Promise((r) => setTimeout(r, 30));
		}
		assert.ok(gone.emitted.find((e) => e.type === "swarm/dropped"), "emits swarm/dropped");
		await new Promise((r) => setTimeout(r, 1800));
		assert.equal(server.api.agents.get("gone1"), null);
		admin.close();
	} finally {
		if (plugin && gone) plugin.uninstall(gone as unknown as GodObject);
		rmHome(home);
		await server.stop();
	}
});

test("plain disconnect reconnects (drop flag untouched)", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	const url = `ws://127.0.0.1:${server.port}`;
	// Integration test: reconnect is real timer behavior, genuine waits apply.
	let plugin: Plugin | undefined;
	let back: FakeAgent | undefined;
	try {
		back = new FakeAgent("back1", "b", "b");
		plugin = createSwarmJoin({ mode: "worker", server: url });
		back.install(plugin);
		const port = server.port;
		await server.stop();
		const server2 = await startDaemon({ home, port });
		try {
			assert.equal(await waitRegistered(server2, "back1", 8000), true);
			assert.ok(!back.emitted.find((e) => e.type === "swarm/dropped"), "no drop emit on plain disconnect");
		} finally {
			await server2.stop();
		}
	} finally {
		if (plugin && back) plugin.uninstall(back as unknown as GodObject);
		rmHome(home);
	}
});
