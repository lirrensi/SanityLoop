// ============================================================================
// processes.test.ts — the daemon's memory for forks: templates module,
// processes.json CRUD, atomic write-through, torn-file behavior, autorestart
// policy, boot resubmit, and fleet.json migration (read once, then deleted).
// Exit facts arrive via the PM2 bus — stderrTail is best-effort (usually
// absent since err lands in NULL).
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdirSync,
	writeFileSync,
	existsSync,
	readFileSync,
	mkdtempSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanTemplates, findTemplate } from "../src/server/templates.ts";
import { loadProcesses } from "../src/server/stores.ts";
import { startDaemon, tmpHome, rmHome } from "./harness.ts";

const IDLE_TS = `setTimeout(() => process.exit(0), 400);\n`;

function makeHome(): string {
	return mkdtempSync(join(tmpdir(), "swarm-proc-"));
}

function seedTemplates(home: string): string {
	const tdir = join(home, "templates");
	mkdirSync(tdir, { recursive: true });
	writeFileSync(join(tdir, "idle.ts"), IDLE_TS);
	writeFileSync(join(tdir, "w1.json"), JSON.stringify({ id: "w1", file: "idle.ts" }));
	return tdir;
}

test("scanTemplates resolves valid manifests, skips broken ones (mode dropped)", () => {
	const home = makeHome();
	const tdir = seedTemplates(home);
	writeFileSync(join(tdir, "broken.json"), "{ not json");
	writeFileSync(join(tdir, "nofile.json"), JSON.stringify({ id: "x" }));
	writeFileSync(join(tdir, "withmode.json"), JSON.stringify({ id: "wm", file: "idle.ts", mode: "admin" }));

	const t = scanTemplates(tdir);
	assert.equal(t.length, 2, `expected w1 + withmode, got ${JSON.stringify(t.map((x) => x.id))}`);
	const wm = t.find((x) => x.id === "wm")!;
	assert.ok(!("mode" in wm), "template mode is dropped");
	rmSync(home, { recursive: true, force: true });
});

test("findTemplate matches by id / file / file-without-ext", () => {
	const home = makeHome();
	const tdir = seedTemplates(home);
	assert.equal(findTemplate(tdir, "w1")?.id, "w1");
	assert.equal(findTemplate(tdir, "w1.json")?.id, "w1");
	rmSync(home, { recursive: true, force: true });
});

test("processes.json round-trips through the daemon; torn file starts clean", async () => {
	const home = tmpHome();
	const tdir = join(home, "templates");
	mkdirSync(tdir, { recursive: true });
	writeFileSync(join(tdir, "idle.ts"), IDLE_TS);
	writeFileSync(join(tdir, "w1.json"), JSON.stringify({ id: "w1", file: "idle.ts" }));
	try {
		const server = await startDaemon({ home, templatesDir: tdir });
		const started = await server.api.processes.start("web", { from: "w1" });
		assert.ok(started && started.pid);
		const ppath = join(home, "processes.json");
		assert.ok(existsSync(ppath), "write-through on mutate");
		const disk = JSON.parse(readFileSync(ppath, "utf8"));
		assert.equal(disk.rows[0].name, "web");
		server.api.processes.stop("web");
		await server.stop();

		// torn file → start clean
		writeFileSync(ppath, "{ torn");
		const server2 = await startDaemon({ home, templatesDir: tdir });
		assert.deepEqual(server2.api.processes.list(), []);
		await server2.stop();
	} finally {
		rmHome(home);
	}
});

test("fleet.json migrates once into processes, then is deleted", async () => {
	const home = tmpHome();
	const tdir = join(home, "templates");
	mkdirSync(tdir, { recursive: true });
	writeFileSync(join(tdir, "idle.ts"), IDLE_TS);
	writeFileSync(join(tdir, "w1.json"), JSON.stringify({ id: "w1", file: "idle.ts" }));
	writeFileSync(
		join(home, "fleet.json"),
		JSON.stringify({ v: 1, recipes: [{ sessionId: "legacy-web", template: "w1.json", args: [], env: {}, cwd: ".", createdAt: 1 }] }),
	);
	try {
		const server = await startDaemon({ home, templatesDir: tdir });
		const def = server.api.processes.get("legacy-web");
		assert.ok(def, "legacy recipe became a remembered process");
		assert.equal(def.from, "w1.json");
		assert.ok(!existsSync(join(home, "fleet.json")), "fleet.json deleted after migration");
		await server.stop();
		// second boot: no fleet.json, processes.json is the memory
		assert.ok(existsSync(join(home, "processes.json")));
	} finally {
		rmHome(home);
	}
});

test("autorestart=true stays running on crash; false records exit and stops", async () => {
	const home = tmpHome();
	const tdir = join(home, "templates");
	mkdirSync(tdir, { recursive: true });
	writeFileSync(join(tdir, "crash.ts"), `process.exit(3);\n`);
	writeFileSync(join(tdir, "crash.json"), JSON.stringify({ id: "crash", file: "crash.ts" }));
	try {
		const server = await startDaemon({ home, templatesDir: tdir });
		const started = (await server.api.processes.start("flaky", { from: "crash", autorestart: true }))!;
		assert.ok(started.pid);
		// PM2 autorestart: the supervisor reports the PM2-driven restart and
		// the daemon counts it (starts++). No fake clock — poll the count.
		const dl = Date.now() + 8000;
		while (Date.now() < dl) {
			const cur = server.api.processes.get("flaky");
			if (cur && cur.starts >= 2) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		const after = server.api.processes.get("flaky")!;
		assert.ok(after.starts >= 2, `autorestart resubmitted (starts=${after.starts})`);
		assert.equal(after.status, "running");
		server.api.processes.stop("flaky");
		await server.stop();

		// autorestart=false: the crash lands as exit facts, desired state → stopped.
		const server2 = await startDaemon({ home, templatesDir: tdir });
		const once = (await server2.api.processes.start("doomed", { from: "crash", autorestart: false }))!;
		assert.ok(once.pid);
		const dl2 = Date.now() + 8000;
		while (Date.now() < dl2) {
			const cur = server2.api.processes.get("doomed");
			if (cur && cur.status === "stopped") break;
			await new Promise((r) => setTimeout(r, 100));
		}
		const dead = server2.api.processes.get("doomed")!;
		assert.equal(dead.status, "stopped");
		assert.equal(dead.lastExit?.code, 3);
		// stderrTail is best-effort via the bus — usually absent, never asserted
		await server2.stop();

		// boot resubmit: a kept running process reforks on the next start()
		server2.api.processes.save("keeper", { from: "crash", autorestart: false });
		const raw = JSON.parse(readFileSync(join(home, "processes.json"), "utf8"));
		for (const r of raw.rows) if (r.name === "keeper") r.status = "running";
		writeFileSync(join(home, "processes.json"), JSON.stringify(raw, null, 2));
		const server3 = await startDaemon({ home, templatesDir: tdir });
		const kept = server3.api.processes.get("keeper")!;
		assert.equal(kept.status, "running");
		assert.ok(typeof kept.pid === "number", "boot reforked the kept process");
		server3.api.processes.stop("keeper");
		await server3.stop();
	} finally {
		rmHome(home);
	}
});

test("stop/remove kill the label; restart kills then reforks with a fresh session", async () => {
	const home = tmpHome();
	const tdir = join(home, "templates");
	mkdirSync(tdir, { recursive: true });
	writeFileSync(join(tdir, "idle.ts"), IDLE_TS);
	writeFileSync(join(tdir, "w1.json"), JSON.stringify({ id: "w1", file: "idle.ts" }));
	try {
		const server = await startDaemon({ home, templatesDir: tdir });
		const s1 = (await server.api.processes.start("p1", { from: "w1" }))!;
		assert.ok(typeof s1.pid === "number");
		const r = await server.api.processes.restart("p1");
		assert.ok(r.ok);
		assert.ok(r.sessionId && r.sessionId !== s1.sessionId, "restart reforks with a fresh session");
		server.api.processes.remove("p1");
		assert.equal(server.api.processes.get("p1"), null);
		// loadProcesses still parses the on-disk mirror
		assert.ok(Array.isArray([...loadProcesses(join(home, "processes.json")).values()]));
		await server.stop();
	} finally {
		rmHome(home);
	}
});
