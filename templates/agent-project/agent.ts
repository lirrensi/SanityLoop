// ============================================================================
// templates/agent-project/agent.ts — the thing you RUN.
// It is NOT runtime config. It reads its own directory, assembles the agent
// as if it were one file, and runs it.
//
//   node --experimental-strip-types --experimental-transform-types agent.ts
//
// Optional env:
//   MODEL_BASE_URL  e.g. http://localhost:58080/v1 (llama.cpp) — default OpenAI
//   OPENAI_API_KEY  when using the OpenAI-compatible default
// ============================================================================
import { SimpleModel } from "@sanityloop/core";
import { createDefaultInputs } from "@sanityloop/inputs";
import { loadAgentFolder } from "./loader.ts";

const agent = await loadAgentFolder({
	model: new SimpleModel({
		api: "chat_completions",
		modelId: process.env.SWARM_MODEL ?? "gpt-4o-mini",
		apiKey: process.env.OPENAI_API_KEY,
		baseUrl: process.env.MODEL_BASE_URL,
		stream: true,
	}),
	agentId: "agent-project",
	description: "a folder-assembled agent (System.md + Agents.md + tools/ + filters/ + skills/ + subagents/)",
});

agent.install(createDefaultInputs());
agent.run();