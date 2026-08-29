import { basename } from "node:path";
import type { RunTarget, RunOptions, RunResult, StageSpec } from "./types.ts";

export interface RunInSandboxOpts {
	target: RunTarget;
	// The agent's entry function — runs unchanged inside the target.
	run: () => void | Promise<void>;
	// Copy mode: this file's path (pass `import.meta.filename`). Staged to agent/<base>.
	script?: string;
	// Extra files to stage alongside the script (skills, node_modules, AGENTS.md...).
	extraStage?: StageSpec[];
	// Mount mode: the script is already inside the target (e.g. bind-mounted root).
	runPath?: string;
	env?: Record<string, string>;
	ports?: number[];
	args?: string[];
	// "already inside" marker so a relaunched process doesn't recurse.
	marker?: string;
}

// Core, testable: stage (if needed) + run the script inside the target.
// Returns the target's RunResult, or null when the marker guard fired (the
// agent ran in place and nothing was launched). Never exits the process.
export async function stageAndRun(
	opts: RunInSandboxOpts,
): Promise<RunResult | null> {
	const marker = opts.marker ?? "SL_INSIDE_SANDBOX";
	if (process.env[marker]) {
		await opts.run();
		return null;
	}

	let entry: string;
	if (opts.runPath) {
		entry = opts.runPath;
		if (opts.extraStage) await opts.target.stage(opts.extraStage);
	} else {
		if (!opts.script) {
			throw new Error(
				"runInSandbox: provide `script` (import.meta.filename) or `runPath`",
			);
		}
		const base = basename(opts.script);
		entry = `agent/${base}`;
		const stage: StageSpec[] = [
			{ from: opts.script, to: entry },
			...(opts.extraStage ?? []),
		];
		await opts.target.stage(stage);
	}

	// pi-lens-ignore: sql-injection  (false positive: target.run launches the agent script, not SQL)
	const result = await opts.target.run(entry, {
		args: opts.args,
		env: { ...opts.env, [marker]: "1" },
		ports: opts.ports,
	} satisfies RunOptions);
	return result;
}

// Thin wrapper over stageAndRun that exits the host process with the script's
// exit code once the target finishes (host side). Inside the sandbox the
// marker guard runs the agent in place and this returns without exiting.
export async function runInSandbox(opts: RunInSandboxOpts): Promise<void> {
	const result = await stageAndRun(opts);
	if (result) process.exit(result.code ?? 0);
}
