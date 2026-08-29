// packages/extras/session-search/test/search-history.test.ts
// PROVES: searches the FULL transcript, compactions included — archived
// (enabled:false) messages are found and tagged; hits carry excerpts;
// every part of a message is searchable (text, tool args, error tails).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "@sanityloop/core";
import type { Message } from "@sanityloop/core";
import { StubModel } from "@sanityloop/test-kit/core";
import { createSearchHistory } from "@sanityloop/session-search";

function msg(partial: Partial<Message> & { type: Message["type"] }): Message {
	return {
		id: `m-${partial.type}-${crypto.randomUUID().slice(0, 6)}`,
		enabled: true,
		committedAt: Date.now(),
		...partial,
	} as Message;
}

function agentWith(msgs: Message[]): Agent {
	const a = new Agent({ model: new StubModel([]), agentId: "test-session" });
	for (const m of msgs) a.messages.push(m);
	return a;
}

const SESSION: Message[] = [
	msg({
		type: "user",
		enabled: false,
		content: [
			{ type: "text", content: "old: deploy the docker stack to prod" },
		],
	}),
	msg({
		type: "user",
		content: [{ type: "text", content: "why is the build failing?" }],
	}),
	msg({
		type: "assistant",
		content: [
			{
				type: "text",
				content: "check docker logs and the registry credentials",
			},
		],
	}),
	msg({
		type: "toolCall",
		content: {
			answer: "",
			stored: [
				{
					id: "c1",
					type: "function",
					name: "docker_logs",
					parameters: { container: "api" },
				},
			],
		},
	}),
	msg({
		type: "toolResult",
		content: {
			answer: "no such container: api",
			error: true,
			errorMessage: "container not found",
		},
	}),
];

test("finds text across the FULL history — archived (compaction-hidden) hits included and tagged", async () => {
	const tool = createSearchHistory();
	const res = await tool.execute({ query: "docker" }, agentWith(SESSION));
	assert.equal(res.error, undefined);
	const stored = res.stored as {
		hits: Array<{ active: boolean }>;
		total: number;
	};
	assert.ok(stored.total >= 3, `expected >=3 docker hits, got ${stored.total}`);
	const archived = stored.hits.filter((h) => !h.active);
	assert.ok(
		archived.length >= 1,
		"archived (enabled:false) message must be searchable and tagged inactive",
	);
	const resArchived = await tool.execute(
		{ query: "deploy the docker stack" },
		agentWith(SESSION),
	);
	const hitsArch = (
		resArchived.stored as { hits: Array<{ active: boolean; excerpt: string }> }
	).hits;
	assert.equal(hitsArch.length, 1);
	assert.equal(
		hitsArch[0].active,
		false,
		"compacted message is in history but not current context",
	);
	assert.ok(
		hitsArch[0].excerpt.includes("prod"),
		"excerpt carries the matching context",
	);
});

test("case-insensitive substring", async () => {
	const tool = createSearchHistory();
	const res = await tool.execute({ query: "REGISTRY" }, agentWith(SESSION));
	assert.equal((res.stored as { total: number }).total, 1);
});

test("searches EVERY part of a message: tool args + error tails", async () => {
	const tool = createSearchHistory();
	const byArgs = await tool.execute(
		{ query: "docker_logs" },
		agentWith(SESSION),
	);
	assert.equal(
		(byArgs.stored as { total: number }).total,
		1,
		"tool name in a toolCall must be searchable",
	);
	const byErr = await tool.execute(
		{ query: "container not found" },
		agentWith(SESSION),
	);
	assert.equal(
		(byErr.stored as { total: number }).total,
		1,
		"errorMessage must be searchable",
	);
});

test("limit caps hits, stored.total keeps the full count", async () => {
	const tool = createSearchHistory({ limit: 2 });
	const res = await tool.execute({ query: "docker" }, agentWith(SESSION));
	const stored = res.stored as { hits: unknown[]; total: number };
	assert.equal(stored.hits.length, 2);
	assert.ok(stored.total > 2);
});

test("no match → friendly no-hits answer with coverage", async () => {
	const tool = createSearchHistory();
	const res = await tool.execute({ query: "unicorns" }, agentWith(SESSION));
	assert.ok(String(res.answer).includes("No hits"));
	assert.ok(String(res.answer).includes("searched 5 messages"));
});

test("missing query → error result", async () => {
	const tool = createSearchHistory();
	const res = await tool.execute({}, agentWith(SESSION));
	assert.equal(res.error, true);
	assert.ok(String(res.answer).includes("query"));
});

test("runs INSIDE a real loop as a plain tool (the model can call it)", async () => {
	// parent model calls search_history → then answers
	const res = await createSearchHistory().execute(
		{ query: "build failing" },
		agentWith(SESSION),
	);
	assert.equal(res.error, undefined);
	assert.ok(String(res.answer).includes("build failing"));
});
