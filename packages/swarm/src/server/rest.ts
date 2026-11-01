// ============================================================================
// sanity/src/packages/swarm/src/server/rest.ts — the second door.
// ONE API, MANY SURFACES: this adapter maps REST routes onto the daemon's
// FleetApi — the SAME ops the WS frames speak, with the SAME role tokens and
// the SAME permission table. Type-blind like everything else: bodies are
// single JSON objects with keys, passed through untouched.
//
//   GET    /api/v1                             route index (discovery)
//   GET    /api/v1/health                      daemon self-description
//   GET    /api/v1/agents?status=&mode=&agentId=&room=
//   GET    /api/v1/agents/:id
//   GET    /api/v1/agents/:id/events?limit=N  the recent-events ring
//   GET    /api/v1/history                     every agent ever seen
//   GET    /api/v1/templates                   spawnable templates (no mode)
//   DELETE /api/v1/agents/:id                 drop = close socket + forget the agent
//   GET    /api/v1/processes                   process definitions
//   POST   /api/v1/processes                   {name, file?|from?, autorestart?, prompt?} = save + fork now
//   GET    /api/v1/processes/:name
//   POST   /api/v1/processes/:name/start       {file?, from?, autorestart?, prompt?}
//   POST   /api/v1/processes/:name/save        {file?, from?, autorestart?}
//   POST   /api/v1/processes/:name/stop        murder the pid
//   POST   /api/v1/processes/:name/restart      {prompt?}
//   POST   /api/v1/processes/:name/autorestart  {autorestart}
//   DELETE /api/v1/processes/:name             stop + forget
//   GET    /api/v1/tasks                       task definitions
//   POST   /api/v1/tasks                       {name, file?|from?, fire, everyMs?, at?}
//   GET    /api/v1/tasks/:name
//   POST   /api/v1/tasks/:name/fire            {prompt?}
//   POST   /api/v1/tasks/:name/trigger         {context?, prompt?} — paused-immune, schedule untouched, at-most-once
//   POST   /api/v1/tasks/:name/pause           {paused?}
//   POST   /api/v1/tasks/:name/resume
//   DELETE /api/v1/tasks/:name                 forget the definition
//   POST   /api/v1/agents/:id/input            <the input object itself>
//   POST   /api/v1/agents/:id/control          {action: stop|abort|pause|wake}
//
// ROOMS: the SAME visibility rule as every other door. The caller presents a
// mount point — `?room=` or the `X-Swarm-Room` header (default "global" = see
// everything). Every route filters through the same prefix check: an ancestor
// sees its descendants; sideways and upward: invisible — and an agent you
// can't see doesn't exist (404), can't be steered, and can't be dropped.
//
// input/listen stay WS-only where they are about streams; input is here because
// steering a worker is fleet management too. Auth: `Authorization: Bearer
// <role-token>` — the token IS the role. No tokens configured (open mode) →
// full access, same trust the CLI's admin claim gets (the daemon is
// 127.0.0.1-bound by default).
// ============================================================================
import type { IncomingMessage, ServerResponse } from "node:http";
import {
	CONTROL_ACTIONS,
	normalizeRoom,
	type ControlAction,
	type SwarmRole,
} from "../protocol.ts";
import type { FleetApi } from "./index.ts";

export interface RestOptions {
	api: FleetApi;
	tokens?: Partial<Record<SwarmRole, string>>;
	prefix?: string;
	meta: () => Record<string, unknown>;
}

/** Body cap for POST routes — the door stays small. */
const MAX_BODY_BYTES = 1 << 20;

const json = (res: ServerResponse, code: number, data: unknown): void => {
	const body = JSON.stringify(data);
	res.writeHead(code, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(body),
	});
	res.end(body);
};

const fail = (res: ServerResponse, code: number, error: string): void =>
	json(res, code, { error });

const bearer = (req: IncomingMessage): string | undefined => {
	const h = req.headers.authorization;
	if (!h) return undefined;
	const m = /^Bearer\s+(.+)$/.exec(h.trim());
	return m?.[1];
};

/** The REST identity model: the bearer token IS the role. Open mode → admin. */
function roleForToken(opts: RestOptions, token: string | undefined): SwarmRole | null {
	const tokens = opts.tokens ?? {};
	const anyTokens = Object.values(tokens).some((t) => t !== undefined);
	if (!anyTokens) return "admin";
	if (!token) return null;
	for (const role of ["admin", "peer", "worker"] as const) {
		if (tokens[role] && tokens[role] === token) return role;
	}
	return null;
}

/** peer ⊂ admin — the same ladder the WS PERMS table walks. */
const atLeast = (role: SwarmRole, need: SwarmRole): boolean =>
	role === "admin" || (role === "peer" && need === "peer");

function readBody(req: IncomingMessage, cap = MAX_BODY_BYTES): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > cap) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/** Parse a POST body as a single JSON object with keys — the one shape we accept. */
async function readObject(req: IncomingMessage): Promise<Record<string, unknown> | null> {
	try {
		const text = await readBody(req);
		if (!text.trim()) return {};
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		if (Object.keys(parsed).length === 0) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

const str = (v: unknown): string | undefined =>
	typeof v === "string" && v ? v : undefined;

const ROUTES = [
	"GET /api/v1",
	"GET /api/v1/health",
	"GET /api/v1/agents",
	"GET /api/v1/agents/:id",
	"GET /api/v1/agents/:id/events",
	"DELETE /api/v1/agents/:id",
	"GET /api/v1/processes",
	"POST /api/v1/processes",
	"GET /api/v1/processes/:name",
	"POST /api/v1/processes/:name/start",
	"POST /api/v1/processes/:name/save",
	"POST /api/v1/processes/:name/stop",
	"POST /api/v1/processes/:name/restart",
	"POST /api/v1/processes/:name/autorestart",
	"DELETE /api/v1/processes/:name",
	"GET /api/v1/tasks",
	"POST /api/v1/tasks",
	"GET /api/v1/tasks/:name",
	"POST /api/v1/tasks/:name/fire",
	"POST /api/v1/tasks/:name/trigger {context?, prompt?}",
	"POST /api/v1/tasks/:name/pause",
	"POST /api/v1/tasks/:name/resume",
	"DELETE /api/v1/tasks/:name",
	"GET /api/v1/templates",
	"POST /api/v1/agents/:id/input",
	"POST /api/v1/agents/:id/control",
] as const;

/** The REST adapter. Always responds — hand it every non-upgrade request. */
export function handleRest(
	req: IncomingMessage,
	res: ServerResponse,
	opts: RestOptions,
): void {
	const prefix = opts.prefix ?? "/api/v1";
	const url = new URL(req.url ?? "/", "http://localhost");
	const method = (req.method ?? "GET").toUpperCase();

	if (!url.pathname.startsWith(prefix)) {
		return fail(res, 404, "not found — the swarm speaks under " + prefix);
	}

	const role = roleForToken(opts, bearer(req));
	if (!role) {
		return fail(res, 401, "unauthorized — bad or missing bearer token");
	}

	const seg = url.pathname.slice(prefix.length).split("/").filter(Boolean);
	const query = url.searchParams;

	// ---- the mount point — the same visibility law as every other door ----
	// `?room=` or `X-Swarm-Room`; default "global" = see everything.
	const rawRoom = query.get("room") ?? req.headers["x-swarm-room"];
	const mount = normalizeRoom(
		typeof rawRoom === "string" ? rawRoom : undefined,
	);
	if (mount === null) {
		return fail(res, 400, `malformed room path: ${String(rawRoom)}`);
	}

	const need = (level: SwarmRole): boolean => {
		if (!atLeast(role, level)) {
			fail(res, 403, `forbidden — this route needs ${level}, your token is ${role}`);
			return false;
		}
		return true;
	};

	(async () => {
		// ---- discovery ----------------------------------------------------
		if (method === "GET" && seg.length === 0) return json(res, 200, { routes: ROUTES });

		// ---- health -------------------------------------------------------
		if (method === "GET" && seg[0] === "health" && seg.length === 1) {
			return json(res, 200, { ok: true, ...opts.meta() });
		}

		// ---- history / templates ------------------------------------------
		if (method === "GET" && seg[0] === "history" && seg.length === 1) {
			if (!need("peer")) return;
			return json(res, 200, opts.api.history(mount));
		}
		if (method === "GET" && seg[0] === "templates" && seg.length === 1) {
			if (!need("peer")) return;
			return json(res, 200, opts.api.templates());
		}

		// ---- agents -------------------------------------------------------
		if (seg[0] === "agents") {
			if (seg.length === 1) {
				if (method === "GET") {
					if (!need("peer")) return;
					const filter: Parameters<FleetApi["agents"]["list"]>[0] = {};
					const status = query.get("status");
					if (status === "online" || status === "offline") filter.status = status;
					const mode = query.get("mode");
					if (mode === "worker" || mode === "peer" || mode === "admin") filter.mode = mode;
					const agentId = query.get("agentId");
					if (agentId) filter.agentId = agentId;
					filter.under = mount;
					return json(res, 200, opts.api.agents.list(filter));
				}
				return fail(res, 405, "method not allowed");
			}

			const id = decodeURIComponent(seg[1]!);

			if (seg.length === 2) {
				if (method === "GET") {
					if (!need("peer")) return;
					const w = opts.api.agents.get(id, mount);
					return w ? json(res, 200, w) : fail(res, 404, `unknown agent: ${id}`);
				}
				if (method === "DELETE") {
					if (!need("admin")) return;
					return json(res, 200, opts.api.agents.drop(id, mount));
				}
				return fail(res, 405, "method not allowed");
			}

			if (seg[2] === "events" && seg.length === 3 && method === "GET") {
				if (!need("peer")) return;
				const events = opts.api.events(
					id,
					Number(query.get("limit") ?? 100) || 100,
					mount,
				);
				return events ? json(res, 200, events) : fail(res, 404, `unknown agent: ${id}`);
			}
			if (seg[2] === "input" && seg.length === 3 && method === "POST") {
				if (!need("peer")) return;
				const body = await readObject(req);
				if (!body) {
					return fail(res, 400, "input must be a single JSON object with keys — passed through as-is");
				}
				const r = opts.api.input(id, body, mount);
				return r ? json(res, 200, r) : fail(res, 404, `agent not online: ${id}`);
			}
			if (seg[2] === "control" && seg.length === 3 && method === "POST") {
				if (!need("peer")) return;
				const body = await readObject(req);
				const action = body?.action;
				if (typeof action !== "string" || !CONTROL_ACTIONS.includes(action as ControlAction)) {
					return fail(res, 400, `action must be one of: ${CONTROL_ACTIONS.join(", ")}`);
				}
				const r = opts.api.control(id, action as ControlAction, mount);
				return r ? json(res, 200, r) : fail(res, 404, `agent not online: ${id}`);
			}
		}

		// ---- processes ----------------------------------------------------
		if (seg[0] === "processes") {
			if (!need("admin")) return;
			if (seg.length === 1) {
				if (method === "GET") return json(res, 200, opts.api.processes.list());
				if (method === "POST") {
					const body = await readObject(req);
					if (!body) return fail(res, 400, "body must be a single JSON object with keys");
					const name = str(body.name);
					if (!name) return fail(res, 400, "missing `name`");
					const r = await opts.api.processes.start(name, {
						file: str(body.file),
						from: str(body.from),
						autorestart: typeof body.autorestart === "boolean" ? body.autorestart : undefined,
						prompt: str(body.prompt),
					});
					if (!r) return fail(res, 404, `unknown template/file: ${str(body.from) ?? str(body.file) ?? "(none)"}`);
					return json(res, 200, r);
				}
				return fail(res, 405, "method not allowed");
			}
			const name = decodeURIComponent(seg[1]!);
			if (seg.length === 2 && method === "GET") {
				const p = opts.api.processes.get(name);
				return p ? json(res, 200, p) : fail(res, 404, `unknown process: ${name}`);
			}
			if (seg.length === 2 && method === "DELETE") {
				return json(res, 200, opts.api.processes.remove(name));
			}
			if (seg.length === 3 && method === "POST") {
				const body = await readObject(req);
				if (!body && seg[2] !== "start" && seg[2] !== "restart" && seg[2] !== "stop") {
					return fail(res, 400, "body must be a single JSON object with keys");
				}
				const b = body ?? {};
				switch (seg[2]) {
					case "start": {
						const r = await opts.api.processes.start(name, {
							file: str(b.file),
							from: str(b.from),
							autorestart: typeof b.autorestart === "boolean" ? b.autorestart : undefined,
							prompt: str(b.prompt),
						});
						if (!r) return fail(res, 404, `unknown process / missing agent file: ${name}`);
						return json(res, 200, r);
					}
					case "save": {
						const r = opts.api.processes.save(name, {
							file: str(b.file),
							from: str(b.from),
							autorestart: typeof b.autorestart === "boolean" ? b.autorestart : undefined,
						});
						return json(res, 200, r);
					}
					case "stop":
						return json(res, 200, opts.api.processes.stop(name));
					case "restart": {
						const r = await opts.api.processes.restart(name, { prompt: str(b.prompt) });
						return r.ok
							? json(res, 200, r)
							: fail(res, 409, `unknown process / missing agent file: ${name}`);
					}
					case "autorestart": {
						if (typeof b.autorestart !== "boolean") {
							return fail(res, 400, "`autorestart` must be a boolean");
						}
						return json(res, 200, opts.api.processes.setAutorestart(name, b.autorestart));
					}
				}
			}
			return fail(res, 404, "no such route");
		}

		// ---- tasks --------------------------------------------------------
		if (seg[0] === "tasks") {
			if (!need("admin")) return;
			if (seg.length === 1) {
				if (method === "GET") return json(res, 200, opts.api.tasks.list());
				if (method === "POST") {
					const body = await readObject(req);
					if (!body) return fail(res, 400, "body must be a single JSON object with keys");
					const name = str(body.name);
					const fire = str(body.fire);
					if (!name) return fail(res, 400, "missing `name`");
					if (fire !== "every" && fire !== "at" && fire !== "manual") {
						return fail(res, 400, "`fire` must be one of: every, at, manual");
					}
					const r = opts.api.tasks.define({
						name,
						file: str(body.file),
						from: str(body.from),
						fire,
						everyMs: typeof body.everyMs === "number" ? body.everyMs : undefined,
						at: typeof body.at === "number" ? body.at : undefined,
					});
					if (!r) return fail(res, 400, `bad task definition: ${name}`);
					return json(res, 200, r);
				}
				return fail(res, 405, "method not allowed");
			}
			const name = decodeURIComponent(seg[1]!);
			if (seg.length === 2 && method === "GET") {
				const t = opts.api.tasks.get(name);
				return t ? json(res, 200, t) : fail(res, 404, `unknown task: ${name}`);
			}
			if (seg.length === 2 && method === "DELETE") {
				return json(res, 200, opts.api.tasks.remove(name));
			}
			if (seg.length === 3 && method === "POST") {
				const body = await readObject(req);
				const b = body ?? {};
				switch (seg[2]) {
					case "fire": {
						const r = await opts.api.tasks.fire(name, { prompt: str(b.prompt) });
						if (!r) return fail(res, 404, `unknown task / missing agent file / paused (use trigger): ${name}`);
						return json(res, 200, r);
					}
					case "trigger": {
						const r = await opts.api.tasks.trigger(name, { context: str(b.context), prompt: str(b.prompt) });
						if (!r) return fail(res, 404, `unknown task / missing agent file: ${name}`);
						if ("busy" in r && r.busy) return fail(res, 409, `task ${name} already firing (at-most-once)`);
						return json(res, 200, r);
					}
					case "pause":
						return json(res, 200, opts.api.tasks.pause(
							name,
							typeof b.paused === "boolean" ? b.paused : true,
						));
					case "resume":
						return json(res, 200, opts.api.tasks.resume(name));
				}
			}
			return fail(res, 404, "no such route");
		}

		return fail(res, 404, "no such route");
	})().catch((err: unknown) => {
		if (!res.headersSent) {
			fail(res, 500, err instanceof Error ? err.message : String(err));
		} else {
			res.end();
		}
	});
}
