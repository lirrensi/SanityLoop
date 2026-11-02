// supervisor.test.ts — the muscle (supervisor.ts), direct unit tests.
// Fork/exit codes, graceful stop vs SIGKILL, home-lock refuse+release,
// supervisor autorestart backoff, crash-loop guard, and the disconnect no-op.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { existsSync } from "node:fs";
import {
	Supervisor,
	acquireHomeLock,
	releaseHomeLock,
	homeLockPath,
	type ExitFacts,
} from "../src/server/supervisor.ts";
import { tmpHome, rmHome } from "./harness.ts";

function collector() {
	let buf = "";
	const w = new Writable({
		write(chunk, _enc, cb) {
			buf += chunk.toString();
			cb();
		},
	});
	return { w, data: () => buf };
}

function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	return new Promise((resolve, reject) => {
		const iv = setInterval(() => {
			if (cond()) {
				clearInterval(iv);
				resolve();
			} else if (Date.now() - start > timeoutMs) {
				clearInterval(iv);
				reject(new Error("timed out waiting for condition"));
			}
		}, 50);
		iv.unref?.();
	});
}

test("fork echoes SWARM_SPAWN_ID=label and reports exit code 0", async () => {
	const home = tmpHome();
	let death: ExitFacts | undefined;
	const sup = new Supervisor({
		homeDir: home,
		onExit: (_label, facts) => {
			death = facts;
		},
	});
	try {
		const { w, data } = collector();
		const forked = sup.fork(
			{
				label: "echo1",
				cmd: process.execPath,
				args: ["-e", "process.stdout.write(process.env.SWARM_SPAWN_ID ?? '');"],
			},
			{ stdout: w },
		);
		assert.ok(forked.pid);
		assert.match(forked.sessionId, /^swarm-/);
		await waitFor(() => death !== undefined);
		assert.equal(death?.code, 0);
		assert.equal(death?.signal, null);
		// stream may flush just after exit — poll briefly
		const start = Date.now();
		while (data() !== "echo1" && Date.now() - start < 2000) {
			await new Promise((r) => setTimeout(r, 50));
		}
		assert.equal(data(), "echo1");
		assert.deepEqual(sup.lastExit("echo1"), death);
	} finally {
		await sup.stopAll(500);
		rmHome(home);
	}
});

test("nonzero exit code propagates (no restart by default)", async () => {
	const home = tmpHome();
	const deaths: ExitFacts[] = [];
	let restarts = 0;
	const sup = new Supervisor({
		homeDir: home,
		onExit: (_l, f) => deaths.push(f),
		onRestart: () => restarts++,
	});
	try {
		sup.fork({ label: "fail1", cmd: process.execPath, args: ["-e", "process.exit(3);"] });
		await waitFor(() => deaths.length === 1);
		assert.equal(deaths[0]?.code, 3);
		assert.equal(restarts, 0);
	} finally {
		await sup.stopAll(500);
		rmHome(home);
	}
});

test("stop is graceful (SIGTERM honored) within the grace", async () => {
	const home = tmpHome();
	const sup = new Supervisor({ homeDir: home });
	try {
		sup.fork({
			label: "grace1",
			cmd: process.execPath,
			args: ["-e", "process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);"],
		});
		await new Promise((r) => setTimeout(r, 300));
		const ok = await sup.stop("grace1", 2000);
		assert.equal(ok, true);
		const last = sup.lastExit("grace1");
		assert.ok(last);
		// graceful: exited via SIGTERM handler (code 0) or SIGTERM itself
		assert.ok(last?.code === 0 || last?.signal === "SIGTERM", JSON.stringify(last));
		assert.equal(await sup.stop("grace1", 200), false);
	} finally {
		await sup.stopAll(500);
		rmHome(home);
	}
});

test("stop escalates to SIGKILL past the grace", async () => {
	const home = tmpHome();
	const sup = new Supervisor({ homeDir: home });
	try {
		sup.fork({
			label: "kill1",
			cmd: process.execPath,
			args: ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);"],
		});
		await new Promise((r) => setTimeout(r, 300));
		const ok = await sup.stop("kill1", 300);
		assert.equal(ok, true);
		const last = sup.lastExit("kill1");
		assert.equal(last?.signal, "SIGKILL");
	} finally {
		await sup.stopAll(500);
		rmHome(home);
	}
});

test("home lock refuses a second daemon, releases cleanly", () => {
	const home = tmpHome();
	try {
		acquireHomeLock(home);
		assert.ok(existsSync(homeLockPath(home)));
		assert.throws(() => acquireHomeLock(home), /another daemon|lock/i);
		releaseHomeLock(home);
		assert.ok(!existsSync(homeLockPath(home)));
		acquireHomeLock(home);
		releaseHomeLock(home);
	} finally {
		rmHome(home);
	}
});

test("autorestart backs off (200ms floor) and restarts crashes", async () => {
	const home = tmpHome();
	let restarts = 0;
	const sup = new Supervisor({ homeDir: home, onRestart: () => restarts++ });
	try {
		sup.fork({
			label: "flap1",
			cmd: process.execPath,
			args: ["-e", "process.exit(1);"],
			autorestart: "always",
		});
		await new Promise((r) => setTimeout(r, 1500));
		assert.ok(restarts >= 2, `expected >=2 restarts in 1.5s, got ${restarts}`);
		await sup.stop("flap1", 500);
		const atStop = restarts;
		await new Promise((r) => setTimeout(r, 600));
		assert.equal(restarts, atStop);
	} finally {
		await sup.stopAll(500);
		rmHome(home);
	}
});

test("crash-loop guard gives up after 5 quick deaths", async () => {
	const home = tmpHome();
	let restarts = 0;
	let death: ExitFacts | undefined;
	const sup = new Supervisor({
		homeDir: home,
		onExit: (_l, f) => {
			death = f;
		},
		onRestart: () => restarts++,
	});
	try {
		sup.fork({
			label: "loop1",
			cmd: process.execPath,
			args: ["-e", "process.exit(1);"],
			autorestart: "always",
		});
		await waitFor(() => death !== undefined, 12000);
		assert.equal(death?.code, 1);
		assert.ok(restarts <= 4, `expected <=4 restarts before give-up, got ${restarts}`);
	} finally {
		await sup.stopAll(500);
		rmHome(home);
	}
});

test("disconnect/killDaemon are no-ops (API compat)", () => {
	const home = tmpHome();
	try {
		const sup = new Supervisor({ homeDir: home });
		assert.doesNotThrow(() => sup.disconnect());
		assert.doesNotThrow(() => sup.killDaemon());
	} finally {
		rmHome(home);
	}
});
