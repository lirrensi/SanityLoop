// A subagent. Default-export a builder that returns a FRESH Agent each spawn.
// The optional named `description` export feeds the parent's `sub_spawn` tool.
import { Agent, SimpleModel } from "@sanityloop/core";

export const description = "Researches a topic and returns a concise, cited answer.";

export default function build(): Agent {
	return new Agent({
		model: new SimpleModel({
			api: "chat_completions",
			modelId: process.env.SWARM_MODEL ?? "gpt-4o-mini",
			apiKey: process.env.OPENAI_API_KEY,
			baseUrl: process.env.MODEL_BASE_URL,
			stream: true,
		}),
		agentId: "researcher",
		description,
	});
}