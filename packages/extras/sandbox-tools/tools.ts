// @sanityloop/sandbox-tools — createSandboxedTools: read/edit/write/bash
// with metadata imported (not forked) from the host factories, but every
// execute crosses the container wall via an ExecTransport.
//
// Path translation (model-relative ↔ container-absolute):
//   - relative paths pass through (SDK resolves against containerCwd)
//   - container-side absolutes under containerCwd (or extraContainerRoots)
//     pass through — the model learned them from `pwd`/ls
//   - agent.cwd-prefixed absolutes rewrite to containerCwd
//   - absolutes outside agent.cwd are rejected BEFORE crossing (tool error,
//     never a throw across the loop)
//   - bash `workdir` is NOT translated (it is container-relative by nature);
//     the default cwd is containerCwd.
import path from "node:path";
import { truncateTail, formatSize } from "@sanityloop/util";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createBasicTools } from "@sanityloop/basic-fs-tools";
import { createBashTool } from "@sanityloop/shell-tool";
import type { ExecTransport } from "./exec.ts";
import { ExecError } from "./exec.ts";

export const SANDBOX_SDK_VERSION = 1;
export const SANDBOX_SDK_PATH = "/opt/sdk/cli.cjs";
function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface SandboxedToolsOptions {
  /** Existing container name (or id). Created by anyone: fleet, docker run -d, CI. */
  container: string;
  /** How to run a process inside the container (cliExec/dockerodeExec/fleet). */
  exec: ExecTransport;
  /** Container working dir. SDK resolves relative paths against it. Default "/workspace". */
  containerCwd?: string;
  /** Path to cli.cjs inside the container. Default "/opt/sdk/cli.cjs". */
  sdkPath?: string;
  /** Per-call timeout in ms. */
  timeoutMs?: number;
  /** Bash display truncation (tail — errors live at the end). Default 2000 lines / 50KB. */
  maxLines?: number;
  maxBytes?: number;
  /** Temp file prefix for full-output spill. Default "sanity-bash". */
  tempFilePrefix?: string;
  /** Extra container-side roots the model may address absolutely (e.g. "/docs"). Default []. */
  extraContainerRoots?: string[];
}

export interface SdkEnvelope {
  protocol: number;
  tool: "read" | "edit" | "write" | "version";
  args: Record<string, unknown>;
}

interface SdkToolResult {
  answer: string;
  stored?: unknown;
  error?: boolean;
  errorMessage?: string;
}

/** Test seam + shared contract: pure host-side path translation (no exec). */
export function translatePath(
  p: string,
  hostCwd: string,
  containerCwd: string,
  extraContainerRoots: string[] = [],
): { ok: true; containerPath: string } | { ok: false; answer: string } {
  // Container-side absolute: the model learned the in-container layout
  // (e.g. from `pwd`) — pass through when under a known container root.
  const posixP = p.split(path.sep).join("/");
  for (const root of [containerCwd, ...extraContainerRoots]) {
    const norm = root.length > 1 ? root.replace(/\/+$/, "") : root;
    if (posixP === norm || posixP.startsWith(norm + "/")) {
      return { ok: true, containerPath: posixP };
    }
  }
  if (!path.isAbsolute(p)) return { ok: true, containerPath: p };
  const rel = path.relative(hostCwd, p);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    return { ok: true, containerPath: path.posix.join(containerCwd, rel.split(path.sep).join("/")) };
  }
  return {
    ok: false,
    answer: `Refusing to access ${p}: outside the agent working directory (${hostCwd}). Sandboxed tools can only reach files under the agent cwd (mapped to ${containerCwd} in the container), container paths under ${containerCwd}, or relative paths.`,
  };
}

function wallError(tool: string, detail: string) {
  return {
    answer: `${tool}: container exec failed: ${detail}`,
    stored: { wallFailure: true },
    error: true as const,
    errorMessage: detail,
  };
}

export function createSandboxedTools(opts: SandboxedToolsOptions) {
  const { container, exec, timeoutMs } = opts;
  const containerCwd = opts.containerCwd ?? "/workspace";
  const sdkPath = opts.sdkPath ?? SANDBOX_SDK_PATH;

  if (!container) throw new Error("createSandboxedTools: `container` is required");

  // SDK version check, once per toolset, on first use. Any wall failure here
  // surfaces as the tool's error result (loop lands idle, never throws).
  let versionChecked = false;
  let versionError: string | null = null;
  async function ensureSdkVersion(signal?: AbortSignal): Promise<string | null> {
    if (versionChecked) return versionError;
    versionChecked = true;
    try {
      const res = await exec(
        container,
        ["node", sdkPath],
        { stdin: JSON.stringify({ protocol: 1, tool: "version", args: {} }), cwd: containerCwd, timeoutMs, signal },
      );
      if (res.code !== 0) {
        versionError = `SDK exited with code ${res.code}: ${res.stderr.trim() || res.stdout.trim() || "(no output)"}`;
        return versionError;
      }
      let doc: { ok?: boolean; result?: { stored?: { version?: unknown } }; error?: string };
      try {
        doc = JSON.parse(res.stdout);
      } catch {
        versionError = `SDK returned non-JSON output: ${res.stdout.slice(0, 200)}`;
        return versionError;
      }
      if (!doc.ok) {
        versionError = `SDK error: ${doc.error ?? "(unknown)"}`;
        return versionError;
      }
      if (doc.result?.stored?.version !== SANDBOX_SDK_VERSION) {
        versionError =
          `SDK version mismatch: container has ${JSON.stringify(doc.result?.stored?.version)} (want ${SANDBOX_SDK_VERSION}). Rebuild the sandbox image.`;
        return versionError;
      }
      return null;
    } catch (e) {
      versionError = errMessage(e);
      return versionError;
    }
  }

  async function callSdk(tool: "read" | "edit" | "write", args: Record<string, unknown>, signal?: AbortSignal) {
    const versionProblem = await ensureSdkVersion(signal);
    if (versionProblem) return wallError(tool, versionProblem);
    let res;
    try {
      res = await exec(
        container,
        ["node", sdkPath],
        { stdin: JSON.stringify({ protocol: 1, tool, args } satisfies SdkEnvelope), cwd: containerCwd, timeoutMs, signal },
      );
    } catch (e) {
      return wallError(tool, errMessage(e));
    }
    if (res.code !== 0) {
      const detail = res.stderr.trim() || res.stdout.trim() || `exit code ${res.code}`;
      return wallError(tool, `SDK exited with code ${res.code}: ${detail}`);
    }
    let doc: { ok?: boolean; result?: SdkToolResult; error?: string };
    try {
      doc = JSON.parse(res.stdout);
    } catch {
      return wallError(tool, `SDK returned non-JSON output: ${res.stdout.slice(0, 200)}`);
    }
    if (!doc.ok || !doc.result) return wallError(tool, `SDK error: ${doc.error ?? "(unknown)"}`);
    return { answer: doc.result.answer, stored: doc.result.stored, ...(doc.result.error ? { error: true as const, errorMessage: doc.result.errorMessage } : {}) };
  }

type HostTool = ReturnType<typeof createBashTool>;

// Metadata is IMPORTED from the host factories — never forked text.
  const host = { ...createBasicTools(), bash: createBashTool() };

  const wrapMeta = (base: HostTool, execute: HostTool["execute"]): HostTool => ({
    ...base,
    execute,
  });

  const fsExecute = (tool: "read" | "edit" | "write"): HostTool["execute"] => async (params, agent) => {
    const hostCwd = typeof agent.cwd === "string" ? agent.cwd : process.cwd();
    const p = params && typeof params === "object" && "path" in params ? params.path : undefined;
    if (typeof p !== "string" || p.length === 0) {
      return { answer: `${tool}: \`path\` is required and must be a string`, error: true, errorMessage: "path required" };
    }
    const t = translatePath(p, hostCwd, containerCwd, opts.extraContainerRoots);
    if (!t.ok) return { answer: t.answer, stored: { wallFailure: false }, error: true, errorMessage: "path outside agent cwd" };
    const args = params && typeof params === "object" ? { ...(params as Record<string, unknown>), path: t.containerPath } : { path: t.containerPath };
    return callSdk(tool, args, agent.abortSignal);
  };

  const read = wrapMeta(host.read, fsExecute("read"));
  const edit = wrapMeta(host.edit, fsExecute("edit"));
  const write = wrapMeta(host.write, fsExecute("write"));

  // bash runs directly via `sh -lc` — no SDK hop. Metadata still host-imported.
  // Validation messages mirror the host tool so the model sees identical text.
  const bashExecute: HostTool["execute"] = async (params, agent) => {
    const hostCwd = typeof agent.cwd === "string" ? agent.cwd : process.cwd();
    const rec = params && typeof params === "object" ? params : {};
    const command = "command" in rec ? rec.command : undefined;
    const workdir = "workdir" in rec ? rec.workdir : undefined;
    const timeout = "timeout" in rec ? rec.timeout : undefined;
    const description = "description" in rec ? rec.description : undefined;
    if (typeof command !== "string" || command.trim().length === 0) {
      return { answer: "bash: `command` is required and must be a string", error: true, errorMessage: "command required" };
    }
    if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)) {
      return { answer: `bash: invalid timeout '${String(timeout)}' — must be a positive number of seconds`, error: true, errorMessage: "invalid timeout" };
    }
    const cwd = typeof workdir === "string" && workdir.trim().length > 0 ? workdir : containerCwd;
    const timeoutMsForCall = timeout !== undefined ? Math.round(timeout * 1000) : timeoutMs;
    const versionProblem = await ensureSdkVersion(agent.abortSignal);
    if (versionProblem) return wallError("bash", versionProblem);
    let res;
    try {
      res = await exec(container, ["sh", "-lc", command], {
        cwd,
        timeoutMs: timeoutMsForCall,
        signal: agent.abortSignal,
      });
    } catch (e) {
      return wallError("bash", errMessage(e));
    }
    // Host-parity formatting: combined stdout+stderr, CRLF→LF, tail-truncated
    // with the full output spilled to a HOST temp file (the model can read it
    // back through the fs tools — the container never sees this path).
    const combined = [res.stdout, res.stderr ? `\n[stderr]\n${res.stderr}` : ""].join("").replace(/\r\n?/g, "\n").trim();
    const timedOut = res.code === null;
    const aborted = agent.abortSignal?.aborted ?? false;
    const trunc = truncateTail(combined, { maxLines: opts.maxLines, maxBytes: opts.maxBytes });
    let fullOutputPath: string | undefined;
    let text = trunc.content || "(no output)";
    if (trunc.truncated) {
      fullOutputPath = join(tmpdir(), `${opts.tempFilePrefix ?? "sanity-bash"}-${randomUUID().slice(0, 8)}.log`);
      writeFileSync(fullOutputPath, combined, "utf8");
      const startLine = trunc.totalLines - trunc.outputLines + 1;
      const endLine = trunc.totalLines;
      if (trunc.truncatedBy === "lines") {
        text += `\n\n[Showing lines ${startLine}-${endLine} of ${trunc.totalLines}. Full output: ${fullOutputPath}]`;
      } else {
        text += `\n\n[Showing lines ${startLine}-${endLine} of ${trunc.totalLines} (${formatSize(trunc.maxBytes)} limit). Full output: ${fullOutputPath}]`;
      }
    }
    let answer = text;
    if (timedOut) {
      answer += `\n\nCommand timed out${timeout !== undefined ? ` after ${String(timeout)} seconds` : ""}. Retry with a larger timeout if the command is expected to take longer.`;
    } else if (res.code !== 0) {
      answer += `\n\nCommand exited with code ${res.code}.`;
    }
    // Aborted is a control stop, not a tool failure — matches the host tool.
    const failed = !aborted && (timedOut || (res.code ?? 0) !== 0);
    return {
      answer,
      error: failed || undefined,
      stored: {
        exitCode: aborted || timedOut ? undefined : res.code,
        timedOut,
        aborted,
        truncated: trunc.truncated,
        fullOutputPath,
        cwd,
        ...(typeof description === "string" ? { description } : {}),
      },
    };
  };
  const bash = wrapMeta(host.bash, bashExecute);

  return { read, edit, write, bash };
}

/** Re-export the host metadata source so tests compare against the same objects. */
export { createBasicTools, createBashTool };
export type { ExecTransport, ExecOptions, ExecResult } from "./exec.ts";
export { cliExec, dockerodeExec, buildDockerExecArgs, buildDockerodeOptions, buildExecCreateOptions, ExecError } from "./exec.ts";
export type SandboxedTool = ReturnType<typeof createSandboxedTools>["read"];
