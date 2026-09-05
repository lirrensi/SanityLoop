// ============================================================================
// rooms.test.ts — ROOMS + FEDERATION. A room is a path prefix, not an object.
// ONE visibility rule: an ancestor sees its descendants; sideways and upward:
// invisible. The swarm name is STAMPED by the daemon — workers never claim it.
// Federation = the daemon dials a daemon and mirrors its truth under the
// remote's declared name. State folds, never invents; authority stays home;
// no transit; names collide loudly.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { startDaemon, WsClient, tmpHome, rmHome } from "./harness.ts";
import type { SwarmServer } from "../src/server/index.ts";

/** Register a raw client and wait for the welcome. */
async function register(
	url: string,
	sessionId: string,
	mode: "worker" | "peer" | "admin",
	room?: string,
): Promise<WsClient> {
	const c = new WsClient(url);
	await c.ready();
	c.send({
		op: "register",
		sessionId,
		agentId: sessionId,
		mode,
		...(room !== undefined ? { room } : {}),
	});
	await c.waitFor("welcome");
	return c;
}

/** Poll until fn() is true — the daemon folds asynchronously, we wait for truth. */
async function until(fn: () => boolean, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (fn()) return;
		await new Promise((r) => setTimeout(r, 40));
	}
	assert.ok(fn(), "condition not met in time");
}

// ---------------------------------------------------------------------------
// ROOMS: stamping, addressing, visibility
// ---------------------------------------------------------------------------

test("rooms: the daemon stamps the address; a mount sees only its subtree", async () => {
	const home = tmpHome();
	let server: SwarmServer | undefined;
	let w1: WsClient | undefined;
	let w2: WsClient | undefined;
	let peer: WsClient | undefined;
	let admin: WsClient | undefined;
	try {
		server = await startDaemon({ home, name: "alpha" });
		const url = `ws://127.0.0.1:${server.port}`;

		w1 = await register(url, "w1", "worker", "global/room1");
		w2 = await register(url, "w2", "worker", "global/room2");

		// the address is STAMPED: swarm/room/sessionId — workers never claim the swarm
		const info1 = server.api.get("w1")!;
		assert.equal(info1.room, "global/room1");
		assert.equal(info1.address, "alpha/global/room1/w1");
		assert.equal(info1.origin, "local");

		// a peer mounted at room1 sees room1 (including itself), and NOTHING else
		peer = await register(url, "p1", "peer", "global/room1");
		const peerList = (await peer.rpc({ op: "list" })).data as {
			address: string;
		}[];
		assert.deepEqual(
			peerList.map((r) => r.address).sort(),
			["alpha/global/room1/p1", "alpha/global/room1/w1"],
		);

		// 404 semantics: a room you can't see doesn't exist
		const invisible = await peer.rpc({ op: "get", sessionId: "w2" });
		assert.equal(invisible.data, null, "w2 is invisible from the room1 mount");
		const visibleGet = await peer.rpc({ op: "get", sessionId: "w1" });
		assert.equal(visibleGet.data.address, "alpha/global/room1/w1");

		// an admin mounted at global sees the whole tree (filter to workers —
		// the registry honestly lists peer/admin connections too)
		admin = await register(url, "a1", "admin");
		const adminList = ((await admin.rpc({ op: "list" })).data as {
			address: string;
			mode: string;
		}[]).filter((r) => r.mode === "worker");
		assert.deepEqual(
			adminList.map((r) => r.address).sort(),
			["alpha/global/room1/w1", "alpha/global/room2/w2"],
		);

		// full-address targeting works alongside bare sessionIds
		const byAddress = server.api.get("alpha/global/room2/w2")!;
		assert.equal(byAddress.sessionId, "w2");

		// malformed room paths are rejected, never guessed
		const bad = new WsClient(url);
		await bad.ready();
		bad.send({
			op: "register",
			sessionId: "evil",
			agentId: "evil",
			mode: "worker",
			room: "global/../global",
		});
		const err = await bad.waitFor("error");
		assert.match(String(err.error), /malformed room/);
		bad.close();
	} finally {
		w1?.close();
		w2?.close();
		peer?.close();
		admin?.close();
		rmHome(home);
		await server?.stop();
	}
});

test("rooms: broadcast blast radius = mount ∩ room scope ∩ online", async () => {
	const home = tmpHome();
	let server: SwarmServer | undefined;
	const clients: WsClient[] = [];
	try {
		server = await startDaemon({ home, name: "alpha" });
		const url = `ws://127.0.0.1:${server.port}`;
		clients.push(await register(url, "w1", "worker", "global/room1"));
		clients.push(await register(url, "w2", "worker", "global/room2"));
		const admin = await register(url, "a1", "admin");
		clients.push(admin);

		// scope to a subtree: only room1 hears it
		const res = (await admin.rpc({
			op: "broadcast",
			room: "global/room1",
			body: { type: "input_followup", text: "hello room1" },
		})).data as { sent: number };
		assert.equal(res.sent, 1);
		const got = await clients[0]!.waitFor("input");
		assert.equal(got.body.text, "hello room1");

		// a mount is a hard ceiling, even for an admin wearing one: room2 is
		// invisible from a room1 mount, so the target list comes back empty
		const lowAdmin = await register(url, "a2", "admin", "global/room1");
		clients.push(lowAdmin);
		const capped = (await lowAdmin.rpc({
			op: "broadcast",
			targets: ["w2"],
			body: { type: "input_followup", text: "sneak" },
		})).data as { sent: number; targets: number };
		assert.equal(capped.sent, 0, "the mount filters the target list");
	} finally {
		for (const c of clients) c.close();
		rmHome(home);
		await server?.stop();
	}
});

test("rooms: an unnamed daemon is a hermit — but still a full local swarm", async () => {
	const home = tmpHome();
	let server: SwarmServer | undefined;
	let c: WsClient | undefined;
	try {
		server = await startDaemon({ home }); // no name
		const url = `ws://127.0.0.1:${server.port}`;
		c = await register(url, "w1", "worker", "global/room1");
		const info = server.api.get("w1")!;
		// no swarm segment — the address is room/sessionId
		assert.equal(info.address, "global/room1/w1");
		// federation refuses loudly, both directions
		const fed = server.federate({ url: "ws://127.0.0.1:1" });
		assert.equal(fed.ok, false);
		assert.match(String(fed.error), /hermit|unnamed/);
	} finally {
		c?.close();
		rmHome(home);
		await server?.stop();
	}
});

// ---------------------------------------------------------------------------
// FEDERATION: mount, mirror, fold, forward, offline, no transit
// ---------------------------------------------------------------------------

test("federation: A dials B, mirrors its truth, forwards authority, follows it offline", async () => {
	const homeA = tmpHome();
	const homeB = tmpHome();
	const homeC = tmpHome();
	let A: SwarmServer | undefined;
	let B: SwarmServer | undefined;
	let C: SwarmServer | undefined;
	const clients: WsClient[] = [];
	try {
		A = await startDaemon({ home: homeA, name: "alpha" });
		B = await startDaemon({ home: homeB, name: "beta" });
		const urlA = `ws://127.0.0.1:${A.port}`;
		const urlB = `ws://127.0.0.1:${B.port}`;

		// B has a local worker; A has a local worker too (namespace collision bait:
		// the SAME sessionId on both sides must yield DIFFERENT addresses)
		const b1 = await register(urlB, "shared-id", "worker");
		const a1 = await register(urlA, "shared-id", "worker", "global/room1");
		clients.push(b1, a1);

		// A dials B as a peer
		const fed = A.federate({ url: urlB });
		assert.equal(fed.ok, true);

		// the mirror appears under B's declared name, stamped by A —
		// and UNDER the root room, so the default global mount sees it
		await until(() =>
			A!.api
				.list()
				.some((r) => r.address === "alpha/global/beta/global/shared-id"),
		);
		const mirror = A.api.get("alpha/global/beta/global/shared-id")!;
		assert.equal(mirror.origin, "mirrored");
		assert.equal(mirror.spawned, false, "A never spawned it — it can't restart it");
		assert.equal(mirror.room, "global/beta/global");
		// same sessionId, different swarms → different addresses, both alive
		assert.equal(A.api.get("alpha/global/room1/shared-id")!.origin, "local");

		// state folds from the REMOTE's own reports — never invented
		b1.send({ op: "report", event: "agentStart", payload: {} });
		await until(() => A.api.get("alpha/global/beta/global/shared-id")!.state === "busy");
		b1.send({ op: "report", event: "agentSettled", payload: {} });
		await until(() => A.api.get("alpha/global/beta/global/shared-id")!.state === "idle");

		// voices relay: an A-side admin subscribes to the MIRROR ADDRESS and
		// receives what the B worker reports
		const adminA = await register(urlA, "adm-a", "admin");
		clients.push(adminA);
		await adminA.rpc({ op: "listen", sessionId: "alpha/global/beta/global/shared-id", on: true });
		b1.send({ op: "report", event: "textDelta", payload: { streamDelta: "hi from B" } });
		const relayed = await adminA.waitFor("event");
		assert.equal(relayed.target, "shared-id");
		assert.equal(relayed.event, "textDelta");
		assert.equal(relayed.payload.streamDelta, "hi from B");

		// authority stays home: input through A lands on B's REAL worker
		const r = A.api.input("alpha/global/beta/global/shared-id", {
			type: "input_followup",
			text: "hello across the wire",
		});
		assert.equal(r?.ok, true);
		const down = await b1.waitFor("input");
		assert.equal(down.body.text, "hello across the wire");

		// NO TRANSIT: C mounts into B — A must never see C's view
		C = await startDaemon({ home: homeC, name: "gamma" });
		const urlC = `ws://127.0.0.1:${C.port}`;
		const c1 = await register(urlC, "c1", "worker");
		clients.push(c1);
		B.federate({ url: urlC });
		await until(() =>
			B!
				.api.list()
				.some((r) => r.address === "beta/global/gamma/global/c1"),
		);
		// A only mirrors B's LOCAL workers — B's mirror of C is invisible from A
		const aRows = A.api.list().map((r) => r.address);
		assert.ok(
			!aRows.some((addr) => addr.includes("gamma")),
			`no transit: A saw ${aRows.join(", ")}`,
		);

		// B's wire dies → every mirror under beta follows it down. TCP is the heartbeat.
		const urlBForA = urlB;
		await B.stop();
		await until(() =>
			A!
				.api.list()
				.every(
					(r) =>
						!r.address.startsWith("alpha/global/beta/") || r.status === "offline",
				),
		);
		void urlBForA;
	} finally {
		for (const c of clients) c.close();
		rmHome(homeA);
		rmHome(homeB);
		rmHome(homeC);
		await C?.stop().catch(() => {});
		await B?.stop().catch(() => {});
		await A?.stop().catch(() => {});
	}
});

test("federation: mounting an unnamed (hermit) daemon is refused", async () => {
	const homeA = tmpHome();
	const homeH = tmpHome();
	let A: SwarmServer | undefined;
	let H: SwarmServer | undefined;
	try {
		A = await startDaemon({ home: homeA, name: "alpha" });
		H = await startDaemon({ home: homeH }); // hermit
		A.federate({ url: `ws://127.0.0.1:${H.port}` });
		// the mount connects, learns there is no name to stamp under, refuses
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(
			A.api.list().filter((r) => r.origin === "mirrored").length,
			0,
			"nothing mirrored from a hermit",
		);
	} finally {
		rmHome(homeA);
		rmHome(homeH);
		await H?.stop().catch(() => {});
		await A?.stop().catch(() => {});
	}
});

test("federation: mount-name collisions refuse loudly", async () => {
	const homeA = tmpHome();
	const homeB = tmpHome();
	let A: SwarmServer | undefined;
	let B: SwarmServer | undefined;
	try {
		A = await startDaemon({ home: homeA, name: "alpha" });
		B = await startDaemon({ home: homeB, name: "alpha" }); // same name as A
		A.federate({ url: `ws://127.0.0.1:${B.port}` });
		await new Promise((r) => setTimeout(r, 300));
		// mounting a daemon that claims OUR OWN name is refused — no mirror loop
		assert.equal(
			A.api.list().filter((r) => r.origin === "mirrored").length,
			0,
			"own-name mount refused",
		);
	} finally {
		rmHome(homeA);
		rmHome(homeB);
		await B?.stop().catch(() => {});
		await A?.stop().catch(() => {});
	}
});
