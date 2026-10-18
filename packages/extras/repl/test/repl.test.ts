// ============================================================================
// test/repl.test.ts — pipe-mode REPL + markdown colors, without a TTY.
// ============================================================================
// What e2e repl-tmux owns (TUI render, key routing) is NOT covered here. This
// suite pins: pure markdown rendering (ANSI markers, stripped text, widths,
// empty input), plugin lifecycle (capability declare/sweep, safe no-op
// uninstall), and the non-TTY fallback (pipe-mode banner, stream routing).
//
// NOTE: installReadline creates a real readline on process.stdin and
// uninstall() never closes it (data listener + pending question leak —
// verified: data-listener count stays elevated after uninstall). Every install
// here is paired with sweepReadlineLeak, which drops exactly the listeners
// install added. Flagged upstream — delete the sweep if uninstall learns to
// close the interface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, EVENTS } from "@sanityloop/core";
import { StubModel } from "@sanityloop/test-kit/core";
import { createReplPlugin } from "@sanityloop/repl";
import { formatMarkdown, stripAnsi, visibleWidth } from "../colors.ts";

function captureStdout(chunks: string[]): () => void {
	const orig = process.stdout.write;
	process.stdout.write = ((chunk: unknown): boolean => {
		chunks.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	return () => {
		process.stdout.write = orig;
	};
}

function replIds(agent: Agent): string[] {
	return agent.filters.filter((f) => f.id.startsWith("repl/")).map((f) => f.id);
}

function sweepReadlineLeak(baseline: Function[]): void {
	for (const listener of process.stdin.listeners("data")) {
		if (!baseline.includes(listener)) process.stdin.removeListener("data", listener);
	}
	if (process.stdin.listeners("data").length === 0) process.stdin.pause();
}

/** Install in pipe mode (muted), run fn, then uninstall + sweep the leaked readline. */
async function withPipeRepl(
	opts: Parameters<typeof createReplPlugin>[0],
	fn: (agent: Agent, chunks: string[]) => Promise<void>,
): Promise<void> {
	const agent = new Agent({ model: new StubModel([]), agentId: "repl-test" });
	const chunks: string[] = [];
	const restore = captureStdout(chunks);
	const baseline = [...process.stdin.listeners("data")];
	try {
		await agent.install(createReplPlugin(opts));
		await fn(agent, chunks);
	} finally {
		restore();
		agent.uninstall("repl");
		sweepReadlineLeak(baseline);
	}
}

// ---------------------------------------------------------------------------
// colors/markdown pure
// ---------------------------------------------------------------------------

test("heading keeps the # marker wrapped in ANSI; stripped text matches", () => {
	const out = formatMarkdown("# Hello");
	assert.ok(out.includes("\x1b["), "heading must carry ANSI styling");
	assert.ok(out.includes("#"), "heading marker must survive");
	assert.equal(stripAnsi(out), "\n# Hello");
});

test("bold and codespan keep ANSI; stripped text matches", () => {
	const bold = formatMarkdown("**bold**");
	assert.ok(bold.includes("\x1b[1m"), "bold must carry the bold code");
	assert.equal(stripAnsi(bold), "bold");
	const code = formatMarkdown("`x`");
	assert.ok(code.includes("\x1b["), "codespan must carry ANSI");
	assert.equal(stripAnsi(code), "x");
});

test("code blocks and lists keep markers with ANSI; stripped text matches", () => {
	const block = formatMarkdown("```\ncode block\n```");
	assert.ok(block.includes("\x1b["), "code block must carry ANSI");
	assert.ok(stripAnsi(block).includes("code block"), "code content must survive");
	const list = formatMarkdown("- a\n- b");
	assert.ok(list.includes("\x1b["), "list markers must carry ANSI");
	assert.equal(stripAnsi(list), "• a\n• b");
	const ordered = formatMarkdown("1. x\n2. y");
	assert.equal(stripAnsi(ordered), "1. x\n2. y");
});

test("links keep text + href with ANSI; images collapse with ANSI", () => {
	const link = formatMarkdown("[text](http://x)");
	assert.ok(link.includes("\x1b["), "link must carry ANSI");
	assert.equal(stripAnsi(link), "text (http://x)");
	const image = formatMarkdown("![alt](img.png)");
	assert.ok(image.includes("\x1b["), "image collapse must carry ANSI");
	assert.equal(stripAnsi(image), "[image: alt]");
});

test("visibleWidth ignores ANSI styling", () => {
	const styled = formatMarkdown("# Hi **b**");
	assert.equal(visibleWidth(styled), stripAnsi(styled).length);
	assert.equal(visibleWidth(styled), visibleWidth(stripAnsi(styled)));
	assert.equal(visibleWidth(""), 0);
	assert.equal(visibleWidth("plain"), 5);
});

test("empty and whitespace input render to empty; plain text passes through", () => {
	assert.equal(formatMarkdown(""), "");
	assert.equal(formatMarkdown("   "), "");
	assert.equal(formatMarkdown("plain"), "plain");
});

// ---------------------------------------------------------------------------
// plugin lifecycle (pipe mode — tests never have a TTY)
// ---------------------------------------------------------------------------

test("install in pipe mode declares the repl capability and stream filters", async () => {
	await withPipeRepl({ prompt: "t> " }, async (agent) => {
		const cap = agent.getDeclaredCapability("repl");
		assert.ok(cap, "repl capability must be declared");
		assert.match(cap.description, /readline/);
		const ids = replIds(agent);
		for (const id of ["repl/input-feedback", "repl/stream", "repl/newline", "repl/session"]) {
			assert.ok(ids.includes(id), `${id} must be installed`);
		}
		assert.ok(process.stdin.listeners("data").length > 0, "pipe mode must hold stdin via readline");
	});
});

test("uninstall removes repl/ filters and the capability, keeping foreign filters", async () => {
	await withPipeRepl({}, async (agent) => {
		agent.addFilter({ event: EVENTS.agentStart, id: "canary/keep", priority: 0, fn: async () => {} });
		assert.equal(agent.uninstall("repl"), true);
		assert.deepEqual(replIds(agent), []);
		assert.equal(agent.getDeclaredCapability("repl"), undefined);
		assert.ok(agent.filters.some((f) => f.id === "canary/keep"), "foreign filters must survive");
	});
});

test("uninstall without install is a safe no-op", () => {
	const agent = new Agent({ model: new StubModel([]), agentId: "repl-test" });
	assert.doesNotThrow(() => createReplPlugin().uninstall(agent));
	assert.deepEqual(replIds(agent), []);
	assert.equal(agent.getDeclaredCapability("repl"), undefined);
});

// ---------------------------------------------------------------------------
// non-TTY fallback
// ---------------------------------------------------------------------------

test("pipe-mode install writes the banner and prompt to stdout", async () => {
	await withPipeRepl({ prompt: "t> " }, async (_agent, chunks) => {
		const plain = stripAnsi(chunks.join(""));
		assert.ok(plain.includes("sanityloop"), "banner must name sanityloop");
		assert.ok(plain.includes("repl (pipe mode)"), "banner must say pipe mode");
		assert.ok(plain.includes("t> "), "banner must honor the prompt option");
	});
});

test("stream filters write textDelta verbatim, skip thinkingDelta, end with newline", async () => {
	await withPipeRepl({}, async (agent, chunks) => {
		chunks.length = 0; // drop the banner + prompt
		await agent.bus.runFromRegistry(EVENTS.textDelta, {
			streamDelta: { type: "textDelta", delta: "hello " },
		});
		await agent.bus.runFromRegistry(EVENTS.textDelta, {
			streamDelta: { type: "textDelta", delta: "world" },
		});
		await agent.bus.runFromRegistry(EVENTS.thinkingDelta, {
			streamDelta: { type: "thinkingDelta", delta: "hmm" },
		});
		await agent.bus.runFromRegistry(EVENTS.textEnd, {});
		assert.deepEqual(chunks, ["hello ", "world", "\n"]);
	});
});
