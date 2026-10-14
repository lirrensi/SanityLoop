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

const CRASH_TS = `console.error("boom-line");\nprocess.exit(3);\n`;
// static bare import — fails at load with ERR_MODULE_NOT_FOUND naming the package
const BAD_IMPORT_TS = `import "no-such-pkg-xyz-123";\nconsole.log("never here");\n`;

function seedCrashTemplates(home: string): string {
	const tdir = join(home, "templates");
	mkdirSync(tdir, { recursive: true });
	writeFileSync(join(tdir, "crash.ts"), CRASH_TS);
	writeFileSync(join(tdir, "crash.json"), JSON.stringify({ id: "crash", file: "crash.ts" }));
	writeFileSync(join(tdir, "badimport.ts"), BAD_IMPORT_TS);
	writeFileSync(join(tdir, "badimport.json"), JSON.stringify({ id: "badimport", file: "badimport.ts" }));
	return tdir;
}

test("spawn records child exit facts (code) and clears on respawn", async () => {
	// resolver per session — the child's onExit fires it, no polling involved.
	// (Integration across a process boundary: the child IS the condition,
	// so wall-clock-free awaiting means awaiting its real exit signal.)
	const home = makeHome();
	const tdir = seedCrashTemplates(home);
	const waiters = new Map<string, () => void>();
	const exits: { sessionId: string; code: number | null }[] = [];
	const sp = new Spawner({
		templatesDir: tdir,
		homeDir: home,
		onExit: (sessionId, facts) => {
			exits.push({ sessionId, code: facts.code });
			waiters.get(sessionId)?.();
		},
	});
	const waitExit = (sessionId: string): Promise<void> => {
		const { promise, resolve } = Promise.withResolvers<void>();
		waiters.set(sessionId, resolve);
		if (sp.lastExit(sessionId)) resolve();
		return promise;
	};
	const tpl = sp.findTemplate("crash")!;
	const { sessionId } = sp.spawn(tpl);
	assert.equal(sp.lastExit(sessionId), undefined);
	await waitExit(sessionId);
	const facts = sp.lastExit(sessionId)!;
	assert.equal(facts.code, 3);
	assert.equal(facts.signal, null);
	assert.ok(typeof facts.at === "number");
	assert.equal(exits.length, 1);
	assert.equal(exits[0].sessionId, sessionId);
	// respawning the same session clears the death — the worker lives again
	waiters.delete(sessionId);
	sp.spawn(tpl, { sessionId });
	assert.equal(sp.lastExit(sessionId), undefined);
	await waitExit(sessionId);
	assert.equal(sp.lastExit(sessionId)!.code, 3);
	rmSync(home, { recursive: true, force: true });
});

test("failing-import fixture leaves its error in stderrTail", async () => {
	const home = makeHome();
	const tdir = seedCrashTemplates(home);
	const { promise, resolve } = Promise.withResolvers<void>();
	const sp = new Spawner({ templatesDir: tdir, homeDir: home, onExit: () => resolve() });
	const tpl = sp.findTemplate("badimport")!;
	const { sessionId } = sp.spawn(tpl);
	await promise;
	const facts = sp.lastExit(sessionId)!;
	assert.notEqual(facts.code, 0);
	assert.match(facts.stderrTail ?? "", /no-such-pkg-xyz-123/);
	rmSync(home, { recursive: true, force: true });
});

test("warn fires for a template in a bare tmp dir", () => {
	const home = makeHome(); // no node_modules anywhere up-tree, no junction
	const tdir = join(home, "templates");
	mkdirSync(tdir, { recursive: true });
	writeFileSync(join(tdir, "idle.ts"), IDLE_TS);
	writeFileSync(join(tdir, "worker.json"), JSON.stringify({ id: "w1", file: "idle.ts" }));
	const sp = new Spawner({ templatesDir: tdir, homeDir: home });
	const tpl = sp.findTemplate("w1")!;
	const warned: string[] = [];
	const orig = console.warn;
	console.warn = (...args: unknown[]) => {
		warned.push(args.map(String).join(" "));
	};
	try {
		const { sessionId } = sp.spawn(tpl);
		sp.kill(sessionId);
	} finally {
		console.warn = orig;
	}
	assert.ok(
		warned.some((w) => w.includes("bare imports may fail")),
		`expected bare-import warn, got: ${JSON.stringify(warned)}`,
	);
	// ...and stays silent when the template lives under a node_modules tree
	const quiet: string[] = [];
	console.warn = (...args: unknown[]) => {
		quiet.push(args.map(String).join(" "));
	};
	try {
		const proj = mkdtempSync(join(tmpdir(), "swarm-proj-"));
		mkdirSync(join(proj, "node_modules"), { recursive: true });
		const tdir2 = join(proj, "templates");
		mkdirSync(tdir2, { recursive: true });
		writeFileSync(join(tdir2, "idle.ts"), IDLE_TS);
		writeFileSync(join(tdir2, "worker.json"), JSON.stringify({ id: "w1", file: "idle.ts" }));
		const sp2 = new Spawner({ templatesDir: tdir2, homeDir: home });
		const { sessionId } = sp2.spawn(sp2.findTemplate("w1")!);
		sp2.kill(sessionId);
		rmSync(proj, { recursive: true, force: true });
	} finally {
		console.warn = orig;
	}
	assert.ok(
		!quiet.some((w) => w.includes("bare imports may fail")),
		`unexpected warn: ${JSON.stringify(quiet)}`,
	);
	rmSync(home, { recursive: true, force: true });
});
