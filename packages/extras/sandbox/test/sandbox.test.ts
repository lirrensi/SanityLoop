// @sanityloop/sandbox — proof-of-work tests. The local-target test REALLY
// executes a child node process; the rest verify the launch wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createLocalSandbox,
	stageFiles,
	stageAndRun,
} from "@sanityloop/sandbox";
import type {
	RunTarget,
	RunOptions,
	RunResult,
	StageSpec,
} from "@sanityloop/sandbox";

function makeMockTarget(): RunTarget & {
	calls: { script: string; opts?: RunOptions }[];
} {
	const calls: { script: string; opts?: RunOptions }[] = [];
	return {
		kind: "mock",
		calls,
		async stage() {},
		async run(script: string, opts?: RunOptions) {
			calls.push({ script, opts });
			return { code: 0, signal: null } satisfies RunResult;
		},
		async dispose() {},
	};
}

test("stageFiles: inline content and host copies land at their staged paths", async () => {
	const root = mkdtempSync(join(tmpdir(), "sl-stage-"));
	writeFileSync(join(root, "src.txt"), "from-host");
	await stageFiles(
		[
			{ content: "inline-content", to: "a/inline.txt" },
			{ from: join(root, "src.txt"), to: "b/copy.txt" },
		],
		root,
	);
	assert.equal(
		readFileSync(join(root, "a/inline.txt"), "utf8"),
		"inline-content",
	);
	assert.equal(readFileSync(join(root, "b/copy.txt"), "utf8"), "from-host");
});

test("createLocalSandbox: REALLY runs a script — env forwarded, stdout captured, exit code surfaced", async () => {
	const workdir = mkdtempSync(join(tmpdir(), "sl-local-run-"));
	writeFileSync(
		join(workdir, "probe.ts"),
		[
			`import { writeFileSync } from "node:fs";`,
			`console.log("stdout_line=" + process.env.PROBE_KEY);`,
			`writeFileSync("made.txt", "written-by-agent");`,
			`process.exit(3);`,
		].join("\n"),
	);

	const sandbox = createLocalSandbox({ workdir });
	let out = "";
	const res = await sandbox.run("probe.ts", {
		env: { PROBE_KEY: "secret-123" },
		onStdout: (c) => (out += c),
	});
	await sandbox.dispose();

	assert.equal(res.code, 3, `expected exit 3, got ${res.code}`);
	assert.ok(out.includes("stdout_line=secret-123"), `stdout was: ${out}`);
	assert.equal(
		readFileSync(join(workdir, "made.txt"), "utf8"),
		"written-by-agent",
	);
});

test("stageAndRun: marker guard runs the agent in place without launching", async () => {
	const target = makeMockTarget();
	let ran = false;
	const prev = process.env.SL_TEST_MARKER;
	process.env.SL_TEST_MARKER = "1";
	try {
		const res = await stageAndRun({
			target,
			runPath: "probe.ts",
			marker: "SL_TEST_MARKER",
			run: () => {
				ran = true;
			},
		});
		assert.equal(res, null);
		assert.equal(ran, true);
		assert.equal(target.calls.length, 0, "no launch when marker is set");
	} finally {
		if (prev === undefined) delete process.env.SL_TEST_MARKER;
		else process.env.SL_TEST_MARKER = prev;
	}
});

test("stageAndRun: mount mode passes runPath, env and ports to the target", async () => {
	const target = makeMockTarget();
	const res = await stageAndRun({
		target,
		runPath: "probe.ts",
		run: () => {},
		env: { A: "1" },
		ports: [8080],
	});
	assert.equal(res?.code, 0);
	assert.equal(target.calls.length, 1);
	assert.equal(target.calls[0]!.script, "probe.ts");
	assert.equal(target.calls[0]!.opts?.env?.SL_INSIDE_SANDBOX, "1");
	assert.equal(target.calls[0]!.opts?.env?.A, "1");
	assert.deepEqual(target.calls[0]!.opts?.ports, [8080]);
});

test("stageAndRun: copy mode stages the script to agent/<base> and runs that entry", async () => {
	const root = mkdtempSync(join(tmpdir(), "sl-copy-"));
	const script = join(root, "my-agent.ts");
	writeFileSync(script, `export {};\n`);

	const target = makeMockTarget();
	let stagedTo: string | null = null;
	target.stage = async (files: StageSpec[]) => {
		const entry = files.find((f) => "from" in f && f.from === script);
		stagedTo = entry && "to" in entry ? entry.to : null;
	};

	const res = await stageAndRun({ target, script, run: () => {} });
	assert.equal(res?.code, 0);
	assert.equal(stagedTo, "agent/my-agent.ts");
	assert.equal(target.calls[0]!.script, "agent/my-agent.ts");
});
