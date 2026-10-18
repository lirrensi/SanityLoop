// packages/extras/compact-handover/test/shim.test.ts — thin shim suite (method:"handoff").
import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "@sanityloop/core";
import type { Message } from "@sanityloop/core";
import { requestCompactInput } from "@sanityloop/util";
import { StubModel, assistantTurn, withDriver } from "@sanityloop/test-kit/core";
import { awaitLanded, waitUntil } from "@sanityloop/test-kit";
import { createCompactHandover } from "@sanityloop/compact-handover";

const text = (id: string, type: Message["type"], content: string): Message =>
    ({ id, enabled: true, type, content: [{ type: "text", content }] }) as Message;

const ids = (agent: Agent): string[] => agent.filters.map((f) => f.id);

function handoverOf(agent: Agent): string | undefined {
    const s = agent.state.handover;
    if (s && typeof s === "object" && "method" in s && typeof s.method === "string") return s.method;
    return undefined;
}

function seed(agent: Agent, n: number): void {
    for (let i = 0; i < n; i++) {
        agent.messages.push(text(`u${i}`, "user", `question ${i}`));
        agent.messages.push(text(`a${i}`, "assistant", `answer ${i}`));
    }
}

test("shim/handoff: install adds watcher+on-demand+trigger+cleanup+catcher, handoff capability", () => {
    const agent = new Agent({ model: new StubModel([]), agentId: "shim-handoff-install" });
    agent.use(createCompactHandover({}));
    const got = ids(agent);
    for (const id of ["compaction/watcher", "compaction/on-demand", "compaction/trigger", "compaction/cleanup", "compaction/catcher"]) {
        assert.ok(got.includes(id), `${id} installed`);
    }
    assert.ok(agent.listDeclaredCapabilities().some((c) => c.id === "compaction:handoff"), "capability compaction:handoff");
    return agent.terminate();
});

test("shim/handoff: defaults ({} install) catcher rebuild writes the handover state key", async () => {
    assert.doesNotThrow(() => createCompactHandover({}), "{} install must not throw");
    const model = new StubModel([() => assistantTurn("THEME: shim handover\nQUICK: ok\nWALK: x\nFINAL: done")]);
    const agent = new Agent({ model, agentId: "shim-handoff-default" });
    agent.use(createCompactHandover({}));
    seed(agent, 10);
    const before = agent.messages.length;
    await withDriver(agent, async () => {
        agent.input({ type: requestCompactInput });
        await waitUntil(() => handoverOf(agent) === "handoff", {
            what: "handoff catcher to rebuild",
            timeoutMs: 15000,
        });
        await awaitLanded(agent);
    });
    assert.ok(agent.messages.length < before, `rebuilt: ${before} → ${agent.messages.length}`);
    assert.ok(agent.messages.some((m) => m.id.startsWith("summary-handoff-")), "handover summary present");
    assert.equal(handoverOf(agent), "handoff");
    assert.ok(!("compaction" in agent.state) || agent.state.compaction === undefined, "compaction key untouched");
    await agent.terminate();
});

test("shim/handoff: uninstall sweeps compaction/ filters + capability", async () => {
    const agent = new Agent({ model: new StubModel([]), agentId: "shim-handoff-clean" });
    agent.use(createCompactHandover({}));
    assert.ok(ids(agent).some((id) => id.startsWith("compaction/")), "filters installed");
    agent.uninstall("compaction");
    assert.equal(agent.filters.filter((f) => f.id.startsWith("compaction/")).length, 0, "uninstall removes every compaction filter");
    assert.ok(!agent.listDeclaredCapabilities().some((c) => c.id === "compaction:handoff"), "capability removed");
    await agent.terminate();
});
