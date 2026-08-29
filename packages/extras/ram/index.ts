// sanity/src/extras/ram.ts — the agent's own scratch RAM.
//
// ONE extension, install-and-forget. The agent gets a key/value memory it owns:
//   ram_get / ram_set / ram_delete / ram_keys   — read/write ANY JSON-able value
//   ram_run (opt-in: allowRun:true)           — execute a stored function-string
//                                               against the RAM (node:vm sandbox)
//
// Per T-0027: "agent has its own ram". We ship the `process` mode only — the RAM
// is a DETACHED in-process object (NOT on agent.state, NOT serialized). It lives
// for the process lifetime; crash-and-resume does NOT restore it. That is the
// "true memory, separate from the agent, same process, not subject to
// serialization" flavor from the ticket thread.
//
// KEYS ARE NESTED PATHS. Dots separate segments; a numeric segment becomes an
// array index. So `ram_set { key:"a.b.c.1.meow", value:"purr" }` builds
// `{ a: { b: { c: [ <_, "purr"> ] } } }` (arrays auto-created for numeric
// segments). Same dotted syntax for get/delete/run.
//
// A stored function is just a STRING value:
//   ram_set { key:"double", value:"(ram, args) => args[0] * 2" }
//   ram_run { key:"double", args:[21] }   → 42
// Because it's plain RAM data, the agent can RE-EVOLVE it with another ram_set —
// code-as-data, first-class citizen of the state. No separate ram_define needed.
//
// OUTPUT GUARD: every ram_get / ram_run reply is byte-capped (maxEchoBytes,
// default 50_000). A giant nested value can never blow up the context.
//
// EXTRA = optional, import-or-not. No core changes.
import vm from "node:vm";
import { Tool, type Plugin } from "@sanityloop/core";

export interface RamOptions {
  /** Max bytes echoed back by ram_get / ram_run. Default: 50_000. */
  maxEchoBytes?: number;
  /**
   * Enable ram_run (execute a stored function-string against the RAM).
   * Functions are stored as strings via ram_set. Default: FALSE — arbitrary code
   * execution is opt-in; you must explicitly pass `allowRun: true` to enable it.
   */
  allowRun?: boolean;
}

type PathSeg = string | number;
type Path = PathSeg[];

/** "a.b.c.1" → ["a","b","c",1] — numeric segments become array indices. */
function parseKey(key: string): Path {
  return key.split(".").map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg));
}

function getPath(root: Record<string, unknown>, path: Path): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PathSeg, unknown>)[seg];
  }
  return cur;
}

function setPath(root: Record<string, unknown>, path: Path, value: unknown): void {
  if (path.length === 0) return;
  let cur: Record<PathSeg, unknown> = root;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    const next = path[i + 1];
    const existing = cur[seg];
    if (existing == null || typeof existing !== "object") {
      // create the right container for the NEXT segment
      cur[seg] = typeof next === "number" ? ([] as unknown as Record<PathSeg, unknown>) : {};
    }
    cur = cur[seg] as Record<PathSeg, unknown>;
  }
  cur[path[path.length - 1]] = value;
}

function deletePath(root: Record<string, unknown>, path: Path): boolean {
  if (path.length === 0) return false;
  let cur: Record<PathSeg, unknown> = root;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    const existing = cur[seg];
    if (existing == null || typeof existing !== "object") return false;
    cur = existing as Record<PathSeg, unknown>;
  }
  const last = path[path.length - 1];
  if (Array.isArray(cur) && typeof last === "number") {
    if (last < 0 || last >= cur.length) return false;
    cur.splice(last, 1);
    return true;
  }
  if (!(last in cur)) return false;
  delete cur[last as string];
  return true;
}

export function createRamPlugin(options: RamOptions = {}): Plugin {
  const maxEchoBytes = options.maxEchoBytes ?? 50_000;
  const allowRun = options.allowRun ?? false;

  // The RAM itself: a detached in-process object. Not on agent.state → not taped.
  const store: Record<string, unknown> = {};

  const toolNames = ["ram_get", "ram_set", "ram_delete", "ram_keys"];
  if (allowRun) toolNames.push("ram_run");

  return {
    id: "ram",
    install(agent) {
      agent.addTool(
        Tool.define({
          name: "ram_get",
          description:
            "Read the agent's RAM. No `key` → whole object (byte-capped). With `key` (supports dotted " +
            "nested paths like `a.b.c.1`) → that value, or undefined.",
          inputSchema: {
            type: "object",
            properties: { key: { type: "string", description: "Optional dotted path to read" } },
          },
          async execute({ key }: { key?: string }) {
            const val = key === undefined ? store : getPath(store, parseKey(key));
            return { answer: truncate(val, maxEchoBytes) };
          },
        }),
      );

      agent.addTool(
        Tool.define({
          name: "ram_set",
          description:
            "Write ANY JSON-able value into RAM under a dotted key (e.g. `a.b.c.1`). Numeric segments " +
            "auto-create arrays. A string containing JS code becomes executable via ram_run (store it as a " +
            "function expression like `(ram, args) => …`).",
          inputSchema: {
            type: "object",
            properties: {
              key: { type: "string" },
              value: { description: "Any JSON-able value (object, array, string, number…)" },
            },
            required: ["key", "value"],
          },
          async execute({ key, value }: { key: string; value: unknown }) {
            setPath(store, parseKey(key), value);
            return { answer: `ram[${key}] set`, stored: { key, type: typeof value } };
          },
        }),
      );

      agent.addTool(
        Tool.define({
          name: "ram_delete",
          description: "Delete a dotted key from RAM (array entries are spliced out).",
          inputSchema: {
            type: "object",
            properties: { key: { type: "string" } },
            required: ["key"],
          },
          async execute({ key }: { key: string }) {
            const removed = deletePath(store, parseKey(key));
            return { answer: removed ? `ram[${key}] deleted` : `key not present` };
          },
        }),
      );

      agent.addTool(
        Tool.define({
          name: "ram_keys",
          description: "List top-level keys currently in RAM.",
          inputSchema: { type: "object", properties: {} },
          async execute() {
            const keys = Object.keys(store);
            return { answer: keys.length ? keys.join(", ") : "(empty)" };
          },
        }),
      );

      if (allowRun) {
        agent.addTool(
          Tool.define({
            name: "ram_run",
            description:
              "Execute a stored FUNCTION against the RAM. `ram[key]` must be a string of a function " +
              "expression, e.g. `(ram, args) => args[0] * 2`. Runs sandboxed in node:vm with `ram` " +
              "and `args` in scope; the function can mutate `ram` and it sticks.",
            inputSchema: {
              type: "object",
              properties: {
                key: { type: "string", description: "Dotted path to the function-string" },
                args: { type: "array", description: "Arguments passed as `args` to the function" },
              },
              required: ["key"],
            },
            async execute({ key, args = [] }: { key: string; args?: unknown[] }) {
              const code = getPath(store, parseKey(key));
              if (typeof code !== "string") {
                return {
                  answer: `ram[${key}] is not a function-string (got ${typeof code})`,
                  error: true,
                };
              }
              if (!Array.isArray(args)) {
                return { answer: "`args` must be an array", error: true };
              }
              try {
                const sandbox: Record<string, unknown> = { ram: store, args, console };
                vm.createContext(sandbox);
                const result = await vm.runInContext(`(${code})(ram, args)`, sandbox);
                return { answer: truncate(result, maxEchoBytes), stored: { key, result: typeof result } };
              } catch (err) {
                return { answer: `ram_run failed: ${(err as Error).message}`, error: true };
              }
            },
          }),
        );
      }
    },
    uninstall(agent) {
      for (const n of toolNames) agent.removeTool(n);
    },
  };
}

function truncate(v: unknown, maxBytes: number): string {
  let s: string;
  if (typeof v === "string") {
    s = v;
  } else {
    try {
      s = v === undefined ? "undefined" : JSON.stringify(v, null, 2) ?? String(v);
    } catch {
      s = String(v);
    }
  }
  const bytes = Buffer.byteLength(s, "utf8");
  if (bytes <= maxBytes) return s;
  return s.slice(0, maxBytes) + `\n…[truncated at ${maxBytes} bytes]`;
}
