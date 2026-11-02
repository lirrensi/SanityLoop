// ============================================================================
// cli.test.ts — the operator's door. Spawns cli.ts as a child process:
// `help` exits 0 and names the programs surface; `exec -- cmd` against a live
// daemon prints the run result; `programs define` + `programs list` round-trip.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
