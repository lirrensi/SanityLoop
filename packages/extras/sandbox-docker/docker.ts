import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageFiles } from "@sanityloop/sandbox";
import type { RunTarget, RunOptions, StageSpec } from "@sanityloop/sandbox";

export interface DockerSandboxOpts {
	image?: string; // default "node:22" (needs --experimental-strip-types → 22.6+)
	readOnly?: boolean; // mount workspace read-only; writes go to tmpfs
	tmpfs?: string; // e.g. "/tmp"
	workdir?: string; // container workdir, default /work
	mount?: string; // host dir to bind-mount into workdir (the T-0011 micro-sandbox)
	extraMounts?: { from: string; to: string; ro?: boolean }[];
}

// Docker Desktop needs forward slashes in bind-mount sources on Windows.
function normalizeMountSource(source: string): string {
	return source.replaceAll("\\", "/");
}

export function buildMountArg(
	opts: DockerSandboxOpts,
	workdir: string,
	stageRoot: string,
): string {
	const source = normalizeMountSource(opts.mount ?? stageRoot);
	const readOnly = opts.readOnly ? ":ro" : "";
	return `${source}:${workdir}${readOnly}`;
}

export function buildRunArgs(
	opts: DockerSandboxOpts,
	workdir: string,
	stageRoot: string,
	image: string,
	script: string,
	run: RunOptions,
): string[] {
	const portArgs = (run.ports ?? []).flatMap((p) => ["-p", `${p}:${p}`]);
	const mountArgs = [
		"-v",
		buildMountArg(opts, workdir, stageRoot),
		...(opts.tmpfs ? ["--tmpfs", opts.tmpfs] : []),
		...(opts.extraMounts ?? []).flatMap((m) => [
			"-v",
			`${normalizeMountSource(m.from)}:${m.to}${m.ro ? ":ro" : ""}`,
		]),
	];
	const envArgs = Object.entries(run.env ?? {}).flatMap(([k, v]) => [
		"-e",
		`${k}=${v}`,
	]);
	return [
		"run",
		"--rm",
		"-i",
		"-w",
		workdir,
		...portArgs,
		...mountArgs,
		...envArgs,
		image,
		"node",
		"--experimental-strip-types",
		script,
		...(run.args ?? []),
	];
}

// Run the whole agent script inside a container. The container only sees what
// you mount — nothing else on the host. No tool modification: the script uses
// node:fs natively; isolation is the container boundary.
//
// Foreground model: `docker run` streams the container's stdout/stderr straight
// into our callbacks and its exit code IS the script's exit code — no
// logs/detach/wait race.
export function createDockerSandbox(opts: DockerSandboxOpts = {}): RunTarget {
	const image = opts.image ?? "node:22";
	const workdir = opts.workdir ?? "/work";
	const stageRoot = mkdtempSync(join(tmpdir(), "sl-docker-"));
	let child: ChildProcess | null = null;

	return {
		kind: `docker:${image}`,

		async stage(files: StageSpec[]) {
			await stageFiles(files, stageRoot);
		},

		async run(script: string, run: RunOptions = {}) {
			const proc = spawn(
				"docker",
				buildRunArgs(opts, workdir, stageRoot, image, script, run),
			);
			child = proc;
			proc.stdout?.on("data", (d) =>
				(run.onStdout ?? process.stdout.write)(d.toString()),
			);
			proc.stderr?.on("data", (d) =>
				(run.onStderr ?? process.stderr.write)(d.toString()),
			);
			run.signal?.addEventListener("abort", () => proc.kill("SIGTERM"));
			const code = await new Promise<number | null>((resolve, reject) => {
				proc.on("error", reject);
				proc.on("close", (c, sig) => resolve(sig ? null : c));
			});
			return { code, signal: null };
		},

		async dispose() {
			if (child) child.kill("SIGTERM");
			rmSync(stageRoot, { recursive: true, force: true });
		},
	};
}
