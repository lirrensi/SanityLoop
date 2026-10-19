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
//   swarm agents kill <sessionId>              [--server ws://...]  (terminate signal)
//   swarm procs list                           [--server ws://...]
//   swarm procs start <name> <template|file> [--autorestart] [--prompt TEXT]
//   swarm procs save <name> <template|file> [--autorestart]
//   swarm procs stop <name> | restart <name> [--prompt TEXT] | remove <name>
//   swarm procs autorestart <name> <true|false>
//   swarm procs get <name>
//   swarm tasks list | define <name> <every|at|manual> [--every-ms N] [--at EPOCH] [--from ...]
//   swarm tasks fire <name> [--prompt TEXT] | swarm tasks trigger <name> [--context TEXT] [--prompt TEXT]
//   swarm tasks pause <name> | resume <name> | remove <name> | get <name>
//   swarm send <sessionId> <text>              [--server ws://...]
//   swarm control <sessionId> <stop|abort|pause|wake> [--server ws://...]
//   swarm history | templates                  [--server ws://...]
//   swarm scan [--templates DIR]
//
// `serve` runs the daemon in-process (it IS the daemon). The rest are clients
// that talk to a running daemon over the wire — the same protocol the UI will
// speak. Boot resubmits every kept process whose desired state is running —
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
  swarm agents [--server ws://H:P]
  swarm agents get <sessionId> [--server ws://H:P]
  swarm agents kill <sessionId> [--server ws://H:P]
  swarm procs list [--server ws://H:P]
  swarm procs start <name> <template|file> [--autorestart] [--prompt TEXT]
  swarm procs save <name> <template|file> [--autorestart]
  swarm procs stop <name> | swarm procs restart <name> [--prompt TEXT] | swarm procs remove <name>
  swarm procs autorestart <name> <true|false>
  swarm procs get <name>
  swarm tasks list [--server ws://H:P]
  swarm tasks define <name> <every|at|manual> [--every-ms N] [--at EPOCH] [--from T] [--file F]
  swarm tasks fire <name> [--prompt TEXT] | swarm tasks trigger <name> [--context TEXT] [--prompt TEXT]
  swarm tasks pause <name> | swarm tasks resume <name>
  swarm tasks remove <name> | swarm tasks get <name>
  swarm send <sessionId> <text> [--server ws://H:P]
  swarm control <sessionId> <stop|abort|pause|wake> [--server ws://H:P]
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

/** The operator's token: --token admin=<tok> (only needed when the daemon has tokens). */
function opToken(args: Args): string | undefined {
	const raw = args.flags.get("token");
	if (typeof raw !== "string") return undefined;
	const eq = raw.indexOf("=");
	return eq >= 0 ? raw.slice(eq + 1) : raw;
}

/** A minimal WS client for the operator commands (the join extension needs an agent; this doesn't). */
function client(
	server: string,
	operatorToken?: string,
): {
	send(frame: unknown): Promise<unknown>;
	close(): void;
} {
	const ws = new WebSocket(server);
	const pending = new Map<
		string,
		{ resolve: (d: unknown) => void; reject: (e: Error) => void }
	>();
	let seq = 0;
	const queue: (() => void)[] = [];
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
		let frame: { op: string; id?: string; data?: unknown; error?: string };
		try {
			frame = JSON.parse((data as Buffer).toString()) as typeof frame;
		} catch {
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
			// dial every mount — failures don't kill the daemon, they log and retry
			for (let i = 0; i < connects.length; i++) {
				server.federate({
					url: connects[i]!,
					as: aliases[i],
					token: opToken(args),
				});
			}
			// keep the process alive — the daemon IS this process
			await new Promise<void>(() => {});
			return;
		}
		case "agents": {
			const sub = a1 ?? "list";
			const c = client(targetServer(args).url, opToken(args));
			if (sub === "list") {
				const rows = (await c.send({ op: "agents_list" })) as Parameters<
					typeof printAgentRow
				>[0][];
				for (const r of rows) printAgentRow(r);
			} else if (sub === "get") {
				if (!rest[0]) die(HELP);
				printJson(await c.send({ op: "agents_get", sessionId: rest[0] }));
			} else if (sub === "kill") {
				if (!rest[0]) die(HELP);
				const res = (await c.send({ op: "kill", sessionId: rest[0] })) as { ok: boolean };
				console.log(`kill: ${res.ok ? "ok" : "not found / not online"}`);
			} else {
				die(HELP);
			}
			c.close();
			return;
		}
		case "procs": {
			const sub = a1 ?? "list";
			const c = client(targetServer(args).url, opToken(args));
			switch (sub) {
				case "list":
					printJson(await c.send({ op: "proc_list" }));
					break;
				case "get":
					if (!rest[0]) die(HELP);
					printJson(await c.send({ op: "proc_get", name: rest[0] }));
					break;
				case "start": {
					const [name, src] = rest;
					if (!name || !src) die(HELP);
					// source = template id when it resolves, else an agent file path
					const looksFile = src.includes("/") || src.includes("\\") || src.endsWith(".ts") || src.endsWith(".js");
					printJson(
						await c.send({
							op: "proc_start",
							name,
							...(looksFile ? { file: src } : { from: src }),
							...(args.flags.has("autorestart") ? { autorestart: true } : {}),
							...(flag(args, "prompt") ? { prompt: flag(args, "prompt") } : {}),
						}),
					);
					break;
				}
				case "save": {
					const [name, src] = rest;
					if (!name) die(HELP);
					const looksFile = !!src && (src.includes("/") || src.includes("\\") || src.endsWith(".ts") || src.endsWith(".js"));
					printJson(
						await c.send({
							op: "proc_save",
							name,
							...(src ? (looksFile ? { file: src } : { from: src }) : {}),
							...(args.flags.has("autorestart") ? { autorestart: true } : {}),
						}),
					);
					break;
				}
				case "stop":
					if (!rest[0]) die(HELP);
					printJson(await c.send({ op: "proc_stop", name: rest[0] }));
					break;
				case "remove":
					if (!rest[0]) die(HELP);
					printJson(await c.send({ op: "proc_remove", name: rest[0] }));
					break;
				case "restart": {
					if (!rest[0]) die(HELP);
					printJson(
						await c.send({
							op: "proc_restart",
							name: rest[0],
							...(flag(args, "prompt") ? { prompt: flag(args, "prompt") } : {}),
						}),
					);
					break;
				}
				case "autorestart": {
					const [name, val] = rest;
					if (!name || (val !== "true" && val !== "false")) die(HELP);
					printJson(
						await c.send({ op: "proc_set_autorestart", name, autorestart: val === "true" }),
					);
					break;
				}
				default:
					die(HELP);
			}
			c.close();
			return;
		}
		case "tasks": {
			const sub = a1 ?? "list";
			const c = client(targetServer(args).url, opToken(args));
			switch (sub) {
				case "list":
					printJson(await c.send({ op: "task_list" }));
					break;
				case "get":
					if (!rest[0]) die(HELP);
					printJson(await c.send({ op: "task_get", name: rest[0] }));
					break;
				case "define": {
					const [name, fire] = rest;
					if (!name || (fire !== "every" && fire !== "at" && fire !== "manual")) die(HELP);
					const everyMs = flag(args, "every-ms") ?? flag(args, "everyMs");
					const at = flag(args, "at");
					const from = flag(args, "from");
					const file = flag(args, "file");
					printJson(
						await c.send({
							op: "task_define",
							name,
							fire,
							...(everyMs ? { everyMs: Number(everyMs) } : {}),
							...(at ? { at: Number(at) } : {}),
							...(from ? { from } : {}),
							...(file ? { file } : {}),
						}),
					);
					break;
				}
				case "fire": {
					if (!rest[0]) die(HELP);
					printJson(
						await c.send({
							op: "task_fire",
							name: rest[0],
							...(flag(args, "prompt") ? { prompt: flag(args, "prompt") } : {}),
						}),
					);
					break;
				}
				case "trigger": {
					if (!rest[0]) die(HELP);
					printJson(
						await c.send({
							op: "task_trigger",
							name: rest[0],
							...(flag(args, "context") ? { context: flag(args, "context") } : {}),
							...(flag(args, "prompt") ? { prompt: flag(args, "prompt") } : {}),
						}),
					);
					break;
				}
				case "pause":
					if (!rest[0]) die(HELP);
					printJson(await c.send({ op: "task_pause", name: rest[0], paused: true }));
					break;
				case "resume":
					if (!rest[0]) die(HELP);
					printJson(await c.send({ op: "task_resume", name: rest[0] }));
					break;
				case "remove":
					if (!rest[0]) die(HELP);
					printJson(await c.send({ op: "task_remove", name: rest[0] }));
					break;
				default:
					die(HELP);
			}
			c.close();
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
	process.exitCode ??= 1;
});
