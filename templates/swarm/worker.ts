// ============================================================================
// worker.ts — a SWARM TEMPLATE (Shape A: the file IS the process).
// The daemon discovers it via templates/worker.json and spawns this file with
// the SWARM_* env contract. The only difference from a standalone agent:
// reading the env + installing the swarm join. The coupling IS the extension.
//
//   node --experimental-strip-types worker.ts
//   env: SWARM_SERVER, SWARM_SESSION_ID, SWARM_TOKEN?, SWARM_SESSIONS_DIR?, SWARM_MODEL?
// ============================================================================
import { join } from "node:path";
import { Agent, EVENTS, SimpleModel } from "@sanityloop/core";
import { createDefaultInputs } from "@sanityloop/inputs";
import { jsonlSession } from "@sanityloop/base-storage";
import { wireSwarm } from "@sanityloop/swarm";

const SESSION_ID = process.env.SWARM_SESSION_ID;
if (!SESSION_ID) {
	console.error("worker: SWARM_SESSION_ID required — spawn me via the daemon");
	process.exit(1);
}

const agent = new Agent({
	model: new SimpleModel({
		modelId: process.env.SWARM_MODEL ?? "gpt-4o-mini",
		apiKey: process.env.OPENAI_API_KEY,
		stream: true,
	}),
	agentId: "worker",
	description: "a minimal swarm worker — reports, receives, persists",
});

// the verified boot: restore → install storage → re-key → join.
// mode is decided HERE (the file's code), not by the manifest — mode has effects.
await wireSwarm(agent, {
	server: process.env.SWARM_SERVER ?? "ws://127.0.0.1:5317",
	mode: "worker",
	token: process.env.SWARM_TOKEN,
	persistent: true,
	sessionId: SESSION_ID,
	storage: jsonlSession(
		join(process.env.SWARM_SESSIONS_DIR ?? "sessions", SESSION_ID),
	),
});

agent.install(createDefaultInputs());

// live until the daemon stops us — then exit cleanly (storage writes its final
// card on the stop event; we exit after the dispatch completes)
agent.addFilter({
	event: EVENTS.stop,
	id: "worker/exit-on-stop",
	priority: 0,
	fn: async (a) => {
		queueMicrotask(() => process.exit(0));
	},
});

agent.run();
