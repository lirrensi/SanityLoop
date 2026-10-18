// packages/extras/pi-model/test/pi-adapter.test.ts — the cross-provider seam.
// Pure mapping only: toPiParts + prepareMessages. No network, no pi-ai import
// (the SDK loads lazily inside callApi — these tests never touch it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PiAdapterModel, toPiParts } from "@sanityloop/pi-model";
import type { Message } from "@sanityloop/core";

const text = (id: string, type: Message["type"], content: string): Message =>
    ({ id, enabled: true, type, content: [{ type: "text", content }] }) as Message;
const model = () => new PiAdapterModel({ provider: "openai", modelId: "test-model" });

// ---------------------------------------------------------------------------
// toPiParts — ContentBlock → pi-ai parts
// ---------------------------------------------------------------------------

test("toPiParts: text stays text; strings wrap; empties stay honest", () => {
    assert.deepEqual(toPiParts("hello"), [{ type: "text", text: "hello" }]);
    assert.deepEqual(toPiParts(""), [{ type: "text", text: "" }]);
    assert.deepEqual(toPiParts(undefined), [{ type: "text", text: "" }]);
    assert.deepEqual(toPiParts([{ type: "text", content: "a" }, { type: "text", content: "b" }]), [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
    ]);
    assert.deepEqual(toPiParts([null, 42, "x"]), [{ type: "text", text: "" }], "garbage → honest empty");
});

test("toPiParts: typeless compound fragments are text (never dropped)", () => {
    // same rule as core's toBlockList — the media commit dropped these here too
    assert.deepEqual(toPiParts([{ id: "f", content: "frag-text" }]), [{ type: "text", text: "frag-text" }]);
    assert.deepEqual(
        toPiParts([{ id: "a", content: "alpha" }, { type: "text", content: "beta" }]),
        [{ type: "text", text: "alpha" }, { type: "text", text: "beta" }],
    );
});

test("toPiParts: image passes through; audio/video/document become descriptors; custom verbatim", () => {
    const parts = toPiParts([
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "audio", data: "ZZ", mimeType: "audio/wav" },
        { type: "video", data: "VV", mimeType: "video/mp4" },
        { type: "document", data: "DD", mimeType: "application/pdf", name: "d.pdf" },
        { type: "video_url", video_url: { url: "http://x/v.mp4" } },
    ]);
    assert.deepEqual(parts[0], { type: "image", data: "aGVsbG8=", mimeType: "image/png" });
    assert.equal(parts[1].type, "text");
    assert.match(parts[1].text!, /audio omitted/);
    assert.match(parts[2].text!, /video omitted/);
    assert.match(parts[3].text!, /document omitted/);
    assert.deepEqual(parts[4], { type: "video_url", video_url: { url: "http://x/v.mp4" } }, "wire-ready passes verbatim");
    // malformed image (no data) drops — never a half-part
    assert.deepEqual(toPiParts([{ type: "image", mimeType: "image/png" }]), [{ type: "text", text: "" }]);
});

// ---------------------------------------------------------------------------
// prepareMessages — the pi-ai Context seam
// ---------------------------------------------------------------------------

test("prepareMessages: systems join to systemPrompt; disabled drop", () => {
    const ctx = model().prepareMessages([
        text("s1", "system", "rules one"),
        text("s2", "system", "rules two"),
        { ...text("off", "user", "hidden"), enabled: false },
        text("u", "user", "go"),
    ]);
    assert.equal(ctx.systemPrompt, "rules one\n\nrules two");
    assert.equal(ctx.messages.length, 1);
    assert.equal((ctx.messages[0] as { role: string }).role, "user");
});

test("prepareMessages: no systems → undefined prompt (not empty string)", () => {
    const ctx = model().prepareMessages([text("u", "user", "go")]);
    assert.equal(ctx.systemPrompt, undefined);
});

test("prepareMessages: user content rides as pi parts (media-aware)", () => {
    const ctx = model().prepareMessages([
        {
            id: "u",
            enabled: true,
            type: "user",
            content: [
                { type: "text", content: "look" },
                { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
            ],
        } as Message,
    ]);
    const msg = ctx.messages[0] as { role: string; content: Array<{ type: string }> };
    assert.equal(msg.role, "user");
    assert.deepEqual(msg.content.map((p) => p.type), ["text", "image"]);
});

test("prepareMessages: assistant shape carries identity + zero usage", () => {
    const ctx = model().prepareMessages([text("a", "assistant", "reply")]);
    const msg = ctx.messages[0] as unknown as Record<string, unknown>;
    assert.equal(msg.role, "assistant");
    assert.deepEqual(msg.content, [{ type: "text", text: "reply" }]);
    assert.equal(msg.provider, "openai");
    assert.equal(msg.model, "test-model");
    assert.equal((msg.usage as { totalTokens: number }).totalTokens, 0);
});

test("prepareMessages: toolCall → assistant with pi ToolCalls; answer text leads", () => {
    const ctx = model().prepareMessages([
        {
            id: "c",
            enabled: true,
            type: "toolCall",
            content: {
                answer: "calling",
                stored: [{ id: "call-1", type: "function", name: "bash", parameters: { cmd: "ls" } }],
            },
        } as unknown as Message,
    ]);
    const msg = ctx.messages[0] as unknown as { role: string; content: Array<Record<string, unknown>>; stopReason: string };
    assert.equal(msg.role, "assistant");
    assert.equal(msg.stopReason, "toolUse");
    assert.deepEqual(msg.content[0], { type: "text", text: "calling" });
    assert.deepEqual(msg.content[1], { type: "toolCall", id: "call-1", name: "bash", arguments: { cmd: "ls" } });
});

test("prepareMessages: toolResult rides answer (string or blocks); isError honest", () => {
    const mk = (content: unknown, extra: Record<string, unknown> = {}): Message =>
        ({ id: "r", enabled: true, type: "toolResult", content, toolCallId: "call-1", toolName: "shot", ...extra }) as Message;
    // string answer → one text part
    const str = model().prepareMessages([mk({ answer: "plain", stored: {} })]);
    assert.deepEqual((str.messages[0] as unknown as { content: unknown }).content, [{ type: "text", text: "plain" }]);
    // block answer → parts: text stays, image rides, video becomes a descriptor
    const ctx = model().prepareMessages([
        mk({ answer: [{ type: "text", content: "screenshot taken" }, { type: "image", data: "aGk=", mimeType: "image/png" }, { type: "video", data: "v", mimeType: "video/mp4" }], stored: {} }),
    ]);
    const msg = ctx.messages[0] as unknown as { role: string; content: Array<{ type: string; text?: string }>; isError: boolean; toolCallId: string; toolName: string };
    assert.equal(msg.role, "toolResult");
    assert.equal(msg.toolCallId, "call-1");
    assert.equal(msg.toolName, "shot");
    assert.equal(msg.isError, false);
    assert.deepEqual(msg.content.map((p) => p.type), ["text", "image", "text"]);
    assert.match(msg.content[2].text!, /video omitted/);
    // error face + catastrophic null
    const err = model().prepareMessages([mk({ answer: "nope", stored: {}, error: true })]);
    assert.equal((err.messages[0] as unknown as { isError: boolean }).isError, true);
    const dead = model().prepareMessages([mk(null)]);
    const deadMsg = dead.messages[0] as unknown as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(deadMsg.isError, true);
    assert.match(deadMsg.content[0].text, /catastrophically/);
});

test("prepareMessages: constructor wires SimpleModel base (api narrates provider)", () => {
    const m = new PiAdapterModel({ provider: "anthropic", modelId: "claude-x", maxContext: 5000, temperature: 0.3 });
    assert.equal(m.provider, "anthropic");
    assert.equal(m.api, "anthropic");
    assert.equal(m.modelId, "claude-x");
    assert.equal(m.maxContext, 5000);
});

test("parseResponse: shared stopReasons vocabulary — length throws retryable, end_turn lands when configured", () => {
    const m = model() as unknown as { parseResponse(r: unknown): { message: { type: string } } };
    const msg = (stopReason: string, extra: Record<string, unknown> = {}) => ({
        content: [{ type: "text", text: "hi" }],
        stopReason,
        ...extra,
    });
    // length → throws, stamped retryable + truncated (terminal in pi TODAY —
    // no retry loop — but the shape unifies with SimpleModel)
    assert.throws(() => m.parseResponse(msg("length")), /bad reason: length/);
    try {
        m.parseResponse(msg("length"));
        assert.fail("must throw");
    } catch (err) {
        const stamped = err as { reason?: string; truncated?: boolean; retryable?: boolean };
        assert.equal(stamped.reason, "length");
        assert.equal(stamped.truncated, true);
        assert.equal(stamped.retryable, true);
    }
    // error/aborted still throw (provider failures, not stops)
    assert.throws(() => m.parseResponse(msg("error", { errorMessage: "boom" })), /boom/);
    assert.throws(() => m.parseResponse(msg("aborted")), /aborted/);
    // end_turn is unclean by DEFAULT ...
    assert.throws(() => m.parseResponse(msg("end_turn")), /bad reason: end_turn/);
    // ... and lands when the provider vocabulary is configured
    const anthropic = new PiAdapterModel({ provider: "anthropic", modelId: "c" }) as unknown as {
        stopReasons: string[];
        parseResponse(r: unknown): { message: { type: string } };
    };
    anthropic.stopReasons = ["stop", "end_turn"];
    assert.equal(anthropic.parseResponse(msg("end_turn")).message.type, "assistant");
    // tool calls bypass regardless of reason
    const withCall = {
        content: [{ type: "text", text: "" }, { type: "toolCall", id: "c1", name: "x", arguments: {} }],
        stopReason: "length",
    };
    assert.equal(m.parseResponse(withCall).message.type, "toolCall");
});
