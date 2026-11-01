import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Tool } from "@sanityloop/core";
import { toShapes } from "../shapes.ts";
import { buildStubs } from "../stubs.ts";
import { buildCatalog, searchCatalog } from "../catalog.ts";
import { formatInvalidToolInput, formatUnknownTool } from "../diagnostics.ts";

function tool(name: string, overrides: Record<string, unknown> = {}) {
    return Tool.define({
        name,
        description: `The ${name} tool. Does ${name} things well.`,
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        execute: async () => ({ answer: "ok" }),
        ...overrides,
    });
}

describe("toShapes", () => {
    it("excludes code + __code internals, keeps disabled, drops hidden via visibleTools", () => {
        const tools = [tool("code"), tool("__code_bridge"), tool("read"), tool("old", { disabled: true })];
        const shapes = toShapes(tools);
        assert.deepEqual(shapes.map((s) => s.name), ["old", "read"]);
        assert.equal(shapes.find((s) => s.name === "old")!.disabled, true);
    });
    it("maps idents deterministically with collision suffixes", () => {
        const shapes = toShapes([tool("a-b"), tool("a_b"), tool("9lives"), tool("__x"), tool("help"), tool("class")]);
        const byName = new Map(shapes.map((s) => [s.name, s.ident]));
        // code-unit sort: "9lives" < "__x" < "a-b" < "a_b" < "class" < "help"
        assert.equal(byName.get("a-b"), "a_b");
        assert.equal(byName.get("a_b"), "a_b_2");
        assert.equal(byName.get("9lives"), "_9lives");
        assert.equal(byName.get("__x"), "");
        assert.equal(byName.get("help"), "help_tool");
        assert.equal(byName.get("class"), "class_");
    });
    it("builds signatures from wire arg names", () => {
        const shapes = toShapes([tool("read")]);
        assert.equal(shapes[0]!.signature, "read(path)");
    });
});

describe("buildStubs", () => {
    it("pins configured tools first, caps at maxStubs, lists overflow", () => {
        const tools = [tool("zebra"), tool("read"), tool("apple")];
        const set = buildStubs(tools, { pinned: ["read"], maxStubs: 2 });
        assert.deepEqual(set.shapes.map((s) => s.name), ["read", "apple"]);
        assert.deepEqual(set.omitted.map((s) => s.name), ["zebra"]);
        assert.match(set.python, /tools\.call\("name"/);
        assert.match(set.python, /zebra/);
    });
    it("python prelude uses OMIT for optionals and wire-name dict literals", () => {
        const set = buildStubs([
            tool("read", {
                inputSchema: {
                    type: "object",
                    properties: { path: { type: "string" }, offset: { type: "integer" } },
                    required: ["path"],
                },
            }),
        ]);
        assert.match(set.python, /def read\(self, path: str, offset: int = OMIT\)/);
        assert.match(set.python, /_call\("read", _args\(\{"path": path, "offset": offset\}\)\)/);
    });
    it("explicit None survives (OMIT only drops the sentinel)", () => {
        const set = buildStubs([tool("read")]);
        assert.match(set.python, /if v is not OMIT/);
    });
    it("non-ident properties become **kwargs with exact keys", () => {
        const set = buildStubs([
            tool("weird", {
                inputSchema: { type: "object", properties: { "foo-bar": { type: "string" } }, required: ["foo-bar"] },
            }),
        ]);
        assert.match(set.python, /\*\*kwargs: Any/);
        assert.match(set.python, /Accepts \(exact keys\): foo-bar/);
        assert.match(set.python, /"foo-bar": kwargs\.get\("foo-bar", OMIT\)/);
    });
    it("fingerprint is order-stable and change-sensitive", () => {
        const a = [tool("b"), tool("a")];
        const b = [tool("a"), tool("b")];
        assert.equal(buildStubs(a).fingerprint, buildStubs(b).fingerprint);
        assert.equal(buildStubs(a).python, buildStubs(b).python);
        const changed = [tool("b"), tool("a", { description: "different" })];
        assert.notEqual(buildStubs(a).fingerprint, buildStubs(changed).fingerprint);
    });
    it("typescript dts is self-contained", () => {
        const set = buildStubs([tool("read")]);
        assert.match(set.typescript, /interface ReadArgs/);
        assert.match(set.typescript, /read\(args: ReadArgs\): Promise<ToolCallResult>/);
        assert.match(set.typescript, /declare const tools: CellTools/);
    });
});

describe("buildCatalog", () => {
    it("fits the 2k budget and covers every tool at least T0", () => {
        const tools = Array.from({ length: 100 }, (_, i) => tool(`tool_${String(i).padStart(3, "0")}`, {
            description: "x".repeat(2000),
        }));
        const catalog = buildCatalog(tools);
        assert.ok(catalog.estTokens <= 2000, `est ${catalog.estTokens}`);
        for (const e of catalog.entries) assert.ok(e.rendered >= 0, e.name);
    });
    it("pins at best tier without starving the tail", () => {
        const tools = [tool("a"), tool("b"), tool("read")];
        const catalog = buildCatalog(tools, { pinned: ["read"] });
        assert.equal(catalog.byName.get("read")!.rendered, 2);
    });
    it("never upgrades to T2 before all T0 (fairness)", () => {
        const tools = Array.from({ length: 30 }, (_, i) => tool(`t${i}`));
        const catalog = buildCatalog(tools, { budgetTokens: 100 });
        const tiers = catalog.entries.map((e) => e.rendered);
        if (tiers.includes(2)) assert.ok(!tiers.includes(-1), "T2 exists while a tool is omitted");
    });
    it("degenerate budgets don't throw", () => {
        const catalog = buildCatalog([tool("a")], { budgetTokens: 1 });
        assert.ok(catalog.text.length > 0);
    });
});

describe("searchCatalog", () => {
    it("ranks exact > prefix > substring > summary", () => {
        const tools = [tool("read_file"), tool("read"), tool("bread")];
        const catalog = buildCatalog(tools);
        const hits = searchCatalog(catalog, "read");
        assert.deepEqual(hits.map((h) => h.name), ["read", "read_file", "bread"]);
    });
    it("empty query lists pinned first", () => {
        const catalog = buildCatalog([tool("z"), tool("read")], { pinned: ["read"] });
        assert.equal(searchCatalog(catalog, "")[0]!.name, "read");
    });
    it("finds omitted tools", () => {
        const tools = Array.from({ length: 50 }, (_, i) => tool(`zztool${i}`));
        const catalog = buildCatalog([...tools, tool("needle")], { budgetTokens: 50 });
        assert.ok(searchCatalog(catalog, "needle").some((h) => h.name === "needle"));
    });
});

describe("diagnostics", () => {
    it("enriches unknown-key errors with did-you-mean", () => {
        const [shape] = toShapes([tool("read")]);
        const out = formatInvalidToolInput("read", "read(path)", 'Invalid arguments for read: unknown property "pah"', ['unknown property "pah"'], shape);
        assert.match(out, /did you mean "path"\? accepted: path\./);
    });
    it("passes host errors verbatim with the signature line", () => {
        const [shape] = toShapes([tool("read")]);
        const out = formatInvalidToolInput("read", "read(path)", 'Invalid arguments for read: missing required property "path"', ['missing required property "path"'], shape);
        assert.ok(out.startsWith('Invalid arguments for read: missing required property "path"\nSignature: read(path)\nHint: required: path.'));
    });
    it("caps at 1200 chars keeping host answer + signature", () => {
        const out = formatInvalidToolInput("t", "t()", `Invalid arguments for t: ${"x".repeat(2000)}`, [], undefined);
        assert.ok(out.length <= 1200);
        assert.match(out, /^Invalid arguments for t: x+/);
    });
    it("unknown tool suggests + points at search", () => {
        assert.equal(formatUnknownTool("reed", "read"), 'Unknown tool: reed\nSignature: (no such tool)\nHint: did you mean "read"? use tools.search("reed") to browse.');
    });
});
