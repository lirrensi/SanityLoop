import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startDaemon, tmpHome, rmHome } from "./harness.ts";
import { deriveStatus, friendlyNameFor, RunStore } from "../src/server/runs.ts";
import type { RunRecord } from "../src/server/stores.ts";
import type { SwarmServer } from "../src/server/index.ts";
// (RunRecord/SwarmServer imported above)

const QUICK = "process.exit(0);";
const FAIL = "process.exit(2);";

async function settled(server: SwarmServer, id: string, timeoutMs = 8000): Promise<RunRecord> {
	return server.api.runs.wait(id, { timeoutMs });
}

test("exec registers a run; get/list reflect it; settle lands completed", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	try {
		const forked = await server.api.runs.exec({
			spawn: { cmd: process.execPath, args: ["-e", QUICK] },
		});
		assert.ok(forked.runId);
		const view = server.api.runs.get(forked.runId);
		assert.ok(view);
		assert.equal(view?.id, forked.runId);
		assert.equal(view?.kind, "job");
		const list = server.api.runs.list({});
		assert.ok(list.some((v) => v.id === forked.runId));
		const rec = await settled(server, forked.runId);
		assert.equal(rec.state, "completed");
		assert.equal(rec.exit?.code, 0);
	} finally {
		await server.stop();
		rmHome(home);
	}
});

test("failed exit settles as failed", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	try {
		const forked = await server.api.runs.exec({
			spawn: { cmd: process.execPath, args: ["-e", FAIL] },
		});
		const rec = await settled(server, forked.runId);
		assert.equal(rec.state, "failed");
		assert.equal(rec.exit?.code, 2);
	} finally {
		await server.stop();
		rmHome(home);
	}
});

test("logs: incremental offsets resume; tailBytes caps", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	try {
		const forked = await server.api.runs.exec({
			spawn: {
				cmd: process.execPath,
				args: ["-e", "process.stdout.write('aaa');process.stdout.write('bbb');"],
			},
		});
		await settled(server, forked.runId);
		const first = server.api.runs.logs(forked.runId, { stream: "stdout" });
		assert.ok(first?.text.includes("aaabbb"), JSON.stringify(first));
		const second = server.api.runs.logs(forked.runId, {
			stream: "stdout",
			offset: first?.nextOffset,
		});
		assert.equal(second?.text, "");
		const tail = server.api.runs.logs(forked.runId, { stream: "stdout", tailBytes: 3 });
		assert.equal(tail?.text, "bbb");
	} finally {
		await server.stop();
		rmHome(home);
	}
});

test("wait resolves on output match", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	try {
		const forked = await server.api.runs.exec({
			spawn: {
				cmd: process.execPath,
				args: ["-e", "setTimeout(()=>{process.stdout.write('READY-123');},200);setTimeout(()=>{},2000);"],
			},
		});
		const rec = await server.api.runs.wait(forked.runId, {
			match: "READY-123",
			timeoutMs: 8000,
		});
		assert.equal(rec.matchedPattern, "READY-123");
		assert.equal(rec.lastEvent, "matched_output");
		server.api.runs.kill(forked.runId, { force: true });
	} finally {
		await server.stop();
		rmHome(home);
	}
});

test("wait times out with a snapshot attached", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	try {
		const forked = await server.api.runs.exec({
			spawn: {
				cmd: process.execPath,
				args: ["-e", "setInterval(()=>{},1000);"],
			},
		});
		const err = await server.api.runs
			.wait(forked.runId, { timeoutMs: 400, match: "never-appears-xyz" })
			.then(
				() => null,
				(e: unknown) => e as { message?: string; snapshot?: RunRecord | null },
			);
		assert.ok(err && /timed out/.test(String(err.message)), JSON.stringify(err?.message));
		assert.ok(err.snapshot, "timeout error carries a snapshot");
		server.api.runs.kill(forked.runId, { force: true });
	} finally {
		await server.stop();
		rmHome(home);
	}
});

test("prune deletes terminal runs past keep / olderThanMs, never live ones", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	try {
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			const f = await server.api.runs.exec({
				spawn: { cmd: process.execPath, args: ["-e", QUICK] },
			});
			ids.push(f.runId);
		}
		for (const id of ids) await settled(server, id);
		const live = await server.api.runs.exec({
			spawn: { cmd: process.execPath, args: ["-e", "setInterval(()=>{},1000);"] },
		});
		const deleted = server.api.runs.prune(undefined, 1);
		assert.ok(deleted.length >= 2, JSON.stringify(deleted));
		for (const id of deleted) assert.equal(server.api.runs.get(id), null);
		assert.ok(server.api.runs.get(live.runId), "live run survives prune");
		server.api.runs.kill(live.runId, { force: true });
	} finally {
		await server.stop();
		rmHome(home);
	}
});

test("friendly names derive from the command root and stay unique", () => {
	const taken = new Set<string>();
	const a = friendlyNameFor("node server.js", taken);
	taken.add(a);
	const b = friendlyNameFor("node server.js", taken);
	assert.notEqual(a, b);
	assert.match(a, /-/);
});

test("deriveStatus: stale when unsupervised; legacy unknown normalizes to stale on load", async () => {
	const base: RunRecord = {
		id: "run-x",
		name: "n",
		kind: "job",
		state: "running",
		spawn: { cmd: "true" },
		trigger: { origin: "exec", attempt: 0 },
		startedAt: Date.now(),
		logPath: "/tmp",
		agents: [],
	};
	assert.equal(deriveStatus({ ...base, pid: 12345 }, false), "stale");
	assert.equal(
		deriveStatus({ ...base, exit: { code: 0, signal: null, at: Date.now() } }, false),
		"completed",
	);
	// legacy persisted "unknown" normalizes to stale when the store loads it
	const home = tmpHome();
	const server = await startDaemon({ home });
	try {
		const forked = await server.api.runs.exec({
			spawn: { cmd: process.execPath, args: ["-e", QUICK] },
		});
		await settled(server, forked.runId);
		const store = new RunStore({ home });
		const metaPath = join(home, "runs", forked.runId, "meta.json");
		const raw = JSON.parse(readFileSync(metaPath, "utf8"));
		raw.state = "unknown";
		delete raw.exit;
		delete raw.endedAt;
		writeFileSync(metaPath, JSON.stringify(raw));
		const reloaded = store.get(forked.runId);
		assert.equal(reloaded.state, "stale");
	} finally {
		await server.stop();
		rmHome(home);
	}
});

test("unknown run: get/logs return null; kill reports ok:false", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	try {
		assert.equal(server.api.runs.get("run-deadbeef"), null);
		assert.equal(server.api.runs.logs("run-deadbeef"), null);
		assert.deepEqual(server.api.runs.kill("run-deadbeef"), {
			ok: false,
			id: "run-deadbeef",
		});
	} finally {
		await server.stop();
		rmHome(home);
	}
});
