// SanityLoop code-mode JS/TS kernel runner.
//
// One long-lived process per (session, cwd). NDJSON control on stdin,
// frames on stdout, tool returns on fd 3, crash noise on stderr.
// See packages/extras/code-mode/protocol.ts for the contract.
//
// State: one vm context, retained across cells. `var`/function land on the
// global; top-level const/let live in the global lexical scope and persist.
// The runner arms NO timers — the host is the only clock.
//
// TS: annotation-stripping via module.stripTypeScriptTypes. enum/namespace/
// parameter-properties fail with a targeted error (same limit as
// --experimental-strip-types itself).
import { stripTypeScriptTypes } from "node:module";
import { createInterface } from "node:readline";
import { runInContext, createContext, Script } from "node:vm";
import { inspect } from "node:util";
import { createReadStream } from "node:fs";

const PROTOCOL = 1;

const frameOut = process.stdout;
let frame3 = null;
try {
  frame3 = createInterface({ input: createReadStream(null, { fd: 3, encoding: "utf8" }) });
} catch {
  frame3 = null;
}

// ---- frame writer (single serialized writer — Node writes split ticks) ----
let writeChain = Promise.resolve();
function emit(obj) {
  const line = JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? `bigint:${v}` : v)) + "\n";
  writeChain = writeChain.then(() => new Promise((resolve) => {
    if (!frameOut.write(line)) frameOut.once("drain", resolve);
    else resolve();
  })).catch(() => {});
}

// ---- return-bridge reader (fd 3) ----
const pending = new Map(); // callId -> { resolve, reject }
if (frame3) {
  frame3.on("line", (line) => {
    let f;
    try { f = JSON.parse(line); } catch { return; }
    if (f.t === "cancel") {
      for (const [, p] of pending) p.reject(cancelledError(f.reason || "cancelled"));
      pending.clear();
      state.cancel = true;
      return;
    }
    const p = pending.get(f.callId);
    if (!p) return;
    pending.delete(f.callId);
    if (f.budgetLeft !== undefined && Number.isFinite(f.budgetLeft)) state.budget = f.budgetLeft;
    if (f.ok) p.resolve(f.answer);
    else p.reject(toolError(f.errorMessage || "tool call failed", f.answer));
  });
}

function toolError(message, answer) {
  const e = new Error(message);
  e.name = "ToolError";
  e.answer = answer;
  return e;
}
function cancelledError(reason) {
  const e = new Error(reason);
  e.name = "Cancelled";
  return e;
}

// ---- vm context ----
const sandbox = {};
let ctx = createContext(sandbox);
let runSeq = 0;

const state = {
  rid: null,
  cancel: false,
  budget: 50,
  seq: 0,
  executions: 0,
  tools: [],
};

function installStubs(tools) {
  state.tools = Array.isArray(tools) ? tools : [];
  const names = new Set(state.tools);
  // Stale cleanup: remove bindings from the previous cell.
  for (const k of Object.keys(sandbox)) {
    if (k.startsWith("__sl_")) continue;
    if (k === "tools" || k === "print" || k === "sleep") continue;
    if (k === "console") continue;
    try { delete sandbox[k]; } catch { /* frozen */ }
  }
  const byName = {};
  for (const name of names) {
    if (name === "code") continue;
    byName[name] = (args = {}) => callHost(name, args);
    if (isIdentifier(name) && !RESERVED.has(name)) sandbox[name] = byName[name];
  }
  const collisionHint = [...names].filter((n) => !isIdentifier(n) || RESERVED.has(n));
  sandbox.tools = {
    ...byName,
    call: (name, args = {}) => callHost(name, args),
    list: () => [...names],
  };
  sandbox.print = (...a) => emit({ t: "stdout", id: state.rid, data: a.map((v) => String(v)).join(" ") + "\n" });
  sandbox.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  sandbox.console = {
    log: (...a) => sandbox.print(...a),
    info: (...a) => sandbox.print(...a),
    warn: (...a) => emit({ t: "stderr", id: state.rid, data: a.map((v) => String(v)).join(" ") + "\n" }),
    error: (...a) => emit({ t: "stderr", id: state.rid, data: a.map((v) => String(v)).join(" ") + "\n" }),
    debug: (...a) => sandbox.print(...a),
  };
  if (collisionHint.length > 0) {
    emit({ t: "stdout", id: state.rid, data: `[code-mode] reachable via tools["name"] only: ${collisionHint.join(", ")}\n` });
  }
}

function isIdentifier(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}
const RESERVED = new Set(
  ("await break case catch class const continue debugger default delete do else enum export extends false finally for " +
   "function if implements import in instanceof interface let new null package private protected public return static " +
   "super switch this throw true try typeof var void while with yield tools print console sleep arguments eval " +
   "undefined NaN Infinity").split(" "),
);

function callHost(name, args) {
  if (state.rid === null || frame3 === null) return Promise.reject(toolError("tool bridge unavailable", ""));
  if (state.cancel) return Promise.reject(cancelledError("cell cancelled"));
  if (state.budget <= 0) return Promise.reject(toolError("budget exhausted for this cell", ""));
  let payload;
  try {
    payload = JSON.parse(JSON.stringify(args ?? {}));
  } catch {
    return Promise.reject(toolError(`argument for ${name} is not JSON-serializable`, ""));
  }
  state.budget -= 1;
  state.seq += 1;
  const callId = `c${state.seq}`;
  emit({ t: "tool-call", id: state.rid, callId, seq: state.seq, name, args: payload });
  return new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
}

// ---- cell pipeline: TS strip → compile → wrap-if-needed ----
const TS_GATE = /:\s*[A-Za-z_$][\w$<>\[\]| ]*(\s*[=,)])|^\s*(interface|type|as\s+const)\b/m;

function prepare(src, id) {
  let js = src;
  if (TS_GATE.test(src)) {
    try {
      js = stripTypeScriptTypes(src);
    } catch (e) {
      if (e && e.code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") {
        throw cellError("TypeScript feature needs transformation (enum/namespace/parameter property) — not supported in cells; use a plain object/const.");
      }
      throw e;
    }
  }
  try {
    return { script: new Script(js, { filename: `cell-${id}.js` }), wrapped: false };
  } catch (e) {
    if (!/await is only valid|Illegal return statement|Unexpected reserved word/.test(e.message)) throw e;
    return { script: new Script(`(async () => {\n${js}\n})()`, { filename: `cell-${id}.js` }), wrapped: true };
  }
}

function cellError(message) {
  const e = new Error(message);
  e.name = "CellError";
  return e;
}

function errShape(e) {
  const stack = typeof e?.stack === "string" ? e.stack.split("\n").slice(0, 20) : [];
  return { ename: e?.name ?? "Error", evalue: e?.message ?? String(e), traceback: stack };
}

async function handle(req) {
  const rid = String(req.id);
  state.rid = rid;
  state.cancel = false;
  state.seq = 0;
  state.budget = Number.isFinite(req.budget) ? req.budget : 50;
  state.executions += 1;
  const t0 = Date.now();
  emit({ t: "status", id: rid, phase: "start" });
  let ok = true, cancelled = false, err = null, value = undefined, hasValue = false;
  try {
    if (typeof req.cwd === "string" && req.cwd) process.chdir(req.cwd);
    installStubs(req.tools);
    let pre;
    try {
      pre = prepare(req.code ?? "", rid);
    } catch (e) {
      ok = false;
      err = errShape(e);
      pre = null;
    }
    if (pre) {
      for (const [, p] of pending) p.reject(cancelledError("stale"));
      pending.clear();
      try {
        // No `timeout` option: the host is the only clock. runInContext
        // rejects timeout: 0, so the key is omitted entirely.
        const v = pre.script.runInContext(ctx, { displayErrors: true });
        if (v !== null && (typeof v === "object" || typeof v === "function") && typeof v.then === "function") {
          value = await v;
        } else {
          value = v;
        }
        hasValue = true;
      } catch (e) {
        if (e && e.name === "Cancelled") { cancelled = true; ok = false; err = errShape(e); }
        else if (/already (been )?declared/.test(e?.message ?? "")) {
          ok = false;
          const m = /'([^']+)'/.exec(e.message);
          err = errShape(cellError(`"${m ? m[1] : "?"}" already exists from an earlier cell. Assign (\`x = …\`), use a new name, or pass \`reset: true\`.`));
        } else { ok = false; err = errShape(e); }
      }
    }
  } catch (e) {
    ok = false;
    err = errShape(e);
  } finally {
    try {
      if (hasValue && value !== undefined) {
        let r;
        try { r = inspect(value, { depth: 2, maxArrayLength: 100, maxStringLength: 4000, breakLength: 100, colors: false }); }
        catch (e) { r = `<unrepresentable: ${e.message}>`; }
        const truncated = r.length > 4000;
        emit({ t: "result", id: rid, repr: truncated ? r.slice(0, 4000) : r, type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value, truncated });
      }
      const wall = Date.now() - t0;
      emit({
        t: "done", id: rid, ok, cancelled, timed_out: false, error: err,
        exec_ms: wall, wall_ms: wall, executions: state.executions, budget_left: state.budget,
      });
    } finally {
      state.rid = null;
    }
  }
}

// ---- control loop ----
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
process.stdin.on("end", () => process.exit(0));

emit({
  t: "status", id: null, phase: "ready", protocol: PROTOCOL,
  runtime: process.version, pid: process.pid, persist: false,
});

rl.on("line", (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.t === "shutdown") { process.exit(0); return; }
  if (req.t !== "exec") return;
  runSeq += 1;
  handle(req).catch((e) => {
    emit({ t: "stderr", id: String(req.id), data: `[runner] fatal: ${e.message}\n` });
    emit({
      t: "done", id: String(req.id), ok: false, cancelled: false, timed_out: false,
      error: errShape(e), exec_ms: 0, wall_ms: 0, executions: state.executions, budget_left: state.budget,
    });
  });
});
