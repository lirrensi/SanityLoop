// ============================================================================
// admin.ts — the COMMANDER. A swarm template that wears the admin hat: it can
// list, query, talk to, create, kill, restart, and broadcast to every worker.
// Command the daemon to spawn it: `swarm create admin`.
//
//   node --experimental-strip-types admin.ts
//   env: SWARM_SERVER, SWARM_SESSION_ID, SWARM_TOKEN?, SWARM_SESSIONS_DIR?, SWARM_MODEL?
// ============================================================================
import { join } from "node:path";
import { Agent, EVENTS, SimpleModel } from "@sanityloop/core";
import { createDefaultInputs } from "@sanityloop/inputs";
import { jsonlSession } from "@sanityloop/base-storage";
import { wireSwarm } from "@sanityloop/swarm";

const SESSION_ID = process.env.SWARM_SESSION_ID;
if (!SESSION_ID) {
	console.error("admin: SWARM_SESSION_ID required — spawn me via the daemon");
	process.exit(1);
}

const agent = new Agent({
	model: new SimpleModel({
		modelId: process.env.SWARM_MODEL ?? "gpt-4o-mini",
		apiKey: process.env.OPENAI_API_KEY,
		stream: true,
	}),
	agentId: "admin",
	description: "the commander — full admin tools over the swarm",
});

// mode is decided HERE — admin. The join installs the full admin toolset.
await wireSwarm(agent, {
	server: process.env.SWARM_SERVER ?? "ws://127.0.0.1:5317",
	mode: "admin",
	token: process.env.SWARM_TOKEN,
	persistent: true,
	sessionId: SESSION_ID,
	storage: jsonlSession(
		join(process.env.SWARM_SESSIONS_DIR ?? "sessions", SESSION_ID),
	),
});

agent.install(createDefaultInputs());

agent.addFilter({
	event: EVENTS.stop,
	id: "admin/exit-on-stop",
	priority: 0,
	fn: async (a) => {
		queueMicrotask(() => process.exit(0));
	},
});

agent.run();
