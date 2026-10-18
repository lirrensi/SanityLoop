// ============================================================================
// packages/extras/powergoal/test/powergoal.test.ts — thin unit suite.
// ============================================================================
// Owns what test/e2e/power-goal.test.ts does NOT: the manage_goal validation
// matrix, no-checker completion, onAbort stop/keep, external state flips, and
// uninstall hygiene. No heartbeat, no timers, no network — every path runs
// through direct tool execute + direct bus dispatch, so each case is fast and
// deterministic. Every test fails if its branch is deleted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, EVENTS } from "@sanityloop/core";
import { createDefaultInputs } from "@sanityloop/inputs";
import { powerGoal } from "@sanityloop/powergoal";
import { StubModel } from "@sanityloop/test-kit/core";

let seq = 0;

/** A real Agent with inputs + powergoal installed — no heartbeat started. */
async function booted(opts: Parameters<typeof powerGoal>[0] = {}) {
	const agent = new Agent({ model: new StubModel([]), agentId: `powergoal-unit-${++seq}` });
	await agent.install(createDefaultInputs());
	await agent.install(powerGoal(opts));
	const tool = agent.tools.find((t) => t.name === "manage_goal");
	assert.ok(tool, "manage_goal tool must be registered");
	return { agent, tool };
}

interface Mirror {
	objective?: string;
	status?: string;
	startedAt?: number;
	fires?: number;
}
const mirror = (agent: Agent): Mirror | undefined =>
	agent.state.powerGoal as Mirror | undefined;

// ---- manage_goal validation matrix ----

test("manage_goal(active) without goal_text errors and arms nothing", async () => {
	const { agent, tool } = await booted();
	const bad = [
		{ set_status: "active" },
		{ set_status: "active", goal_text: "   " },
		{ set_status: "active", goal_text: 42 },
	];
	for (const params of bad) {
		const res = await tool.execute(params, agent);
		assert.ok(
			String(res.answer).startsWith("Error: goal_text is required"),
			`must refuse ${JSON.stringify(params)}: ${String(res.answer)}`,
		);
	}
	assert.equal(mirror(agent), undefined, "refused arm must leave no mirror");
});

test("manage_goal(active) while already pursuing refuses and keeps the first goal", async () => {
	const { agent, tool } = await booted();
	const first = await tool.execute({ set_status: "active", goal_text: "first chore" }, agent);
	assert.ok(String(first.answer).startsWith("Goal active"), `arm failed: ${String(first.answer)}`);
	const second = await tool.execute({ set_status: "active", goal_text: "second chore" }, agent);
	assert.ok(
		String(second.answer).includes("Already pursuing"),
		`double-arm must refuse: ${String(second.answer)}`,
	);
	assert.ok(
		String(second.answer).includes("first chore"),
		`refusal names the live goal: ${String(second.answer)}`,
	);
	assert.equal(mirror(agent)?.objective, "first chore", "second arm must not clobber");
});

test("manage_goal(complete) with no goal reports none", async () => {
	const { agent, tool } = await booted();
	const res = await tool.execute({ set_status: "complete" }, agent);
	assert.equal(res.answer, "No active goal to complete.");
});

test("manage_goal(blocked) with no goal reports none", async () => {
	const { agent, tool } = await booted();
	const res = await tool.execute({ set_status: "blocked" }, agent);
	assert.equal(res.answer, "No active goal to block.");
});

test("manage_goal with unknown status is rejected", async () => {
	const { agent, tool } = await booted();
	const res = await tool.execute({ set_status: "snooze" }, agent);
	assert.equal(res.answer, "Unknown status.");
});

// ---- no-checker semantics ----

test("no checker: arm + manage_goal(complete) completes directly", async () => {
	const { agent, tool } = await booted({}); // no check configured
	const armed = await tool.execute({ set_status: "active", goal_text: "tidy up" }, agent);
	assert.ok(String(armed.answer).startsWith("Goal active"), `arm failed: ${String(armed.answer)}`);
	const done = await tool.execute({ set_status: "complete", note: "done" }, agent);
	assert.ok(
		String(done.answer).includes("Goal completed"),
		`completion failed: ${String(done.answer)}`,
	);
	assert.equal(mirror(agent)?.status, "completed");
});

// ---- onAbort stop vs keep ----

test("beforeAbort stops an active goal by default", async () => {
	const { agent, tool } = await booted(); // default onAbort: "stop"
	await tool.execute({ set_status: "active", goal_text: "fragile work" }, agent);
	await agent.bus.runFromRegistry(EVENTS.beforeAbort, {});
	assert.equal(mirror(agent)?.status, "stopped");
});

test("onAbort keep: beforeAbort leaves an active goal alone", async () => {
	const { agent, tool } = await booted({ onAbort: "keep" });
	await tool.execute({ set_status: "active", goal_text: "resilient work" }, agent);
	await agent.bus.runFromRegistry(EVENTS.beforeAbort, {});
	assert.equal(mirror(agent)?.status, "active");
});

// ---- external state flips ----

test("external terminal tombstone is adopted without consulting the checker", async () => {
	let checks = 0;
	const { agent, tool } = await booted({
		check: () => {
			checks += 1;
			return "never done";
		},
	});
	await tool.execute({ set_status: "active", goal_text: "human-driven" }, agent);
	const snap = mirror(agent);
	assert.ok(snap && typeof snap.startedAt === "number", "precondition: mirror armed");
	agent.state.powerGoal = { ...snap, status: "completed" }; // human override
	await agent.bus.runFromRegistry(EVENTS.stop, {}); // the landing syncs
	assert.equal(mirror(agent)?.status, "completed", "tombstone must be adopted");
	assert.equal(checks, 0, "adoption must not consult the checker");
});

test("externally deleted state drops the goal at the next synced event", async () => {
	const { agent, tool } = await booted();
	await tool.execute({ set_status: "active", goal_text: "vanishing work" }, agent);
	assert.equal(mirror(agent)?.status, "active", "precondition: goal armed");
	delete agent.state.powerGoal;
	await agent.bus.runFromRegistry(EVENTS.stop, {});
	const res = await tool.execute({ set_status: "complete" }, agent);
	assert.equal(res.answer, "No active goal to complete.", "dropped goal is gone");
});

// ---- uninstall hygiene ----

test("uninstall removes filters, the tool, and the state mirror", async () => {
	const { agent, tool } = await booted();
	await tool.execute({ set_status: "active", goal_text: "doomed work" }, agent);
	assert.ok(mirror(agent), "precondition: mirror present");
	assert.equal(agent.uninstall("powergoal"), true);
	assert.equal(
		agent.filters.some((f) => f.id.startsWith("powergoal/")),
		false,
		"no powergoal/ filter may survive",
	);
	assert.equal(
		agent.tools.some((t) => t.name === "manage_goal"),
		false,
		"manage_goal must be gone",
	);
	assert.equal(agent.state.powerGoal, undefined, "state mirror must be deleted");
});
