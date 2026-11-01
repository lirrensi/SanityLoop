import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isProtocolError, parseFrame } from "../protocol.ts";

describe("parseFrame", () => {
    it("parses every frame tag", () => {
        for (const t of ["status", "stdout", "stderr", "result", "tool-call", "done"]) {
            const f = parseFrame(JSON.stringify({ t, id: "c1" }));
            assert.equal(isProtocolError(f), false);
        }
    });
    it("rejects non-JSON", () => {
        const f = parseFrame("not json {");
        assert.equal(isProtocolError(f), true);
    });
    it("rejects non-objects", () => {
        assert.equal(isProtocolError(parseFrame("42")), true);
        assert.equal(isProtocolError(parseFrame("[1]")), true);
    });
    it("rejects unknown tags (protocol error, never silent drop)", () => {
        const f = parseFrame(JSON.stringify({ t: "view", id: "c1" }));
        assert.equal(isProtocolError(f), true);
        if (isProtocolError(f)) assert.match(f.protocolError, /unknown frame tag/);
    });
    it("rejects missing tags", () => {
        assert.equal(isProtocolError(parseFrame(JSON.stringify({ id: "c1" }))), true);
    });
});
