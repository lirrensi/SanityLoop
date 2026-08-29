// The ONLY fixed contract for sandboxing. A RunTarget wraps *process execution*,
// not the tools — the agent script runs INSIDE the target, so tools stay native
// and untouched. Isolation comes from where the process lives.

export interface RunOptions {
  args?: string[];
  env?: Record<string, string>;
  ports?: number[];
  cwd?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
}

// A file to make available inside the sandbox before the script runs.
export type StageSpec =
  | { from: string; to: string } // host path   -> staged relative path
  | { content: string; to: string }; // inline      -> staged relative path

export interface RunResult {
  code: number | null;
  signal: string | null;
}

export interface RunTarget {
  // "local" | "docker:node:22" | "e2b:..." — informational.
  readonly kind: string;
  // Copy-in-at-startup: stage files into the target's workspace (host side).
  stage(files: StageSpec[]): Promise<void>;
  // Run an agent script inside the target. Resolves when the script exits.
  run(script: string, opts?: RunOptions): Promise<RunResult>;
  // Tear down: kill container / remove temp workspace.
  dispose(): Promise<void>;
}
