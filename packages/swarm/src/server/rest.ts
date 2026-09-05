// ============================================================================
// sanity/src/packages/swarm/src/server/rest.ts — the second door.
// ONE API, MANY SURFACES: this adapter maps REST routes onto the daemon's
// FleetApi — the SAME ops the WS frames speak, with the SAME role tokens and
// the SAME permission table. Type-blind like everything else: bodies are
// single JSON objects with keys, passed through untouched.
//
//   GET    /api/v1                             route index (discovery)
//   GET    /api/v1/health                      daemon self-description
//   GET    /api/v1/workers?status=&mode=&agentId=&room=
//   GET    /api/v1/workers/:id
//   GET    /api/v1/workers/:id/events?limit=N  the recent-events ring
//   GET    /api/v1/history                     every worker ever seen
//   GET    /api/v1/templates                   spawnable templates
//   POST   /api/v1/workers                     {template, sessionId?, prompt?}
//   POST   /api/v1/workers/:id/input           <the input object itself>
//   POST   /api/v1/workers/:id/control         {action: stop|abort|pause|wake}
//   POST   /api/v1/workers/:id/restart         {prompt?}
//   DELETE /api/v1/workers/:id                 kill
//
// ROOMS: the SAME visibility rule as every other door. The caller presents a
// mount point — `?room=` or the `X-Swarm-Room` header (default "global" = see
// everything). Every route filters through the same prefix check: an ancestor
// sees its descendants; sideways and upward: invisible — and a worker you
// can't see doesn't exist (404), can't be steered, and can't be killed.
//
// input/listen stay WS-only where they are about streams; input is here because
// steering a worker is fleet management too. Auth: `Authorization: Bearer
// <role-token>` — the token IS the role. No tokens configured (open mode) →
// full access, same trust the CLI's admin claim gets (the daemon is
// 127.0.0.1-bound by default).
// ============================================================================
import type { IncomingMessage, ServerResponse } from "node:http";
import { CONTROL_ACTIONS, ROOT_ROOM, normalizeRoom } from "../protocol.ts";
import type { ControlAction, SwarmRole } from "../protocol.ts";
import type { FleetApi } from "./index.ts";

export interface RestOptions {
	api: FleetApi;
	/** Per-role tokens; empty = open mode (full access — localhost door). */
	tokens: Partial<Record<SwarmRole, string>>;
	/** Daemon self-description for /health. */
	meta(): { port: number; home: string; online: number; total: number; uptimeMs: number };
	/** Route prefix. Default /api/v1. */
	prefix?: string;
}

/** Body cap for POST routes — the door stays small. */
const MAX_BODY_BYTES = 1 << 20;

const json = (res: ServerResponse, code: number, data: unknown): void => {
	const body = JSON.stringify(data);
	res.writeHead(code, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
	});
	res.end(body);
};

const fail = (res: ServerResponse, code: number, error: string): void =>
	json(res, code, { error });

const bearer = (req: IncomingMessage): string | undefined => {
	const raw = req.headers.authorization;
	if (!raw) return undefined;
	const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
	return m ? m[1]!.trim() : undefined;
};

/** The REST identity model: the bearer token IS the role. Open mode → admin. */
function roleForToken(opts: RestOptions, token: string | undefined): SwarmRole | null {
	const anyTokens = Object.values(opts.tokens).some((t) => t !== undefined);
	if (!anyTokens) return "admin";
	if (!token) return null;
	for (const role of ["admin", "peer", "worker"] as const) {
		if (opts.tokens[role] !== undefined && opts.tokens[role] === token) return role;
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
				reject(new Error(`body too large (>${cap} bytes)`));
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
	const text = await readBody(req);
	if (!text.trim()) return {};
	try {
		const parsed = JSON.parse(text) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

const ROUTES = [
	"GET    /api/v1/health",
	"GET    /api/v1/workers?status=online|offline&mode=worker|peer|admin&agentId=&room=",
	"POST   /api/v1/workers                      {template, sessionId?, prompt?}",
	"GET    /api/v1/workers/:id",
	"GET    /api/v1/workers/:id/events?limit=N",
	"POST   /api/v1/workers/:id/input            <single object — passed through>",
	"POST   /api/v1/workers/:id/control          {action: stop|abort|pause|wake}",
	"POST   /api/v1/workers/:id/restart          {prompt?}",
	"DELETE /api/v1/workers/:id",
	"GET    /api/v1/history",
	"GET    /api/v1/templates",
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

		// ---- the fleet ----------------------------------------------------
		if (seg[0] === "workers") {
			// collection
			if (seg.length === 1) {
				if (method === "GET") {
					if (!need("peer")) return;
					const filter: Parameters<FleetApi["list"]>[0] = {};
					const status = query.get("status");
					if (status === "online" || status === "offline") filter.status = status;
					const mode = query.get("mode");
					if (mode === "worker" || mode === "peer" || mode === "admin") filter.mode = mode;
					const agentId = query.get("agentId");
					if (agentId) filter.agentId = agentId;
					filter.under = mount;
					return json(res, 200, opts.api.list(filter));
				}
				if (method === "POST") {
					if (!need("admin")) return;
					const body = await readObject(req);
					if (!body) return fail(res, 400, "body must be a single JSON object with keys");
					const template = typeof body.template === "string" ? body.template : undefined;
					if (!template) return fail(res, 400, "missing `template`");
					const created = opts.api.create(template, {
						sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
						prompt: typeof body.prompt === "string" ? body.prompt : undefined,
					});
					if (!created) return fail(res, 404, `unknown template: ${template}`);
					return json(res, 200, created);
				}
				return fail(res, 405, "method not allowed");
			}

			const id = decodeURIComponent(seg[1]!);

			// item
			if (seg.length === 2) {
				if (method === "GET") {
					if (!need("peer")) return;
					const w = opts.api.get(id, mount);
					return w ? json(res, 200, w) : fail(res, 404, `unknown worker: ${id}`);
				}
				if (method === "DELETE") {
					if (!need("admin")) return;
					return json(res, 200, opts.api.kill(id, mount));
				}
				return fail(res, 405, "method not allowed");
			}

			// sub-resources
			if (seg[2] === "events" && seg.length === 3 && method === "GET") {
				if (!need("peer")) return;
				const events = opts.api.events(
					id,
					Number(query.get("limit") ?? 100) || 100,
					mount,
				);
				return events ? json(res, 200, events) : fail(res, 404, `unknown worker: ${id}`);
			}
			if (seg[2] === "input" && seg.length === 3 && method === "POST") {
				if (!need("peer")) return;
				const body = await readObject(req);
				if (!body) {
					return fail(res, 400, "input must be a single JSON object with keys — passed through as-is");
				}
				const r = opts.api.input(id, body, mount);
				return r ? json(res, 200, r) : fail(res, 404, `worker not online: ${id}`);
			}
			if (seg[2] === "control" && seg.length === 3 && method === "POST") {
				if (!need("peer")) return;
				const body = await readObject(req);
				const action = body?.action;
				if (typeof action !== "string" || !CONTROL_ACTIONS.includes(action as ControlAction)) {
					return fail(res, 400, `action must be one of: ${CONTROL_ACTIONS.join(", ")}`);
				}
				const r = opts.api.control(id, action as ControlAction, mount);
				return r ? json(res, 200, r) : fail(res, 404, `worker not online: ${id}`);
			}
			if (seg[2] === "restart" && seg.length === 3 && method === "POST") {
				if (!need("admin")) return;
				const body = await readObject(req);
				if (!body) return fail(res, 400, "body must be a single JSON object with keys");
				const r = opts.api.restart(
					id,
					{ prompt: typeof body.prompt === "string" ? body.prompt : undefined },
					mount,
				);
				return r.ok
					? json(res, 200, r)
					: fail(res, 409, `not spawned by the daemon / already gone: ${id}`);
			}
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
