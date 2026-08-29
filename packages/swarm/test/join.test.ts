// ============================================================================
// join.test.ts — the COUPLING: createSwarmJoin plugin driven by a fake agent
// (no real Agent/Loop needed). Verifies mode hats, report filters, tool RPC
// against a live daemon, the relayed-event emit, and token rejection.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSwarmJoin } from "../src/join/index.ts";
import type { Plugin } from "@sanityloop/core";
import { startDaemon, WsClient, tmpHome, rmHome } from "./harness.ts";
import { STREAM_EVENTS, LIFECYCLE_EVENTS } from "../src/protocol.ts";

/** A minimal stand-in for the GodObject the join plugin needs. */
class FakeAgent {
	id: string;
	agentId: string;
	description: string;
	filters: any[] = [];
	tools: any[] = [];
	caps: any[] = [];
	emitted: any[] = [];
	inputs: any[] = [];
	stopped = false;
	aborted: any = null;
	paused = false;
	woke = false;
	constructor(id: string, agentId = id, description = "fake") {
		this.id = id;
		this.agentId = agentId;
		this.description = description;
	}
	addFilter(f: any) {
		this.filters.push(f);
	}
	addTool(t: any) {
		this.tools.push(t);
	}
	addDeclaredCapability(c: any) {
		this.caps.push(c);
	}
	removeDeclaredCapability(id: string) {
		this.caps = this.caps.filter((c) => c.id !== id);
	}
	emit(type: string, payload: any) {
		this.emitted.push({ type, payload });
	}
	input(body: any) {
		this.inputs.push(body);
	}
	stop() {
		this.stopped = true;
	}
	abort(r: any) {
		this.aborted = r;
	}
	pause() {
		this.paused = true;
	}
	wake() {
		this.woke = true;
	}
	install(plugin: Plugin) {
		plugin.install(this as any);
	}
}

function findTool(a: FakeAgent, name: string) {
	return a.tools.find((t) => t.name === name);
}

async function waitRegistered(server: any, id: string, ms = 5000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (server.api.get(id)) return true;
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
		plugin?.uninstall(agent as any);
		rmHome(home);
		await server.stop();
	}
});

test("admin-mode join: tools RPC against daemon (list/get/create/kill/send/control/broadcast/listen)", async () => {
	const home = tmpHome();
	const tdir = join(home, "templates");
	mkdirSync(tdir, { recursive: true });
	writeFileSync(join(tdir, "idle.ts"), `setTimeout(() => process.exit(0), 400);\n`);
	writeFileSync(join(tdir, "w1.json"), JSON.stringify({ id: "w1", file: "idle.ts" }));

	const server = await startDaemon({ home, templatesDir: tdir });
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

		// list
		const list = JSON.parse((await findTool(agent, "swarm_list")!.execute({})).answer);
		assert.ok(Array.isArray(list));
		assert.ok(list.find((r: any) => r.sessionId === "target1"));

		// get
		const got = JSON.parse(
			(await findTool(agent, "swarm_get")!.execute({ sessionId: "target1" })).answer,
		);
		assert.equal(got.sessionId, "target1");

		// create (spawns idle fixture)
		const created = JSON.parse(
			(await findTool(agent, "swarm_create")!.execute({ template: "w1" })).answer,
		);
		assert.ok(created.sessionId && typeof created.pid === "number");

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
			if (agent.emitted.find((e) => e.type === "swarm/event" && e.payload?.target === "target1")) {
				got2 = true;
				break;
			}
			await new Promise((r) => setTimeout(r, 30));
		}
		assert.ok(got2, "admin received relayed swarm/event");

		// kill the spawned worker
		const killed = JSON.parse(
			(await findTool(agent, "swarm_kill")!.execute({ sessionId: created.sessionId })).answer,
		);
		assert.equal(killed.ok, true);
	} finally {
		plugin?.uninstall(agent as any);
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
		plugin?.uninstall(agent as any);
		rmHome(home);
		await server.stop();
	}
});
