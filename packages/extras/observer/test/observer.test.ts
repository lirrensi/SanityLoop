// ============================================================================
// test/observer.test.ts — verbosity gating + line shapes, no log channel.
// ============================================================================
// The log-sink logs.test.ts suite owns observer logs:true fan-in — NOT covered
// here (no `write` spy on log-channel paths, no LOG_CHANNEL events). This suite
// pins: verbosity gating (level 1 = lifecycle only, level 2 adds result +
// stream filters), line shapes through agent.emit (level-1 tool/stop lines,
// level-1 textDelta silence), level-2 result lines + contiguous stdout, and
// capability/uninstall sweep.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, EVENTS } from "@sanityloop/core";
import { StubModel } from "@sanityloop/test-kit/core";
import { createObserverPlugin } from "@sanityloop/observer";

function observerIds(agent: Agent): string[] {
	return agent.filters.filter((f) => f.id.startsWith("observer/")).map((f) => f.id);
}

function captureStdout(chunks: string[]): () => void {
	const orig = process.stdout.write;
	process.stdout.write = ((chunk: unknown): boolean => {
		chunks.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	return () => {
		process.stdout.write = orig;
	};
}

// ---------------------------------------------------------------------------
// verbosity gating
// ---------------------------------------------------------------------------

test("level 1 installs lifecycle filters but no stream or usage filters", async () => {
	const agent = new Agent({ model: new StubModel([]), agentId: "obs-test" });
	try {
		await agent.install(createObserverPlugin({ write: () => {} }));
		const events = agent.filters.map((f) => f.event);
		for (const e of [EVENTS.toolStart, EVENTS.toolEnd, EVENTS.stop]) {
			assert.ok(events.includes(e), `level 1 must watch ${e}`);
		}
		for (const e of [EVENTS.textDelta, EVENTS.textEnd, EVENTS.usage, EVENTS.beforeProviderRequest]) {
			assert.ok(!events.includes(e), `level 1 must NOT watch ${e}`);
		}
		assert.ok(!observerIds(agent).some((id) => id.includes("-result")), "level 1 must not install the result filter");
	} finally {
		agent.uninstall("observer");
	}
});

test("level 2 adds the toolEnd-result filter and every stream filter", async () => {
	const agent = new Agent({ model: new StubModel([]), agentId: "obs-test" });
	try {
		await agent.install(createObserverPlugin({ verbosity: 2, write: () => {} }));
		const ids = observerIds(agent);
		assert.ok(ids.includes("observer/toolEnd-result"), "level 2 must install the result filter");
		for (const e of [EVENTS.textDelta, EVENTS.textEnd, EVENTS.thinkingDelta, EVENTS.usage]) {
			assert.ok(
				agent.filters.some((f) => f.id === `observer/${e}`),
				`level 2 must watch ${e}`,
			);
		}
	} finally {
		agent.uninstall("observer");
	}
});

// ---------------------------------------------------------------------------
// level-1 lines via agent.emit
// ---------------------------------------------------------------------------

test("level-1 toolStart/toolEnd lines name the tool; stop names the loop state", async () => {
	const agent = new Agent({ model: new StubModel([]), agentId: "obs-test" });
	const lines: string[] = [];
	try {
		await agent.install(createObserverPlugin({ write: (l) => lines.push(l) }));
		agent.currentTurn = {
			id: "t1",
			enabled: true,
			type: "toolCall",
			content: { answer: "", stored: [{ id: "c1", type: "function", name: "hammer", parameters: {} }] },
		};
		await agent.bus.runFromRegistry(EVENTS.toolStart, {});
		agent.currentTurn = {
			id: "t2",
			enabled: true,
			type: "toolResult",
			toolCallId: "c1",
			toolName: "hammer",
			content: { answer: "done" },
		};
		await agent.bus.runFromRegistry(EVENTS.toolEnd, {});
		agent.loopState = "idle";
		await agent.bus.runFromRegistry(EVENTS.stop, { loopState: agent.loopState });
		assert.deepEqual(lines, ["[toolStart] tool: hammer", "[toolEnd] tool done: hammer", "[stop] stopped (idle)"]);
	} finally {
		agent.uninstall("observer");
	}
});

test("level-1 writes nothing for textDelta", async () => {
	const agent = new Agent({ model: new StubModel([]), agentId: "obs-test" });
	const lines: string[] = [];
	const chunks: string[] = [];
	const restore = captureStdout(chunks);
	try {
		await agent.install(createObserverPlugin({ write: (l) => lines.push(l) }));
		await agent.bus.runFromRegistry(EVENTS.textDelta, {
			streamDelta: { type: "textDelta", delta: "silent" },
		});
		await agent.bus.runFromRegistry(EVENTS.usage, {});
		assert.deepEqual(lines, []);
		assert.deepEqual(chunks, []);
	} finally {
		restore();
		agent.uninstall("observer");
	}
});

// ---------------------------------------------------------------------------
// level-2
// ---------------------------------------------------------------------------

test("level-2 toolEnd-result line carries the answer; empty answer writes no line", async () => {
	const agent = new Agent({ model: new StubModel([]), agentId: "obs-test" });
	const lines: string[] = [];
	try {
		await agent.install(createObserverPlugin({ verbosity: 2, write: (l) => lines.push(l) }));
		agent.currentTurn = {
			id: "t1",
			enabled: true,
			type: "toolResult",
			toolCallId: "c1",
			toolName: "saw",
			content: { answer: "cut it" },
		};
		await agent.bus.runFromRegistry(EVENTS.toolEnd, {});
		agent.currentTurn = {
			id: "t2",
			enabled: true,
			type: "toolResult",
			toolCallId: "c2",
			toolName: "saw",
			content: { answer: "" },
		};
		await agent.bus.runFromRegistry(EVENTS.toolEnd, {});
		assert.deepEqual(lines, ["[toolEnd] tool done: saw", "[toolEnd] → cut it", "[toolEnd] tool done: saw"]);
	} finally {
		agent.uninstall("observer");
	}
});

test("level-2 textDelta lands contiguously on stdout; textEnd adds the newline", async () => {
	const agent = new Agent({ model: new StubModel([]), agentId: "obs-test" });
	const lines: string[] = [];
	const chunks: string[] = [];
	const restore = captureStdout(chunks);
	try {
		await agent.install(createObserverPlugin({ verbosity: 2, write: (l) => lines.push(l) }));
		await agent.bus.runFromRegistry(EVENTS.textDelta, {
			streamDelta: { type: "textDelta", delta: "hel" },
		});
		await agent.bus.runFromRegistry(EVENTS.textDelta, {
			streamDelta: { type: "textDelta", delta: "lo" },
		});
		await agent.bus.runFromRegistry(EVENTS.textEnd, {});
		assert.deepEqual(chunks, ["hel", "lo", "\n"]);
		assert.deepEqual(lines, []);
	} finally {
		restore();
		agent.uninstall("observer");
	}
});

// ---------------------------------------------------------------------------
// capability + uninstall sweep
// ---------------------------------------------------------------------------

test("observer declares its capability; uninstall sweeps filters and capability", async () => {
	const agent = new Agent({ model: new StubModel([]), agentId: "obs-test" });
	await agent.install(createObserverPlugin({ verbosity: 2, write: () => {} }));
	assert.ok(agent.getDeclaredCapability("observer"), "observer capability must be declared");
	agent.addFilter({ event: EVENTS.agentStart, id: "canary/keep", priority: 0, fn: async () => {} });
	assert.equal(agent.uninstall("observer"), true);
	assert.deepEqual(observerIds(agent), []);
	assert.equal(agent.getDeclaredCapability("observer"), undefined);
	assert.ok(agent.filters.some((f) => f.id === "canary/keep"), "foreign filters must survive");
});
