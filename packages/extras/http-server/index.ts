// ============================================================================
// sanity/src/extras/http-server/index.ts — the external channel (REST + SSE + WS)
// ============================================================================
// ONE channel of communication — the same five doors the REPL uses, over HTTP
// AND WebSocket. Elysia gives us both protocols on a single framework with a
// single `.listen()` — zero extra thinking, both wired at once.
//
// The channel is type-blind, like the core: it never interprets an input, an
// await schema, or a change record. It forwards bytes; every behavior lives in the
// filters/plugins that consume the same events the REPL consumes.
//
//   WRITE  POST /input      raw pass-through to agent.input(). THE ONLY write
//                           door. Nothing else, ever.
//   READ   GET /getState    serialized GodObject; ?keys=a,b,state.todos (dotted
//                           paths allowed); no keys = the full document
//          GET /awaits      the parked queue, read-only. Clearing happens ONLY
//                           via a specific input through /input — no second door.
//          GET /questions   pending questions, read-only. Same rule — answering
//                           goes through /input, never a second door.
//          GET /tools       tool schemas (UI builders)
//          GET /capabilities
//          GET /health      ok + loopState (discovery, never gated by apikey)
//   CTL    POST /control    { op: "stop" | "abort" | "pause" | "wake" }
//   STREAM GET /updates     SSE — token stream events (streamStarted, textDelta,
//                           textEnd, thinkingDelta, thinkingEnd, toolcallDelta)
//                           + the universal delta (patched, merged)
//   WS     /ws              THE SAME five doors, message-framed. Client sends
//                           {op:"input"|"control"|"getState"|"awaits"|"questions"|
//                           "tools"|"capabilities"}; server pushes the same stream events
//                           as SSE plus {event:"result",op,data} replies.
//
// Lifecycle: port 0 = random → the real port lands in state.http.port (patched,
// observable) and onPort(). uninstall closes the listener, aborts open streams,
// removes every forwarder filter, and deletes state.http.
//
// RUNTIME: Elysia with the @elysia/node adapter (Node's native http via srvx +
// crossws for WebSocket) — runs under plain `node` exactly like the old Hono
// version, no Bun required. Two adapter quirks handled here: `server.port` stays
// 0 for random ports (real port read from the underlying node server after the
// async bind) and `app.stop()` throws (the server is closed via the listen
// callback's server-info object instead).
// ============================================================================
// heavy elysia values load LAZILY inside install (below) so installing
// @sanityloop/extras never pulls elysia; the type import stays static.
import type { Elysia } from "elysia";
import { EVENTS } from "@sanityloop/core";
import type { EventPayload, GodObject, Plugin } from "@sanityloop/core";
import { agentSnapshot } from "@sanityloop/snapshot";

export interface HttpServerOptions {
	/** Bind address. Default "127.0.0.1" — "localhost" can resolve to ::1 (IPv6-only)
	 * and reject 127.0.0.1 clients. Pass "localhost" explicitly if you want that. */
	addr?: string;
	/** Port; 0 = random (the real port lands in state.http.port + onPort). */
	port?: number;
	/** If set, gates every route except /health (Bearer or x-api-key). */
	apikey?: string;
	/** Called with the actual port once bound. */
	onPort?: (port: number) => void;
}

/** Payload cap for /input — the door stays small. */
const MAX_INPUT_BYTES = 1024 * 1024;

/** The token stream events the SSE/WS channels forward. */
const STREAM_EVENTS = [
	"streamStarted",
	"textDelta",
	"textEnd",
	"thinkingDelta",
	"thinkingEnd",
	"toolcallDelta",
] as const;
/** The universal-delta events — state/message commits at the seams. */
const DELTA_EVENTS = ["patched", "merged"] as const;

/** The full readable GodObject document — ?keys picks from this. */
function stateDoc(agent: GodObject): Record<string, unknown> {
	return {
		description: agent.description || undefined,
		activity: agent.activity,
		state: agent.state,
		transient: agent.transient,
		messages: agent.messages,
		snapshot: agentSnapshot(agent),
		capabilities: agent.listDeclaredCapabilities(),
		plugins: agent.plugins.map((p) => p.id),
		pendingAwaits: agent.pendingAwaits,
		pendingQuestions: agent.pendingQuestions,
		pendingInputs: agent.pendingInputs,
		tools: agent.tools.map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema,
		})),
		loopState: agent.loopState,
		runState: agent.runState,
		inTurn: agent.inTurn,
		hasWork: agent.hasWork,
		inFlight: agent.inFlight,
		ticks: agent.ticks,
		tickPlan: agent.tickPlan,
		model: {
			api: agent.model.api,
			modelId: agent.model.modelId,
			stream: agent.model.stream,
		},
	};
}

/** Dotted keys walk in ("state.todos"); missing → null (keeps JSON clean). */
function pick(
	doc: Record<string, unknown>,
	keys: string[],
): Record<string, unknown> {
	if (keys.length === 0) return doc;
	const out: Record<string, unknown> = {};
	for (const key of keys) {
		let v: unknown = doc;
		for (const part of key.split(".")) {
			if (v == null || typeof v !== "object") {
				v = undefined;
				break;
			}
			v = (v as Record<string, unknown>)[part];
		}
		out[key] = v === undefined ? null : v;
	}
	return out;
}

/** Parse a comma-separated ?keys list (also accepts repeated ?keys= params). */
function parseKeys(queries: Record<string, unknown>, raw: string): string[] {
	const multi = Array.isArray(queries.keys)
		? (queries.keys as string[])
		: typeof queries.keys === "string"
			? [queries.keys as string]
			: [];
	const flat = multi
		.flatMap((v) => v.split(","))
		.concat(raw.split(","))
		.map((s) => s.trim())
		.filter(Boolean);
	return [...new Set(flat)];
}

/** Read + size-check a request body (the write door stays small). */
async function readInputBody(request: Request): Promise<
	{ ok: true; body: unknown } | { ok: false; status: number; error: string }
> {
	// fast reject on an oversized declared content-length
	const declared = Number(request.headers.get("content-length") ?? 0);
	if (declared > MAX_INPUT_BYTES) {
		return { ok: false, status: 413, error: "payload too large" };
	}
	const raw = await request.text();
	if (Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES) {
		return { ok: false, status: 413, error: "payload too large" };
	}
	let body: unknown = null;
	try {
		body = JSON.parse(raw);
	} catch {
		body = null;
	}
	if (!body || typeof (body as { type?: unknown }).type !== "string") {
		return { ok: false, status: 400, error: "input requires a string `type`" };
	}
	return { ok: true, body };
}

/** One connection's shared stream-forwarding logic (SSE + WS). Returns cleanup. */
function wireStreamForwarders(
	agent: GodObject,
	connSeq: number,
	kind: "sse" | "ws",
	emit: (event: string, payload: Record<string, unknown>) => void,
): () => void {
	const forwarders: { event: string; id: string }[] = [];
	const wire = (event: string, name: string) => {
		const id = `http/${kind}/${connSeq}/${name}`;
		agent.addFilter({
			event: name as never,
			id,
			priority: -100,
			fn: (async (agent: unknown, payload: EventPayload | undefined) => {
				if (event === "patched")
					emit(event, { event, change: payload?.change });
				else if (event === "merged") emit(event, { event });
				else emit(event, { event, delta: payload?.streamDelta });
			}) as never,
		});
		forwarders.push({ event: name, id });
	};
	for (const name of STREAM_EVENTS) wire(name, EVENTS[name]);
	for (const name of DELTA_EVENTS) wire(name, EVENTS[name]);
	return () => {
		for (const f of forwarders) agent.removeFilter(f.event, f.id);
	};
}

/** The five doors, shared by REST + WS. Bound to the live GodObject. */
function makeDoor(agent: GodObject) {
	return {
		write(body: unknown) {
			agent.input(body as never);
		},
		readState(keys: string[]) {
			return pick(stateDoc(agent), keys);
		},
		awaits() {
			return agent.pendingAwaits;
		},
		questions() {
			return agent.pendingQuestions;
		},
		tools() {
			return agent.tools.map((t) => ({
				name: t.name,
				description: t.description,
				inputSchema: t.inputSchema,
			}));
		},
		capabilities() {
			return agent.listDeclaredCapabilities();
		},
		health() {
			return {
				ok: true,
				pid: process.pid,
				loopState: agent.loopState,
				runState: agent.runState,
				time: Date.now(),
			};
		},
		control(op: string) {
			switch (op) {
				case "stop":
					agent.stop();
					return { ok: true, op };
				case "abort":
					agent.abort("http/control");
					return { ok: true, op };
				case "pause":
					agent.pause();
					return { ok: true, op };
				case "wake":
					agent.wake();
					return { ok: true, op };
				default:
					return null;
			}
		},
	};
}

/**
 * The http-server channel plugin — Elysia (REST + SSE + WebSocket) on one server.
 */
export function createHttpServer(opts: HttpServerOptions = {}): Plugin {
	const { addr = "127.0.0.1", port = 0, apikey, onPort } = opts;

	// Teardown state lives at the plugin-instance level (uninstall is a
	// separate method — it can't see install's locals).
	let app: Elysia | undefined;
	// The Elysia server-info from the listen callback. With the @elysia/node
	// adapter, `app.server` stays null (so app.stop() throws "isn't running")
	// and `server.port` stays 0 for random ports — the REAL port and the way to
	// stop both live on this object (server.raw.node.server + server.stop()).
	let serverInfo: {
		port: number;
		stop(close?: boolean): Promise<unknown> | void;
		raw?: { node?: { server?: { address(): { port: number } | null } } };
	} | undefined;
	let actualPort = port;
	let connSeq = 0;
	const cleanup = new Set<() => void>();

	return {
		id: "http",

		install(agent) {
			// lazy-optional: elysia loads ONLY when the server is actually installed.
			// @sanityloop/extras ships zero deps; this subpath declares its need.
			const bootstrap = async (): Promise<void> => {
				try {
					const sdk = await import("elysia");
					const nodeAdapter = await import("@elysia/node");
					app = new sdk.Elysia({ adapter: nodeAdapter.node() });
				} catch (err) {
					throw new Error(
						'[sanity] http-server: could not start — this subpath needs "elysia" + "@elysia/node" (not installed?). Run: npm i elysia @elysia/node',
						{ cause: err },
					);
				}
			const door = makeDoor(agent);

			// ---- auth: apikey gates everything except /health (discovery) ----
			app.onBeforeHandle(({ path, request, set }) => {
				if (!apikey || path === "/health") return;
				const h =
					request.headers.get("authorization") ??
					request.headers.get("x-api-key") ??
					"";
				const key = h.startsWith("Bearer ") ? h.slice(7) : h;
				if (key !== apikey) {
					set.status = 401;
					return { error: "unauthorized" };
				}
			});

			// ---- THE ONLY WRITE DOOR: raw pass-through, nothing else ----
			app.post("/input", async ({ request }) => {
				const read = await readInputBody(request);
				if (!read.ok) return new Response(JSON.stringify({ error: read.error }), {
					status: read.status,
					headers: { "content-type": "application/json" },
				});
				door.write(read.body);
				return { ok: true, type: (read.body as { type: string }).type };
			});

			// ---- reads ----
			app.get("/getState", ({ query }) =>
				pick(stateDoc(agent), parseKeys(query, (query.keys as string) ?? "")),
			);
			app.get("/awaits", () => door.awaits());
			app.get("/questions", () => door.questions());
			app.get("/tools", () => door.tools());
			app.get("/capabilities", () => door.capabilities());
			app.get("/health", () => door.health());

			// ---- control ----
			app.post("/control", async ({ request }) => {
				const { op } = (await request.json().catch(() => ({}))) as {
					op?: string;
				};
				const result = op ? door.control(op) : null;
				if (!result)
					return new Response(
						JSON.stringify({ error: `unknown op: ${op ?? ""}` }),
						{ status: 400, headers: { "content-type": "application/json" } },
					);
				return result;
			});

			// ---- stream: SSE over the token stream + the universal delta ----
			app.get("/updates", ({ set }) => {
				connSeq++;
				const me = connSeq;
				set.headers["content-type"] = "text/event-stream";
				set.headers["cache-control"] = "no-cache";
				set.headers["connection"] = "keep-alive";

				let controller: ReadableStreamDefaultController<Uint8Array> | null =
					null;
				let chain: Promise<void> = Promise.resolve();
				const enqueue = (event: string, payload: unknown) => {
					chain = chain
						.then(() => {
							const frame = `event: ${event}\ndata: ${JSON.stringify(
								payload,
							)}\n\n`;
							controller?.enqueue(new TextEncoder().encode(frame));
						})
						.catch(() => {});
				};

				const remove = wireStreamForwarders(agent, me, "sse", enqueue);
				cleanup.add(remove);
				enqueue("ready", { port: actualPort || null });

				return new ReadableStream<Uint8Array>({
					start(c) {
						controller = c;
					},
					cancel() {
						cleanup.delete(remove);
						remove();
						controller = null;
					},
				});
			});

			// ---- ws: THE SAME five doors, message-framed ----
			app.ws("/ws", {
				beforeHandle({ request, set }) {
					if (!apikey) return;
					const h =
						request.headers.get("authorization") ??
						request.headers.get("x-api-key") ??
						"";
					const key = h.startsWith("Bearer ") ? h.slice(7) : h;
					if (key !== apikey) {
						set.status = 401;
						return { error: "unauthorized" };
					}
				},
				open(ws) {
					connSeq++;
					const me = connSeq;
					(ws.data as unknown as { __conn?: number }).__conn = me;

					// shared forwarders — ws.send is ordered per socket, no chain needed
					const remove = wireStreamForwarders(agent, me, "ws", (event, payload) =>
						ws.send(JSON.stringify({ event, ...payload })),
					);
					cleanup.add(remove);
					(ws.data as unknown as { __cleanup?: () => void }).__cleanup = remove;

					ws.send(JSON.stringify({ event: "ready", port: actualPort || null }));
				},
				message(ws, message) {
					const data =
						typeof message === "string" ? safeParse(message) : message;
					if (!data || typeof data !== "object") {
						ws.send(
							JSON.stringify({ event: "error", op: "?", error: "bad frame" }),
						);
						return;
					}
					const { op } = data as { op?: unknown };
					switch (op) {
						case "input": {
							const body = (data as { body?: unknown }).body;
							if (!body || typeof (body as { type?: unknown }).type !== "string") {
								ws.send(
									JSON.stringify({
										event: "error",
										op: "input",
										error: "input requires a string `type`",
									}),
								);
								return;
							}
							door.write(body);
							ws.send(
								JSON.stringify({
									event: "result",
									op: "input",
									data: { ok: true, type: (body as { type: string }).type },
								}),
							);
							return;
						}
						case "control": {
							const opName = (data as { control?: { op?: unknown } }).control
								?.op as string | undefined;
							const result = opName ? door.control(opName) : null;
							ws.send(
								JSON.stringify({
									event: result ? "result" : "error",
									op: "control",
									...(result ? { data: result } : { error: `unknown op: ${opName}` }),
								}),
							);
							return;
						}
						case "getState": {
							const keys = Array.isArray((data as { keys?: unknown }).keys)
								? ((data as { keys?: string[] }).keys ?? [])
								: [];
							ws.send(
								JSON.stringify({ event: "result", op: "getState", data: door.readState(keys) }),
							);
							return;
						}
						case "awaits":
							ws.send(JSON.stringify({ event: "result", op: "awaits", data: door.awaits() }));
							return;
						case "questions":
							ws.send(JSON.stringify({ event: "result", op: "questions", data: door.questions() }));
							return;
						case "tools":
							ws.send(JSON.stringify({ event: "result", op: "tools", data: door.tools() }));
							return;
						case "capabilities":
							ws.send(
								JSON.stringify({ event: "result", op: "capabilities", data: door.capabilities() }),
							);
							return;
						default:
							ws.send(
								JSON.stringify({ event: "error", op: String(op), error: `unknown op: ${String(op)}` }),
							);
					}
				},
				close(ws) {
					const state = ws.data as unknown as {
						__cleanup?: () => void;
					};
					if (state.__cleanup) {
						cleanup.delete(state.__cleanup);
						state.__cleanup();
					}
				},
			});

			// ---- bind ----
			app.listen({ port, hostname: addr }, (server) => {
				serverInfo = server as typeof serverInfo;
				// The @elysia/node adapter reports `server.port` as whatever was
				// passed (0 for random) and binds ASYNCHRONOUSLY (srvx). The real
				// port only shows up on the underlying node server once it's
				// actually listening — poll for it, then settle the port.
				const readPort = () =>
					server.raw?.node?.server?.address()?.port ?? server.port ?? port;
				const settle = (p: number) => {
					actualPort = p;
					agent.state.http = { addr, port: actualPort, apikey: !!apikey };
					onPort?.(actualPort);
				};
				const deadline = Date.now() + 5000;
				const poll = () => {
					const p = readPort();
					if ((p && p > 0) || Date.now() > deadline) {
						settle(p);
						return;
					}
					setTimeout(poll, 10);
				};
				poll();
			});

			agent.addDeclaredCapability({
				id: "http-server",
				description: `external channel (REST + SSE + WS on ${addr}:${actualPort || port})`,
			});
			};
			bootstrap().catch((err) => {
				const message = err instanceof Error ? err.message : String(err);
				agent.state.http = { addr, port, apikey: !!apikey, error: message };
				console.error(`[sanity] http-server: install failed — ${message}`);
			});
		},

		uninstall(agent) {
			for (const fn of cleanup) fn();
			cleanup.clear();
			// app.stop() throws with the node adapter (app.server stays null) —
			// close the underlying server via the server-info object instead.
			serverInfo?.stop(true);
			serverInfo = undefined;
			app = undefined;
			delete agent.state.http;
			agent.removeDeclaredCapability("http-server");
		},
	};
}

/** Defensive JSON parse for WS text frames. */
function safeParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}
