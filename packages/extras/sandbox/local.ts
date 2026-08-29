import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageFiles } from "./stage.ts";
import type { RunTarget, RunOptions, StageSpec } from "./types.ts";

// The "no isolation" target — today's behavior, wrapped as a RunTarget so the
// launcher API is uniform. Like Flue's local(): real host FS + real shell,
// zero isolation by design.
export function createLocalSandbox(opts: { workdir?: string } = {}): RunTarget {
  const workdir = opts.workdir ?? join(tmpdir(), `sl-local-${Date.now()}`);
  mkdirSync(workdir, { recursive: true });
  return {
    kind: "local",
    async stage(files: StageSpec[]) {
      await stageFiles(files, workdir);
    },
    async run(script: string, run: RunOptions = {}) {
      return new Promise((resolve) => {
        const child = spawn("node", ["--experimental-strip-types", script, ...(run.args ?? [])], {
          cwd: run.cwd ?? workdir,
          env: { ...process.env, ...run.env },
          stdio: ["inherit", "pipe", "pipe"],
        });
        run.signal?.addEventListener("abort", () => child.kill("SIGTERM"));
        child.stdout?.on("data", (d) => (run.onStdout ?? process.stdout.write)(d.toString()));
        child.stderr?.on("data", (d) => (run.onStderr ?? process.stderr.write)(d.toString()));
        child.on("exit", (code, signal) => resolve({ code, signal }));
      });
    },
    async dispose() {
      // host temp; remove per policy if desired
    },
  };
}
