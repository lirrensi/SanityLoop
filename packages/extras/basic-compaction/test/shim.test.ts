// packages/extras/basic-compaction/test/shim.test.ts — thin shim suite (method:"soft").
import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "@sanityloop/core";
import type { Message } from "@sanityloop/core";
import { requestCompactInput } from "@sanityloop/util";
import { StubModel, assistantTurn, withDriver } from "@sanityloop/test-kit/core";
import { awaitLanded, waitUntil } from "@sanityloop/test-kit";
import { compaction, createCompaction } from "@sanityloop/basic-compaction";

const text = (id: string, type: Message["type"], content: string): Message =>
    ({ id, enabled: true, type, content: [{ type: "text", content }] }) as Message;

function summaryOf(agent: Agent): string | undefined {
    const s = agent.state.compaction;
    if (s && typeof s === "object" && "summary" in s && typeof s.summary === "string") return s.summary;
    return undefined;
}

const ids = (agent: Agent): string[] => agent.filters.map((f) => f.id);

function seed(agent: Agent, n: number): void {
    for (let i = 0; i < n; i++) {
        agent.messages.push(text(`u${i}`, "user", `question ${i}`));
        agent.messages.push(text(`a${i}`, "assistant", `answer ${i}`));
    }
}

test("shim/soft: install adds watcher+on-demand+trigger+cleanup, NO catcher, soft capability", () => {
    const agent = new Agent({ model: new StubModel([]), agentId: "shim-soft-install" });
    agent.use(createCompaction({}));
    const got = ids(agent);
    for (const id of ["compaction/watcher", "compaction/on-demand", "compaction/trigger", "compaction/cleanup"]) {
        assert.ok(got.includes(id), `${id} installed`);
    }
    assert.ok(!got.includes("compaction/catcher"), "soft shim installs NO catcher (fails if method flipped to handoff)");
    assert.ok(agent.listDeclaredCapabilities().some((c) => c.id === "compaction:soft"), "capability compaction:soft");
    return agent.terminate();
});
test("shim/soft: defaults ({} install) compact on demand and write the compaction state key", async () => {
    assert.doesNotThrow(() => createCompaction({}), "{} install must not throw");
    const model = new StubModel([() => assistantTurn("still here")]);
    const agent = new Agent({ model, agentId: "shim-soft-default" });
    agent.use(createCompaction({ summarize: async () => "SHIM SUMMARY" }));
    seed(agent, 6);
    await withDriver(agent, async () => {
        agent.input({ type: requestCompactInput, reason: "test" });
        await waitUntil(() => summaryOf(agent) === "SHIM SUMMARY", {
            what: "soft shim on-demand compaction",
            timeoutMs: 10000,
        });
        await awaitLanded(agent);
    });
    assert.equal(summaryOf(agent), "SHIM SUMMARY");
    assert.ok(agent.messages.some((m) => m.id.startsWith("summary-soft-")), "soft summary message present");
    assert.ok(!("handover" in agent.state), "handover key untouched");
    await agent.terminate();
});

test("shim/soft: uninstall sweeps compaction/ filters + capability", async () => {
    const agent = new Agent({ model: new StubModel([]), agentId: "shim-soft-clean" });
    agent.use(createCompaction({}));
    assert.ok(ids(agent).some((id) => id.startsWith("compaction/")), "filters installed");
    agent.uninstall("compaction");
    assert.equal(agent.filters.filter((f) => f.id.startsWith("compaction/")).length, 0, "uninstall removes every compaction filter");
    assert.ok(!agent.listDeclaredCapabilities().some((c) => c.id === "compaction:soft"), "capability removed");
    await agent.terminate();
});

test("shim/soft: `compaction` const installs with soft defaults (no catcher, soft capability)", async () => {
    const agent = new Agent({ model: new StubModel([]), agentId: "shim-soft-const" });
    agent.use(compaction);
    const got = ids(agent);
    assert.ok(got.includes("compaction/watcher"), "watcher installed");
    assert.ok(!got.includes("compaction/catcher"), "const installs NO catcher (fails if method flipped)");
    assert.ok(agent.listDeclaredCapabilities().some((c) => c.id === "compaction:soft"), "capability compaction:soft");
    await agent.terminate();
});
