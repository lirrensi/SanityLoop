// ============================================================================
// tests/core/registries.test.ts — declared registries + plugin dependency guard.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    Agent,
    EVENTS,
    PluginDependencyError,
} from "@sanityloop/core";
import type { GodObject, Plugin } from "@sanityloop/core";
import { StubModel } from "@sanityloop/test-kit/core";

function newAgent() {
    return new Agent({ model: new StubModel([]), agentId: "registry-test" });
}

// ---------------------------------------------------------------------------
// Declared capabilities
// ---------------------------------------------------------------------------

test("addDeclaredCapability registers into the Map; get/list/remove siblings work", () => {
    const agent = newAgent();
    agent.addDeclaredCapability({ id: "fs", description: "file system access" });
    assert.equal(agent.getDeclaredCapability("fs")?.description, "file system access");
    assert.deepEqual(agent.listDeclaredCapabilities().map((c) => c.id), ["fs"]);
    assert.equal(agent.removeDeclaredCapability("fs"), true);
    assert.equal(agent.getDeclaredCapability("fs"), undefined);
    assert.equal(agent.removeDeclaredCapability("fs"), false, "removing twice is a no-op");
});

test("duplicate capability id throws loudly (add once, delete once)", () => {
    const agent = newAgent();
    agent.addDeclaredCapability({ id: "x", description: "first" });
    assert.throws(
        () => agent.addDeclaredCapability({ id: "x", description: "second" }),
        /already registered/,
    );
});

test("a capability WITHOUT a description is silently ignored (description REQUIRED)", () => {
    const agent = newAgent();
    agent.addDeclaredCapability({ id: "no-desc" } as never);
    assert.deepEqual(agent.listDeclaredCapabilities(), []);
});

// ---------------------------------------------------------------------------
// Declared inputs + events
// ---------------------------------------------------------------------------

test("declared inputs register / duplicate throws", () => {
    const agent = newAgent();
    agent.addDeclaredInput({ id: "my/ask", schema: null });
    assert.ok(agent.getDeclaredInput("my/ask"));
    assert.throws(() => agent.addDeclaredInput({ id: "my/ask", schema: null }), /already registered/);
    assert.equal(agent.removeDeclaredInput("my/ask"), true);
});

test("the 38 built-in events are pre-declared; built-ins refuse deletion; custom events manage freely", () => {
    const agent = newAgent();
    assert.equal(agent.listDeclaredEvents().length, 38);

    // core events cannot be removed
    for (const builtin of Object.values(EVENTS)) {
        assert.equal(agent.removeDeclaredEvent(builtin), false, `${builtin} is protected`);
    }
    // custom ones can
    agent.addDeclaredEvent({ id: "compaction/start" });
    assert.equal(agent.getDeclaredEvent("compaction/start")?.id, "compaction/start");
    assert.throws(() => agent.addDeclaredEvent({ id: "compaction/start" }), /already registered/);
    assert.equal(agent.addDeclaredEvent({ id: "" }), undefined, "empty id silently ignored");
    assert.equal(agent.removeDeclaredEvent("compaction/start"), true);
});

// ---------------------------------------------------------------------------
// Plugins — install/uninstall lifecycle + the dependency guard
// ---------------------------------------------------------------------------

function noopPlugin(id: string, requires?: string[]): Plugin {
    return {
        id,
        ...(requires ? { requires } : {}),
        install() {},
        uninstall() {},
    };
}

test("install tracks plugins; duplicate plugin id throws", () => {
    const agent = newAgent();
    agent.install(noopPlugin("alpha"));
    assert.deepEqual(agent.plugins.map((p) => p.id), ["alpha"]);
    assert.throws(() => agent.install(noopPlugin("alpha")), /already installed/);
});

test("installing a plugin whose `requires` names an UNINSTALLED plugin → PluginDependencyError BEFORE any registration", () => {
    const agent = newAgent();
    let registered = false;
    const greedy: Plugin = {
        id: "greedy",
        requires: ["ghost-plugin"],
        install(a: GodObject) {
            registered = true;
            a.setState("touched", true);
        },
        uninstall() {},
    };
    let thrown: unknown;
    try {
        agent.install(greedy);
    } catch (err) {
        thrown = err;
    }
    assert.ok(thrown instanceof PluginDependencyError, `expected PluginDependencyError, got ${thrown}`);
    const e = thrown as PluginDependencyError;
    assert.equal(e.kind, "missing");
    assert.equal(e.pluginId, "greedy");
    assert.deepEqual(e.related, ["ghost-plugin"]);
    assert.match(e.message, /requires "ghost-plugin".*not installed/s);
    assert.equal(registered, false, "install() never ran");
    assert.deepEqual(agent.plugins.map((p) => p.id), [], "agent untouched by the failed install");
});

test("install order satisfies requires: dep first, dependent second", () => {
    const agent = newAgent();
    agent.install(noopPlugin("base"));
    agent.install(noopPlugin("wants-base", ["base"]));
    assert.deepEqual(agent.plugins.map((p) => p.id).sort(), ["base", "wants-base"]);
});

test("uninstalling a still-required plugin → PluginDependencyError kind 'in-use'", () => {
    const agent = newAgent();
    let uninstalled = false;
    const base: Plugin = { id: "base", install() {}, uninstall() { uninstalled = true; } };
    agent.install(base);
    agent.install(noopPlugin("dependent", ["base"]));

    let thrown: unknown;
    try {
        agent.uninstall("base");
    } catch (err) {
        thrown = err;
    }
    assert.ok(thrown instanceof PluginDependencyError);
    assert.equal((thrown as PluginDependencyError).kind, "in-use");
    assert.deepEqual((thrown as PluginDependencyError).related, ["dependent"]);
    assert.equal(uninstalled, false, "uninstall never ran");

    // remove the dependent first → now base leaves cleanly
    assert.equal(agent.uninstall("dependent"), true);
    assert.equal(agent.uninstall("base"), true);
    assert.equal(uninstalled, true);
    assert.equal(agent.plugins.length, 0);
});

test("uninstall of an unknown id returns false (nothing to remove)", () => {
    const agent = newAgent();
    assert.equal(agent.uninstall("never-was"), false);
});

test("modular InstallSpec: named steps run in insertion order; null steps are skipped", () => {
    const agent = newAgent();
    const ran: string[] = [];
    agent.install({
        id: "modular",
        install: {
            stepOne: (a: GodObject) => void ran.push(`one:${a.agentId}`),
            stepTwo: null, // subclass nulled this step
            stepThree: () => void ran.push("three"),
        },
        uninstall() {},
    });
    assert.deepEqual(ran, [`one:registry-test`, "three"]);
});
