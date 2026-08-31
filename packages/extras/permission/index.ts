// ============================================================================
// packages/extras/permission/index.ts — per-tool permission gates over the core park
// ============================================================================
// The WHOLE extension is two dumb filters + a sparse config map:
//
//   tools: {
//     "*":       { gate: askAll },                     // broad first…
//     deploy:    { gate: myGate, resolve: myResolve }, // …specific overrides (last match wins)
//     read:      { gate: null },                       // extension bows out — write your own filter
//   }
//
//   gate(agent, rules, call)    — at beforeTool. Owes ONE fate, by state only:
//       allow → do nothing · ask → park a pendingAwait · deny → call.preResolved = {…}
//   resolve(answer, call, agent) — at inputReceived. YOUR effect per answer.
//
// Bare to the core: only beforeTool + pendingAwaits + inputReceived + preResolved.
// No vocabulary, no Decision union, no outcomes. Answers are raw data; the meaning
// lives in YOUR resolve (and in the model reading the tool result).
//
// Fates (why the loop does the right thing with zero protocol):
//   gate did nothing      → awaits empty at the wall   → call runs
//   gate pushed an await  → pendingAwaits non-empty    → loop parks (core behavior)
//   gate set preResolved  → execute skipped            → result flows to the model
//
// Restart-proof: parked awaits are state (taped, restored). Kill the process,
// the question is still there, any channel answers it with the envelope below.
// ============================================================================
import { EVENTS } from "@sanityloop/core";
import type { ToolCallRecord, ToolResult } from "@sanityloop/core";
import type { GodObject, Plugin } from "@sanityloop/core";
import { emitLog, removeFiltersByPrefix } from "@sanityloop/util";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";

// ============================================================================
// CONSTANTS — the two rendezvous names (await type ↔ answer input type)
// ============================================================================

/** The pendingAwait type this plugin parks with. */
export const PERMISSION_AWAIT = "permission/ask";
/** The input type that resolves a parked permission await. */
export const PERMISSION_ANSWER = "permission/answer";

/** The universal answer envelope any channel pushes:
 *  `{ type: PERMISSION_ANSWER, ref: <call id>, answer: <raw, open> }` */

// ============================================================================
// TYPES — the entire contract is two function shapes
// ============================================================================

/**
 * The GATE. Called at `beforeTool` for every call of its tool.
 * Return value IGNORED — command, not query. It owes one fate by state:
 * - allow: do nothing (silence = allow)
 * - ask:   `agent.pendingAwaits.push({ type: PERMISSION_AWAIT, id: call.id, schema })`
 * - deny:  `call.preResolved = { answer: "…" }` (add `error: true` for a hard refusal)
 * `call.parameters` are the tool args; `call.id` is the rendezvous key.
 *
 * ASYNC NATIVE: under THE TWO LOOPS the worker awaits its gate chains end to
 * end — a gate may freely `await` remote policy engines, DBs, auth services.
 * The wall settles it before the tool runs; the SUPERVISOR keeps ticking
 * (inputs, UI, aborts stay live the whole time).
 */
export type PermissionGate = (
  agent: GodObject,
  rules: Record<string, unknown>,
  call: ToolCallRecord,
) => void | Promise<void>;

/**
 * The RESOLVER. Called at `inputReceived` when an answer envelope matches a
 * parked await. Produces YOUR effect per answer — arbitrary code, one branch
 * per answer if you want. `call` is the parked call (found by ref across
 * messages); set `call.preResolved` to skip execution and hand the answer to
 * the model. `call` may be undefined if the call is no longer in the transcript.
 *
 * ASYNC NATIVE too — and RACE-SAFE: the plugin awaits your resolve to
 * completion BEFORE releasing the park, so a slow async effect can never race
 * the machine into executing the call un-gated.
 */
export type PermissionResolve = (
  answer: unknown,
  call: ToolCallRecord | undefined,
  agent: GodObject,
) => void | Promise<void>;

/**
 * Per-tool entry. `undefined` field = fall through to `defaults` for that half.
 * Explicit `null` = the extension BOWS OUT for that half (you own it with a raw
 * filter — the escape hatch that proves this plugin is never a trap).
 */
export interface PermissionEntry {
  gate?: PermissionGate | null;
  resolve?: PermissionResolve | null;
}

export interface PermissionConfig {
  /** Arbitrary blob handed to EVERY gate/resolve. Each reads its own slice. */
  rules?: Record<string, unknown>;
  /** SPARSE map: tool name or wildcard (`"github__*"`, `"*"`) -> entry.
   * LAST matching pattern wins — put broad first, specific after (CSS-like). */
  tools?: Record<string, PermissionEntry>;
  /** What an unmatched tool falls back to. Default: allow in, classic resolve. */
  defaults?: PermissionEntry;
}

// ============================================================================
// DEFAULT GATES — the three postures. Wire one at "*" / defaults.
// ============================================================================

/** ALLOW — the empty gate. No await → the tool just runs. (The hard default.) */
export const allowAll: PermissionGate = () => {};

/** ASK — parks a yes/no question for every call. */
export const askAll: PermissionGate = (agent, _rules, call) => {
  defaultAsk(agent, call, { title: `Run ${call.name}?` });
};

/** DENY — preResolves a refusal. No ask, resolver idle. `error: true` = the
 * model treats it as a failure, not a successful empty result. */
export const denyAll: PermissionGate = (agent, _rules, call) => {
  recordDenial(agent, call, "denied by policy (denyAll)");
  call.preResolved = {
    answer: `denied: ${call.name} is not permitted by policy`,
    error: true,
    errorMessage: "denied by permission policy",
  };
};

// ============================================================================
// HELPERS — plain functions, whole implementation visible, import or don't
// ============================================================================

/** Park a classic permission question for one call. The 10-line ask. */
export function defaultAsk(
  agent: GodObject,
  call: ToolCallRecord,
  opts: { title?: string; detail?: unknown; options?: string[] } = {},
): void {
  agent.pendingAwaits.push({
    type: PERMISSION_AWAIT,
    id: call.id,
    schema: {
      tool: call.name,
      title: opts.title ?? `Run ${call.name}?`,
      detail: opts.detail ?? call.parameters,
      options: opts.options ?? ["yes", "no"],
    },
  });
}

/** CLASSIC resolve — zero code needed. The raw answer becomes the tool result;
 * the model reads it and acts. Meaning lives downstream, not here. */
export function defaultResolve(answer: unknown, call: ToolCallRecord | undefined): void {
  if (!call) return;
  const text = typeof answer === "string" ? answer : JSON.stringify(answer) ?? "undefined";
  call.preResolved = { answer: `The user answered: ${text}. Continue accordingly.` };
}

/** Find the tool's entry: exact and wildcard patterns, LAST match wins.
 * `"*"` matches everything; `"pre*"` matches by prefix. */
export function matchEntry(
  tools: Record<string, PermissionEntry> | undefined,
  name: string,
): PermissionEntry | undefined {
  if (!tools) return undefined;
  let hit: PermissionEntry | undefined;
  for (const pattern of Object.keys(tools)) {
    const matches =
      pattern === "*"
        ? true
        : pattern.endsWith("*")
          ? name.startsWith(pattern.slice(0, -1))
          : pattern === name;
    if (matches) hit = tools[pattern]; // no early return — last match wins
  }
  return hit;
}

/** The call a gate is gating — from the event payload, or the current turn. */
function callsForGate(agent: GodObject, event?: { call?: ToolCallRecord }): ToolCallRecord[] {
  const fromEvent = event?.call;
  if (fromEvent) return [fromEvent];
  const stored = (agent.currentTurn?.content as { stored?: ToolCallRecord[] } | undefined)
    ?.stored;
  return (stored ?? []).filter((c) => !c.preResolved);
}

/** Find a parked call by id across the transcript (the resolver's half of the rendezvous). */
function findCallById(agent: GodObject, id: string): ToolCallRecord | undefined {
  for (const msg of agent.messages) {
    const stored = (msg.content as { stored?: ToolCallRecord[] } | undefined)?.stored;
    const hit = stored?.find((c) => c.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/** Field-level fallback: entry value → defaults value → hard default. `null` stays null. */
function pick<T>(
  entry: PermissionEntry | undefined,
  key: "gate" | "resolve",
  defaults: PermissionEntry | undefined,
  hardDefault: T,
): PermissionGate | PermissionResolve | null | T {
  const v = entry?.[key];
  if (v !== undefined) return v;
  const d = defaults?.[key];
  if (d !== undefined) return d;
  return hardDefault;
}

// ============================================================================
// GLOB + PATH UTILS — tiny, dependency-free, forward-slash normalized
// ============================================================================

/** `*` = one segment, `**` = anything, `?` = one char. Windows paths normalized. */
export function globMatch(glob: string, s: string): boolean {
  const g = glob.replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        if (g[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } // "**/" = zero or more dirs
        else { re += ".*"; i += 1; }                        // "**"  = anything
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i").test(s.replace(/\\/g, "/"));
}

/** Absolute, forward-slash normalized (relative → resolved against cwd). */
function normPath(p: string, cwd: string): string {
  const abs = isAbsolute(p) ? p : resolvePath(cwd, p);
  return abs.replace(/\\/g, "/");
}

/**
 * Normalize a command string for approval matching: trim, collapse whitespace,
 * strip quotes. Approvals are stored and matched against the CANONICAL form, so
 * `git  status` / `"git status"` / `git status` are one and the same.
 */
export function canonicalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ").replace(/["']/g, "");
}

/**
 * Does the command chain multiple operations? These are the BYPASS VECTOR for
 * broad glob approvals: a `git *` approval must NEVER cover `git; rm -rf /`.
 * Compound commands therefore only pass on an EXACT canonical match (see
 * bashGate) — never on a wildcard.
 */
export function isCompoundCommand(command: string): boolean {
  const c = command.trim().replace(/^["']|["']$/g, "");
  if (c.includes(";") || c.includes("&&") || c.includes("||") || c.includes("|")) return true;
  if (c.includes("`") || c.includes("$(")) return true;
  if (c.includes("\n")) return true;
  return false;
}

/** Globs: only resolve `./` / `../` anchors — `**`-led patterns stay untouched. */
function normGlob(g: string, cwd: string): string {
  const n = g.replace(/\\/g, "/");
  return n.startsWith("./") || n.startsWith("../") ? normPath(n, cwd) : n;
}

const PATH_KEYS = new Set([
  "path", "file_path", "filePath", "file", "dir", "directory", "target", "targetPath",
]);

/** Pull path-ish strings out of arbitrary tool params (read/write/edit/MCP…). */
export function extractPaths(params: Record<string, unknown> | undefined): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params ?? {})) {
    const key = k.toLowerCase();
    const pathish = PATH_KEYS.has(k) || PATH_KEYS.has(k.replace(/([A-Z])/g, "_$1").toLowerCase());
    if (typeof v === "string" && (pathish || key.endsWith("path"))) out.push(v);
    else if (Array.isArray(v) && pathish) out.push(...v.filter((x): x is string => typeof x === "string"));
  }
  return out;
}

// ============================================================================
// SESSION APPROVALS — "yes, this session" lives in state (taped, restored)
// ============================================================================

export interface PermissionApproval {
  /** Tool name or glob ("bash", "github__*"). Omit = any tool. */
  tool?: string;
  /** Path glob, absolute normalized ("C:/work/**"). Omit = any path. */
  path?: string;
  /** Command glob ("git *"). Omit = any command. */
  cmd?: string;
  reason?: string;
  createdAt: number;
  expiresAt?: number; // TTL — absent = the whole session
}

/** One audit-grade denial — the ledger half of the decision rule:
 * event = the live wire (sinks catch it NOW), state = the ledger (restored). */
export interface DenialRecord {
  ts: number;
  tool: string;
  callId: string;
  reason: string;
}

/** Cap for the state ledger — denials are rare; this is a runaway guard. */
const AUDIT_CAP = 500;

interface PermissionState { approvals?: PermissionApproval[]; audit?: DenialRecord[] }

function permState(agent: GodObject): PermissionState {
  const st = agent.state as { permission?: PermissionState };
  return (st.permission ??= {});
}

/**
 * THE DECISION RULE for audit-grade facts, applied: write state AND emit.
 * - live wire: emitLog on the shared `log` channel (source "permission") —
 *   every sink (log-sink file/console, observer logs:true) catches it with
 *   zero imports either way.
 * - the ledger: appended to `state.permission.audit` (taped, restored,
 *   inspectable) — capped at the last ${AUDIT_CAP}.
 */
export function recordDenial(agent: GodObject, call: ToolCallRecord, reason: string): void {
  const rec: DenialRecord = { ts: Date.now(), tool: call.name, callId: call.id, reason };
  emitLog(agent, "warn", "permission", `denied ${call.name}: ${reason}`, {
    tool: rec.tool,
    callId: rec.callId,
  });
  const st = permState(agent);
  const audit = (st.audit ??= []);
  audit.push(rec);
  if (audit.length > AUDIT_CAP) audit.splice(0, audit.length - AUDIT_CAP);
}

/** The live approvals array — plain state, inspectable, restored on restart. */
export function approvalsOf(agent: GodObject): PermissionApproval[] {
  const st = permState(agent);
  return (st.approvals ??= []);
}

export function addApproval(
  agent: GodObject,
  a: Omit<PermissionApproval, "createdAt"> & { createdAt?: number },
): void {
  approvalsOf(agent).push({ ...a, createdAt: a.createdAt ?? Date.now() });
}

/** Does an approval cover this query? All specified dims must match; unexpired. */
export function findApproval(
  agent: GodObject,
  q: { tool?: string; path?: string; cmd?: string },
): PermissionApproval | undefined {
  const now = Date.now();
  return approvalsOf(agent).find(
    (a) =>
      (a.expiresAt === undefined || a.expiresAt > now) &&
      (a.tool === undefined || (q.tool !== undefined && globMatch(a.tool, q.tool))) &&
      (a.path === undefined || (q.path !== undefined && globMatch(a.path, q.path))) &&
      (a.cmd === undefined || (q.cmd !== undefined && globMatch(a.cmd, q.cmd))),
  );
}

// ============================================================================
// THE CLASSIC CHOICE SET — yes once · yes this session · no · no + explain
// ============================================================================

/** The standard answers any channel can send (string, or `{ choice, reason }`). */
export const CLASSIC_CHOICES = ["once", "session", "no", "no_explain"] as const;
export type ClassicChoice = (typeof CLASSIC_CHOICES)[number];

/** The classic ask block — pi/opencode-flavored choices, generic renderer food. */
export function classicAsk(
  agent: GodObject,
  call: ToolCallRecord,
  opts: { title?: string; detail?: unknown } = {},
): void {
  defaultAsk(agent, call, { ...opts, options: [...CLASSIC_CHOICES] });
}

/**
 * The classic resolve — interprets the standard choices:
 * - `once`       → approve this call only: SILENCE — the await clears, the
 *                  parked batch resumes and the call executes FOR REAL
 * - `session`    → remember (state.permission.approvals; path calls scope to the
 *                  file's FOLDER, so siblings pass silently) + same silent pass
 * - `no`         → deny (preResolved — execute skipped)
 * - `no_explain` → deny with the human's reason (answer: `{ choice, reason }`)
 * Unknown answer → falls back to `once`. ONLY denials preResolve; approvals
 * must never stand between an approved call and its execution.
 */
export function classicResolve(
  answer: unknown,
  call: ToolCallRecord | undefined,
  agent: GodObject,
): void {
  if (!call) return;
  const obj = (typeof answer === "object" && answer !== null ? answer : undefined) as
    | { choice?: unknown; reason?: unknown }
    | undefined;
  const choice = String(obj?.choice ?? answer ?? "once");
  const reason = obj?.reason === undefined ? undefined : String(obj.reason);

  switch (choice) {
    case "session": {
      const params = call.parameters as { command?: unknown } | undefined;
      const command = typeof params?.command === "string" ? params.command : undefined;
      if (command) {
        // a COMMAND tool: remember the CANONICAL command, not a raw string —
        // `git status` and `git  status` approve the same canonical form, and
        // compound commands only match EXACTLY (bashGate), never via wildcard.
        addApproval(agent, { tool: call.name, cmd: canonicalizeCommand(command) });
        return; // silent approval — the resumed batch executes the call
      }
      const paths = extractPaths(call.parameters);
      if (paths.length > 0)
        for (const p of paths)
          addApproval(agent, { tool: call.name, path: `${dirname(p).replace(/\\/g, "/")}/**` });
      else addApproval(agent, { tool: call.name });
      return; // silent approval — the resumed batch executes the call
    }
    case "no":
      recordDenial(agent, call, "the human declined");
      call.preResolved = { answer: "the human declined", error: true };
      return;
    case "no_explain":
      recordDenial(agent, call, `the human declined: ${reason ?? "(no reason given)"}`);
      call.preResolved = {
        answer: `the human declined: ${reason ?? "(no reason given)"}`,
        error: true,
      };
      return;
    case "once":
    default:
      return; // silent approval — the resumed batch executes the call
  }
}

// ============================================================================
// SHIPPED STRATEGY — fsPathGate: the workspace/full path policy
// ============================================================================
// rules.paths = {
//   mode: "workspace",                  // "workspace" (default) | "full"
//   whitelist: ["D:/shared/**"],        // outside-cwd ventures allowed in workspace mode
//   blacklist: ["**/.env", "../**"],    // ALWAYS wins — even in full mode
// }
//
// Fate order: blacklist → session approval → full → workspace (cwd | whitelist)
// → classicAsk. Nothing to judge (no path params) → silence = allow.

export interface PathRules {
  /** "workspace" (default): cwd + whitelist. "full": everything, blacklist still wins. */
  mode?: "workspace" | "full";
  /** Outside-cwd globs allowed in workspace mode. Relative → resolved against cwd. */
  whitelist?: string[];
  /** Always denied. Relative → resolved against cwd. Beats everything. */
  blacklist?: string[];
}

export const fsPathGate: PermissionGate = (agent, rules, call) => {
  const cfg: PathRules = (rules.paths as PathRules | undefined) ?? {};
  const cwd = normPath(agent.cwd, agent.cwd);
  const paths = extractPaths(call.parameters).map((p) => normPath(p, agent.cwd));
  if (paths.length === 0) return; // not a path tool (or no path params) → allow

  // 1) BLACKLIST ALWAYS WINS — even in full mode.
  for (const p of paths) {
    if ((cfg.blacklist ?? []).some((g) => globMatch(normGlob(g, agent.cwd), p))) {
      recordDenial(agent, call, `blacklisted path ${p}`);
      call.preResolved = {
        answer: `blocked: ${p} is blacklisted`,
        error: true,
        errorMessage: "path blacklist",
      };
      return;
    }
  }

  // 2) session approval covering every path → allow silently
  const unapproved = paths.filter((p) => !findApproval(agent, { tool: call.name, path: p }));
  if (unapproved.length === 0) return;

  // 3) full mode: blacklist was the only gate
  if (cfg.mode === "full") return;

  // 4) workspace mode: cwd + whitelist; the rest → classic ask
  const whitelisted = (cfg.whitelist ?? []).map((g) => normGlob(g, agent.cwd));
  const outside = unapproved.filter(
    (p) =>
      !(p === cwd || p.startsWith(cwd + "/")) &&
      !whitelisted.some((g) => globMatch(g, p)),
  );
  if (outside.length === 0) return;

  classicAsk(agent, call, {
    title: `Access outside the workspace?`,
    detail: { paths: outside, cwd, tool: call.name },
  });
};

// ============================================================================
// SHIPPED STRATEGY — bashGate: the command policy (canonical + compound-safe)
// ============================================================================
// rules.commands = {
//   blacklist: ["rm -rf *", "git push --force"],  // ALWAYS denied
// }
//
// Fate order: blacklist → session approval (canonical) → compound-command
// safety → allow (simple commands default to allow, matching the workspace
// posture — path tools ask, simple commands run).
//
// THE SECURITY CORE: a broad approval like `git *` must NEVER cover a compound
// command (`git; rm -rf /`, `git push && make deploy`). Compound commands only
// pass on an EXACT canonical approval; otherwise they ask.

export interface CommandRules {
  /** Command globs that ALWAYS win — denied even in the default allow posture. */
  blacklist?: string[];
}

export const bashGate: PermissionGate = (agent, rules, call) => {
  const params = call.parameters as { command?: unknown } | undefined;
  const raw = typeof params?.command === "string" ? params.command : undefined;
  if (!raw || raw.trim().length === 0) return; // nothing to judge → allow

  const canonical = canonicalizeCommand(raw);
  const cfg: CommandRules = (rules.commands as CommandRules | undefined) ?? {};

  // 1) BLACKLIST ALWAYS WINS.
  for (const g of cfg.blacklist ?? []) {
    if (globMatch(g, canonical)) {
      recordDenial(agent, call, `blacklisted command ${canonical}`);
      call.preResolved = {
        answer: `blocked: command is blacklisted`,
        error: true,
        errorMessage: "command blacklist",
      };
      return;
    }
  }

  // 2) COMPOUND SAFETY — only an EXACT canonical approval passes silently.
  if (isCompoundCommand(canonical)) {
    const exact = approvalsOf(agent).some(
      (a) =>
        (a.expiresAt === undefined || a.expiresAt > Date.now()) &&
        (a.tool === undefined || a.tool === call.name) &&
        (a.cmd === undefined || a.cmd === canonical),
    );
    if (exact) return;
    classicAsk(agent, call, {
      title: `Run compound command?`,
      detail: { command: canonical, tool: call.name },
    });
    return;
  }

  // 3) Simple command — a session approval covering the canonical form passes.
  if (findApproval(agent, { tool: call.name, cmd: canonical })) return;

  // 4) Default posture: allow (simple commands are the boring case).
};

// ============================================================================
// THE PLUGIN — two dumb filters. That's the whole mechanism.
// ============================================================================

export function createPermissions(config: PermissionConfig = {}): Plugin {
  const rules = config.rules ?? {};
  // Awaits currently being resolved — blocks double-submits while an async
  // resolve is still swimming. In-process by design: restore starts clean.
  const settling = new WeakSet<object>();

  return {
    id: "permission",
    install(agent) {
      // ---- GATE (beforeTool, blocks:true): decide → allow / park / deny ----
      agent.addFilter({
        event: EVENTS.beforeTool,
        id: "permission/gate",
        priority: 100,
        fn: async (agent, event) => {
          for (const call of callsForGate(agent, event as { call?: ToolCallRecord })) {
            if (call.preResolved) continue; // already denied/answered — never re-gate
            // Idempotent under park→resume: the parked turn re-runs this gate.
            if (
              agent.pendingAwaits.some(
                (a) => a.type === PERMISSION_AWAIT && a.id === call.id,
              )
            )
              continue;
            const entry = matchEntry(config.tools, call.name);
            const gate = pick(entry, "gate", config.defaults, allowAll);
            if (gate === null) continue; // escape hatch — you own this tool
            // THE LAW: awaited. An async gate settles fully before its fate is
            // judged by the wall — remote policy engines just work, clock free.
            await (gate as PermissionGate)(agent, rules, call);
          }
        },
      });

      // ---- RESOLVER (inputReceived): match the envelope → call YOUR resolve ----
      agent.addFilter({
        event: EVENTS.inputReceived,
        id: "permission/resolve",
        priority: 100,
        fn: async (agent) => {
          const input = agent.currentInput as
            | { type?: string; ref?: string; answer?: unknown }
            | undefined;
          if (input?.type !== PERMISSION_ANSWER || typeof input.ref !== "string") return;
          const idx = agent.pendingAwaits.findIndex(
            (a) => a.type === PERMISSION_AWAIT && a.id === input.ref,
          );
          if (idx < 0) return; // unknown/stale ref — not ours, not anyone's problem
          const aw = agent.pendingAwaits[idx];
          if (settling.has(aw)) return; // double-submit mid-resolve — ignored
          settling.add(aw);
          try {
            const call = findCallById(agent, input.ref);
            const name = call?.name ?? (aw.schema as { tool?: string } | undefined)?.tool;
            const entry = name ? matchEntry(config.tools, name) : undefined;
            const resolve = pick(entry, "resolve", config.defaults, defaultResolve);
            if (resolve !== null) {
              // RACE-SAFE ORDER: effects land FIRST, awaited to completion — the
              // park stays held so a slow async effect can never race the machine
              // into executing the call un-gated. Release LAST.
              await (resolve as PermissionResolve)(input.answer, call, agent);
            }
          } finally {
            const i = agent.pendingAwaits.indexOf(aw);
            if (i >= 0) agent.pendingAwaits.splice(i, 1); // release the park
          }
        },
      });

      // ---- CLEANUP (beforeAbort): drop our parked awaits — no hang on next run ----
      agent.addFilter({
        event: EVENTS.beforeAbort,
        id: "permission/cleanup",
        priority: 100,
        fn: async (agent) => {
          const kept = agent.pendingAwaits.filter((a) => a.type !== PERMISSION_AWAIT);
          agent.pendingAwaits.splice(0, agent.pendingAwaits.length, ...kept);
        },
      });

      agent.addDeclaredCapability({
        id: "permission",
        description:
          "per-tool permission gates (allow/ask/deny) over the core park; " +
          `answer via input { type: "${PERMISSION_ANSWER}", ref, answer }`,
      });
    },
    uninstall(agent) {
      removeFiltersByPrefix(agent, "permission/");
      agent.removeDeclaredCapability("permission");
    },
  };
}

// Re-export for convenience — a deny IS a ToolResult-shaped preResolve.
export type { ToolResult };
