// @sanityloop/sandbox-tools — exec transport: one narrow interface for
// running a process inside an EXISTING named container. Foreground only
// (no spawn/await/kill — v2, after core builds local bg support).
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import Docker from "dockerode";
import type { DockerOptions, ExecCreateOptions } from "dockerode";

export interface ExecOptions {
  /** Bytes piped to the process stdin (never touches a shell command line). */
  stdin?: string | Uint8Array;
  /** Working directory inside the container. */
  cwd?: string;
  /** Extra env vars for the process. */
  env?: Record<string, string>;
  /** Kill/timeout budget in ms. Best effort per backend. */
  timeoutMs?: number;
  /** Abort the exec early when fired. */
  signal?: AbortSignal;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run argv inside `container`; stdin piped, stdout/stderr captured. */
export type ExecTransport = (
  container: string,
  argv: string[],
  opts?: ExecOptions,
) => Promise<ExecResult>;

/** Exec error — transport-level. Callers turn this into a tool error result. */
export class ExecError extends Error {
  readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ExecError";
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// CLI backend: `docker exec -i` via spawn. Zero dependencies.
// ---------------------------------------------------------------------------

export interface CliExecOptions {
  /** Path to the docker CLI. Default "docker". */
  dockerPath?: string;
}

/** Test seam + the argv `cliExec` spawns (unit-tested, no daemon). */
export function buildDockerExecArgs(
  container: string,
  argv: string[],
  opts: ExecOptions = {},
): string[] {
  const args = ["exec", "-i"];
  if (opts.cwd) args.push("--workdir", opts.cwd);
  for (const [k, v] of Object.entries(opts.env ?? {})) args.push("--env", `${k}=${v}`);
  args.push(container, ...argv);
  return args;
}

/** Exec via the docker CLI. Args are passed as an argv array — no shell. */
export function cliExec(cliOpts: CliExecOptions = {}): ExecTransport {
  const dockerPath = cliOpts.dockerPath ?? "docker";
  return (container, argv, opts = {}) => {
    let resolve!: (v: ExecResult) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<ExecResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    let proc: ChildProcess;
    try {
      proc = spawn(dockerPath, buildDockerExecArgs(container, argv, opts));
    } catch (e) {
      reject(new ExecError(`cliExec: failed to spawn ${dockerPath}: ${e instanceof Error ? e.message : String(e)}`, e));
      return promise;
    }
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => (stdout += d.toString()));
    proc.stderr?.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (e) =>
      settle(() => reject(new ExecError(`cliExec: ${dockerPath} exec failed: ${e.message}`, e))),
    );
    proc.on("close", (code) => settle(() => resolve({ code, stdout, stderr })));
    const onAbort = () => {
      proc.kill("SIGTERM");
      settle(() => resolve({ code: null, stdout, stderr }));
    };
    if (opts.signal?.aborted) {
      onAbort();
      return promise;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        proc.kill("SIGTERM");
        settle(() => resolve({ code: null, stdout, stderr }));
      }, opts.timeoutMs);
      timer.unref?.();
    }
    // Small JSON payloads fit the pipe buffer; end() flushes any queued write.
    if (opts.stdin !== undefined) proc.stdin?.write(opts.stdin);
    proc.stdin?.end();
    proc.on("close", () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    });
    return promise;
  };
}

// ---------------------------------------------------------------------------
// dockerode backend: socket / remote / TLS via the dockerode API.
// No other dockerode surface is used by this package.
// ---------------------------------------------------------------------------

export interface DockerodeExecOptions {
  socketPath?: string; // e.g. /var/run/docker.sock
  host?: string;
  port?: number;
  protocol?: "http" | "https";
  ca?: Buffer | string;
  cert?: Buffer | string;
  key?: Buffer | string;
}

/** Test seam: which dockerode constructor options we build (no daemon). */
export function buildDockerodeOptions(execOpts: DockerodeExecOptions = {}): DockerOptions {
  const out: DockerOptions = {};
  if (execOpts.socketPath !== undefined) out.socketPath = execOpts.socketPath;
  if (execOpts.host !== undefined) out.host = execOpts.host;
  if (execOpts.port !== undefined) out.port = execOpts.port;
  if (execOpts.protocol !== undefined) out.protocol = execOpts.protocol;
  if (execOpts.ca !== undefined) out.ca = execOpts.ca;
  if (execOpts.cert !== undefined) out.cert = execOpts.cert;
  if (execOpts.key !== undefined) out.key = execOpts.key;
  return out;
}

/** Test seam: Container.exec() create options for a call (no daemon). */
export function buildExecCreateOptions(argv: string[], opts: ExecOptions = {}): ExecCreateOptions {
  const create: ExecCreateOptions = {
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    Cmd: argv,
  };
  if (opts.cwd !== undefined) create.WorkingDir = opts.cwd;
  if (opts.env !== undefined) create.Env = Object.entries(opts.env).map(([k, v]) => `${k}=${v}`);
  return create;
}

/** Exec via dockerode (socket/remote/TLS). Stdin attached, streams demuxed. */
export function dockerodeExec(execOpts: DockerodeExecOptions = {}): ExecTransport {
  const docker = new Docker(buildDockerodeOptions(execOpts));
  return async (container, argv, opts = {}) => {
    try {
      const ctr = docker.getContainer(container);
      const exec = await ctr.exec(buildExecCreateOptions(argv, opts));
      const stream = await exec.start({ stdin: true, hijack: true });
      let resolve!: (v: number | null) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<number | null>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      let timer: NodeJS.Timeout | undefined;
      if (opts.timeoutMs !== undefined) {
        timer = setTimeout(
          () => reject(new ExecError(`dockerodeExec: timed out after ${opts.timeoutMs}ms`)),
          opts.timeoutMs,
        );
        timer.unref?.();
      }
      const onAbort = () => reject(new ExecError("dockerodeExec: aborted"));
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      const finish = (fn: () => void) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const out = new PassThrough();
      const err = new PassThrough();
      let stdout = "";
      let stderr = "";
      out.on("data", (d) => (stdout += d.toString()));
      err.on("data", (d) => (stderr += d.toString()));
      docker.modem.demuxStream(stream, out, err);
      stream.on("end", () => {
        exec
          .inspect()
          .then((info) => {
            finish(() => resolve(typeof info?.ExitCode === "number" ? info.ExitCode : null));
          })
          .catch((inspectErr: unknown) => {
            finish(() => reject(new ExecError(`dockerodeExec: inspect failed: ${inspectErr instanceof Error ? inspectErr.message : String(inspectErr)}`, inspectErr)));
          });
      });
      stream.on("error", (e: Error) => {
        finish(() => reject(new ExecError(`dockerodeExec: stream error: ${e.message}`, e)));
      });
      if (opts.stdin !== undefined) stream.write(opts.stdin);
      stream.end();
      const code = await promise;
      return { code, stdout, stderr };
    } catch (e) {
      if (e instanceof ExecError) throw e;
      throw new ExecError(`dockerodeExec: exec in ${container} failed: ${e instanceof Error ? e.message : String(e)}`, e);
    }
  };
}
