// ============================================================================
// sanity/src/packages/swarm/src/server/federate.ts — THE MOUNT. Federation as
// one dumb dial: this daemon connects to another daemon as a PEER, learns its
// declared name, and mirrors its online workers into our registry under that
// name as a room subtree.
//
//   <ourSwarm>/<mountName>/<remoteRoom>/<remoteSessionId>
//
// The rules, encoded here and nowhere else:
//   · state is truth — mirrors are upserted from the remote's registry snapshot
//     and advanced ONLY by the remote workers' own reports, folded by the host
//     daemon's existing fold. Nothing is invented, not even remotely.
//   · offline is free — the mount socket drops → every mirror under it goes
//     offline. TCP is the heartbeat. Reconnect with backoff, re-list, follow.
//   · authority stays home — input/control/kill/restart on a mirror are
//     forwarded verbatim to the remote; ITS tokens and perms decide.
//   · no transit — the remote's own mirrors (origin "mirrored") are never
//     mirrored. A sees B's workers, never B's view of C. Mount the distant
//     daemon directly if you want it; no infinity mirrors.
//   · names are claimed loudly — mount name = remote's declared name (or --as).
//     Collision with our own name or another mount = the mount refuses. Silence
//     is how ghost topologies happen; we don't do silence.
//
// The mount is not an agent. It speaks the wire, it never thinks.
// ============================================================================
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { ROOT_ROOM, normalizeRoom } from "../protocol.ts";
import type { WorkerInfo } from "../protocol.ts";
import type { FederateOptions, MirrorForward } from "./index.ts";

/** What a mount may do to the host daemon's state — the narrow door. */
export interface FederationHost {
	/** The declared name of THIS daemon (undefined = hermit — mounts refused). */
	readonly swarmName: string | undefined;
	/** Claim a mount name. False = taken (by us or another mount) — refuse loudly. */
	claimMount(name: string): boolean;
	releaseMount(name: string): void;
	/** Follow the remote's registry: upsert its workers as mirrors under the
	 *  mount, remove the ones it forgot. Returns sessionId → address links. */
	syncMount(
		mount: string,
		remote: WorkerInfo[],
		forward: MirrorForward,
	): { sessionId: string; address: string }[];
	/** The mount's wire died — every mirror under it follows into a status. */
	setMountStatus(mount: string, status: "online" | "offline"): void;
	/** A relayed voice from a mirrored worker — folded, never invented. */
	reportEntry(address: string, event: string, payload: unknown): void;
}

export interface MountHandle {
	/** The mount name once known (after the first welcome) — undefined until then. */
	mount(): string | undefined;
	/** Drop the wire and stop reconnecting. */
	stop(): void;
}

/** Backoff cap for mount reconnects — patient, not immortal. */
const MAX_RECONNECT_MS = 30_000;
/** RPC timeout for remote list calls. */
const RPC_TIMEOUT_MS = 10_000;

export function createMount(
	host: FederationHost,
	opts: FederateOptions,
): MountHandle {
	const log = (msg: string): void =>
		console.log(`[fed] ${opts.as ?? opts.url}: ${msg}`);

	if (!host.swarmName) {
		// the hermit rule — a mount needs a name to stamp under, so does the dialer
		log("refused: this daemon is unnamed — declare a name to federate");
		return { mount: () => undefined, stop: () => {} };
	}

	let ws: WebSocket | undefined;
	let socketOwner = 0;
	let attempt = 0;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	/** The mount name — remote's declared name, or --as. Undefined until welcome. */
	let mountName: string | undefined;
	let claimed = false;
	/** remote (bare) sessionId → our mirror address. */
	const links = new Map<string, string>();
	/** pending rpc (list) — request id → resolver. */
	const pending = new Map<
		string,
		{
			resolve: (data: unknown) => void;
			reject: (err: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	let seq = 0;

	const send = (frame: Record<string, unknown>): void => {
		if (ws && ws.readyState === WebSocket.OPEN)
			ws.send(JSON.stringify(frame));
	};

	const rpcList = (): Promise<WorkerInfo[]> =>
		new Promise((resolve, reject) => {
			const id = `f${++seq}`;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error("remote list timed out"));
			}, RPC_TIMEOUT_MS);
			timer.unref?.();
			pending.set(id, { resolve, reject, timer });
			send({ op: "list", id });
		});

	/** Mirror the remote's current truth: upsert + prune + subscribe. */
	const refresh = async (): Promise<void> => {
		if (!mountName) return;
		try {
			const remote = (await rpcList()) as WorkerInfo[];
			const mapped = host.syncMount(mountName, remote, forward);
			links.clear();
			for (const l of mapped) links.set(l.sessionId, l.address);
			// subscribe to every mirrored worker — reports flow back as events
			for (const [sessionId] of links) {
				send({ op: "listen", sessionId, on: true });
			}
			log(
				`mirrored ${mapped.length} worker(s) under "${mountName}" from ${opts.url}`,
			);
		} catch (err) {
			log(
				`refresh failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	};

	/** Ops routed down to the remote — verbatim, its tokens decide. */
	const forward: MirrorForward = (frame) => send(frame);

	const scheduleReconnect = (): void => {
		if (reconnectTimer) return;
		const delay = Math.min(500 * 2 ** attempt, MAX_RECONNECT_MS);
		attempt++;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined;
			connect();
		}, delay);
		reconnectTimer.unref?.();
	};

	const handleMessage = (raw: unknown): void => {
		let frame: Record<string, unknown>;
		try {
			frame = JSON.parse(
				typeof raw === "string" ? raw : (raw as Buffer).toString(),
			) as Record<string, unknown>;
		} catch {
			return;
		}
		switch (frame.op) {
			case "welcome":
				{
					attempt = 0;
					const remoteName =
						typeof frame.swarm === "string" ? frame.swarm : undefined;
					if (!remoteName) {
						// a hermit cannot be mounted — there is no name to stamp under
						log("refused: remote daemon has no declared name (hermit)");
						ws?.close();
						return;
					}
					const wanted = opts.as ?? remoteName;
					if (wanted !== mountName) {
						if (!host.claimMount(wanted)) {
							log(
								`refused: mount name "${wanted}" is taken (our own name or another mount)`,
							);
							ws?.close();
							return; // collision is a config error — no retry, stay loud
						}
						if (claimed) host.releaseMount(mountName!);
						mountName = wanted;
						claimed = true;
					}
					void refresh();
				}
				return;
			case "event":
				{
					// a relayed voice from a worker we subscribed to — fold it locally
					const sessionId = String(frame.target ?? "");
					const address = links.get(sessionId);
					if (address)
						host.reportEntry(address, String(frame.event), frame.payload);
				}
				return;
			case "result":
				{
					const id = typeof frame.id === "string" ? frame.id : undefined;
					const p = id ? pending.get(id) : undefined;
					if (!p) return;
					pending.delete(id);
					clearTimeout(p.timer);
					p.resolve(frame.data);
				}
				return;
			case "error":
				{
					const id = typeof frame.id === "string" ? frame.id : undefined;
					const p = id ? pending.get(id) : undefined;
					if (!p) {
						log(`remote error: ${String(frame.error ?? "?")}`);
						return;
					}
					pending.delete(id!);
					clearTimeout(p.timer);
					p.reject(new Error(String(frame.error ?? "remote error")));
				}
				return;
			default:
				return; // pong, closed, input, control — not ours to interpret
		}
	};

	const connect = (): void => {
		const owner = ++socketOwner;
		let socket: WebSocket;
		try {
			socket = new WebSocket(opts.url);
		} catch (err) {
			log(
				`bad mount url "${opts.url}": ${err instanceof Error ? err.message : String(err)}`,
			);
			return;
		}
		ws = socket;
		socket.on("open", () => {
			if (owner !== socketOwner) return;
			// we are a PEER on the remote — full visibility of its registry snapshot
			send({
				op: "register",
				sessionId: `fed-${randomUUID().slice(0, 8)}`,
				agentId: "federation",
				mode: "peer",
				persistent: false,
				token: opts.token,
			});
		});
		socket.on("message", (data) => {
			if (owner !== socketOwner) return;
			handleMessage(data);
		});
		socket.on("error", () => {
			/* the close handler owns reconnection */
		});
		socket.on("close", () => {
			if (owner !== socketOwner) return;
			if (ws === socket) ws = undefined;
			// the wire is gone — every mirror under this mount follows it down
			if (mountName) host.setMountStatus(mountName, "offline");
			links.clear();
			for (const [, p] of pending) {
				clearTimeout(p.timer);
				p.reject(new Error("mount connection closed"));
			}
			pending.clear();
			scheduleReconnect();
		});
	};

	connect();

	return {
		mount: () => mountName,
		stop() {
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
				reconnectTimer = undefined;
			}
			socketOwner++; // orphan every live socket's handlers
			if (claimed && mountName) host.releaseMount(mountName);
			claimed = false;
			if (ws) {
				try {
					ws.close();
				} catch {
					/* ignore */
				}
				ws = undefined;
			}
		},
	};
}

/** Reserved — rooms normalize through the same helper the daemon uses. */
export const mountRoom = (mount: string, room?: string): string =>
	`${mount}/${normalizeRoom(room) ?? ROOT_ROOM}`;
