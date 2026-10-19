// ============================================================================
// death.test.ts — the wire death verbs, end to end with REAL agents.
//   control shutdown → input_terminate → loopState terminated, corpse kept
//   control reset   → request_reset    → wiped to identity block, loop alive
// Both no-op gracefully without the inputs plugin (type-blind core ignores
// unknown input types). No destroy anywhere on the wire — by design.
// Integration tests: registry folding + loop beats are real timer behavior
// against the platform clock, so polling via waitUntil applies throughout.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "@sanityloop/core";
import { createDefaultInputs } from "@sanityloop/inputs";
import { StubModel, assistantTurn, withDriver } from "@sanityloop/test-kit/core";
import { waitUntil } from "@sanityloop/test-kit";
import { createSwarmJoin } from "../src/join/index.ts";
import type { GodObject, Plugin } from "@sanityloop/core";
import type { SwarmServer } from "../src/server/index.ts";
import { startDaemon, WsClient, tmpHome, rmHome } from "./harness.ts";

function deathAgent(id: string, withInputs: boolean): Agent {
	// session id MUST be fixed: the join registers agent.id as the sessionId,
	// so control/agents_get target agent.id (not agentId).
	const agent = new Agent({
		id,
		model: new StubModel([() => assistantTurn("ok")]),
		agentId: id,
		description: "death-verb worker",
	});
	if (withInputs) agent.install(createDefaultInputs());
	return agent;
}

function joinWorker(agent: Agent, url: string) {
	const plugin = createSwarmJoin({ mode: "worker", server: url });
	plugin.install(agent as never);
	return plugin;
}

async function adminOn(url: string, sessionId: string): Promise<WsClient> {
	const c = new WsClient(url);
	await c.ready();
	c.send({ op: "register", sessionId, agentId: sessionId, mode: "admin" });
	await c.waitFor("welcome");
	return c;
}

async function untilOnline(server: SwarmServer, sessionId: string): Promise<void> {
	await waitUntil(() => (server.api.agents.get(sessionId)?.status ?? "") === "online", {
		what: `${sessionId} online`,
	});
}

test("control shutdown terminates the joined agent (corpse inspectable via agents_get)", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	const url = `ws://127.0.0.1:${server.port}`;
	let admin: WsClient | undefined;
	const agent = deathAgent("death-shutdown", true);
	const plugin = joinWorker(agent, url);
	try {
		await withDriver(agent, async () => {
			await untilOnline(server, "death-shutdown");
			admin = await adminOn(url, "boss1");
			await admin.rpc({ op: "control", target: "death-shutdown", action: "shutdown" });
			await waitUntil(() => agent.loopState === "terminated", { what: "shutdown terminates" });
			assert.equal(agent.loopState, "terminated");
			assert.ok(agent.messages !== undefined, "corpse object inspectable post-mortem");
			assert.ok(server.api.agents.get("death-shutdown"), "corpse still in registry (terminated, not dropped)");
			const viaGet = await admin!.rpc({ op: "agents_get", sessionId: "death-shutdown" });
			assert.ok(viaGet.data, "corpse readable via agents_get");
		});
	} finally {
		plugin.uninstall(agent as never);
		admin?.close();
		rmHome(home);
		await server.stop();
	}
});

test("control reset wipes to the identity block (loop alive)", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	const url = `ws://127.0.0.1:${server.port}`;
	let admin: WsClient | undefined;
	const agent = deathAgent("death-reset", true);
	const plugin = joinWorker(agent, url);
	try {
		agent.messages.push({
			id: "sys-identity",
			enabled: true,
			type: "system",
			committedAt: Date.now(),
			content: [{ type: "text", content: "you are death-reset" }],
		});
		await withDriver(agent, async () => {
			await untilOnline(server, "death-reset");
			// give the agent a past: a user turn that lands
			agent.input({ type: "input_followup", text: "remember me" });
			await waitUntil(() => agent.messages.some((m) => m.type === "assistant"), { what: "turn to land" });
			assert.ok(agent.messages.length > 1, "history grew past identity");
			admin = await adminOn(url, "boss2");
			await admin.rpc({ op: "control", target: "death-reset", action: "reset" });
			await waitUntil(
				() => agent.messages.length === 1 && agent.messages[0]?.type === "system",
				{ what: "reset wipes to identity block" },
			);
			assert.deepEqual(agent.messages.map((m) => m.type), ["system"]);
			assert.notEqual(agent.loopState, "terminated", "loop alive after reset");
			assert.ok(agent.ticks > 0, "heartbeat still beating");
		});
	} finally {
		plugin.uninstall(agent as never);
		admin?.close();
		rmHome(home);
		await server.stop();
	}
});

test("shutdown + reset no-op gracefully without the inputs plugin (type-blind core)", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	const url = `ws://127.0.0.1:${server.port}`;
	let admin: WsClient | undefined;
	const agent = deathAgent("death-bare", false);
	const plugin = joinWorker(agent, url);
	try {
		await withDriver(agent, async () => {
			await untilOnline(server, "death-bare");
			admin = await adminOn(url, "boss3");
			const ticksBefore = agent.ticks;
			await admin.rpc({ op: "control", target: "death-bare", action: "shutdown" });
			await admin.rpc({ op: "control", target: "death-bare", action: "reset" });
			// Integration check: the verdict is loop-state truth, not a guessed
			// delay — wait until the heartbeat provably beat past the verbs.
			await waitUntil(() => agent.ticks > ticksBefore + 2, { what: "loop beats past inert verbs" });
			assert.notEqual(agent.loopState, "terminated", "no inputs plugin = no death");
		});
	} finally {
		plugin.uninstall(agent as never);
		admin?.close();
		rmHome(home);
		await server.stop();
	}
});

test("shutdown forwards over a mirror (authority stays home)", async () => {
	const homeA = tmpHome();
	const homeB = tmpHome();
	let A: SwarmServer | undefined;
	let B: SwarmServer | undefined;
	const clients: WsClient[] = [];
	const agent = deathAgent("death-mirror", true);
	let plugin: Plugin | undefined;
	try {
		A = await startDaemon({ home: homeA, name: "alpha" });
		B = await startDaemon({ home: homeB, name: "beta" });
		const urlA = `ws://127.0.0.1:${A.port}`;
		const urlB = `ws://127.0.0.1:${B.port}`;

		// real worker joins B with the inputs vocab
		plugin = joinWorker(agent, urlB);
		await withDriver(agent, async () => {
			await untilOnline(B!, "death-mirror");

			// A dials B — the mirror appears under beta
			const fed = A!.federate({ url: urlB });
			assert.equal(fed.ok, true);
			await waitUntil(
				() => A!.api.agents.list().some((r) => r.address === "alpha/global/beta/global/death-mirror"),
				{ what: "mirror appears" },
			);

			// control THROUGH A lands on B's real worker (existing forward pattern)
			const adminA = new WsClient(urlA);
			clients.push(adminA);
			await adminA.ready();
			adminA.send({ op: "register", sessionId: "adm-a", agentId: "adm", mode: "admin" });
			await adminA.waitFor("welcome");
			const r1 = await adminA.rpc({
				op: "control",
				target: "alpha/global/beta/global/death-mirror",
				action: "shutdown",
			});
			assert.equal(r1.data.ok, true);
			await waitUntil(() => agent.loopState === "terminated", { what: "mirrored shutdown terminates" });
			assert.equal(agent.loopState, "terminated");
		});
	} finally {
		if (plugin) plugin.uninstall(agent as never);
		for (const c of clients) c.close();
		rmHome(homeA);
		rmHome(homeB);
		await B?.stop().catch(() => {});
		await A?.stop().catch(() => {});
	}
});
