// packages/extras/base-storage/test/search-sessions.test.ts
// PROVES the storage plugin's OWN session-search: real tapes under a root,
// enumerated + replayed with base-storage's own machinery; hits labeled by
// sessionId; archived messages found; root absent → graceful no-hits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { jsonlSession } from "@sanityloop/base-storage";
import type { SessionSearchHit } from "@sanityloop/base-storage";
import { createSessionsSearchTool } from "@sanityloop/base-storage";
import { makeAgent, seedUserMessage } from "@sanityloop/test-kit/core";
import { makeTempDir, sleep } from "@sanityloop/test-kit";

async function writeSession(
	root: string,
	id: string,
	texts: Array<string | { text: string; enabled?: boolean }>,
) {
	const dir = join(root, id);
	const { agent } = makeAgent({ script: [] });
	const session = jsonlSession(dir);
	agent.install(session.plugin);
	await session.storage.flush(); // baseline lands
	for (const t of texts) {
		const spec = typeof t === "string" ? { text: t } : t;
		seedUserMessage(agent, spec.text);
		if (spec.enabled === false) agent.messages.at(-1)!.enabled = false;
		// dispatch the pending patch onto the tape queue (the house trick)
		agent.input({ type: "__test_flush__", async: true });
		await sleep(30);
	}
	await session.storage.flush();
	return dir;
}

test("searches every persisted session under the inherited root, hits labeled by sessionId", async (t) => {
	const base = await makeTempDir(t);
	const root = join(base, "sessions");
	await writeSession(root, "crypto", [
		"should we run docker in prod",
		"registry credentials are fine",
	]);
	await writeSession(root, "garden", [
		"the tomatoes need watering, docker not involved",
	]);

	const tool = createSessionsSearchTool({ root });
	const res = await tool.execute({ query: "docker" });

	assert.equal(res.error, undefined);
	const stored = res.stored as {
		hits: SessionSearchHit[];
		total: number;
		coverage: string;
	};
	assert.ok(
		stored.total >= 2,
		`expected hits from both sessions, got ${stored.total}`,
	);
	const sessionIds = new Set(stored.hits.map((h) => h.sessionId));
	assert.ok(sessionIds.has("crypto"), "hit from the crypto session");
	assert.ok(sessionIds.has("garden"), "hit from the garden session");
	assert.ok(
		stored.coverage.includes("2 session(s)"),
		`coverage: ${stored.coverage}`,
	);
});

test("archived (enabled:false) messages are found and tagged", async (t) => {
	const base = await makeTempDir(t);
	const root = join(base, "sessions");
	await writeSession(root, "old", [
		{ text: "the deployment password is sesame", enabled: false },
		{ text: "the deployment is green" },
	]);

	const tool = createSessionsSearchTool({ root });
	const res = await tool.execute({ query: "sesame" });
	const hits = (res.stored as { hits: SessionSearchHit[] }).hits;
	assert.equal(hits.length, 1);
	assert.equal(hits[0].active, false, "compacted message tagged archived");
	assert.equal(hits[0].sessionId, "old");
});

test("empty / absent root → graceful no-hits, tool never throws", async (t) => {
	const base = await makeTempDir(t);
	const missing = join(base, "nope");
	const tool = createSessionsSearchTool({ root: missing });
	const res = await tool.execute({ query: "anything" });
	assert.equal(res.error, undefined);
	assert.ok(String(res.answer).includes("No hits"));
});

test("missing query → error result", async (t) => {
	const base = await makeTempDir(t);
	const tool = createSessionsSearchTool({ root: base });
	const res = await tool.execute({});
	assert.equal(res.error, true);
	assert.ok(String(res.answer).includes("query"));
});
