// sanity/src/extras/runlog.ts — the between-runs ledger.
//
// ONE extension, install-and-forget. Point it at a folder; it writes a record of
// every "operation" the agent performs, so you can answer — a week later, after
// daily cron runs — "did it succeed, and how much did it cost me?"
//
// Per T-0025: logging between runs. Two execution patterns:
//   • "process" (default) → one record per agentStart→agentSettled. Matches a
//     cron / ephemeral worker: each process invocation = one operation.
//   • "turn"               → one record per turnStart→turnEnd. Matches a
//     long-lived loop: each job the human/queue hands it is one operation.
//
// Output (all in `dir`):
//   runs.jsonl   — append-only, one JSON record per operation
//   summary.json — aggregate, REWRITTEN each op, PERSISTED across processes
//                  (so a cron job's summary accumulates day over day)
//
// Each record carries: id, start/end, duration, success, model, and a STATS
// DELTA (tokens + $ cost) for that operation — read straight from agent.stats.
// `error` events during an op flip it to a failure and capture the message.
//
// Optional `runlog_summary` tool lets the agent read the ledger from inside.
//
// EXTRA = optional, import-or-not. No core changes.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Tool, type Plugin, EVENTS } from "@sanityloop/core";

export interface RunLogOptions {
  /** Folder where runs.jsonl + summary.json live. Required. */
  dir: string;
  /**
   * What counts as one operation.
   *  "process" → one record per agentStart→agentSettled (cron/ephemeral, default)
   *  "turn"    → one record per turnStart→turnEnd (long-lived loop: each job = one op)
   */
  granularity?: "process" | "turn";
  /** Expose a `runlog_summary` tool to read the aggregate from inside the agent. Default: true. */
  tool?: boolean;
}

interface StatSnap {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

interface RunRecord {
  id: string;
  agentId?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  success: boolean;
  error?: string;
  model?: string;
  stats: StatSnap;
  granularity: "process" | "turn";
}

interface Summary {
  totalRuns: number;
  successes: number;
  failures: number;
  successRate: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCost: number;
  totalDurationMs: number;
  firstRun?: string;
  lastRun?: string;
  updatedAt: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function snapStats(s: any): StatSnap {
  return {
    input: s?.input ?? 0,
    output: s?.output ?? 0,
    cacheRead: s?.cacheRead ?? 0,
    cacheWrite: s?.cacheWrite ?? 0,
    totalTokens: s?.totalTokens ?? 0,
    cost: s?.cost?.total ?? 0,
  };
}

function diffStats(before: StatSnap, after: StatSnap): StatSnap {
  return {
    input: after.input - before.input,
    output: after.output - before.output,
    cacheRead: after.cacheRead - before.cacheRead,
    cacheWrite: after.cacheWrite - before.cacheWrite,
    totalTokens: after.totalTokens - before.totalTokens,
    cost: round2(after.cost - before.cost),
  };
}

function emptySummary(): Summary {
  return {
    totalRuns: 0,
    successes: 0,
    failures: 0,
    successRate: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    totalDurationMs: 0,
    updatedAt: new Date().toISOString(),
  };
}

export function createRunLogPlugin(options: RunLogOptions): Plugin {
  if (!options.dir) throw new Error("createRunLogPlugin requires `dir`");
  const outDir = resolve(options.dir);
  const granularity = options.granularity ?? "process";
  const tool = options.tool ?? true;

  const startEvent = granularity === "process" ? EVENTS.agentStart : EVENTS.turnStart;
  const endEvent = granularity === "process" ? EVENTS.agentSettled : EVENTS.turnEnd;

  const runsFile = join(outDir, "runs.jsonl");
  const summaryFile = join(outDir, "summary.json");

  // Load persisted summary so a cron job's ledger accumulates across invocations.
  let summary: Summary = emptySummary();
  if (existsSync(summaryFile)) {
    try {
      summary = { ...emptySummary(), ...JSON.parse(readFileSync(summaryFile, "utf8")) };
    } catch {
      summary = emptySummary();
    }
  }

  // Per-operation scratch state (closure — one active unit at a time).
  let unit: {
    id: string;
    startedAt: number;
    startStats: StatSnap;
    failed: boolean;
    errorMsg?: string;
  } | null = null;

  function updateSummary(rec: RunRecord) {
    summary.totalRuns++;
    if (rec.success) summary.successes++;
    else summary.failures++;
    summary.successRate = summary.successes / summary.totalRuns;
    summary.totalInputTokens += rec.stats.input;
    summary.totalOutputTokens += rec.stats.output;
    summary.totalTokens += rec.stats.totalTokens;
    summary.totalCost = round2(summary.totalCost + rec.stats.cost);
    summary.totalDurationMs += rec.durationMs;
    if (!summary.firstRun) summary.firstRun = rec.startedAt;
    summary.lastRun = rec.endedAt;
    summary.updatedAt = new Date().toISOString();
  }

  function finalize(agent: any) {
    if (!unit) return;
    const now = Date.now();
    const delta = diffStats(unit.startStats, snapStats(agent.stats));
    const rec: RunRecord = {
      id: unit.id,
      agentId: agent.agentId,
      startedAt: new Date(unit.startedAt).toISOString(),
      endedAt: new Date(now).toISOString(),
      durationMs: now - unit.startedAt,
      success: !unit.failed,
      model: agent.stats?.model,
      stats: delta,
      granularity,
    };
    if (unit.failed) rec.error = unit.errorMsg;
    appendFileSync(runsFile, JSON.stringify(rec) + "\n");
    updateSummary(rec);
    writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
    unit = null;
  }

  return {
    id: `runlog:${granularity}`,
    install(agent) {
      mkdirSync(outDir, { recursive: true });

      agent.addFilter({
        event: startEvent,
        id: "runlog/start",
        priority: 0,
        fn: async (_agent: any) => {
          unit = {
            id: randomUUID(),
            startedAt: Date.now(),
            startStats: snapStats(_agent.stats),
            failed: false,
          };
        },
      });

      agent.addFilter({
        event: EVENTS.error,
        id: "runlog/error",
        priority: 0,
        fn: async (_agent: any, payload: any) => {
          if (!unit) return;
          unit.failed = true;
          unit.errorMsg =
            payload?.message ?? payload?.error?.message ?? (typeof payload === "string" ? payload : JSON.stringify(payload));
        },
      });

      agent.addFilter({
        event: endEvent,
        id: "runlog/end",
        priority: 0,
        fn: async (a: any) => {
          finalize(a);
        },
      });

      if (tool) {
        agent.addTool(
          Tool.define({
            name: "runlog_summary",
            description:
              "Return the aggregate run ledger: total runs, success rate, total tokens + cost, durations. " +
              "Persisted across process invocations, so it answers 'how much did it cost me this week'.",
            inputSchema: { type: "object", properties: {} },
            async execute() {
              return { answer: JSON.stringify(summary, null, 2) };
            },
          }),
        );
      }
    },
    uninstall(agent) {
      agent.removeFilter(startEvent, "runlog/start");
      agent.removeFilter(EVENTS.error, "runlog/error");
      agent.removeFilter(endEvent, "runlog/end");
      if (tool) agent.removeTool("runlog_summary");
    },
  };
}
