// @sanityloop/sandbox-docker — unit checks on the docker run-arg construction
// plus a LIVE container test proving real isolation. The live test runs only
// when SL_DOCKER=1 (needs a running Docker daemon + the node:22 image).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMountArg, buildRunArgs, createDockerSandbox } from "../docker.ts";
import type { RunOptions } from "@sanityloop/sandbox";

test("buildMountArg: readOnly appends :ro; defaults to the staged root", () => {
	assert.equal(
		buildMountArg({ mount: "C:/proj", readOnly: true }, "/work", "stage"),
		"C:/proj:/work:ro",
	);
	assert.equal(
		buildMountArg({ mount: "C:/proj" }, "/work", "stage"),
		"C:/proj:/work",
	);
	assert.equal(buildMountArg({}, "/work", "stage"), "stage:/work");
});

test("buildRunArgs: mounts, tmpfs, ports, env and entry all end up in the docker command", () => {
	const args = buildRunArgs(
		{ mount: "C:/proj", readOnly: true, tmpfs: "/tmp" },
		"/work",
		"stageRoot",
		"node:22",
		"probe.ts",
		{ env: { K: "v" }, ports: [8080], args: ["--flag"] } satisfies RunOptions,
	);
	const s = args.join(" ");
	assert.ok(s.includes("-v C:/proj:/work:ro"), s);
	assert.ok(s.includes("--tmpfs /tmp"), s);
	assert.ok(s.includes("-p 8080:8080"), s);
	assert.ok(s.includes("-e K=v"), s);
	assert.ok(s.includes("node:22"), s);
	assert.ok(s.includes("--experimental-strip-types"), s);
	assert.ok(s.includes("probe.ts"), s);
	assert.ok(s.includes("--flag"), s);
});

test("LIVE docker micro-sandbox: real isolation (needs SL_DOCKER=1)", {
	skip: process.env.SL_DOCKER !== "1",
}, async () => {
	const projectRoot = mkdtempSync(join(tmpdir(), "sl-docker-live-"));
	writeFileSync(
		join(projectRoot, "probe.ts"),
		[
			`import { writeFileSync } from "node:fs";`,
			`console.log("platform=" + process.platform);`,
			`console.log("probe_key=" + (process.env.PROBE_KEY ?? "none"));`,
			`let tmpOk = "no"; try { writeFileSync("/tmp/p.txt", "x"); tmpOk = "yes"; } catch {}`,
			`let workWrite = "unexpected-write-ok"; try { writeFileSync("/work/escape.txt", "x"); } catch { workWrite = "blocked"; }`,
			`console.log("tmp_write=" + tmpOk);`,
			`console.log("work_write=" + workWrite);`,
		].join("\n"),
	);

	const sandbox = createDockerSandbox({
		mount: projectRoot,
		readOnly: true,
		tmpfs: "/tmp",
		image: "node:22",
	});
	let out = "";
	const res = await sandbox.run("probe.ts", {
		env: { PROBE_KEY: "docker-secret" },
		onStdout: (c) => (out += c),
		onStderr: (c) => (out += c),
	});
	await sandbox.dispose();

	assert.equal(res.code, 0, `expected exit 0, got ${res.code}; output: ${out}`);
	assert.ok(
		out.includes("platform=linux"),
		`host is not win32 inside container; output: ${out}`,
	);
	assert.ok(out.includes("probe_key=docker-secret"), out);
	assert.ok(
		out.includes("tmp_write=yes"),
		`tmpfs write should succeed; output: ${out}`,
	);
	assert.ok(
		out.includes("work_write=blocked"),
		`read-only mount should block writes; output: ${out}`,
	);
});
