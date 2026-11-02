// ============================================================================
// sanity/src/packages/swarm/src/server/cli.ts — the operator's door.
// ONE API, MANY SURFACES: the CLI is a WS client speaking the same ops the
// REST routes and the frames speak — same server, same tokens, same perms.
//
//   swarm serve [--port N] [--addr H] [--templates DIR] [--name N]
//              [--token admin=TOK --token peer=TOK --token worker=TOK]
//              [--connect ws://B [--as ALIAS]]...
//   swarm agents [--server ws://...]
//   swarm agents get <sessionId>               [--server ws://...]
//   swarm agents drop <sessionId>             [--server ws://...]  (close socket + forget)
//   swarm listen (--session <id> | --run <id-or-name> | --program <name>) [--server ws://...]
//   swarm programs list|get|define|patch|launch|remove|preview|logs
//   swarm runs list|get|logs|wait|kill|signal|save|restart|prune
//   swarm exec [--wait-ms N] [--detach] [--cwd DIR] -- <cmd> [args...]
//   swarm send <sessionId> <text>              [--server ws://...]
//   swarm control <sessionId> <stop|abort|pause|wake|shutdown|reset>
//   swarm history | templates | events <sessionId>
//   swarm scan [--templates DIR]
//
// `serve` runs the daemon in-process (it IS the daemon). The rest are clients
// that talk to a running daemon over the wire — the same protocol the UI will
// speak. Boot resubmits every kept program whose desired state is running —
// there is no resurrect flag; the definitions ARE the desired state.
// ============================================================================
import { createSwarmServer } from "./index.ts";
import { ensureScaffold, homeLayout, loadConfig, resolveHome } from "./config.ts";
import { scanTemplates } from "./templates.ts";
import { DEFAULT_PORT } from "../protocol.ts";
import type { ControlAction, SwarmRole } from "../protocol.ts";
import WebSocket from "ws";

const HELP = `usage:
  swarm serve [--dir HOME] [--port N] [--addr H] [--templates DIR]
              [--name N] [--token <role>=<tok>]... [--connect ws://B [--as ALIAS]]...
  swarm agents [--status online|offline] [--mode worker|peer|admin]
               [--agent-id ID] [--room PATH] [--server ws://H:P]
  swarm agents get <sessionId> [--server ws://H:P]
  swarm agents drop <sessionId> [--server ws://H:P]
  swarm listen (--session <id> | --run <id-or-name> | --program <name>) [--server ws://H:P]
  swarm programs list [--server ws://H:P]
  swarm programs get <name> [--server ws://H:P]
  swarm programs define <name> [--kind service|job]
      [--file F | --cmd CMD -- <args...>] [--from T]
      [--desired running|stopped] [--restart never|always|on-failure]
      [--schedule-cron EXPR] [--schedule-every-ms N] [--schedule-at ISO|epoch]
      [--timezone TZ] [--overlap skip|allow|allowN|buffer1|bufferAll|cancel|restart]
      [--allow-n N] [--timeout-ms N] [--paused] [--notes TEXT]
      [--json '{...}']  (--json provides defaults, explicit flags override)
  swarm programs patch <name> [--paused true|false] [--desired running|stopped]
      [--notes TEXT] [--restart never|always|on-failure]
      [--schedule-cron EXPR] [--schedule-every-ms N] [--schedule-at ISO|epoch]
      [--json '{...}']  (--json provides defaults, explicit flags override)
  swarm programs launch <name> [--context TEXT] [--prompt TEXT] [--wait-ms N] [--token TOK]
  swarm programs remove <name> | preview <name> [--n N] | logs <name> [--tail-bytes N]
  swarm runs list [--program P] [--state S] [--limit N]
  swarm runs get <id> | logs <id> [--stream stdout|stderr|both] [--tail-bytes N] [--offset N]
  swarm runs wait <id> [--match PAT] [--timeout-ms N] | kill <id> [--grace-ms N] [--force]
  swarm runs signal <id> <sig> | save <id> <name> [--kind service|job]
  swarm runs restart <id> | prune [--older-than-ms N] [--keep N]
  swarm exec [--wait-ms N] [--timeout-ms N] [--name NAME] [--detach] [--cwd DIR] -- <cmd> [args...]
  swarm send <sessionId> <text> [--server ws://H:P]
  swarm control <sessionId> <stop|abort|pause|wake|shutdown|reset> [--server ws://H:P]
  swarm history | swarm templates [--server ws://H:P]
  swarm scan [--dir HOME] [--templates DIR]
  swarm help`;

interface Args {
	flags: Map<string, string | true>;
	positionals: string[];
}

function parseArgs(argv: string[]): Args {
	const flags = new Map<string, string | true>();
	const positionals: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--") {
			// everything past the separator is a positional (the spawned command)
			for (i++; i < argv.length; i++) positionals.push(argv[i]!);
			break;
		}
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				// repeated keys accumulate (multiple --token / --connect / --as) —
				// stringified list under one key, order preserved
				const prev = flags.get(key);
				flags.set(key, prev === undefined ? next : `${prev}\u0000${next}`);
				i++;
			} else {
				flags.set(key, true);
			}
		} else {
			positionals.push(a);
		}
	}
	return { flags, positionals };
}

/** All values of a (possibly repeated) flag, in declaration order. */
function flagValues(flags: Map<string, string | true>, key: string): string[] {
	const raw = flags.get(key);
	return raw === undefined ? [] : String(raw).split("\u0000");
}

/** The daemon a command targets: --server wins; else the home's config.json tells us. */
function targetServer(args: Args): { url: string; home: string } {
	const home = resolveHome(args.flags);
	const explicit = args.flags.get("server");
	if (typeof explicit === "string") return { url: explicit, home };
	const cfg = loadConfig(home);
	if (cfg) return { url: `ws://${cfg.addr}:${cfg.port}`, home };
	return { url: `ws://127.0.0.1:${DEFAULT_PORT}`, home };
}

/** The operator's token: --token admin=<tok> (only needed when the daemon has tokens).
 *  Repeated --token flags accumulate; prefer the admin value, else the
 *  peer value — never the NUL-joined raw. */
function opToken(args: Args): string | undefined {
	let peer: string | undefined;
	for (const t of flagValues(args.flags, "token")) {
		const eq = t.indexOf("=");
		const role = eq >= 0 ? t.slice(0, eq) : "";
		const value = eq >= 0 ? t.slice(eq + 1) : t;
		if (role === "admin") return value;
		if (role === "peer" && peer === undefined) peer = value;
	}
	return peer;
}

/** A bare `--token TOK` (no `role=`) on `programs launch`: the program's
 *  triggerToken for the watchdog path — NOT an operator role token. */
function launchToken(args: Args): string | undefined {
	for (const t of flagValues(args.flags, "token")) {
		if (!t.includes("=")) return t;
	}
	return undefined;
}

/** A minimal WS client for the operator commands (the join extension needs an agent; this doesn't). */
function client(
	server: string,
	operatorToken?: string,
): {
	send(frame: unknown): Promise<unknown>;
	onEvent(cb: (frame: { op: string; target?: string; event?: string; payload?: unknown }) => void): void;
	close(): void;
} {
	const ws = new WebSocket(server);
	const pending = new Map<
		string,
		{ resolve: (d: unknown) => void; reject: (e: Error) => void }
	>();
	let seq = 0;
	const queue: (() => void)[] = [];
	const listeners: ((frame: { op: string; target?: string; event?: string; payload?: unknown }) => void)[] = [];
	ws.on("open", () => {
		// the operator registers as admin — in open mode the claim is trusted;
		// with tokens the operator passes --token admin=<tok>
		ws.send(
			JSON.stringify({
				op: "register",
				sessionId: `cli-${crypto.randomUUID().slice(0, 8)}`,
				agentId: "cli",
				mode: "admin",
				persistent: false,
				token: operatorToken,
			}),
		);
		queue.forEach((f) => f());
	});
	ws.on("message", (data: unknown) => {
		let frame: { op: string; id?: string; data?: unknown; error?: string } & Record<string, unknown>;
		try {
			frame = JSON.parse((data as Buffer).toString()) as typeof frame;
		} catch {
			return;
		}
		if (frame.op === "event") {
			for (const cb of listeners) {
				try {
					cb(frame as { op: string; target?: string; event?: string; payload?: unknown });
				} catch {
					/* ignore */
				}
			}
			return;
		}
		if (frame.id && pending.has(frame.id)) {
			const p = pending.get(frame.id)!;
			pending.delete(frame.id);
			if (frame.op === "error")
				p.reject(new Error(frame.error ?? "unknown error"));
			else p.resolve(frame.data);
		}
	});
	return {
		send(frame: unknown): Promise<unknown> {
			const id = `c${++seq}`;
			const { promise, resolve, reject } = Promise.withResolvers<unknown>();
			pending.set(id, { resolve, reject });
			const go = () => ws.send(JSON.stringify({ ...(frame as object), id }));
			if (ws.readyState === WebSocket.OPEN) go();
			else queue.push(go);
			return promise;
		},
		onEvent(cb: (frame: { op: string; target?: string; event?: string; payload?: unknown }) => void): void {
			listeners.push(cb);
		},
		close() {
			try {
				ws.close();
			} catch {
				/* ignore */
			}
		},
	};
}

const printJson = (data: unknown): void =>
	console.log(JSON.stringify(data, null, 2));

const printAgentRow = (r: {
	status: string;
	state?: string;
	sessionId: string;
	address?: string;
	agentId: string;
	parent?: string;
	persistent: boolean;
}): void =>
	console.log(
		`${r.status.padEnd(7)} ${(r.state ?? "-").padEnd(7)} ${(r.address ?? r.sessionId).padEnd(40)} ${r.agentId}${r.parent ? ` [parent ${r.parent}]` : ""}${r.persistent ? " [persistent]" : ""}`,
	);

const flag = (args: Args, key: string): string | undefined =>
	typeof args.flags.get(key) === "string" ? (args.flags.get(key) as string) : undefined;

const die = (msg: string): never => {
	console.error(msg);
	process.exitCode = 1;
	throw new Error(msg);
};

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const args = parseArgs(argv);
	const cmd = args.positionals[0] ?? "help";
	const a1 = args.positionals[1];
	const rest = args.positionals.slice(2);

	switch (cmd) {
		case "serve": {
			const home = resolveHome(args.flags);
			ensureScaffold(home);
			const layout = homeLayout(home);
			const port = Number(args.flags.get("port") ?? DEFAULT_PORT);
			const addr = (args.flags.get("addr") as string) ?? "127.0.0.1";
			const name =
				typeof args.flags.get("name") === "string"
					? (args.flags.get("name") as string)
					: undefined;
			const templatesDir =
				(args.flags.get("templates") as string) ?? layout.templatesDir;
			const tokensRaw = flagValues(args.flags, "token");
			const tokens: Partial<Record<SwarmRole, string>> = {};
			for (const t of tokensRaw) {
				const [role, ...r] = t.split("=");
				if (role === "admin" || role === "peer" || role === "worker") {
					tokens[role] = r.join("=");
				}
			}
			// federation mounts: --connect pairs with --as by index (alias optional)
			const connects = flagValues(args.flags, "connect");
			const aliases = flagValues(args.flags, "as");
			if (aliases.length > connects.length) {
				console.error(
					"[swarm] --as given without a matching --connect (pair them by index)",
				);
				process.exitCode = 1;
				return;
			}
			if (connects.length && !name) {
				// hermit rule: federation requires a declared name — in BOTH directions
				console.error(
					"[swarm] federation requires a declared name — add --name <swarm>",
				);
				process.exitCode = 1;
				return;
			}
			const server = createSwarmServer({
				home,
				addr,
				port,
				name,
				tokens: Object.keys(tokens).length ? tokens : undefined,
				templatesDir,
			});
			await server.start();
			const t =
				server
					.templates()
					.map((x) => x.id ?? x.file)
					.join(", ") || "(none)";
			console.log(
				`[swarm] daemon on ws://${addr}:${server.port} — rest http://${addr}:${server.port}/api/v1 — home: ${home} — templates: ${t}`,
			);
			if (name) console.log(`[swarm] name: ${name}`);
			else console.log("[swarm] unnamed (hermit mode — federation refused)");
			if (Object.keys(tokens).length) {
				console.log(
					`[swarm] tokens: ${Object.entries(tokens)
						.map(([r]) => `${r}=***`)
						.join(", ")}`,
				);
			}
			// dial every mount — failures don't stop the daemon, they log and retry
			for (let i = 0; i < connects.length; i++) {
				server.federate({
					url: connects[i]!,
					as: aliases[i],
					token: opToken(args),
				});
			}
			// Graceful shutdown: children stop, the scoped daemon dies, no orphans.
			// A second signal exits immediately (code 1).
			let shuttingDown = false;
			const shutdown = (sig: string): void => {
				if (shuttingDown) {
					console.error(`[swarm] ${sig} again — exiting immediately`);
					process.exit(1);
				}
				shuttingDown = true;
				void (async () => {
					try {
						await server.stop();
						await server.killDaemon();
					} finally {
						process.exit(0);
					}
				})();
			};
			process.once("SIGINT", () => shutdown("SIGINT"));
			process.once("SIGTERM", () => shutdown("SIGTERM"));
			// keep the process alive — the daemon IS this process
			await new Promise<void>(() => {});
			return;
		}
		case "agents": {
			const sub = a1 ?? "list";
			const c = client(targetServer(args).url, opToken(args));
			if (sub === "list") {
				type AgentRow = Parameters<typeof printAgentRow>[0] & { mode?: string; room?: string };
				const rows = (await c.send({ op: "agents_list" })) as AgentRow[];
				const status = flag(args, "status");
				if (status !== undefined && status !== "online" && status !== "offline") die(HELP);
				const mode = flag(args, "mode");
				if (mode !== undefined && mode !== "worker" && mode !== "peer" && mode !== "admin") die(HELP);
				const agentId = flag(args, "agent-id");
				const room = flag(args, "room");
				for (const r of rows) {
					if (status && r.status !== status) continue;
					if (mode && r.mode !== mode) continue;
					if (agentId && r.agentId !== agentId) continue;
					if (room && r.room !== room) continue;
					printAgentRow(r);
				}
			} else if (sub === "get") {
				if (!rest[0]) die(HELP);
				printJson(await c.send({ op: "agents_get", sessionId: rest[0] }));
			} else if (sub === "drop") {
				if (!rest[0]) die(HELP);
				const res = (await c.send({ op: "drop", sessionId: rest[0] })) as { ok: boolean };
				console.log(`drop: ${res.ok ? "ok" : "not found"}`);
			} else {
				die(HELP);
			}
			c.close();
			return;
		}
		case "programs": {
			const sub = a1 ?? "list";
			const c = client(targetServer(args).url, opToken(args));
			const num = (key: string): number | undefined => {
				const v = flag(args, key);
				if (v === undefined) return undefined;
				const n = Number(v);
				if (!Number.isFinite(n)) die(`--${key} must be a number`);
				return n;
			};
			switch (sub) {
				case "list":
					printJson(await c.send({ op: "program_list" }));
					break;
				case "get":
					if (!rest[0]) die(HELP);
					printJson(await c.send({ op: "program_get", name: rest[0] }));
					break;
				case "define": {
					const name = rest[0];
					if (!name) die(HELP);
					// spawn: --file F wins; else --cmd CMD with trailing positionals
					// after `--` as args (`--` itself never reaches the positionals).
					const extraArgs = rest.slice(1);
					const file = flag(args, "file");
					const cmd = flag(args, "cmd");
					const from = flag(args, "from");
					const kind = flag(args, "kind");
					if (kind !== undefined && kind !== "service" && kind !== "job") die(HELP);
					const desired = flag(args, "desired");
					if (desired !== undefined && desired !== "running" && desired !== "stopped") die(HELP);
					const restartFlag = flag(args, "restart");
					if (restartFlag !== undefined && restartFlag !== "never" && restartFlag !== "always" && restartFlag !== "on-failure") die(HELP);
					const cron = flag(args, "schedule-cron");
					const everyMs = num("schedule-every-ms");
					const atRaw = flag(args, "schedule-at");
					const timezone = flag(args, "timezone");
					let at: number | undefined;
					if (atRaw !== undefined) {
						at = /^-?\d+$/.test(atRaw) ? Number(atRaw) : Date.parse(atRaw);
						if (!Number.isFinite(at)) die(`--schedule-at must be an ISO date or epoch ms`);
					}
					const overlap = flag(args, "overlap");
					if (overlap !== undefined && !["skip", "allow", "allowN", "buffer1", "bufferAll", "cancel", "restart"].includes(overlap)) die(HELP);
					const jsonRaw = flag(args, "json");
					let jsonDefaults: Record<string, unknown> = {};
					if (jsonRaw !== undefined) {
						try {
							const parsed: unknown = JSON.parse(jsonRaw);
							if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) die(`--json must be a JSON object`);
							jsonDefaults = parsed as Record<string, unknown>;
						} catch (e) {
							if (e instanceof Error && e.message.startsWith("--json")) die(e.message);
							const detail = e instanceof Error ? e.message : String(e);
							die(`--json is not valid JSON: ${detail}`);
						}
					}
					const flagFields: Record<string, unknown> = {
						...(kind ? { kind } : {}),
						...(file ? { spawn: { file } } : {}),
						...(cmd ? { spawn: { cmd, ...(extraArgs.length ? { args: extraArgs } : {}) } } : {}),
						...(from ? { from } : {}),
						...(desired ? { desired } : {}),
						...(restartFlag ? { restart: { policy: restartFlag } } : {}),
						...(cron !== undefined || everyMs !== undefined || at !== undefined
							? {
									schedule: {
										kind: cron !== undefined ? "cron" : everyMs !== undefined ? "every" : "at",
										...(cron !== undefined ? { expr: cron } : {}),
										...(everyMs !== undefined ? { everyMs } : {}),
										...(at !== undefined ? { at } : {}),
										...(timezone ? { timezone } : {}),
									},
								}
							: {}),
						...(overlap ? { overlap } : {}),
						...(num("allow-n") !== undefined ? { allowN: num("allow-n") } : {}),
						...(num("timeout-ms") !== undefined ? { timeoutMs: num("timeout-ms") } : {}),
						...(args.flags.has("paused") ? { paused: true } : {}),
						...(flag(args, "notes") ? { notes: flag(args, "notes") } : {}),
					};
					printJson(await c.send({ op: "program_define", name, ...jsonDefaults, ...flagFields }));
					break;
				}
				case "patch": {
					const name = rest[0];
					if (!name) die(HELP);
					const patch: Record<string, unknown> = {};
					const pausedRaw = flag(args, "paused");
					if (args.flags.has("paused")) {
						if (pausedRaw === undefined || pausedRaw === "true") patch["paused"] = true;
						else if (pausedRaw === "false") patch["paused"] = false;
						else die(HELP);
					}
					const desired = flag(args, "desired");
					if (desired !== undefined) {
						if (desired !== "running" && desired !== "stopped") die(HELP);
						patch["desired"] = desired;
					}
					const notes = flag(args, "notes");
					if (notes !== undefined) patch["notes"] = notes;
					const restartFlag = flag(args, "restart");
					if (restartFlag !== undefined) {
						if (restartFlag !== "never" && restartFlag !== "always" && restartFlag !== "on-failure") die(HELP);
						patch["restart"] = { policy: restartFlag };
					}
					const cron = flag(args, "schedule-cron");
					const everyMsRaw = flag(args, "schedule-every-ms");
					const atRaw = flag(args, "schedule-at");
					if (cron !== undefined || everyMsRaw !== undefined || atRaw !== undefined) {
						if (
							(cron !== undefined && ["cleared", "clear", "none"].includes(cron)) ||
							(everyMsRaw !== undefined && ["cleared", "clear", "none"].includes(everyMsRaw)) ||
							(atRaw !== undefined && ["cleared", "clear", "none"].includes(atRaw))
						) {
							patch["schedule"] = { kind: "manual" };
						} else {
							const everyMs = everyMsRaw !== undefined ? Number(everyMsRaw) : undefined;
							if (everyMsRaw !== undefined && !Number.isFinite(everyMs!)) die(`--schedule-every-ms must be a number`);
							let at: number | undefined;
							if (atRaw !== undefined) {
								at = /^-?\d+$/.test(atRaw) ? Number(atRaw) : Date.parse(atRaw);
								if (!Number.isFinite(at)) die(`--schedule-at must be an ISO date or epoch ms`);
							}
							patch["schedule"] = {
								kind: cron !== undefined ? "cron" : everyMs !== undefined ? "every" : "at",
								...(cron !== undefined ? { expr: cron } : {}),
								...(everyMs !== undefined ? { everyMs } : {}),
								...(at !== undefined ? { at } : {}),
							};
						}
					}
					const jsonRaw = flag(args, "json");
					let jsonPatch: Record<string, unknown> = {};
					if (jsonRaw !== undefined) {
						try {
							const parsed: unknown = JSON.parse(jsonRaw);
							if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) die(`--json must be a JSON object`);
							jsonPatch = parsed as Record<string, unknown>;
						} catch (e) {
							if (e instanceof Error && e.message.startsWith("--json")) die(e.message);
							const detail = e instanceof Error ? e.message : String(e);
							die(`--json is not valid JSON: ${detail}`);
						}
					}
					const merged: Record<string, unknown> = { ...jsonPatch, ...patch };
					if (Object.keys(merged).length === 0) die(HELP);
					printJson(await c.send({ op: "program_patch", name, patch: merged }));
					break;
				}
				case "launch": {
					if (!rest[0]) die(HELP);
					printJson(
						await c.send({
							op: "program_launch",
							name: rest[0],
							...(flag(args, "context") ? { context: flag(args, "context") } : {}),
							...(flag(args, "prompt") ? { prompt: flag(args, "prompt") } : {}),
							...(flag(args, "wait-ms") ? { waitMs: Number(flag(args, "wait-ms")) } : {}),
							...(launchToken(args) ? { token: launchToken(args) } : {}),
						}),
					);
					break;
				}
				case "remove":
					if (!rest[0]) die(HELP);
					printJson(await c.send({ op: "program_remove", name: rest[0] }));
					break;
				case "preview":
					if (!rest[0]) die(HELP);
					printJson(
						await c.send({
							op: "program_preview",
							name: rest[0],
							...(flag(args, "n") ? { n: Number(flag(args, "n")) } : {}),
						}),
					);
					break;
				case "logs":
					if (!rest[0]) die(HELP);
					printJson(
						await c.send({
							op: "program_logs",
							name: rest[0],
							...(flag(args, "tail-bytes") ? { tailBytes: Number(flag(args, "tail-bytes")) } : {}),
						}),
					);
					break;
				default:
					die(HELP);
			}
			c.close();
			return;
		}
		case "runs": {
			const sub = a1 ?? "list";
			const c = client(targetServer(args).url, opToken(args));
			switch (sub) {
				case "list":
					printJson(
						await c.send({
							op: "run_list",
							...(flag(args, "program") ? { program: flag(args, "program") } : {}),
							...(flag(args, "state") ? { state: flag(args, "state") } : {}),
							...(flag(args, "limit") ? { limit: Number(flag(args, "limit")) } : {}),
						}),
					);
					break;
				case "get":
					if (!rest[0]) die(HELP);
					printJson(await c.send({ op: "run_get", runId: rest[0] }));
					break;
				case "logs":
					if (!rest[0]) die(HELP);
					printJson(
						await c.send({
							op: "run_logs",
							runId: rest[0],
							...(flag(args, "stream") ? { stream: flag(args, "stream") } : {}),
							...(flag(args, "tail-bytes") ? { tailBytes: Number(flag(args, "tail-bytes")) } : {}),
							...(flag(args, "offset") ? { offset: Number(flag(args, "offset")) } : {}),
						}),
					);
					break;
				case "wait":
					if (!rest[0]) die(HELP);
					printJson(
						await c.send({
							op: "run_wait",
							runId: rest[0],
							...(flag(args, "match") ? { match: flag(args, "match") } : {}),
							...(flag(args, "timeout-ms") ? { timeoutMs: Number(flag(args, "timeout-ms")) } : {}),
						}),
					);
					break;
				case "kill":
					if (!rest[0]) die(HELP);
					printJson(
						await c.send({
							op: "run_kill",
							runId: rest[0],
							...(flag(args, "grace-ms") ? { graceMs: Number(flag(args, "grace-ms")) } : {}),
							...(args.flags.has("force") ? { force: true } : {}),
						}),
					);
					break;
				case "signal":
					if (!rest[0] || !rest[1]) die(HELP);
					printJson(await c.send({ op: "run_signal", runId: rest[0], signal: rest[1] }));
					break;
				case "save":
					if (!rest[0] || !rest[1]) die(HELP);
					printJson(
						await c.send({
							op: "run_save",
							runId: rest[0],
							name: rest[1],
							...(flag(args, "kind") ? { kind: flag(args, "kind") } : {}),
						}),
					);
					break;
				case "restart":
					if (!rest[0]) die(HELP);
					printJson(await c.send({ op: "run_restart", runId: rest[0] }));
					break;
				case "prune":
					printJson(
						await c.send({
							op: "run_prune",
							...(flag(args, "older-than-ms") ? { olderThanMs: Number(flag(args, "older-than-ms")) } : {}),
							...(flag(args, "keep") ? { keep: Number(flag(args, "keep")) } : {}),
						}),
					);
					break;
				default:
					die(HELP);
			}
			c.close();
			return;
		}
		case "exec": {
			// everything after `exec` (past the `--` separator) is the command:
			// `swarm exec -- echo hi` → positionals [exec echo hi].
			const cmdParts = [a1, ...rest].filter((x): x is string => !!x);
			if (cmdParts.length === 0) die(HELP);
			const c = client(targetServer(args).url, opToken(args));
			const detached = args.flags.has("detach");
			const waitMs = detached ? 0 : Number(flag(args, "wait-ms") ?? "30000");
			if (!Number.isFinite(waitMs)) die(`--wait-ms must be a number`);
			printJson(
				await c.send({
					op: "run_exec",
					spawn: { cmd: cmdParts[0]!, ...(cmdParts.length > 1 ? { args: cmdParts.slice(1) } : {}), ...(flag(args, "cwd") ? { cwd: flag(args, "cwd") } : {}) },
					waitMs,
					...(flag(args, "timeout-ms") ? { timeoutMs: Number(flag(args, "timeout-ms")) } : {}),
					...(flag(args, "name") ? { name: flag(args, "name") } : {}),
				}),
			);
			c.close();
			return;
		}
		case "listen": {
			const sessionId = flag(args, "session");
			const runId = flag(args, "run");
			const program = flag(args, "program");
			const chosen = [sessionId, runId, program].filter((v): v is string => typeof v === "string");
			if (chosen.length !== 1) die(HELP);
			const c = client(targetServer(args).url, opToken(args));
			c.onEvent((frame) => {
				console.log(JSON.stringify(frame));
			});
			await c.send({
				op: "listen",
				...(sessionId ? { sessionId } : {}),
				...(runId ? { runId } : {}),
				...(program ? { program } : {}),
				on: true,
			});
			const off = {
				op: "listen",
				...(sessionId ? { sessionId } : {}),
				...(runId ? { runId } : {}),
				...(program ? { program } : {}),
				on: false,
			};
			const cleanup = (): void => {
				void c.send(off).catch(() => {});
				setTimeout(() => {
					c.close();
					process.exit(0);
				}, 100);
			};
			process.once("SIGINT", cleanup);
			process.once("SIGTERM", cleanup);
			// stream forever — Ctrl-C sends {on:false} best-effort via close
			await new Promise<void>(() => {});
			return;
		}
		case "events": {
			if (!a1) {
				console.error(HELP);
				process.exitCode = 1;
				return;
			}
			const c = client(targetServer(args).url, opToken(args));
			const limit = Number(args.flags.get("limit") ?? 100) || 100;
			printJson(await c.send({ op: "events", sessionId: a1, limit }));
			c.close();
			return;
		}
		case "history": {
			const c = client(targetServer(args).url, opToken(args));
			printJson(await c.send({ op: "history" }));
			c.close();
			return;
		}
		case "templates": {
			const c = client(targetServer(args).url, opToken(args));
			printJson(await c.send({ op: "templates" }));
			c.close();
			return;
		}
		case "send": {
			const text = rest.join(" ");
			if (!a1 || !text) {
				console.error(HELP);
				process.exitCode = 1;
				return;
			}
			const c = client(targetServer(args).url, opToken(args));
			printJson(
				await c.send({
					op: "input",
					target: a1,
					body: { type: "input_followup", text },
				}),
			);
			c.close();
			return;
		}
		case "control": {
			const action = rest[0] as ControlAction | undefined;
			if (!a1 || !action) {
				console.error(HELP);
				process.exitCode = 1;
				return;
			}
			const c = client(targetServer(args).url, opToken(args));
			printJson(await c.send({ op: "control", target: a1, action }));
			c.close();
			return;
		}
		case "scan": {
			const dir =
				(args.flags.get("templates") as string) ??
				homeLayout(resolveHome(args.flags)).templatesDir;
			for (const t of scanTemplates(dir)) {
				console.log(
					`${(t.id ?? "?").padEnd(20)} ${t.file} → ${t.path}${t.description ? ` — ${t.description}` : ""}`,
				);
			}
			return;
		}
		default:
			console.log(HELP);
			return;
	}
}

void main().catch((err) => {
	console.error(`[swarm] ${err instanceof Error ? err.message : String(err)}`);
	process.exit(process.exitCode ?? 1);
});
