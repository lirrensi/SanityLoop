// ============================================================================
// sanity/src/extras/tool-discovery — tool_search + enumerate_tools
// ============================================================================
// The discovery pair for HIDDEN tools (the visibility axis):
//
//   tool_search(query, page, limit)   — search ALL registered tools by name or
//       description, hidden ones INCLUDED. The "I know what I want, not the
//       name" door. For big catalogs: 100 tools, search is the finder.
//
//   enumerate_tools(visibility, page, limit) — inventory. Defaults to "hidden"
//       so the model learns what is CALLABLE BY NAME but not in context
//       ("I have 50 tools, 20 visible, 30 hidden"). Also supports "visible"
//       and "all".
//
// Both are paginated at 20 max (configurable), 1-indexed pages, and return the
// repo's house style: the answer ends with a page hint to continue
// ("[Use page=2 to see more.]") — never a silent dump.
//
// Hidden tools are NOT secrets — they are callable by name once known. These
// tools are the discovery surface for that contract.
//
// BACKEND TRUTH: on grammar-constrained servers (llama.cpp and most
// OpenAI-compatible backends), the model can ONLY emit tool calls whose names
// are in the DECLARED `tools` array — a hidden tool name is physically
// un-callable no matter how smart the model is. The `call_tool` dispatcher is
// the bridge: ONE visible tool that resolves ANY registered name (incl.
// hidden) through the schema wall + disabled check + the tool's own execute.
//   discover via tool_search/enumerate_tools  →  call via call_tool.
//
// CAVEAT — whether ANY of this works depends on the model + its inference
// template, not just the harness:
//   1. some models are too weak to follow "callable but not listed" — they
//      never attempt the discovery→call chain (or loop on discovery);
//   2. even a smart model may be BLOCKED by the template/server from emitting
//      a tool call to an undeclared name — that is a template restriction,
//      not a harness bug. `call_tool` sidesteps it because it IS declared;
//      but if the template also forbids calling a tool with dynamic
//      arguments, hidden tools are simply unusable on that backend.
// Test against your real endpoint before betting on hidden-tool UX.
//
// PERMISSION NOTE: call_tool delegates to the target tool's execute directly,
// so it BYPASSES the beforeTool gate for the inner call. Permission it at the
// dispatcher level (gate `call_tool` itself) for strict setups.
//
//   const agent = new Agent({ model, tools: [...], ... });
//   agent.install(createToolDiscoveryPlugin());
//   await agent.run();
//
// The discovery tools themselves are VISIBLE (the door must be findable).
import { Tool, validateToolArgs } from "@sanityloop/core";
import type { GodObject, Plugin, ToolType } from "@sanityloop/core";

// ----------------------------------------------------------------------------
// Options + helpers
// ----------------------------------------------------------------------------

export interface ToolDiscoveryOptions {
  /** Max items per page — pagination clamp. Default 20. */
  maxPageSize?: number;
  /** Default items per page when the model omits `limit`. Default 20. */
  defaultPageSize?: number;
}

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_PAGE = 1;

/** A tool's inventory row — everything a discovery tool tells the model. */
export interface ToolView {
  name: string;
  description: string;
  hidden: boolean;
  disabled: boolean;
}

function view(t: ToolType): ToolView {
  return { name: t.name, description: t.description ?? "", hidden: !!t.hidden, disabled: !!t.disabled };
}

function clampLimit(n: number | undefined, max: number, fallback: number): number {
  if (n === undefined) return fallback;
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function normPage(n: number | undefined): number {
  return n !== undefined && Number.isInteger(n) && n >= 1 ? n : DEFAULT_PAGE;
}

function paginate<T>(items: T[], page: number, limit: number) {
  const total = items.length;
  const start = (page - 1) * limit;
  const pageItems = items.slice(start, start + limit);
  return { pageItems, total, start, end: start + pageItems.length };
}

/** One line per tool — the model sees name, description, visibility, callability. */
function renderToolList(items: ToolView[]): string {
  return items
    .map((t) => {
      const vis = t.hidden ? "hidden" : "visible";
      const cap = t.disabled ? "disabled" : "enabled";
      const note = t.hidden && !t.disabled ? " — callable by name" : "";
      return `- ${t.name}${t.description ? ` — ${t.description}` : ""} (${vis}, ${cap}${note})`;
    })
    .join("\n");
}

/** THE ANTI-LOOP LINE — a small model that keeps re-searching must be told to stop. */
function actionHint(items: ToolView[]): string {
  const callableHidden = items.filter((t) => t.hidden && !t.disabled);
  if (callableHidden.length === 0) return "";
  if (callableHidden.length === 1) {
    return `\n[Action: call "${callableHidden[0]!.name}" directly NOW with its required parameters — hidden tools execute immediately. Do NOT search again.]`;
  }
  return `\n[Action: call the hidden tool(s) above directly by name — they execute immediately. Do NOT search again.]`;
}

/** The shared pagination tail — never a silent dump, never repeats the range
 * (the answer already states "showing X-Y of N"). Just the next move. */
function pageHint(pageItems: unknown[], start: number, total: number, nextPage: number): string {
  if (pageItems.length > 0 && start + pageItems.length < total) {
    return `\n[Use page=${nextPage} to see more.]`;
  }
  if (pageItems.length === 0 && total > 0) {
    return `\n[Page is past the end. Use page=1 to start.]`;
  }
  return "";
}

// ----------------------------------------------------------------------------
// tool_search — search EVERYTHING (hidden included)
// ----------------------------------------------------------------------------

/** The search tool — name/description substring match over ALL registered tools. */
export function createToolSearchTool(opts: ToolDiscoveryOptions = {}): ToolType {
  const maxPageSize = opts.maxPageSize ?? DEFAULT_PAGE_SIZE;
  const defaultPageSize = opts.defaultPageSize ?? DEFAULT_PAGE_SIZE;
  return Tool.define({
    name: "tool_search",
    description:
      `Search all registered tools by name or description (case-insensitive substring). ` +
      `HIDDEN tools are included — they are callable by name even though they are not in context. ` +
      `Paginated at ${defaultPageSize} per page; the result ends with a page hint to continue. ` +
      `Empty query = everything.`,
    promptSnippet: "Search all tools by name/description (hidden included)",
    promptGuidelines: [
      "Use tool_search when you need a tool you don't see in context — hidden tools ARE callable once you know their name.",
      "Results are paginated at 20 — follow the page hint to see more.",
    ],
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Substring to match against tool names and descriptions (case-insensitive). Empty string = list everything.",
        },
        page: { type: "integer", minimum: 1, description: "1-indexed page. Default 1." },
        limit: { type: "integer", minimum: 1, description: `Items per page. Default ${defaultPageSize}, max ${maxPageSize}.` },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(params, agent) {
      const { query, page, limit } = params as { query?: string; page?: number; limit?: number };
      const q = (query ?? "").toLowerCase();
      const items = agent.tools
        .filter(
          (t) =>
            q === "" ||
            t.name.toLowerCase().includes(q) ||
            (t.description ?? "").toLowerCase().includes(q),
        )
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(view);
      const p = normPage(page);
      const lim = clampLimit(limit, maxPageSize, defaultPageSize);
      const { pageItems, total, start, end } = paginate(items, p, lim);

      let answer = `Found ${total} matching tool${total === 1 ? "" : "s"}`;
      if (total > 0) {
        answer += ` (showing ${start + 1}-${end} of ${total}):\n${renderToolList(pageItems)}`;
      } else {
        answer += ".";
      }
      answer += actionHint(pageItems);
      answer += pageHint(pageItems, start, total, p + 1);
      return { answer, stored: { query: query ?? "", page: p, limit: lim, total, items: pageItems } };
    },
  });
}

// ----------------------------------------------------------------------------
// enumerate_tools — the inventory, defaults to HIDDEN
// ----------------------------------------------------------------------------

/** The inventory tool — defaults to listing hidden (callable-but-not-in-context) tools. */
export function createEnumerateToolsTool(opts: ToolDiscoveryOptions = {}): ToolType {
  const maxPageSize = opts.maxPageSize ?? DEFAULT_PAGE_SIZE;
  const defaultPageSize = opts.defaultPageSize ?? DEFAULT_PAGE_SIZE;
  return Tool.define({
    name: "enumerate_tools",
    description:
      `List registered tools. Defaults to "hidden" — the tools that are callable by name ` +
      `but NOT in context (progressive disclosure). Use visibility='visible' for in-context tools, ` +
      `'all' for everything. Paginated at ${defaultPageSize} per page; the result ends with a page hint to continue.`,
    promptSnippet: "Enumerate tools (defaults to hidden)",
    promptGuidelines: [
      "Call enumerate_tools to learn what HIDDEN tools are available — they are callable by name even though they are not in context.",
      "Results are paginated at 20 — follow the page hint to see more.",
    ],
    inputSchema: {
      type: "object",
      properties: {
        visibility: {
          type: "string",
          enum: ["hidden", "visible", "all"],
          description: "Which set to list. Default 'hidden'.",
        },
        page: { type: "integer", minimum: 1, description: "1-indexed page. Default 1." },
        limit: { type: "integer", minimum: 1, description: `Items per page. Default ${defaultPageSize}, max ${maxPageSize}.` },
      },
      additionalProperties: false,
    },
    async execute(params, agent) {
      const { visibility = "hidden", page, limit } = params as {
        visibility?: "hidden" | "visible" | "all";
        page?: number;
        limit?: number;
      };
      const all = [...agent.tools].sort((a, b) => a.name.localeCompare(b.name));
      const visibleCount = agent.visibleTools().length;
      const hiddenCount = all.length - visibleCount;
      const filtered = all.filter((t) =>
        visibility === "all" ? true : visibility === "hidden" ? !!t.hidden : !t.hidden,
      );
      const items = filtered.map(view);
      const p = normPage(page);
      const lim = clampLimit(limit, maxPageSize, defaultPageSize);
      const { pageItems, total, start, end } = paginate(items, p, lim);

      const label = visibility === "hidden" ? "Hidden" : visibility === "visible" ? "Visible" : "All";
      const parts = [
        `Tool inventory: ${visibleCount} visible (in context), ${hiddenCount} hidden (callable by name, not in context).`,
        `${label} tools (${total === 0 ? 0 : `${start + 1}-${end}`} of ${total}):`,
      ];
      if (pageItems.length > 0) parts.push(renderToolList(pageItems));
      let answer = parts.join("\n");
      answer += actionHint(pageItems);
      answer += pageHint(pageItems, start, total, p + 1);
      return {
        answer,
        stored: { visibility, page: p, limit: lim, total, visibleCount, hiddenCount, items: pageItems },
      };
    },
  });
}

// ----------------------------------------------------------------------------
// call_tool — the dispatcher bridge for hidden tools (grammar-constrained
// backends can't emit undeclared tool names, so ONE visible dispatcher resolves
// any registered name internally).
// ----------------------------------------------------------------------------

/** The dispatcher — call ANY registered tool by name, hidden ones included. */
export function createCallToolTool(): ToolType {
  return Tool.define({
    name: "call_tool",
    description:
      `Call ANY registered tool by name — including HIDDEN tools (registered but not listed in context). ` +
      `Use this when a needed tool is hidden, or when you know a tool's name from tool_search/enumerate_tools. ` +
      `The target tool's schema is enforced before it runs.`,
    promptSnippet: "Call any registered tool by name (incl. hidden)",
    promptGuidelines: [
      "When a needed tool is hidden or you know its name from tool_search/enumerate_tools, call it through call_tool.",
      "Provide arguments as an object matching the target tool's schema.",
    ],
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The registered tool name to call." },
        arguments: { type: "object", description: "Arguments for the target tool (match its schema)." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    async execute(params, agent) {
      const { name, arguments: args } = params as { name?: string; arguments?: Record<string, unknown> };
      if (typeof name !== "string" || name.length === 0) {
        return { answer: "call_tool: `name` is required (a registered tool name)", error: true, errorMessage: "name required" };
      }
      const tool = agent.tools.find((t) => t.name === name);
      if (!tool) return { answer: `Unknown tool: ${name}`, error: true, errorMessage: "unknown tool" };
      if (tool.disabled) return { answer: `Tool ${name} is disabled`, error: true, errorMessage: "disabled" };
      const callArgs = args ?? {};
      // THE SCHEMA WALL — same discipline as the core: custom validate overrides the JSON-Schema check.
      const errors = tool.validate ? (tool.validate(callArgs) ?? []) : validateToolArgs(tool.inputSchema, callArgs);
      if (errors.length > 0) {
        return {
          answer: `Invalid arguments for ${name}: ${errors.join("; ")}`,
          error: true,
          errorMessage: "invalid_arguments",
          stored: { errors },
        };
      }
      return tool.execute(callArgs, agent);
    },
  });
}

// ----------------------------------------------------------------------------
// The plugin — batch install, namespace id, declared capability
// ----------------------------------------------------------------------------

export function createToolDiscoveryPlugin(opts: ToolDiscoveryOptions = {}): Plugin {
  return {
    id: "tool-discovery",
    install(agent) {
      agent.addTool(createToolSearchTool(opts));
      agent.addTool(createEnumerateToolsTool(opts));
      agent.addTool(createCallToolTool());
      agent.addDeclaredCapability({
        id: "tool-discovery",
        description: "tool_search + enumerate_tools + call_tool — discover and call hidden tools by name",
      });
    },
    uninstall(agent) {
      agent.removeTool("tool_search");
      agent.removeTool("enumerate_tools");
      agent.removeTool("call_tool");
      agent.removeDeclaredCapability("tool-discovery");
    },
  };
}

// re-export for convenience — the tools alone, no plugin ceremony
export type { GodObject };