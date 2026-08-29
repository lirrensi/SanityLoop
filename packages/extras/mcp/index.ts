// ============================================================================
// sanity/src/extras/mcp/index.ts — MCP adapter (stdio + remote HTTP servers)
// ============================================================================
// MCP is "just an extension that adds a list of tools" (what-we-need #15.2).
// Nothing in core knows MCP exists — this adapter spawns/connects servers,
// handshakes, lists their tools, converts them to plain Sanity Tools, and
// hands the list over. Three-step lifecycle, fully synchronous on the agent side:
//
//   const mcp = createMcp({                    // 1. declare — sync, no I/O
//     fs:  { command: ["npx", "-y", "@modelcontextprotocol/server-filesystem"] },
//     web: { url: "https://example.com/mcp", headers: { authorization: "Bearer …" } },
//   });
//   await mcp.init(15_000);                    // 2. connect — the ONLY await.
//                                              //    forced max timeout (optional,
//                                              //    overrides per-server ones).
//                                              //    Per-server failure degrades
//                                              //    to state.mcp.<name>.status,
//                                              //    never throws the whole init.
//   agent.install(mcp.getPlugin());            // 3. insert the READY tool list.
//                                              //    install is sync — the list
//                                              //    exists before the agent runs.
//
// Built on @modelcontextprotocol/client v2 (the 2026-07-28 spec line), which
// keeps this file almost wrapper-free:
//   - connect()/callTool()/listTools() take NATIVE RequestOptions timeouts
//     → no homegrown deadline racing anywhere in here.
//   - A failed spawn/handshake REJECTS connect() cleanly (no async landmines)
//     → per-server failure is one try/catch away from a degraded status.
//   - Transports: command present → StdioClientTransport; url present →
//     StreamableHTTPClientTransport. Legacy SSE-only servers are NOT
//     auto-fallback anymore (SSE is deprecated upstream) — declare a different
//     transport or proxy if you need one.
//   - Omitting env lets the SDK inherit its safe default environment;
//     declaring env merges your keys over the parent's.
//
// Sanity deviations from opencode's adapter:
//   - tool names namespaced server_tool (sanitized) — collision-proof
//   - isError → error TEXT as the answer (never throw — the loop does
//     error-as-result, the model sees the text and self-corrects)
//   - notifications/tools/list_changed → re-list + replace that server's set
// ============================================================================
import { pathToFileURL } from "node:url";
// heavy MCP values load LAZILY inside connectServer (below) so installing
// @sanityloop/extras never pulls @modelcontextprotocol/*; types stay static.
import type {
	Client,
	Tool as McpTool,
	CallToolResult,
	RequestOptions,
} from "@modelcontextprotocol/client";
import type {
	GodObject,
	JsonSchema,
	Plugin,
	ToolType,
	ToolResult,
} from "@sanityloop/core";

/** One server declaration — opencode-shaped, plus remote URLs. */
export interface McpServerConfig {
	/** The command to spawn: "npx" + args, OR a full [cmd, ...args] array. */
	command?: string | string[];
	/** Extra args when `command` is a bare string. */
	args?: string[];
	/** Remote MCP endpoint (streamable HTTP). Present → remote mode; `command` ignored. */
	url?: string;
	/** Extra HTTP headers for the remote connection (auth etc.). Remote only. */
	headers?: Record<string, string>;
	/** Working directory for the child. Stdio only. */
	cwd?: string;
	/** Extra environment for the child, merged over the parent's. Stdio only.
	 * Omitted → the SDK's safe default environment. */
	env?: Record<string, string>;
	/** Connect/call timeout in ms. Default 30_000. init(maxTimeout) overrides. */
	timeout?: number;
	/** false = skip this server entirely. */
	enabled?: boolean;
}

/** The declaration object: server name → config. */
export type McpConfig = Record<string, McpServerConfig>;

export type McpServerStatus =
	| { status: "connected"; tools: string[] }
	| { status: "failed"; error: string }
	| { status: "disabled" };

const DEFAULT_TIMEOUT = 30_000;

/** Name-spacing — opencode's rule: two servers may both expose `read`. */
function sanitize(name: string): string {
	return name.replace(/[^a-zA-Z0-9_]/g, "_");
}
function toolName(server: string, name: string): string {
	return `${sanitize(server)}_${sanitize(name)}`;
}

function textBlocks(content: CallToolResult["content"]): string[] {
	return content
		.filter(
			(c): c is { type: "text"; text: string } =>
				c.type === "text" && typeof (c as { text?: unknown }).text === "string",
		)
		.map((c) => c.text);
}

interface ServerRuntime {
	key: string;
	cfg: McpServerConfig;
	status: McpServerStatus;
	client?: Client;
	/** The Sanity tools currently registered for this server. */
	tools: ToolType[];
}

/** A fresh Client that answers roots/list with the working dir — servers that ask get a home. */
function makeClient(server: ServerRuntime, ClientCtor: typeof import("@modelcontextprotocol/client")["Client"]): Client {
	const client = new ClientCtor(
		{ name: "sanityloop", version: "0.1.0" },
		{ capabilities: { roots: {} } },
	);
	client.setRequestHandler("roots/list", () =>
		Promise.resolve({
			roots: [
				{ uri: pathToFileURL(server.cfg.cwd ?? process.cwd()).href },
			],
		}),
	);
	return client;
}

/** Connect one declared server and fill in its runtime. Never throws —
 * any failure becomes a degraded `failed` status on the runtime itself. */
async function connectServer(server: ServerRuntime): Promise<void> {
	const cfg = server.cfg;
	const timeout = cfg.timeout ?? DEFAULT_TIMEOUT;

	// lazy-optional: MCP loads ONLY when a connect actually happens.
	// @sanityloop/extras ships zero deps; this subpath declares its need.
	let sdk: typeof import("@modelcontextprotocol/client");
	let stdio: typeof import("@modelcontextprotocol/client/stdio");
	try {
		sdk = await import("@modelcontextprotocol/client");
		stdio = await import("@modelcontextprotocol/client/stdio");
	} catch (err) {
		throw new Error(
			'[sanity] mcp: this subpath needs "@modelcontextprotocol/*", which is not installed. Run: npm i @modelcontextprotocol/client',
			{ cause: err },
		);
	}

	const client = makeClient(server, sdk.Client);
	try {
		if (cfg.url !== undefined) {
			await client.connect(
				new sdk.StreamableHTTPClientTransport(new URL(cfg.url), {
					requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
				}),
				{ timeout },
			);
		} else {
			const [cmd, ...args] =
				typeof cfg.command === "string"
					? [cfg.command, ...(cfg.args ?? [])]
					: cfg.command!;
			const env = cfg.env
				? ({ ...process.env, ...cfg.env } as Record<string, string>)
				: undefined;
			await client.connect(
				new stdio.StdioClientTransport({
					command: cmd,
					args,
					cwd: cfg.cwd,
					stderr: "pipe",
					env,
				}),
				{ timeout },
			);
		}
		const listed = await client.listTools(undefined, { timeout });
		server.client = client;
		server.tools = listed.tools.map((t) => toSanityTool(server, t));
		server.status = {
			status: "connected",
			tools: server.tools.map((t) => t.name),
		};
	} catch (err) {
		// kill whatever half-exists, then degrade — init never throws for one server
		await client.close().catch(() => {});
		server.status = {
			status: "failed",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/** Convert an MCP tool def into a Sanity Tool bound to its client. */
function toSanityTool(server: ServerRuntime, mcpTool: McpTool): ToolType {
	const client = server.client!;
	const timeout = server.cfg.timeout ?? DEFAULT_TIMEOUT;
	return {
		name: toolName(server.key, mcpTool.name),
		description: mcpTool.description ?? "",
		inputSchema: {
			type: "object",
			...(mcpTool.inputSchema as Record<string, unknown> | undefined),
			properties:
				(
					mcpTool.inputSchema as
						| { properties?: Record<string, unknown> }
						| undefined
				)?.properties ?? {},
			additionalProperties: false,
		} as JsonSchema,
		...(mcpTool.outputSchema !== undefined
			? { outputSchema: mcpTool.outputSchema as JsonSchema }
			: {}),
		async execute(params: unknown, _ctx: GodObject): Promise<ToolResult> {
			try {
				const result = await client.callTool(
					{
						name: mcpTool.name,
						arguments: (params ?? {}) as Record<string, unknown>,
					},
					{
						resetTimeoutOnProgress: true,
						timeout,
						onprogress: () => {},
					} satisfies RequestOptions,
				);
				if (result.isError) {
					const text = textBlocks(result.content).join("\n\n");
					return {
						answer: `[mcp error from ${server.key}] ${text || "MCP tool returned an error"}`,
						stored: { server: server.key, mcpError: true },
						error: true,
						errorMessage: text || "MCP tool returned an error",
					};
				}
				let answer: string;
				if (result.content.length > 0) {
					answer = textBlocks(result.content).join("\n");
				} else if (
					result.structuredContent !== undefined &&
					result.structuredContent !== null
				) {
					answer = JSON.stringify(result.structuredContent);
				} else {
					answer = "";
				}
				return { answer, stored: { server: server.key } };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					answer: `[mcp call failed on ${server.key}] ${msg}`,
					stored: { server: server.key, error: msg },
					error: true,
					errorMessage: msg,
				};
			}
		},
	};
}

/**
 * The MCP adapter. create → init (the ONLY await) → getPlugin() → install.
 * init is idempotent; getPlugin() before a successful init throws.
 */
export class McpAdapter {
	private readonly servers: ServerRuntime[];
	private ready = false;
	private plugin: Plugin | undefined;

	constructor(config: McpConfig) {
		this.servers = Object.entries(config).map(([key, cfg]) => ({
			key,
			cfg,
			status:
				cfg.enabled === false
					? { status: "disabled" }
					: { status: "failed", error: "not initialized" },
			tools: [],
		}));
	}

	/**
	 * Connect every server, list + convert tools. `maxTimeout` (ms) FORCES a cap
	 * on every server, overriding their per-server timeout. Per-server failure
	 * degrades (state.mcp.<name>.status = failed) — the whole init never throws
	 * for one dead server. Idempotent: the second call resolves instantly.
	 */
	async init(maxTimeout?: number): Promise<this> {
		if (this.ready) return this;
		const cap = maxTimeout ?? DEFAULT_TIMEOUT;
		await Promise.all(
			this.servers
				.filter((s) => s.cfg.enabled !== false)
				.map(async (s) => {
					if (maxTimeout !== undefined) s.cfg = { ...s.cfg, timeout: cap };
					await connectServer(s);
					return s;
				}),
		);
		this.ready = true;
		return this;
	}

	/** The ready Plugin — install it and the tool list lands as-is. */
	getPlugin(): Plugin {
		if (!this.ready) {
			throw new Error(
				`[sanity] mcp: init() must resolve before getPlugin() — the tool list must be ready before install. ` +
					`await mcp.init(); then agent.install(mcp.getPlugin());`,
			);
		}
		if (this.plugin) return this.plugin;
		const servers = this.servers;
		this.plugin = {
			id: "mcp",
			install(agent: GodObject) {
				const connected = servers.filter(
					(s) => s.status.status === "connected" && s.client,
				);
				for (const s of connected) {
					for (const t of s.tools) agent.addTool(t);
					// a server announcing "tools changed" → re-list + replace its set
					s.client!.setNotificationHandler(
						"notifications/tools/list_changed",
						async () => {
							try {
								const listed = await s.client!.listTools();
								const next = listed.tools.map((t) => toSanityTool(s, t));
								// replace THIS server's set wholesale: remove what it had,
								// then insert the fresh list in full. (Diffing against the
								// PRE-change set here would delete the existing tools and
								// never re-add them — they'd vanish from the agent forever.)
								for (const t of s.tools) agent.removeTool(t.name);
								for (const t of next) agent.addTool(t);
								s.tools = next;
								s.status = {
									status: "connected",
									tools: next.map((t) => t.name),
								};
								if (agent.state.mcp)
									(agent.state.mcp as Record<string, unknown>)[s.key] =
										s.status;
							} catch {
								// a dead re-list is a failed server — note it, keep the old set
								s.status = {
									status: "failed",
									error: "tools/list_changed re-list failed",
								};
								if (agent.state.mcp)
									(agent.state.mcp as Record<string, unknown>)[s.key] =
										s.status;
							}
						},
					);
				}
				// every server's status lands in state — connected, failed, disabled
				agent.state.mcp ??= {};
				const mcpState = agent.state.mcp as Record<string, unknown>;
				for (const s of servers) mcpState[s.key] = s.status;
				if (connected.length > 0) {
					const desc = `${connected.length} server${connected.length === 1 ? "" : "s"} (${connected.reduce((n, s) => n + s.tools.length, 0)} tools)`;
					agent.addDeclaredCapability({ id: "mcp", description: desc });
				}
			},
			uninstall(agent: GodObject) {
				for (const s of servers) {
					for (const t of s.tools)
						if (agent.tools.some((x) => x.name === t.name))
							agent.removeTool(t.name);
					if (s.client) void s.client.close().catch(() => {});
					s.client = undefined;
					s.tools = [];
				}
				agent.removeDeclaredCapability("mcp");
				delete agent.state.mcp;
			},
		};
		return this.plugin;
	}

	/** The ready tools, flat — take the list, skip the plugin entirely. */
	get tools(): ToolType[] {
		return this.servers.flatMap((s) => s.tools);
	}

	/** Per-server statuses — mirrors what install writes to state.mcp. */
	get status(): Record<string, McpServerStatus> {
		return Object.fromEntries(this.servers.map((s) => [s.key, s.status]));
	}
}

/** The factory — declare, init, install. */
export function createMcp(config: McpConfig): McpAdapter {
	return new McpAdapter(config);
}
