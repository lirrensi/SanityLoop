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
//   GET    /api/v1/programs                    program definitions
//   POST   /api/v1/programs                    {name, kind?, spawn, ...ProgramDefine fields} = define
//   GET    /api/v1/programs/:name
//   PATCH  /api/v1/programs/:name              merge + validate (promotion)
//   DELETE /api/v1/programs/:name              forget the definition
//   POST   /api/v1/programs/:name/launch       {context?, prompt?, waitMs?, token?}
//   GET    /api/v1/programs/:name/preview?n=   next-N fire times, no fork
//   GET    /api/v1/programs/:name/logs?tailBytes=
//   POST   /api/v1/runs/exec                   {spawn, waitMs?, timeoutMs?, name?, context?} (+?wait= overrides)
//   GET    /api/v1/runs?program=&state=&limit=
//   POST   /api/v1/runs/prune                  {olderThanMs?, keep?}
//   GET    /api/v1/runs/:id                    id-or-name
//   GET    /api/v1/runs/:id/logs?stream=&tailBytes=&offset=
//   POST   /api/v1/runs/:id/wait               {match?, timeoutMs?} (timeout → 408 + snapshot)
//   POST   /api/v1/runs/:id/kill               {graceMs?, force?}
//   POST   /api/v1/runs/:id/signal             {signal}
//   POST   /api/v1/runs/:id/save               {name, kind?} = promote orphan run
//   POST   /api/v1/runs/:id/restart            same spawn, new run
//   POST   /api/v1/agents/:id/input            <the input object itself>
//   POST   /api/v1/agents/:id/control          {action: stop|abort|pause|wake}
//
// ROOMS: the SAME visibility rule as every other door. The caller presents a
// mount point — `?room=` or the `X-Swarm-Room` header (default "global" = see
// everything). Agent routes filter through the same prefix check: an ancestor
// sees its descendants; sideways and upward: invisible — and an agent you
// can't see doesn't exist (404), can't be steered, and can't be dropped.
// Programs/runs routes carry NO room scoping (admin-only ops; the ledger and
// the definitions are global) — the mount point is ignored there.
//
// input/listen stay WS-only where they are about streams; input is here because
// steering a worker is fleet management too. Auth: `Authorization: Bearer
// <role-token>` — the token IS the role. No tokens configured (open mode) →
// full access, same trust the CLI's admin claim gets (the daemon is
// 127.0.0.1-bound by default). Launch honors the watchdog path too: a
// body.token (or bearer) matching the program's triggerToken authorizes
// POST /programs/:name/launch without a role token. waitMs on launch/exec is
// caller patience, never run lifetime: the daemon waits up to waitMs for the
// settled record and returns the fork either way (always 200 with the exec/
// launch result; the daemon decides inline vs detached by waitMs).
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
	"GET /api/v1/programs",
	"POST /api/v1/programs",
	"GET /api/v1/programs/:name",
	"PATCH /api/v1/programs/:name",
	"DELETE /api/v1/programs/:name",
	"POST /api/v1/programs/:name/launch {context?, prompt?, waitMs?, token?}",
	"GET /api/v1/programs/:name/preview",
	"GET /api/v1/programs/:name/logs",
	"POST /api/v1/runs/exec",
	"GET /api/v1/runs",
	"POST /api/v1/runs/prune",
	"GET /api/v1/runs/:id",
	"GET /api/v1/runs/:id/logs",
	"POST /api/v1/runs/:id/wait",
	"POST /api/v1/runs/:id/kill",
	"POST /api/v1/runs/:id/signal",
	"POST /api/v1/runs/:id/save",
	"POST /api/v1/runs/:id/restart",
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

		// ---- programs (global — no room scoping) ------------------------------
		if (seg[0] === "programs") {
			if (seg.length === 1) {
				if (!need("admin")) return;
				if (method === "GET") return json(res, 200, opts.api.programs.list());
				if (method === "POST") {
					const body = await readObject(req);
					if (!body) return fail(res, 400, "body must be a single JSON object with keys");
					const name = str(body.name);
					if (!name) return fail(res, 400, "missing `name`");
					const fields: Record<string, unknown> = { ...body };
					delete fields.name;
					const r = opts.api.programs.define({ name, ...fields });
					if (r !== null && typeof r === "object" && "error" in r && Array.isArray(r.error)) {
						return fail(res, 400, r.error.join("; "));
					}
					if (r !== null && typeof r === "object" && "error" in r) {
						return fail(res, 400, "invalid program definition");
					}
					return json(res, 200, r);
				}
				return fail(res, 405, "method not allowed");
			}
			const name = decodeURIComponent(seg[1]!);
			if (seg.length === 2) {
				if (method === "GET") {
					if (!need("admin")) return;
					const p = opts.api.programs.get(name);
					return p ? json(res, 200, p) : fail(res, 404, `unknown program: ${name}`);
				}
				if (method === "PATCH") {
					if (!need("admin")) return;
					const body = await readObject(req);
					if (!body) return fail(res, 400, "body must be a single JSON object with keys");
					const r = opts.api.programs.patch(name, body);
					if (!r) return fail(res, 404, `unknown program: ${name}`);
					if (typeof r === "object" && r !== null && "error" in r && Array.isArray(r.error)) {
						return fail(res, 400, r.error.join("; "));
					}
					if (typeof r === "object" && r !== null && "error" in r) {
						return fail(res, 400, "invalid program patch");
					}
					return json(res, 200, r);
				}
				if (method === "DELETE") {
					if (!need("admin")) return;
					return json(res, 200, opts.api.programs.remove(name));
				}
				return fail(res, 405, "method not allowed");
			}
			if (seg.length === 3 && seg[2] === "launch" && method === "POST") {
				const body = await readObject(req);
				const b = body ?? {};
				const view = opts.api.programs.get(name);
				if (!view) return fail(res, 404, `unknown program: ${name}`);
				const presented = str(b.token) ?? bearer(req);
				const trigger = view.def.triggerToken;
				if (!(trigger && presented === trigger)) {
					if (!need("admin")) return;
				}
				const waitMs = typeof b.waitMs === "number" ? b.waitMs : undefined;
				const r = await opts.api.programs.launch(name, {
					context: str(b.context),
					prompt: str(b.prompt),
					waitMs,
				});
				if (!r) return fail(res, 404, `unknown program: ${name}`);
				if (typeof r === "object" && "busy" in r) return fail(res, 409, `program ${name} already launching (at-most-once)`);
				if (typeof r === "object" && r !== null && "error" in r && Array.isArray(r.error)) {
					return fail(res, 400, r.error.join("; "));
				}
				if (typeof r === "object" && r !== null && "error" in r) return fail(res, 400, "launch failed");
				return json(res, 200, r);
			}
			if (seg.length === 3 && seg[2] === "preview" && method === "GET") {
				if (!need("admin")) return;
				const raw = query.get("n");
				const parsed = raw === null ? undefined : Number(raw);
				const r = opts.api.programs.preview(name, parsed === undefined || !Number.isFinite(parsed) ? undefined : parsed);
				return r ? json(res, 200, r) : fail(res, 404, `unknown program: ${name}`);
			}
			if (seg.length === 3 && seg[2] === "logs" && method === "GET") {
				if (!need("admin")) return;
				const raw = query.get("tailBytes");
				const parsed = raw === null ? undefined : Number(raw);
				const r = opts.api.programs.logs(name, parsed === undefined || !Number.isFinite(parsed) ? undefined : parsed);
				return r ? json(res, 200, r) : fail(res, 404, `unknown program: ${name}`);
			}
			return fail(res, 404, "no such route");
		}

		// ---- runs (global — no room scoping) ----------------------------------
		if (seg[0] === "runs") {
			if (!need("admin")) return;
			if (seg.length === 1) {
				if (method === "GET") {
					const limitRaw = query.get("limit");
					const limitParsed = limitRaw === null ? undefined : Number(limitRaw);
					return json(res, 200, opts.api.runs.list({
						program: query.get("program") ?? undefined,
						state: query.get("state") ?? undefined,
						limit: limitParsed === undefined || !Number.isFinite(limitParsed) ? undefined : limitParsed,
					}));
				}
				return fail(res, 405, "method not allowed");
			}
			if (seg.length === 2 && seg[1] === "exec" && method === "POST") {
				const body = await readObject(req);
				if (!body) return fail(res, 400, "body must be a single JSON object with keys");
				const spawn = body.spawn;
				if (typeof spawn !== "object" || spawn === null || Array.isArray(spawn)) {
					return fail(res, 400, "missing `spawn` ({file} or {cmd, args?, cwd?})");
				}
				const waitRaw = query.get("wait");
				const waitParsed = waitRaw === null ? undefined : Number(waitRaw);
				const waitMs = waitParsed !== undefined && Number.isFinite(waitParsed)
					? waitParsed
					: typeof body.waitMs === "number" ? body.waitMs : undefined;
				try {
					const file = "file" in spawn ? spawn.file : undefined;
					const cmd = "cmd" in spawn ? spawn.cmd : undefined;
					const args = "args" in spawn && Array.isArray(spawn.args) && spawn.args.every((a: unknown) => typeof a === "string") ? (spawn.args as string[]) : undefined;
					const cwd = "cwd" in spawn ? spawn.cwd : undefined;
					const spawnArg = typeof file === "string"
						? { file }
						: typeof cmd === "string"
							? { cmd, ...(args ? { args } : {}), ...(typeof cwd === "string" ? { cwd } : {}) }
							: null;
					if (!spawnArg) {
						return fail(res, 400, "missing `spawn` ({file} or {cmd, args?, cwd?})");
					}
					const r = await opts.api.runs.exec({
						spawn: spawnArg,
						waitMs,
						timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
						name: str(body.name),
						context: str(body.context),
					});
					return json(res, 200, r);
				} catch (err: unknown) {
					return fail(res, 400, err instanceof Error ? err.message : String(err));
				}
			}
			if (seg.length === 2 && seg[1] === "prune" && method === "POST") {
				const body = await readObject(req);
				const b = body ?? {};
				return json(res, 200, opts.api.runs.prune(
					typeof b.olderThanMs === "number" ? b.olderThanMs : undefined,
					typeof b.keep === "number" ? b.keep : undefined,
				));
			}
			const id = decodeURIComponent(seg[1]!);
			if (seg.length === 2 && method === "GET") {
				const r = opts.api.runs.get(id);
				return r ? json(res, 200, r) : fail(res, 404, `unknown run: ${id}`);
			}
			if (seg.length === 3 && seg[2] === "logs" && method === "GET") {
				const stream = query.get("stream");
				const tailRaw = query.get("tailBytes");
				const offRaw = query.get("offset");
				const tailParsed = tailRaw === null ? undefined : Number(tailRaw);
				const offParsed = offRaw === null ? undefined : Number(offRaw);
				const r = opts.api.runs.logs(id, {
					stream: stream === "stdout" || stream === "stderr" || stream === "both" ? stream : undefined,
					tailBytes: tailParsed === undefined || !Number.isFinite(tailParsed) ? undefined : tailParsed,
					offset: offParsed === undefined || !Number.isFinite(offParsed) ? undefined : offParsed,
				});
				return r ? json(res, 200, r) : fail(res, 404, `unknown run: ${id}`);
			}
			if (seg.length === 3 && method === "POST") {
				const body = await readObject(req);
				const b = body ?? {};
				switch (seg[2]) {
					case "wait": {
						try {
							const r = await opts.api.runs.wait(id, {
								match: str(b.match),
								timeoutMs: typeof b.timeoutMs === "number" ? b.timeoutMs : undefined,
							});
							return json(res, 200, r);
						} catch (err: unknown) {
							const msg = err instanceof Error ? err.message : String(err);
							if (typeof err === "object" && err !== null && "snapshot" in err && err.snapshot !== null && err.snapshot !== undefined) {
								return json(res, 408, { error: msg, snapshot: err.snapshot });
							}
							if (/unknown run/i.test(msg)) return fail(res, 404, msg);
							return fail(res, 409, msg);
						}
					}
					case "kill":
						return json(res, 200, opts.api.runs.kill(id, {
							graceMs: typeof b.graceMs === "number" ? b.graceMs : undefined,
							force: typeof b.force === "boolean" ? b.force : undefined,
						}));
					case "signal": {
						const signal = str(b.signal);
						if (!signal) return fail(res, 400, "missing `signal`");
						const r = opts.api.runs.signal(id, signal);
						return r ? json(res, 200, r) : fail(res, 404, `unknown run: ${id}`);
					}
					case "save": {
						const sname = str(b.name);
						if (!sname) return fail(res, 400, "missing `name`");
						const kind = str(b.kind);
						const r = opts.api.runs.save(id, sname, kind === "service" || kind === "job" ? kind : undefined);
						if (!r) return fail(res, 404, `unknown run: ${id}`);
						if (typeof r === "object" && r !== null && "error" in r && Array.isArray(r.error)) {
							return fail(res, 400, r.error.join("; "));
						}
						if (typeof r === "object" && r !== null && "error" in r) return fail(res, 400, "save failed");
						return json(res, 200, r);
					}
					case "restart": {
						const r = await opts.api.runs.restart(id);
						return r ? json(res, 200, r) : fail(res, 404, `unknown run: ${id}`);
					}
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
