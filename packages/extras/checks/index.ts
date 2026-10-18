// ============================================================================
// packages/extras/checks/index.ts — deterministic binary checks + verdict
// ============================================================================
// Zero-LLM micro-scorers over the transcript. A check is a pure predicate:
//
//   checks.includes("done")        — assistant text contains "done"
//   checks.calledTool("search")    — tool "search" ran at least once
//   checks.noToolErrors()          — no tool result with error: true
//   checks.maxToolCalls(5)         — at most 5 tool calls
//   checks.toolOrder(["a", "b"])   — "a" ran before "b"
//
// The plugin collects tool/text evidence at toolEnd/messageAdded, reduces the
// verdict at turnEnd/agentSettled, and mirrors it into state:
//
//   state.checks = { last: { id, score, at }[], verdict: "passed"|"failed" }
//
// Gates = must score 1.0 or the verdict is "failed". Tracked metrics score
// 0/1 but never fail. Testing use: install in a harness, drive a turn, assert
// the verdict — deterministic, no model in the scoring path.
//
// EXTRA = optional, import-or-not. No core changes.
import { EVENTS } from "@sanityloop/core";
import type {
  GodObject,
  Message,
  Plugin,
} from "@sanityloop/core";
import { removeFiltersByPrefix } from "@sanityloop/util";

// ----------------------------------------------------------------------------
// Evidence — the per-turn scratch the checks read. Closure, not state: hot
// path, rebuilt every turn, only the reduced verdict crosses into state.
// ----------------------------------------------------------------------------

export interface ChecksEvidence {
  /** Assistant-visible text committed this turn (assistant + user-aside-from-seed). */
  texts: string[];
  /** Tool names in commit order this turn. */
  tools: string[];
  /** Tool names whose result had error: true. */
  errorTools: string[];
  /** Every committed tool result, in order. */
  results: { name: string; error: boolean }[];
}

export function emptyEvidence(): ChecksEvidence {
  return { texts: [], tools: [], errorTools: [], results: [] };
}

// ----------------------------------------------------------------------------
// Checks — pure predicates over evidence. Each returns 1 (met) or 0 (unmet).
// A check is `{ id, run }` — data, not framework; compose freely.
// ----------------------------------------------------------------------------

export interface Check {
  id: string;
  run(evidence: ChecksEvidence): 1 | 0;
}

function textOf(m: Message): string {
  const c = m.content;
  if (!Array.isArray(c)) return "";
  let out = "";
  for (const b of c) {
    if (typeof b === "object" && b !== null && "type" in b && "content" in b) {
      const type = b.type;
      const content = b.content;
      if (type === "text" && typeof content === "string") out += content;
    }
  }
  return out;
}

/** Accumulate one committed message into evidence — shared by the plugin. */
export function collectInto(evidence: ChecksEvidence, m: Message): void {
  if (m.type === "assistant" || m.type === "assistant-compound") {
    const t = textOf(m);
    if (t.length > 0) evidence.texts.push(t);
  } else if (m.type === "toolResult") {
    const content = m.content;
    const error =
      typeof content === "object" &&
      content !== null &&
      "error" in content &&
      content.error === true;
    const name =
      "toolName" in m && typeof m.toolName === "string" ? m.toolName : "?";
    evidence.tools.push(name);
    evidence.results.push({ name, error });
    if (error) evidence.errorTools.push(name);
  }
}

export const checks = {
  /** Assistant text contains the substring. */
  includes: (substr: string): Check => ({
    id: `includes:${substr}`,
    run: (e) => (e.texts.some((t) => t.includes(substr)) ? 1 : 0),
  }),
  /** Tool ran at least once this turn. */
  calledTool: (name: string): Check => ({
    id: `calledTool:${name}`,
    run: (e) => (e.tools.includes(name) ? 1 : 0),
  }),
  /** Tool never ran this turn. */
  didNotCall: (name: string): Check => ({
    id: `didNotCall:${name}`,
    run: (e) => (e.tools.includes(name) ? 0 : 1),
  }),
  /** No tool result with error: true. */
  noToolErrors: (): Check => ({
    id: "noToolErrors",
    run: (e) => (e.errorTools.length === 0 ? 1 : 0),
  }),
  /** At most N tool calls. */
  maxToolCalls: (n: number): Check => ({
    id: `maxToolCalls:${n}`,
    run: (e) => (e.tools.length <= n ? 1 : 0),
  }),
  /** Tools ran in this relative order (gaps allowed). */
  toolOrder: (names: string[]): Check => ({
    id: `toolOrder:${names.join(">")}`,
    run: (e) => {
      let idx = 0;
      for (const t of e.tools) {
        if (t === names[idx]) idx++;
        if (idx >= names.length) return 1;
      }
      return names.length === 0 || idx >= names.length ? 1 : 0;
    },
  }),
};

// ----------------------------------------------------------------------------
// Verdict — gates must be 1.0, tracked metrics never fail.
// ----------------------------------------------------------------------------

export type ChecksVerdict = "passed" | "failed";

export interface CheckScore {
  id: string;
  score: 1 | 0;
  gate: boolean;
  at: number;
}

export interface ChecksOptions {
  /** Hard requirements — any 0 flips the verdict to "failed". */
  gates?: Check[];
  /** Tracked only — scored and mirrored, never fail. */
  metrics?: Check[];
  /** Fired after every reduction with the verdict + scores. */
  onVerdict?: (verdict: ChecksVerdict, scores: CheckScore[]) => void;
  /** Where the mirror lives. Default "checks". */
  stateKey?: string;
  /** Plugin id. Default "checks". */
  id?: string;
}

export interface ChecksSnapshot {
  verdict: ChecksVerdict;
  scores: CheckScore[];
  at: number;
}

export function createChecks(opts: ChecksOptions = {}): Plugin {
  const pluginId = opts.id ?? "checks";
  const stateKey = opts.stateKey ?? "checks";
  const prefix = `${pluginId}/`;
  const gates = opts.gates ?? [];
  const metrics = opts.metrics ?? [];
  let evidence = emptyEvidence();

  function reduce(agent: GodObject): void {
    const at = Date.now();
    const scores: CheckScore[] = [
      ...gates.map((c) => ({ id: c.id, score: c.run(evidence), gate: true as const, at })),
      ...metrics.map((c) => ({ id: c.id, score: c.run(evidence), gate: false as const, at })),
    ];
    const verdict: ChecksVerdict = scores.some((s) => s.gate && s.score === 0)
      ? "failed"
      : "passed";
    agent.state[stateKey] = { verdict, scores, at } satisfies ChecksSnapshot;
    opts.onVerdict?.(verdict, scores);
    evidence = emptyEvidence();
  }

  return {
    id: pluginId,
    install(agent) {
      evidence = emptyEvidence();
      agent.addFilter({
        event: EVENTS.messageAdded,
        id: `${prefix}collect`,
        priority: 0,
        fn: async (agent) => {
          // tool commits announce via toolEnd, not messageAdded — skip here
          // (collectInto keeps the toolResult branch for direct callers).
          const last = agent.messages.at(-1);
          if (last && last.type !== "toolResult") collectInto(evidence, last);
        },
      });
      agent.addFilter({
        event: EVENTS.toolEnd,
        id: `${prefix}collect-tool`,
        priority: 0,
        fn: async (_agent, payload) => {
          if (payload === undefined || typeof payload !== "object") return;
          if (!("call" in payload) || !("result" in payload)) return;
          const call = payload.call;
          const result = payload.result;
          const name =
            typeof call === "object" && call !== null && "name" in call && typeof call.name === "string"
              ? call.name
              : "?";
          const error =
            typeof result === "object" && result !== null && "error" in result && result.error === true;
          evidence.tools.push(name);
          evidence.results.push({ name, error });
          if (error) evidence.errorTools.push(name);
        },
      });
      agent.addFilter({
        event: EVENTS.turnEnd,
        id: `${prefix}reduce`,
        priority: 0,
        fn: async (agent) => {
          reduce(agent);
        },
      });
      agent.addFilter({
        event: EVENTS.agentSettled,
        id: `${prefix}reduce-settled`,
        priority: 0,
        fn: async (agent) => {
          // a settled run with no turn boundary still deserves a verdict —
          // but never double-reduce an already-reduced turn (empty evidence
          // + existing snapshot = the turnEnd reduction already ran).
          const raw = agent.state[stateKey];
          const snap: ChecksSnapshot | undefined =
            typeof raw === "object" && raw !== null && "verdict" in raw
              ? (raw as ChecksSnapshot)
              : undefined;
          const fresh =
            evidence.texts.length > 0 ||
            evidence.tools.length > 0;
          if (fresh || snap === undefined) reduce(agent);
        },
      });
      agent.addDeclaredCapability({
        id: pluginId,
        description: "deterministic binary checks over the transcript (gates + metrics → state mirror)",
      });
    },
    uninstall(agent) {
      removeFiltersByPrefix(agent, prefix);
      agent.removeDeclaredCapability(pluginId);
      delete agent.state[stateKey];
    },
  };
}
