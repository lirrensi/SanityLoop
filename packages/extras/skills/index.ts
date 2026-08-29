// sanity/src/extras/skills.ts — simple skills (opencode/pi/codex pattern).
//
// ONE class, two calls. That's it.
//
//   const skills = new Skills({ dirs: [".agents/skills"], max: 8 });
//   agent.messages.push(skills.getPromptPart("context"));  // the menu → sys
//   agent.addTool(skills.getTool());                        // the loader tool
//
//   getPromptPart(type) — scans the folder(s), returns the catalog:
//     "text"    → the catalog as a plain string (embed into your own system text)
//     "context" → a ready system Message (splice into the messages array)
//   The catalog lists `name — description` per skill, capped at `max` — the
//   model learns what it CAN call, no bodies dumped into the prompt.
//
//   getTool() — the `skill` tool: the model calls it with a name, the tool
//   reads that SKILL.md from disk and returns the body (truncated to
//   maxSkillBytes) as the tool result. THAT is "loading the skill up".
//
// SKILL.md shape (the one everyone shares):
//   ---
//   name: my-skill
//   description: Use when ...
//   ---
//   <body>
//
// Both calls are SYNCHRONOUS — everything is in hand before the agent starts.
// No filters, no state, no event hooks. agents-md stays a filter because it
// reacts to the loop (read traversal); skills just hands you pieces to place.
//
// EXTRA = optional, import-or-not. No core changes.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { Tool, type ToolType } from "@sanityloop/core";
import type { Message, Plugin } from "@sanityloop/core";
import { DEFAULT_MAX_BYTES, truncateHead } from "@sanityloop/util";

export interface Skill {
  name: string;
  description?: string;
  filePath: string;
}

export interface SkillsOptions {
  /** Directories scanned for skills. Required. Relative paths resolve against `cwd`. */
  dirs: string | string[];
  /** Max skills listed in the prompt part. Default: 8. */
  max?: number;
  /** Per-skill body cap in bytes when loaded via the tool. Default: 50KB. */
  maxSkillBytes?: number;
  /** File names that mark a skill. Default: ["SKILL.md"]. */
  fileNames?: string[];
  /** Base dir for relative `dirs`. Default: process.cwd(). */
  cwd?: string;
  /**
   * Skill names to force-load into context at boot. Their full SKILL.md body is
   * injected as a system message so the model sees it WITHOUT calling the
   * `skill` tool — deterministic context, no lazy load, no manual paste.
   * Names not found are reported loudly, never silently dropped.
   */
  preload?: string[];
}

interface ParsedSkill {
  name: string;
  description?: string;
  content: string;
}

/** Split a SKILL.md into { name, description, content }. Throws on bad YAML. */
function parseSkillFile(absPath: string): ParsedSkill {
  const raw = readFileSync(absPath, "utf8");
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  let frontmatter: Record<string, unknown> = {};
  let body = normalized;
  if (normalized.startsWith("---")) {
    const endIndex = normalized.indexOf("\n---", 3);
    if (endIndex !== -1) {
      const yamlString = normalized.slice(4, endIndex);
      body = normalized.slice(endIndex + 4).trim();
      frontmatter = (parse(yamlString) ?? {}) as Record<string, unknown>;
    }
  }

  const name =
    typeof frontmatter.name === "string" && frontmatter.name.trim() !== ""
      ? frontmatter.name.trim()
      : basename(dirname(absPath));
  const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : undefined;
  return { name, description, content: body };
}

/** Recursively scan dirs for skill files, deduped by absolute path. */
function scanSkills(dirs: string[], fileNames: Set<string>): Skill[] {
  const all = new Map<string, Skill>();
  for (const dir of dirs) {
    const stack: string[] = [dir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries: string[];
      try {
        entries = readdirSync(current, { withFileTypes: false }) as string[];
      } catch {
        continue; // missing dir → skipped silently (like pi)
      }
      for (const entry of entries) {
        const absPath = join(current, entry);
        if (fileNames.has(entry)) {
          try {
            const { name, description } = parseSkillFile(absPath);
            all.set(resolve(absPath), { name, description, filePath: resolve(absPath) });
          } catch {
            // bad skill → skip, don't kill the catalog
          }
        } else if (isDir(absPath)) {
          stack.push(absPath);
        }
      }
    }
  }
  return [...all.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export class Skills {
  private dirs: string[];
  private fileNames: Set<string>;
  private max: number;
  private maxSkillBytes: number;
  private preload: Set<string>;

  constructor(opts: SkillsOptions) {
    const base = opts.cwd ?? process.cwd();
    this.dirs = (Array.isArray(opts.dirs) ? opts.dirs : [opts.dirs]).map((d) => resolve(base, d));
    this.fileNames = new Set(opts.fileNames ?? ["SKILL.md"]);
    this.max = opts.max ?? 8;
    this.maxSkillBytes = opts.maxSkillBytes ?? DEFAULT_MAX_BYTES;
    this.preload = new Set(opts.preload ?? []);
  }

  /** The catalog as a system Message — splice straight into the messages array. */
  getPromptPart(type: "context"): Message;
  /** The catalog as a plain string — embed into your own system prompt text. */
  getPromptPart(type?: "text"): string;
  getPromptPart(type: "text" | "context" = "context"): string | Message {
    const skills = scanSkills(this.dirs, this.fileNames);
    // the PROMPT shows only the first `max` — the tool can still load any
    const listed = skills.slice(0, this.max);
    const lines = listed.map((s) =>
      s.description
        ? `- ${s.name} — ${s.description}${this.preload.has(s.name) ? " (preloaded — already in context)" : ""}`
        : `- ${s.name}${this.preload.has(s.name) ? " (preloaded — already in context)" : ""}`,
    );
    if (listed.length === 0) {
      lines.push("(no skills loaded)");
    } else if (skills.length > listed.length) {
      lines.push(`(+${skills.length - listed.length} more skills — not listed)`);
    }
    const text =
      `# Available Skills\n` +
      `Call the \`skill\` tool with the exact name below to load a skill's full instructions when the task matches.\n\n` +
      lines.join("\n");
    if (type === "text") return text;
    return {
      id: "skills-catalog",
      enabled: true,
      type: "system",
      content: [{ type: "text", content: text }],
    };
  }

  /**
   * Full bodies of `preload` skills as system Messages — one per skill, pushed
   * into context at boot so the model sees them WITHOUT the `skill` tool.
   * Unknown names emit a loud notice (never silently dropped).
   */
  getPreloadParts(): Message[] {
    if (this.preload.size === 0) return [];
    const all = scanSkills(this.dirs, this.fileNames);
    const parts: Message[] = [];
    for (const name of this.preload) {
      const skill = all.find((s) => s.name === name);
      if (!skill) {
        parts.push({
          id: `skills-preload-${name}`,
          enabled: true,
          type: "system",
          content: [
            {
              type: "text",
              content:
                `# Skill preload FAILED: "${name}"\n` +
                `No skill with this name was found in the scanned dirs. ` +
                `Check the spelling / dirs.`,
            },
          ],
        });
        continue;
      }
      const { content } = parseSkillFile(skill.filePath);
      const body = truncateHead(content, { maxBytes: this.maxSkillBytes });
      parts.push({
        id: `skills-preload-${name}`,
        enabled: true,
        type: "system",
        content: [
          {
            type: "text",
            content:
              `# Preloaded skill: ${skill.name}\n` +
              (skill.description ? `${skill.description}\n\n` : "") +
              body.content +
              (body.truncated ? "\n\n[skill body truncated to fit context]" : ""),
          },
        ],
      });
    }
    return parts;
  }

  /** The `skill` tool — loads a skill body by name. Add it to the tools array. */
  getTool(): ToolType {
    const dirs = this.dirs;
    const fileNames = this.fileNames;
    const maxSkillBytes = this.maxSkillBytes;
    return Tool.define({
      name: "skill",
      description:
        "Load a skill by name. Skills are listed in the Available Skills system message; " +
        "call this when the task matches one of them. Returns the skill's full instructions.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "Exact skill name from the catalog" } },
        required: ["name"],
      },
      async execute({ name }: { name: string }) {
        const all = scanSkills(dirs, fileNames);
        const skill = all.find((s) => s.name === name);
        if (!skill) {
          const available = all.map((s) => s.name).join(", ") || "(none loaded)";
          return { answer: `No skill named "${name}". Available skills: ${available}`, error: true, errorMessage: "no such skill" };
        }
        try {
          const { content } = parseSkillFile(skill.filePath);
          const body = truncateHead(content, { maxBytes: maxSkillBytes });
          return {
            answer: body.content + (body.truncated ? "\n\n[skill body truncated to fit context]" : ""),
            stored: { name: skill.name, filePath: skill.filePath, truncated: body.truncated },
          };
        } catch (err) {
          return { answer: `Failed to load skill "${name}": ${(err as Error).message}`, stored: { name: skill.name }, error: true, errorMessage: (err as Error).message };
        }
      },
    });
  }
}

/**
 * skills as a Plugin — config at construction, batch in/out.
 * install: scans dirs, pushes the catalog into the system messages, adds the `skill` tool.
 * uninstall: removes the tool and splices out the catalog message (fixed id "skills-catalog").
 */
export function createSkillsPlugin(options: SkillsOptions): Plugin {
  return {
    id: "skills",
    install(agent) {
      const skills = new Skills(options);
      const part = skills.getPromptPart("context");
      if (typeof part !== "string") agent.messages.push(part);
      for (const p of skills.getPreloadParts()) agent.messages.push(p);
      agent.addTool(skills.getTool());
      agent.addDeclaredCapability({ id: "skills", description: "skills catalog + skill tool" });
    },
    uninstall(agent) {
      agent.removeTool("skill");
      const idx = agent.messages.findIndex((m) => m.id === "skills-catalog");
      if (idx >= 0) agent.messages.splice(idx, 1);
      for (let i = agent.messages.length - 1; i >= 0; i--) {
        if (agent.messages[i].id.startsWith("skills-preload-")) agent.messages.splice(i, 1);
      }
      agent.removeDeclaredCapability("skills");
    },
  };
}
