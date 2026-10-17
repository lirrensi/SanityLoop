// sanityloop sandbox SDK — runs INSIDE the container at /opt/sdk/cli.cjs.
// Dependency-free (node stdlib only): read/edit/write/version over stdin→stdout.
//
// Wire (protocol 1):
//   stdin:  {"protocol":1,"tool":"read"|"edit"|"write"|"version","args":{...}}
//   stdout: {"ok":true,"result":{answer,stored,error?,errorMessage?}}   tool result (incl. tool errors)
//           {"ok":false,"error":"..."}                                    transport-level failure only
//
// Result shapes mirror the host tools (@sanityloop/basic-fs-tools) so downstream
// consumers cannot tell which side executed. A tool-level failure (missing file,
// old_string not found, binary guard) is {ok:true,result:{error:true,...}} —
// only protocol violations and unexpected crashes yield {ok:false}.
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const PROTOCOL = 1;
const SDK_VERSION = 1;
const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

function truncateHead(content) {
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = content.length === 0 ? [] : content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  const totalLines = lines.length;
  if (totalLines <= MAX_LINES && totalBytes <= MAX_BYTES) {
    return { content, truncated: false, totalLines, totalBytes };
  }
  const firstBytes = Buffer.byteLength(lines[0] ?? "", "utf-8");
  if (firstBytes > MAX_BYTES) {
    return { content: "", truncated: true, totalLines, totalBytes };
  }
  const out = [];
  let bytes = 0;
  for (const line of lines) {
    const lb = Buffer.byteLength(line + "\n", "utf-8");
    if (out.length + 1 > MAX_LINES) break;
    if (bytes + lb > MAX_BYTES) break;
    out.push(line);
    bytes += lb;
  }
  return {
    content: out.join("\n") + (out.length > 0 ? "\n" : ""),
    truncated: true,
    totalLines,
    totalBytes,
  };
}

async function writeAtomic(p, content) {
  const dir = path.dirname(p);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${crypto.randomUUID()}`);
  await fsp.writeFile(tmp, content, "utf8");
  try {
    await fsp.rename(tmp, p);
  } catch {
    await fsp.writeFile(p, content, "utf8");
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
  }
}

function toolError(answer, errorMessage, stored) {
  return { answer, stored: stored ?? {}, error: true, errorMessage };
}

async function doRead(args) {
  const { path: p, offset, limit } = args ?? {};
  if (typeof p !== "string" || p.length === 0) {
    return toolError("read: `path` is required and must be a string", "path required");
  }
  let raw;
  try {
    raw = await fsp.readFile(p, "utf8");
  } catch (e) {
    return toolError(`Cannot read ${p}: ${e.message}`, e.code ?? "read failed", { path: p });
  }
  if (raw.includes("\u0000")) {
    return toolError(`Cannot read ${p}: appears to be a binary file.`, "binary file", { path: p });
  }
  const allLines = raw.split("\n");
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();
  const total = allLines.length;
  if (total === 0) return { answer: "File is empty.", stored: { path: p, total: 0 } };
  const start = offset ?? 1;
  if (!Number.isInteger(start) || start < 1 || start > total) {
    return toolError(
      `Offset ${start} is out of range (file has ${total} lines). Use offset=1 to start, or offset=${total} for the last line.`,
      "offset out of range",
      { total },
    );
  }
  const selected = allLines.slice(start - 1, limit ? start - 1 + limit : undefined);
  const numbered = selected.map((line, i) => `${start + i}:${line}`);
  const trunc = truncateHead(numbered.join("\n"));
  let answer = trunc.content;
  let nextOffset;
  const shownCount = trunc.content === "" ? 0 : trunc.content.split("\n").length;
  const lastShown = start + shownCount - 1;
  if (trunc.truncated || lastShown < total) {
    nextOffset = lastShown + 1;
    answer += `\n\n[Showing lines ${start}-${lastShown} of ${total}. Use offset=${nextOffset} to continue.]`;
  }
  return { answer, stored: { path: p, total, nextOffset } };
}

async function doEdit(args) {
  const { path: p, old_string, new_string, multiple } = args ?? {};
  if (typeof p !== "string" || p.length === 0) {
    return toolError("edit: `path` is required and must be a string", "path required");
  }
  if (typeof old_string !== "string" || typeof new_string !== "string") {
    return toolError("edit: `old_string` and `new_string` must be strings", "old_string/new_string required");
  }
  let raw;
  try {
    raw = await fsp.readFile(p, "utf8");
  } catch (e) {
    return toolError(`Cannot edit ${p}: ${e.message}`, e.code ?? "read failed", { error: "read-failed" });
  }
  const matches = raw.split(old_string).length - 1;
  if (matches === 0) {
    return toolError(
      `Edit failed: old_string not found in ${p}. Call read() to inspect the current content.`,
      "old_string not found",
      { error: "not-found" },
    );
  }
  if (matches > 1 && !multiple) {
    return toolError(
      `Edit failed: old_string matches ${matches} times in ${p}. Pass multiple:true to replace all, or use a more specific old_string.`,
      "old_string matches multiple times",
      { error: "multiple-matches", matches },
    );
  }
  const result = multiple ? raw.split(old_string).join(new_string) : raw.replace(old_string, new_string);
  try {
    await writeAtomic(p, result);
  } catch (e) {
    return toolError(`Edit failed: cannot write ${p}: ${e.message}`, e.code ?? "write failed", { error: "write-failed" });
  }
  return { answer: `Successfully edited ${p}: ${matches} replacement(s).`, stored: { replacements: matches } };
}

async function doWrite(args) {
  const { path: p, content } = args ?? {};
  if (typeof p !== "string" || p.length === 0) {
    return toolError("write: `path` is required and must be a string", "path required");
  }
  if (typeof content !== "string") {
    return toolError("write: `content` is required and must be a string", "content required");
  }
  try {
    await writeAtomic(p, content);
  } catch (e) {
    return toolError(`Cannot write ${p}: ${e.message}`, e.code ?? "write failed", { path: p });
  }
  return {
    answer: `Wrote ${p} (${content.length} chars).`,
    stored: { bytes: Buffer.byteLength(content, "utf8") },
  };
}

async function main() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  let req;
  try {
    req = JSON.parse(input);
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, error: "sdk: stdin is not valid JSON" }) + "\n");
    process.exitCode = 1;
    return;
  }
  if (!req || typeof req !== "object" || req.protocol !== PROTOCOL) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: `sdk: unsupported protocol ${JSON.stringify(req?.protocol)} (want ${PROTOCOL})` }) + "\n",
    );
    process.exitCode = 1;
    return;
  }
  let result;
  try {
    switch (req.tool) {
      case "read":
        result = await doRead(req.args);
        break;
      case "edit":
        result = await doEdit(req.args);
        break;
      case "write":
        result = await doWrite(req.args);
        break;
      case "version":
      case "ping":
        result = { answer: `sdk version ${SDK_VERSION}`, stored: { version: SDK_VERSION } };
        break;
      default:
        process.stdout.write(JSON.stringify({ ok: false, error: `sdk: unknown tool ${JSON.stringify(req.tool)}` }) + "\n");
        process.exitCode = 1;
        return;
    }
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: `sdk: internal error: ${e?.message ?? String(e)}` }) + "\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(JSON.stringify({ ok: true, result }) + "\n");
}

main().catch((e) => {
  try {
    process.stdout.write(JSON.stringify({ ok: false, error: `sdk: fatal: ${e?.message ?? String(e)}` }) + "\n");
  } catch {}
  process.exitCode = 1;
});
