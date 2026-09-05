// ============================================================================
// sanity/src/packages/swarm/src/server/cli.ts — the operator's door.
// ONE API, MANY SURFACES: the CLI is a WS client speaking the same ops the
// REST routes and the frames speak — same server, same tokens, same perms.
//
//   swarm serve [--port N] [--addr H] [--templates DIR] [--manifest FILE]
//              [--name N] [--token admin=TOK --token peer=TOK --token worker=TOK]
//              [--connect ws://B [--as ALIAS]]... [--resurrect]
//   swarm create <template> [--session ID] [--prompt TEXT] [--server ws://...]
//   swarm list    [--server ws://...]
//   swarm get <sessionId>                        [--server ws://...]
//   swarm events <sessionId> [--limit N]         [--server ws://...]
//   swarm history                                [--server ws://...]
//   swarm templates                              [--server ws://...]
//   swarm send <sessionId> <text>                [--server ws://...]
//   swarm control <sessionId> <stop|abort|pause|wake> [--server ws://...]
//   swarm kill <sessionId>      [--server ws://...]
//   swarm restart <sessionId> [--prompt TEXT]   [--server ws://...]
//   swarm scan [--templates DIR]
//
// `serve` runs the daemon in-process (it IS the daemon). The rest are clients
// that talk to a running daemon over the wire — the same protocol the UI will
// speak. Command the daemon to spawn an admin agent: `swarm create admin`.
// ============================================================================
import { createSwarmServer } from "./index.ts";
import { ensureScaffold, homeLayout, loadConfig, resolveHome } from "./config.ts";
import { Spawner } from "./spawner.ts";
import { DEFAULT_PORT } from "../protocol.ts";
import type { ControlAction, SwarmRole } from "../protocol.ts";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";

const HELP = `usage:
  swarm serve [--dir HOME] [--port N] [--addr H] [--templates DIR] [--manifest FILE]
              [--name N] [--token <role>=<tok>]... [--connect ws://B [--as ALIAS]]... [--resurrect]
  swarm create <template> [--session ID] [--prompt TEXT] [--dir HOME] [--server ws://H:P]
  swarm list                                  [--dir HOME] [--server ws://H:P]
  swarm get <sessionId>                       [--dir HOME] [--server ws://H:P]
  swarm events <sessionId> [--limit N]        [--dir HOME] [--server ws://H:P]
  swarm history                               [--dir HOME] [--server ws://H:P]
  swarm templates                             [--dir HOME] [--server ws://H:P]
  swarm send <sessionId> <text>               [--dir HOME] [--server ws://H:P]
  swarm control <sessionId> <stop|abort|pause|wake> [--dir HOME] [--server ws://H:P]
  swarm kill <sessionId>                      [--dir HOME] [--server ws://H:P]
  swarm restart <sessionId> [--prompt TEXT]   [--dir HOME] [--server ws://H:P]
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
			return new Promise<unknown>((resolve, reject) => {
				pending.set(id, { resolve, reject });
				const go = () => ws.send(JSON.stringify({ ...(frame as object), id }));
				if (ws.readyState === WebSocket.OPEN) go();
				else queue.push(go);
			});
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

const printWorkerRow = (r: {
	status: string;
	state?: string;
	sessionId: string;
	address?: string;
	agentId: string;
	persistent: boolean;
	spawned: boolean;
}): void =>
	console.log(
		`${r.status.padEnd(7)} ${(r.state ?? "-").padEnd(7)} ${(r.address ?? r.sessionId).padEnd(40)} ${r.agentId}${r.persistent ? " [persistent]" : ""}${r.spawned ? " [spawned]" : ""}`,
	);

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
			const manifestPath =
				(args.flags.get("manifest") as string) ?? layout.manifestPath;
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
				manifestPath,
				resurrectOnBoot: args.flags.has("resurrect"),
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
		case "create": {
			if (!a1) {
				console.error(HELP);
				process.exitCode = 1;
				return;
			}
			const c = client(targetServer(args).url, opToken(args));
			const res = (await c.send({
				op: "create",
				template: a1,
				sessionId:
					typeof args.flags.get("session") === "string"
						? (args.flags.get("session") as string)
						: undefined,
				prompt:
					typeof args.flags.get("prompt") === "string"
						? (args.flags.get("prompt") as string)
						: undefined,
			})) as { sessionId: string; pid?: number };
			console.log(
				`created ${res.sessionId}${res.pid ? ` (pid ${res.pid})` : ""}`,
			);
			c.close();
			return;
		}
		case "list": {
			const c = client(targetServer(args).url, opToken(args));
			const rows = (await c.send({ op: "list" })) as Parameters<
				typeof printWorkerRow
			>[0][];
			for (const r of rows) printWorkerRow(r);
			c.close();
			return;
		}
		case "get": {
			if (!a1) {
				console.error(HELP);
				process.exitCode = 1;
				return;
			}
			const c = client(targetServer(args).url, opToken(args));
			printJson(await c.send({ op: "get", sessionId: a1 }));
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
		case "kill":
		case "restart": {
			if (!a1) {
				console.error(HELP);
				process.exitCode = 1;
				return;
			}
			const c = client(targetServer(args).url, opToken(args));
			const res = (await c.send({
				op: cmd,
				sessionId: a1,
				prompt:
					cmd === "restart" && typeof args.flags.get("prompt") === "string"
						? (args.flags.get("prompt") as string)
						: undefined,
			})) as { ok: boolean };
			console.log(`${cmd}: ${res.ok ? "ok" : "not spawned / already gone"}`);
			c.close();
			return;
		}
		case "scan": {
			const dir =
				(args.flags.get("templates") as string) ??
				homeLayout(resolveHome(args.flags)).templatesDir;
			const s = new Spawner({ templatesDir: dir });
			for (const t of s.scanTemplates()) {
				console.log(
					`${(t.id ?? "?").padEnd(20)} ${(t.mode ?? "worker").padEnd(7)} ${t.file} → ${t.path}${t.description ? ` — ${t.description}` : ""}`,
				);
			}
			return;
		}
		default:
			console.log(HELP);
			return;
	}
}

main().catch((err) => {
	console.error(`[swarm] ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
