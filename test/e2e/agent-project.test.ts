// ============================================================================
// test/e2e/agent-project.test.ts — smoke test for the folder-assembled agent.
// Loads the REAL templates/agent-project folder and proves every slot was wired:
// System.md + Agents.md system text, tools/, filters/, skills/, subagents/.
// No LLM needed — StubModel is only there to satisfy the Agent constructor.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { StubModel } from "@sanityloop/test-kit/core";
import { loadAgentFolder } from "../../templates/agent-project/loader.ts";

test("folder-assembled agent: system text, tools, filters, skills, subagents all wired", async () => {
	const agent = await loadAgentFolder({
		dir: resolve("templates/agent-project"),
		model: new StubModel([]),
		agentId: "agent-project-test",
	});

	const tools: any[] = (agent as any).tools ?? [];
	const filters: any[] = (agent as any).filters ?? [];
	const systemText = agent.messages
		.filter((m) => m.type === "system")
		.map((m) => JSON.stringify(m.content))
		.join(" ");

	// ---- system text: Agents.md (crew bible) + System.md + skills catalog ----
	assert.ok(systemText.includes("crew bible"), "Agents.md system text present");
	assert.ok(systemText.includes("folder is your whole body"), "System.md system text present");

	// ---- tools/ ----
	const greet = tools.find((t) => t.name === "greet");
	assert.ok(greet, "tools/greet.ts registered as a tool");
	// and the loaded tool actually executes
	const greetRes = await greet.execute({ name: "World" }, agent as any);
	assert.deepEqual(greetRes, { answer: "Hello, World!" });
	// skills expose the lazy `skill` loader tool
	assert.ok(tools.some((t) => t.name === "skill"), "skills catalog tool registered");

	// ---- filters/ (hooks-analog) ----
	assert.ok(
		filters.some((f) => f.id === "note-cycles/agent-start"),
		"filters/note_cycles.ts registered as a filter",
	);

	// ---- subagents/ ----
	assert.ok(
		tools.some((t) => t.name === "sub_spawn"),
		"subagents/researcher wired into the sub-agent manager (sub_spawn present)",
	);
});