// ============================================================================
// harness.ts — shared test scaffolding for the swarm package.
// Not a test file itself (no `node:test` calls) — imported by the *.test.ts.
// Provides: a temp daemon HOME, a started SwarmServer, and a tiny WS client
// that speaks the swarm wire (rpc by id, waitFor by op).
// ============================================================================
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSwarmServer, type SwarmServer } from "../src/server/index.ts";
import type { SwarmRole } from "../src/protocol.ts";
import WebSocket from "ws";

/** A throwaway HOME for one daemon under the system temp dir. */
export function tmpHome(): string {
	return mkdtempSync(join(tmpdir(), "swarm-test-"));
}

export interface DaemonOpts {
	home: string;
	/** The daemon's declared swarm name — absent = hermit. */
	name?: string;
	tokens?: Partial<Record<SwarmRole, string>>;
	port?: number;
	templatesDir?: string;
	manifestPath?: string;
	resurrectOnBoot?: boolean;
}

/** Start a daemon on a random port, bound to 127.0.0.1. */
export async function startDaemon(opts: DaemonOpts): Promise<SwarmServer> {
	const server = createSwarmServer({
		home: opts.home,
		addr: "127.0.0.1",
		port: opts.port ?? 0,
		name: opts.name,
		tokens: opts.tokens,
		templatesDir: opts.templatesDir,
		manifestPath: opts.manifestPath,
		resurrectOnBoot: opts.resurrectOnBoot,
	});
	await server.start();
	return server;
}

/** Minimal WS client that understands the swarm wire. */
export class WsClient {
	ws: WebSocket;
	private queue: any[] = [];
	private waiters = new Map<
		string,
		{ resolve: (d: any) => void; reject: (e: any) => void; timer: any }
	>();

	constructor(url: string) {
		this.ws = new WebSocket(url);
		this.ws.on("message", (d) => this.onMsg(d));
	}

	private onMsg(raw: WebSocket.RawData): void {
		let f: any;
		try {
			f = JSON.parse(raw.toString());
		} catch {
			return;
		}
		// rpc replies carry an id
		const isRpcReply = (f.op === "result" || f.op === "error") && f.id !== undefined;
		if (isRpcReply) {
			const w = this.waiters.get(String(f.id));
			if (w) {
				clearTimeout(w.timer);
				this.waiters.delete(String(f.id));
				f.op === "error" ? w.reject(new Error(f.error)) : w.resolve(f);
			}
			return;
		}
		// server-push frames: match by op
		const w = this.waiters.get(f.op);
		if (w) {
			clearTimeout(w.timer);
			this.waiters.delete(f.op);
			w.resolve(f);
			return;
		}
		this.queue.push(f);
	}

	ready(): Promise<void> {
		return new Promise((res) => {
			if (this.ws.readyState === WebSocket.OPEN) return res();
			this.ws.on("open", () => res());
		});
	}

	send(f: any): void {
		this.ws.send(JSON.stringify(f));
	}

	/** RPC: resolves with the matching `result` frame (rejects on `error`). */
	rpc(f: any, timeout = 5000): Promise<any> {
		const id = "r" + Math.random().toString(36).slice(2);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters.delete(id);
				reject(new Error("rpc timeout: " + f.op));
			}, timeout);
			this.waiters.set(id, { resolve, reject, timer });
			this.send({ ...f, id });
		});
	}

	/** Wait for a server-push frame by op (checks the backlog first). */
	waitFor(op: string, timeout = 5000): Promise<any> {
		const existing = this.queue.find((q) => q.op === op);
		if (existing) {
			this.queue = this.queue.filter((q) => q !== existing);
			return Promise.resolve(existing);
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters.delete(op);
				reject(new Error("waitFor timeout: " + op));
			}, timeout);
			this.waiters.set(op, { resolve, reject, timer });
		});
	}

	close(): void {
		try {
			this.ws.close();
		} catch {
			/* ignore */
		}
	}
}

/** Recursively remove a temp home (best-effort). */
export function rmHome(home: string): void {
	try {
		rmSync(home, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}
