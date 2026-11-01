import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	createA2aClient,
	flattenPart,
	flattenParts,
	buildUserMessage,
	isTaskResult,
	a2aErrorText,
	type A2aClientLike,
	type A2aTask,
} from "../index.ts";

function task(over: Partial<A2aTask> = {}): A2aTask {
	return {
		id: "task-1",
		contextId: "ctx-1",
		status: { state: "COMPLETED", message: { parts: [] } },
		...over,
	};
}

function textPart(value: string) {
	return {
		content: { $case: "text", value },
		metadata: undefined,
		filename: "",
		mediaType: "text/plain",
	};
}

function stubGod() {
	const tools: { name: string; [k: string]: unknown }[] = [];
	const caps: { id: string; description: string }[] = [];
	const state: Record<string, unknown> = {};
	return {
		tools,
		state,
		addTool(t: { name: string }) {
			tools.push(t);
			return this;
		},
		removeTool(name: string) {
			const i = tools.findIndex((t) => t.name === name);
			if (i >= 0) tools.splice(i, 1);
			return i >= 0;
		},
		addDeclaredCapability(c: { id: string; description: string }) {
			caps.push(c);
		},
		removeDeclaredCapability(id: string) {
			const i = caps.findIndex((c) => c.id === id);
			if (i >= 0) caps.splice(i, 1);
			return i >= 0;
		},
		caps,
	};
}

describe("flatten", () => {
	it("text part returns value", () => {
		assert.equal(flattenPart(textPart("hi")), "hi");
	});
	it("data part stringifies", () => {
		assert.equal(
			flattenPart({ content: { $case: "data", value: { a: 1 } } }),
			'{"a":1}',
		);
	});
	it("url part formats as file line", () => {
		assert.equal(
			flattenPart({
				content: { $case: "file", value: "https://x/f.png" },
				mediaType: "image/png",
			}),
			"file: https://x/f.png (image/png)",
		);
	});
	it("raw part formats as binary marker", () => {
		assert.equal(
			flattenPart({
				content: { $case: "bytes", value: "zz" },
				mediaType: "image/png",
				filename: "a.png",
			}),
			"[binary image/png a.png]",
		);
	});
	it("joins parts with newline, empty on missing", () => {
		assert.equal(flattenParts(undefined), "");
		assert.equal(flattenParts([textPart("a"), textPart("b")]), "a\nb");
	});
});

describe("guards and builders", () => {
	it("isTaskResult discriminates on status", () => {
		assert.equal(isTaskResult(task()), true);
		assert.equal(
			isTaskResult({ messageId: "m", role: "user", parts: [] }),
			false,
		);
	});
	it("buildUserMessage echoes ids, fresh messageId", () => {
		const a = buildUserMessage({ prompt: "hi" });
		const b = buildUserMessage({ prompt: "hi" });
		assert.notEqual(a.messageId, b.messageId);
		assert.equal(a.taskId, undefined);
		const c = buildUserMessage({
			prompt: "hi",
			contextTaskId: "t1",
			contextId: "c1",
		});
		assert.equal(c.taskId, "t1");
		assert.equal(c.contextId, "c1");
		assert.equal(c.parts.length, 1);
	});
	it("a2aErrorText maps class + code", () => {
		class TaskNotCancelable extends Error {
			statusCode = 409;
		}
		const t = a2aErrorText(new TaskNotCancelable("nope"));
		assert.match(t, /TaskNotCancelable/);
		assert.match(t, /409/);
		assert.equal(a2aErrorText(new Error("boom")), "Error: boom");
	});
});

describe("adapter", () => {
	it("getPlugin throws before init", () => {
		assert.throws(() => createA2aClient({ agents: {} }).getPlugin());
	});

	it("continuation: send echoes ids and names task/context/state", async () => {
		let seen: Record<string, unknown> | undefined;
		const fake: A2aClientLike = {
			sendMessage: async (params) => {
				seen = params;
				return task({
					id: "task-9",
					contextId: "ctx-9",
					status: {
						state: "COMPLETED",
						message: { parts: [textPart("done")] },
					},
					artifacts: [{ parts: [textPart("art")] }],
				});
			},
			cancelTask: async () => task(),
		};
		const a2a = createA2aClient(
			{ agents: { researcher: { url: "https://remote/agent" } } },
			{
				createClient: async () => ({
					client: fake,
					card: {
						name: "Researcher",
						description: "Researches things",
						url: "https://remote/agent",
						skills: [{ name: "search" }, { name: "summarize" }],
					},
				}),
			},
		);
		await a2a.init();
		const god = stubGod();
		(a2a.getPlugin().install as (g: unknown) => void)(god);
		assert.deepEqual(
			god.tools.map((t) => t.name).sort(),
			["a2a_researcher_cancel", "a2a_researcher_send"],
		);
		const send = a2a.tools.find((t) => t.name === "a2a_researcher_send")!;
		assert.match(send.description, /Researcher/);
		assert.match(send.description, /search/);
		const res = (await send.execute(
			{ prompt: "go", contextTaskId: "task-9", contextId: "ctx-9" },
			god as never,
		)) as { answer: string; stored: Record<string, unknown> };
		const msg = seen!["message"] as Record<string, unknown>;
		assert.equal(msg["taskId"], "task-9");
		assert.equal(msg["contextId"], "ctx-9");
		assert.match(res.answer, /task task-9 \(COMPLETED\) in context ctx-9/);
		assert.match(res.answer, /done/);
		assert.match(res.answer, /art/);
		assert.equal(res.stored["taskId"], "task-9");
		assert.equal(res.stored["taskState"], "COMPLETED");
	});

	it("INPUT_REQUIRED appends the continue hint", async () => {
		const fake: A2aClientLike = {
			sendMessage: async () =>
				task({
					status: {
						state: "INPUT_REQUIRED",
						message: { parts: [textPart("need more")] },
					},
				}),
			cancelTask: async () => task(),
		};
		const a2a = createA2aClient(
			{ agents: { helper: { url: "https://h" } } },
			{ createClient: async () => ({ client: fake }) },
		);
		await a2a.init();
		const send = a2a.tools.find((t) => t.name === "a2a_helper_send")!;
		const res = (await send.execute({ prompt: "hi" }, {} as never)) as {
			answer: string;
		};
		assert.match(res.answer, /Call again with contextTaskId\/contextId/);
	});

	it("degraded agent: send returns error answer, cancel maps failure", async () => {
		const a2a = createA2aClient(
			{ agents: { dead: { url: "https://dead" } } },
			{
				createClient: async () => {
					throw new Error("connection refused");
				},
			},
		);
		await a2a.init(); // must not throw
		assert.equal(a2a.status["dead"]?.status, "failed");
		const send = a2a.tools.find((t) => t.name === "a2a_dead_send")!;
		const res = (await send.execute({ prompt: "hi" }, {} as never)) as {
			answer: string;
			error?: boolean;
		};
		assert.equal(res.error, true);
		assert.match(res.answer, /connection refused/);

		class TaskNotCancelable extends Error {}
		const fake2: A2aClientLike = {
			sendMessage: async () => task(),
			cancelTask: async () => {
				throw new TaskNotCancelable("cannot cancel now");
			},
		};
		const a2a2 = createA2aClient(
			{ agents: { live: { url: "https://live" } } },
			{ createClient: async () => ({ client: fake2 }) },
		);
		await a2a2.init();
		const cancel = a2a2.tools.find((t) => t.name === "a2a_live_cancel")!;
		const cres = (await cancel.execute({ taskId: "t1" }, {} as never)) as {
			answer: string;
			error?: boolean;
		};
		assert.equal(cres.error, true);
		assert.match(cres.answer, /TaskNotCancelable/);
	});

	it("uninstall removes tools, capability, state", async () => {
		const fake: A2aClientLike = {
			sendMessage: async () => task(),
			cancelTask: async () => task(),
		};
		const a2a = createA2aClient(
			{ agents: { r: { url: "https://r" } } },
			{ createClient: async () => ({ client: fake }) },
		);
		await a2a.init();
		const god = stubGod();
		const plugin = a2a.getPlugin();
		(plugin.install as (g: unknown) => void)(god);
		assert.equal(god.tools.length, 2);
		assert.ok("a2a" in god.state);
		(plugin.uninstall as (g: unknown) => void)(god);
		assert.equal(god.tools.length, 0);
		assert.ok(!("a2a" in god.state));
		assert.equal(god.caps.length, 0);
	});
});
