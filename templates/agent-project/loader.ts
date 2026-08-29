// ============================================================================
// templates/agent-project/loader.ts — the folder → Agent assembler.
// Reads the sibling files/folders and composes them as if it were one file.
//
//   System.md               → this agent's system prompt
//   Agents.md               → shared instructions for EVERY agent (main + subs)
//   tools/*.ts              → default-export a tool (name = filename or `name`)
//   filters/*.ts            → default-export a filter (our hooks-analog)
//   skills/<name>/SKILL.md  → a skill (folder = name; loaded on demand)
//   subagents/<id>/agent.ts → a subagent builder (+ its own System.md)
//
// Everything eve has that we DON'T (connections/channels/schedules/sandbox)
// is deliberately absent — those concepts don't map to our Lego.
// ============================================================================
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	Agent,
	Tool,
	type Filter,
	type Message,
	type ModelContract,
} from "@sanityloop/core";
import { Skills } from "@sanityloop/skills";
import { createSubAgents, type SubEntryLike } from "@sanityloop/subagents";

export interface LoadAgentFolderOptions {
	/** The agent folder. Default: the directory of this loader file. */
	dir?: string;
	model: ModelContract;
	agentId?: string;
	description?: string;
}

function systemMsg(content: string, label: string): Message {
	return {
		id: `${label.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`,
		enabled: true,
		type: "system",
		content: [{ type: "text", content }],
	};
}

/** Dynamic-import every `.ts` in `dir/<slot>` and hand each module to `visit`. */
async function loadModules(
	dir: string,
	slot: string,
	visit: (mod: Record<string, unknown>) => void,
): Promise<void> {
	const slotDir = join(dir, slot);
	if (!existsSync(slotDir)) return;
	for (const file of readdirSync(slotDir)) {
		if (!file.endsWith(".ts")) continue;
		const mod = (await import(pathToFileURL(join(slotDir, file)).href)) as Record<
			string,
			unknown
		>;
		visit(mod);
	}
}

export async function loadAgentFolder(opts: LoadAgentFolderOptions): Promise<Agent> {
	const dir = opts.dir ?? dirname(fileURLToPath(import.meta.url));
	const agent = new Agent({
		model: opts.model,
		agentId: opts.agentId ?? basename(dir),
		description: opts.description,
	});

	// ---- system text: Agents.md (the crew bible) then System.md (this agent) ----
	const sharedSystem = join(dir, "Agents.md");
	if (existsSync(sharedSystem)) {
		agent.messages.push(systemMsg(readFileSync(sharedSystem, "utf8"), "Agents"));
	}
	const ownSystem = join(dir, "System.md");
	if (existsSync(ownSystem)) {
		agent.messages.push(systemMsg(readFileSync(ownSystem, "utf8"), "System"));
	}

	// ---- tools/ ----
	await loadModules(dir, "tools", (mod) => {
		const def = mod.default as Record<string, unknown> | undefined;
		if (!def || typeof def.name !== "string" || typeof def.execute !== "function") return;
		agent.addTool(Tool.define(def as never));
	});

	// ---- filters/ (the hooks-analog) ----
	await loadModules(dir, "filters", (mod) => {
		const f = mod.default as Filter | undefined;
		if (f && typeof f.event === "string" && f.id && typeof f.fn === "function") {
			agent.addFilter(f);
		}
	});

	// ---- skills/ — one folder per skill, SKILL.md inside ----
	const skillsDir = join(dir, "skills");
	if (existsSync(skillsDir)) {
		const skills = new Skills({ dirs: [skillsDir] });
		const catalog = skills.getPromptPart("context") as Message | null;
		if (catalog) agent.messages.push(catalog);
		agent.addTool(skills.getTool());
	}

	// ---- subagents/ — one folder per subagent, agent.ts inside ----
	const subsDir = join(dir, "subagents");
	if (existsSync(subsDir)) {
		const subs: SubEntryLike[] = [];
		for (const id of readdirSync(subsDir)) {
			const subDir = join(subsDir, id);
			if (!statSync(subDir).isDirectory()) continue;
			const entry = join(subDir, "agent.ts");
			if (!existsSync(entry)) continue;
			const mod = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
			const build = mod.default as (() => Agent) | undefined;
			if (typeof build !== "function") continue;
			const description = typeof mod.description === "string" ? mod.description : id;
			subs.push({
				id,
				description,
				build: () => {
					// fresh per spawn: the sub's System.md, then the crew bible, first
					const sub = build();
					const subSystem = join(subDir, "System.md");
					if (existsSync(subSystem)) {
						sub.messages.unshift(systemMsg(readFileSync(subSystem, "utf8"), "System"));
					}
					if (existsSync(sharedSystem)) {
						sub.messages.unshift(systemMsg(readFileSync(sharedSystem, "utf8"), "Agents"));
					}
					return sub;
				},
			});
		}
		if (subs.length) agent.install(createSubAgents({ subs }));
	}

	return agent;
}