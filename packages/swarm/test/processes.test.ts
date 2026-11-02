// processes.test.ts — template scanning + legacy migration only.
// Autorestart/stop/restart lifecycle moved to programs.test.ts and
// supervisor.test.ts. Template scan stays (daemon still resolves `from`).
// Migration: processes.json + tasks.json → programs.json on boot (kept, never
// deleted); torn programs.json starts clean.
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
import { join } from "path";
import { scanTemplates, findTemplate } from "../src/server/templates.ts";
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

test("legacy processes.json + tasks.json migrate to programs.json on boot; files kept", async () => {
	const home = tmpHome();
	try {
		writeFileSync(
			join(home, "processes.json"),
			JSON.stringify({
				v: 1,
				rows: [
					{
						name: "legacy-svc",
						file: "/tmp/idle.ts",
						autorestart: true,
						status: "stopped",
						starts: 3,
						createdAt: 1,
						updatedAt: 2,
					},
				],
			}),
		);
		writeFileSync(
			join(home, "tasks.json"),
			JSON.stringify({
				v: 1,
				rows: [
					{
						name: "legacy-job",
						file: "/tmp/idle.ts",
						fire: "manual",
						paused: false,
						runs: 2,
						createdAt: 1,
						updatedAt: 2,
					},
				],
			}),
		);
		const server = await startDaemon({ home });
		try {
			const svc = server.api.programs.get("legacy-svc");
			assert.ok(svc, "legacy process became a program");
			assert.equal(svc.def.kind, "service");
			assert.equal(svc.def.counters.runs, 3);
			assert.deepEqual(svc.def.restart, { policy: "always" });
			const job = server.api.programs.get("legacy-job");
			assert.ok(job, "legacy task became a program");
			assert.equal(job.def.kind, "job");
			assert.equal(job.def.counters.runs, 2);
		} finally {
			await server.stop();
		}
		assert.ok(existsSync(join(home, "processes.json")), "legacy files are kept, never deleted");
		assert.ok(existsSync(join(home, "tasks.json")), "legacy files are kept, never deleted");
		assert.ok(existsSync(join(home, "programs.json")), "programs.json is the memory after migration");
		// second boot: programs.json wins, no duplicate migration
		const server2 = await startDaemon({ home });
		try {
			assert.equal(server2.api.programs.list().length, 2);
		} finally {
			await server2.stop();
		}
	} finally {
		rmHome(home);
	}
});

test("torn programs.json starts clean", async () => {
	const home = tmpHome();
	try {
		writeFileSync(join(home, "programs.json"), "{ torn");
		const server = await startDaemon({ home });
		try {
			assert.deepEqual(server.api.programs.list(), []);
		} finally {
			await server.stop();
		}
	} finally {
		rmHome(home);
	}
});

test("programs.json write-through on define", async () => {
	const home = tmpHome();
	try {
		const server = await startDaemon({ home });
		try {
			server.api.programs.define({
				name: "persist-me",
				spawn: { cmd: process.execPath, args: ["-e", "process.exit(0);"] },
			});
			const ppath = join(home, "programs.json");
			assert.ok(existsSync(ppath), "write-through on mutate");
			const disk = JSON.parse(readFileSync(ppath, "utf8"));
			assert.ok(disk.rows.some((r: { name: string }) => r.name === "persist-me"));
		} finally {
			await server.stop();
		}
	} finally {
		rmHome(home);
	}
});
