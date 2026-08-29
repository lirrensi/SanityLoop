// A filter (our hooks-analog). Default-export the filter — the loader registers it.
import type { GodObject } from "@sanityloop/core";

export default {
	event: "agentStart",
	id: "note-cycles/agent-start",
	priority: 10,
	async fn(agent: GodObject) {
		console.log(`[filter] ${agent.agentId} started a cycle`);
	},
};