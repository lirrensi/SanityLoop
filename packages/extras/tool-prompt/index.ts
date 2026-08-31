// sanity/src/extras/tool-prompt.ts — aggregate tool prompt contributions (pi-style)
//
// Pi separates a tool's interface into THREE layers that feed the system prompt:
//   description        — the full contract, on the tool itself
//   promptSnippet      — one-liner for the tool menu ("Read file contents")
//   promptGuidelines   — behavioral rules ("use read instead of cat",
//                        "never pad edits with unchanged regions")
//
// This extra assembles those layers into a ready system Message. Splice the
// result into agent.messages at boot (after the base system prompt) and the
// model gets a compact tool menu + rule list WITHOUT reading every description.
//
//   const agent = new Agent({...});
//   agent.addTool(readTool).addTool(editTool).addTool(bashTool);
//   agent.messages.push(buildToolPromptPart(agent.tools));
//   await agent.run();
//
// No filters, no state — a pure derivation from the current tool registry.
// Tools without snippet/guidelines simply contribute nothing.
import type { Message, Plugin, ToolType } from "@sanityloop/core";

export interface ToolPromptOptions {
  /** Max snippets shown in the menu before truncation. Default 40. */
  maxSnippets?: number;
}

/** Build the tool-menu + rules system message from a tool list. */
export function buildToolPromptPart(tools: ToolType[], opts: ToolPromptOptions = {}): Message {
  const maxSnippets = opts.maxSnippets ?? 40;
  const withSnippet = tools.filter((t) => t.promptSnippet);
  const shown = withSnippet.slice(0, maxSnippets);

  const parts: string[] = [];
  if (shown.length > 0) {
    const lines = shown.map((t) => `- ${t.name}: ${t.promptSnippet}`);
    if (withSnippet.length > shown.length) {
      lines.push(`(+${withSnippet.length - shown.length} more tools — not listed)`);
    }
    parts.push(`# Tools\n${lines.join("\n")}`);
  }

  const guidelines: string[] = [];
  for (const t of tools) {
    for (const g of t.promptGuidelines ?? []) {
      guidelines.push(`- [${t.name}] ${g}`);
    }
  }
  if (guidelines.length > 0) {
    parts.push(`# Tool rules\n${guidelines.join("\n")}`);
  }

  const text = parts.join("\n\n") || "# Tools\n(no tool prompt contributions)";
  return {
    id: "tool-prompt",
    enabled: true,
    type: "system",
    content: [{ type: "text", content: text }],
  };
}

/**
 * The plugin form — installs the tool-prompt message. NOTE: install runs when
 * the plugin is installed, so install THIS LAST (after the tools it summarizes)
 * or re-call buildToolPromptPart + splice manually when the registry grows.
 */
export function createToolPromptPlugin(opts: ToolPromptOptions = {}): Plugin {
  return {
    id: "tool-prompt",
    install(agent) {
      agent.messages.push(buildToolPromptPart(agent.tools, opts));
    },
    uninstall(agent) {
      const idx = agent.messages.findIndex((m) => m.id === "tool-prompt");
      if (idx >= 0) agent.messages.splice(idx, 1);
    },
  };
}