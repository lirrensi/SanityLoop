// ============================================================================
// e2e-worker.ts — a REAL swarm worker used by packages/swarm/test/e2e.test.ts.
// It is a genuine agent: boots via wireSwarm, joins the daemon, runs a real
// loop driven by a scripted StubModel (NO network / NO API key). The daemon
// spawns THIS file as a child process, so the e2e test exercises the full
// spawn → join → report → input → run → stream-back pipeline for real.
// ============================================================================
import { join } from "node:path";
import { Agent, EVENTS } from "@sanityloop/core";
import { createDefaultInputs } from "@sanityloop/inputs";
import { jsonlSession } from "@sanityloop/base-storage";
import { wireSwarm } from "@sanityloop/swarm";
import { StubModel, assistantTurn } from "@sanityloop/test-kit/core";

const SESSION_ID = process.env.SWARM_SESSION_ID;
if (!SESSION_ID) {
	console.error("e2e-worker: SWARM_SESSION_ID required — spawn me via the daemon");
	process.exit(1);
}

const agent = new Agent({
	// 5 scripted turns so the model never "exhausts" regardless of how many
	// cycles the loop runs during the test.
	model: new StubModel([
		() => assistantTurn("booted"),
		() => assistantTurn("got your ping"),
		() => assistantTurn("ok"),
		() => assistantTurn("ok"),
		() => assistantTurn("ok"),
	]),
	agentId: "e2e-worker",
	description: "e2e swarm worker (stub model, no network)",
});

await wireSwarm(agent, {
	server: process.env.SWARM_SERVER || "ws://127.0.0.1:5317",
	mode: "worker",
	sessionId: SESSION_ID,
	persistent: true,
	storage: jsonlSession(join(process.env.SWARM_SESSIONS_DIR || "sessions", SESSION_ID)),
});

agent.install(createDefaultInputs());

// exit cleanly when the daemon stops us
agent.addFilter({
	event: EVENTS.stop,
	id: "e2e-worker/exit-on-stop",
	priority: 0,
	fn: async () => {
		queueMicrotask(() => process.exit(0));
	},
});

agent.run();
