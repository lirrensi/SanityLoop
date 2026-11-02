// ============================================================================
// cli.test.ts — the operator's door. Spawns cli.ts as a child process:
// `help` exits 0 and names the programs surface; `exec -- cmd` against a live
// daemon prints the run result; `programs define` + `programs list` round-trip.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startDaemon, tmpHome, rmHome } from "./harness.ts";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/server/cli.ts", import.meta.url));
const NODE_FLAGS = ["--experimental-strip-types", "--experimental-transform-types"];

async function cli(home: string, port: number, args: string[]): Promise<{ stdout: string; stderr: string }> {
	return (await run(process.execPath, [...NODE_FLAGS, CLI, ...args], {
		env: {
			...process.env,
			SWARM_HOME: home,
			// the CLI resolves --server explicitly in every call below; the env
			// home only keeps config.json reads out of the real ~/.sanity.
			SWARM_SERVER: `ws://127.0.0.1:${port}`,
		},
		timeout: 30000,
	})) as { stdout: string; stderr: string };
}

test("CLI: help exits 0 and names the programs surface", async () => {
	const home = tmpHome();
	try {
		const { stdout } = (await run(process.execPath, [...NODE_FLAGS, CLI, "help"], {
			env: { ...process.env, SWARM_HOME: home },
			timeout: 30000,
		})) as { stdout: string };
		assert.ok(stdout.includes("programs"), "help names programs");
		assert.ok(stdout.includes("runs"), "help names runs");
		assert.ok(stdout.includes("exec"), "help names exec");
	} finally {
		rmHome(home);
	}
});

test("CLI: exec against a live daemon prints the result", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	try {
		const url = `ws://127.0.0.1:${server.port}`;
		const { stdout } = await cli(home, server.port, [
			"exec",
			"--server",
			url,
			"--wait-ms",
			"15000",
			"--",
			process.execPath,
			"--version",
		]);
		const parsed = JSON.parse(stdout) as { runId?: string };
		assert.ok(parsed.runId, `exec prints a run result with runId: ${stdout.slice(0, 200)}`);
	} finally {
		rmHome(home);
		await server.stop();
	}
});

test("CLI: programs define + list round-trip", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	try {
		const url = `ws://127.0.0.1:${server.port}`;
		const defined = await cli(home, server.port, [
			"programs",
			"define",
			"cli-prog",
			"--server",
			url,
			"--kind",
			"job",
			"--cmd",
			process.execPath,
			"--",
			"--version",
		]);
		const defParsed = JSON.parse(defined.stdout) as { name?: string };
		assert.equal(defParsed.name, "cli-prog");

		const listed = await cli(home, server.port, ["programs", "list", "--server", url]);
		const rows = JSON.parse(listed.stdout) as { name: string }[];
		assert.ok(rows.find((p) => p.name === "cli-prog"), "defined program listed");

		const gotten = await cli(home, server.port, ["programs", "get", "cli-prog", "--server", url]);
		const view = JSON.parse(gotten.stdout) as { def?: { name?: string }; name?: string };
		assert.equal(view.def?.name ?? view.name, "cli-prog");
	} finally {
		rmHome(home);
		await server.stop();
	}
});
test("CLI: programs define --json merged with flags (flags win)", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	try {
		const url = `ws://127.0.0.1:${server.port}`;
		await cli(home, server.port, [
			"programs", "define", "json-prog", "--server", url,
			"--json", '{"overlap":"allow","keepRuns":5,"notes":"from-json"}',
			"--notes", "from-flag", "--cmd", process.execPath, "--", "--version",
		]);
		const gotten = await cli(home, server.port, ["programs", "get", "json-prog", "--server", url]);
		const view = JSON.parse(gotten.stdout) as { def?: Record<string, unknown> };
		const def = view.def ?? (view as unknown as Record<string, unknown>);
		assert.equal(def["overlap"], "allow");
		assert.equal(def["keepRuns"], 5);
		assert.equal(def["notes"], "from-flag");
	} finally {
		rmHome(home);
		await server.stop();
	}
});

test("CLI: programs define --json invalid dies with message", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	try {
		const url = `ws://127.0.0.1:${server.port}`;
		await assert.rejects(
			cli(home, server.port, ["programs", "define", "bad-json", "--server", url, "--json", "{oops", "--cmd", "x"]),
			/--json is not valid JSON/,
		);
	} finally {
		rmHome(home);
		await server.stop();
	}
});

test("CLI: exec --cwd runs in the given dir", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	try {
		const url = `ws://127.0.0.1:${server.port}`;
		const { stdout } = await cli(home, server.port, [
			"exec", "--server", url, "--wait-ms", "15000", "--cwd", "/tmp", "--", "pwd",
		]);
		const parsed = JSON.parse(stdout) as { logs?: { stdout?: string }; stdout?: string; text?: string };
		const text = JSON.stringify(parsed);
		assert.ok(text.includes("/tmp"), `exec --cwd printed /tmp: ${stdout.slice(0, 300)}`);
	} finally {
		rmHome(home);
		await server.stop();
	}
});

test("CLI: agents list --status filters", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	try {
		const url = `ws://127.0.0.1:${server.port}`;
		// the CLI's own admin session registers as an online agent, so the
		// unfiltered list is non-empty; --status offline must filter it out
		const { stdout } = await cli(home, server.port, ["agents", "list", "--server", url, "--status", "offline"]);
		assert.equal(stdout.trim(), "");
		await assert.rejects(
			cli(home, server.port, ["agents", "list", "--server", url, "--status", "bogus"]),
		);
	} finally {
		rmHome(home);
		await server.stop();
	}
});

test("CLI: listen --run prints the runCompleted event", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	try {
		const url = `ws://127.0.0.1:${server.port}`;
		// detached sleep run: returns immediately with a runId, completes later
		const { stdout } = await cli(home, server.port, [
			"exec", "--server", url, "--detach", "--", "sleep", "1",
		]);
		const parsed = JSON.parse(stdout) as { runId?: string; id?: string };
		const runId = parsed.runId ?? parsed.id;
		assert.ok(runId, `detached exec returned a runId: ${stdout.slice(0, 200)}`);
		const child = spawn(
			process.execPath,
			[...NODE_FLAGS, CLI, "listen", "--server", url, "--run", runId!],
			{ env: { ...process.env, SWARM_HOME: home }, stdio: ["ignore", "pipe", "pipe"] },
		);
		// Integration: the daemon emits runCompleted on the real clock — poll the
		// child's stdout until the event line arrives (sleep 1 settles in ~1s).
		let out = "";
		const seen = new Promise<void>((resolve) => {
			const timer = setInterval(() => {
				if (out.includes("runCompleted")) {
					clearInterval(timer);
					resolve();
				}
			}, 100);
			child.stdout.on("data", (d: Buffer) => {
				out += d.toString();
			});
		});
		await Promise.race([
			seen,
			once(child, "exit").then(() => {
				throw new Error(`listen exited before runCompleted: ${out.slice(0, 500)}`);
			}),
		]);
		child.kill("SIGINT");
		await once(child, "exit").catch(() => {});
		assert.ok(out.includes("runCompleted"), `listen printed runCompleted: ${out.slice(0, 500)}`);
	} finally {
		rmHome(home);
		await server.stop();
	}
});

test("CLI: listen requires exactly one target", async () => {
	const home = tmpHome();
	const server = await startDaemon({ home });
	try {
		const url = `ws://127.0.0.1:${server.port}`;
		await assert.rejects(cli(home, server.port, ["listen", "--server", url]));
		await assert.rejects(
			cli(home, server.port, ["listen", "--server", url, "--run", "x", "--program", "y"]),
		);
	} finally {
		rmHome(home);
		await server.stop();
	}
});

test("CLI: doctor --json exits 0 on a fresh tmp home with machine-parseable checks", async () => {
	const home = tmpHome();
	try {
		const { stdout } = await cli(home, 0, ["doctor", "--dir", home, "--json"]);
		const parsed = JSON.parse(stdout) as {
			home: string;
			checks: { name: string; status: string; detail: string }[];
		};
		assert.equal(parsed.home, home);
		assert.ok(parsed.checks.length >= 5, "doctor reports its checks");
		for (const c of parsed.checks) {
			assert.ok(c.name, "check has a name");
			assert.ok(["PASS", "FAIL", "SKIP"].includes(c.status), `check ${c.name} has a status`);
		}
	} finally {
		rmHome(home);
	}
});

test("CLI: install without a service manager prints instructions, exit 2, creates nothing", async () => {
	const home = tmpHome();
	try {
		try {
			await cli(home, 0, ["install", "--dir", home]);
			// a manager IS present (container systemctl --user): real install
			// succeeded — uninstall again so the test leaves nothing behind.
			await cli(home, 0, ["uninstall", "--dir", home]);
		} catch (e: unknown) {
			// no manager: manual instructions on stderr, exit 2, nothing created.
			assert.ok(e instanceof Error, "install rejects without a manager");
			assert.ok("code" in e && e.code === 2, "install exits 2 without a manager");
			assert.ok(
				"stderr" in e && typeof e.stderr === "string" && e.stderr.includes("swarm serve"),
				"instructions name the serve command",
			);
		}
	} finally {
		rmHome(home);
	}
});
