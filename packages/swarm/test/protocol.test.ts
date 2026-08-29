// ============================================================================
// protocol.test.ts — pure unit tests for the wire types + parseFrame.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	parseFrame,
	DEFAULT_PORT,
	STREAM_EVENTS,
	LIFECYCLE_EVENTS,
	CONTROL_ACTIONS,
} from "../src/protocol.ts";

test("parseFrame accepts a valid frame", () => {
	const f = parseFrame(JSON.stringify({ op: "list" }));
	assert.equal(f?.op, "list");
});

test("parseFrame rejects non-objects and unparseable text", () => {
	assert.equal(parseFrame("123"), null);
	assert.equal(parseFrame('"hi"'), null);
	assert.equal(parseFrame("not json at all"), null);
});

test("parseFrame rejects missing/empty op", () => {
	assert.equal(parseFrame(JSON.stringify({ foo: 1 })), null);
	assert.equal(parseFrame(JSON.stringify({ op: "" })), null);
});

test("constants are sane", () => {
	assert.equal(DEFAULT_PORT, 5317);
	assert.ok(STREAM_EVENTS.includes("textDelta"));
	assert.ok(LIFECYCLE_EVENTS.includes("agentStart"));
	assert.ok(LIFECYCLE_EVENTS.includes("error"));
	assert.deepEqual([...CONTROL_ACTIONS], ["stop", "abort", "pause", "wake"]);
});
