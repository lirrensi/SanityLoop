// ============================================================================
// spawner.test.ts — the hypervisor half: template discovery + child_process
// lifecycle + fleet manifest. Uses a trivial idle fixture (sleeps then exits)
// so we can observe a live pid without an LLM.
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
import { Spawner } from "../src/server/spawner.ts";

const IDLE_TS = `setTimeout(() => process.exit(0), 400);\n`;

function makeHome(): string {
	return mkdtempSync(join(tmpdir(), "swarm-spawner-"));
}

function seedTemplates(home: string): string {
	const tdir = join(home, "templates");
	mkdirSync(tdir, { recursive: true });
	writeFileSync(join(tdir, "idle.ts"), IDLE_TS);
	writeFileSync(
		join(tdir, "worker.json"),
		JSON.stringify({ id: "w1", description: "a worker", mode: "worker", file: "idle.ts" }),
	);
	return tdir;
}

test("scanTemplates resolves valid manifests, skips broken ones", () => {
	const home = makeHome();
	const tdir = seedTemplates(home);
	writeFileSync(join(tdir, "broken.json"), "{ not json");
	writeFileSync(join(tdir, "nofile.json"), JSON.stringify({ id: "x" })); // no file pointer
	writeFileSync(join(tdir, "missing.json"), JSON.stringify({ id: "y", file: "ghost.ts" })); // file missing

	const sp = new Spawner({ templatesDir: tdir, manifestPath: join(home, "fleet.json") });
	const t = sp.scanTemplates();
	assert.equal(t.length, 1);
	assert.equal(t[0].id, "w1");
	assert.equal(t[0].mode, "worker");
	assert.equal(t[0].description, "a worker");
	assert.equal(t[0].path, join(tdir, "idle.ts"));
	rmSync(home, { recursive: true, force: true });
});

test("findTemplate matches by id / file / file-without-ext", () => {
	const home = makeHome();
	const tdir = seedTemplates(home);
	const sp = new Spawner({ templatesDir: tdir });
	assert.ok(sp.findTemplate("w1"));
	assert.ok(sp.findTemplate("worker.json"));
	assert.ok(sp.findTemplate("worker"));
	assert.equal(sp.findTemplate("nope"), undefined);
	rmSync(home, { recursive: true, force: true });
});

test("spawn → pid + spawned flag + manifest write; kill removes recipe", () => {
	const home = makeHome();
	const tdir = seedTemplates(home);
	const manifest = join(home, "fleet.json");
	const sp = new Spawner({ templatesDir: tdir, manifestPath: manifest });
	const tpl = sp.findTemplate("w1")!;

	const r1 = sp.spawn(tpl);
	assert.ok(typeof r1.sessionId === "string");
	assert.ok(typeof r1.pid === "number");
	assert.equal(sp.isSpawned(r1.sessionId), true);
	assert.ok(sp.pidOf(r1.sessionId));

	assert.ok(existsSync(manifest));
	const m = JSON.parse(readFileSync(manifest, "utf8"));
	assert.equal(m.recipes.length, 1);
	assert.equal(m.recipes[0].sessionId, r1.sessionId);

	const killed = sp.kill(r1.sessionId);
	assert.equal(killed, true);
	assert.equal(sp.isSpawned(r1.sessionId), false);
	const m2 = JSON.parse(readFileSync(manifest, "utf8"));
	assert.equal(m2.recipes.length, 0);
	rmSync(home, { recursive: true, force: true });
});

test("restart returns a fresh process + recipe; unknown session → false", () => {
	const home = makeHome();
	const tdir = seedTemplates(home);
	const sp = new Spawner({ templatesDir: tdir, manifestPath: join(home, "fleet.json") });
	const tpl = sp.findTemplate("w1")!;
	const r1 = sp.spawn(tpl);
	assert.equal(sp.restart("nope"), false);
	const ok = sp.restart(r1.sessionId);
	assert.equal(ok, true);
	assert.equal(sp.isSpawned(r1.sessionId), true);
	sp.kill(r1.sessionId);
	rmSync(home, { recursive: true, force: true });
});

test("resurrectAll respawns recorded recipes", () => {
	const home = makeHome();
	const tdir = seedTemplates(home);
	const manifest = join(home, "fleet.json");
	const sp = new Spawner({ templatesDir: tdir, manifestPath: manifest });
	const tpl = sp.findTemplate("w1")!;
	const r1 = sp.spawn(tpl);
	const ids = sp.resurrectAll();
	assert.equal(ids.length, 1);
	assert.equal(ids[0], r1.sessionId);
	assert.ok(sp.pidOf(ids[0]));
	sp.kill(ids[0]);
	rmSync(home, { recursive: true, force: true });
});
