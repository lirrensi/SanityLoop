// ============================================================================
// test/e2e/fullstack-lifecycle.test.ts — THE template-agent ASSEMBLY, FOR REAL.
// ============================================================================
// template-agent.ts is what users copy. This test builds that exact stack —
// agents-md-loader + compaction + inputs + skills + bash + session tape —
// against a REAL temp workspace with a REAL AGENTS.md on disk, drives one turn
// whose tool REALLY writes a file, then proves the crash-resume promise
// in-process by restoring the tape into a FRESH agent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GodObject } from "@sanityloop/core";
import { Tool } from "@sanityloop/core";
import { Agent } from "@sanityloop/core";
import { createAgentsMdLoader } from "@sanityloop/agents-md-loader";
import { createCompaction } from "@sanityloop/basic-compaction";
import { createDefaultInputs } from "@sanityloop/inputs";
import { createSkillsPlugin } from "@sanityloop/skills";
import { createBashPlugin } from "@sanityloop/shell-tool";
import { jsonlSession } from "@sanityloop/base-storage";
import { StubModel, assistantTurn, callTo, toolCallTurn } from "@sanityloop/test-kit/core";
import { awaitLanded, makeTempDir, sleep, waitUntil } from "@sanityloop/test-kit";

const AGENTS_MARKER = "SANITY-E2E-AGENTS-MARKER-7f3a";

test("full-stack assembly: real AGENTS.md load, real disk effect, clean tape restore", async (t) => {
    const dir = await makeTempDir(t, "sanity-e2e-fullstack-");
    await writeFile(join(dir, "AGENTS.md"), `# rules\n${AGENTS_MARKER} keep replies terse.\n`, "utf8");
    await mkdir(join(dir, ".agents", "skills"), { recursive: true });
    let calls = 0;
    const model = new StubModel([
        () => {
            calls++;
            return toolCallTurn([
                callTo("write_note", { path: "effect.txt", content: "FULLSTACK WAS HERE" }),
            ]);
        },
        () => {
            calls++;
            return assistantTurn("effect written");
        },
    ]);

    const agent = new Agent({
        model,
        agentId: "fullstack-e2e",
        cwd: dir,
        tools: [
            Tool.define({
                name: "write_note",
                description: "Write a file into the workspace.",
                inputSchema: {
                    type: "object",
                    properties: { path: { type: "string" }, content: { type: "string" } },
                    required: ["path", "content"],
                },
                async execute({ path, content }: { path: string; content: string }) {
                    const full = join(dir, path);
                    await writeFile(full, content, "utf8");
                    return { answer: `wrote ${path}`, stored: { bytes: content.length } };
                },
            }),
        ],
    });

    // The template-agent batch — one line each, drop-in, no conflicts.
    const session = jsonlSession(join(dir, "sessions", "main"));
    t.after(() => sleep(50));
    agent.install(createAgentsMdLoader());
    agent.install(createCompaction());
    agent.install(createDefaultInputs());
    agent.install(createSkillsPlugin({ dirs: [join(dir, ".agents", "skills")] }));
    agent.install(createBashPlugin());
    agent.install(session.plugin);

    // The stack assembled: bash registered alongside our tool.
    const names = agent.tools.map((tool) => tool.name);
    assert.ok(names.includes("write_note"), "our tool missing");
    assert.ok(names.includes("bash"), "bash plugin did not register its tool");

    // Drive ONE real turn.
    agent.messages.push({
        id: "user-seed",
        enabled: true,
        type: "user",
        committedAt: Date.now(),
        content: [{ type: "text", content: "write effect.txt please" }],
    });
    agent.run();
    await awaitLanded(agent, { timeout: 10_000 });

    assert.equal(calls, 2, "model contract violated: expected exactly two provider calls");

    // REAL EFFECT on disk.
    const effectPath = join(dir, "effect.txt");
    assert.ok(
        await waitUntilSilent(() => existsSync(effectPath), 5_000),
        "effect.txt never landed",
    );

    // AGENTS.md really loaded into context (the loader read the REAL file).
    const dump = JSON.stringify(agent.messages);
    assert.ok(dump.includes(AGENTS_MARKER), "AGENTS.md marker never entered the context");

    // Crash-resume promise, in-process: fresh agent, same tape.
    await waitUntilSilent(() => existsSync(join(dir, "sessions", "main", "state.json")), 5_000);
    const fresh = new Agent({ model: new StubModel([]), agentId: "restored-e2e" });
    const restored = await session.restoreInto(fresh as unknown as GodObject);
    assert.equal(restored, true, "restoreInto lied — nothing came back");
    const restoredDump = JSON.stringify(fresh.messages);
    assert.ok(restoredDump.includes("FULLSTACK WAS HERE"), "toolCall record lost in restore");
    assert.ok(restoredDump.includes("effect written"), "assistant reply lost in restore");
});

/** Bounded existence probe — sleeps between checks, never spins hot. */
async function waitUntilSilent(cond: () => boolean, timeoutMs: number): Promise<boolean> {
    try {
        await waitUntil(cond, { timeout: timeoutMs, step: 50 });
        return true;
    } catch {
        return false;
    }
}
