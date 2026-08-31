// ============================================================================
// realcalls.ts — REAL end-to-end demo. Spawns an actual worker whose SimpleModel
// points at the local llama.cpp server on :58080, sends it a real prompt through
// the daemon, and prints the streamed reply. Not a unit test — a live demo.
// Run: node --experimental-strip-types --experimental-transform-types packages/swarm/test/realcalls.ts
// ============================================================================
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, WsClient, tmpHome, rmHome } from "./harness.ts";

// model served by the llama.cpp server on :58080 (from GET /v1/models); overridable
const MODEL = process.env.SWARM_MODEL || "local-model";

// The REAL worker source — a genuine Agent wired with wireSwarm, but its model
// is a real SimpleModel pointed at the local llama.cpp. No StubModel here.
const WORKER_TS = `
import { join } from "node:path";
import { Agent, EVENTS, SimpleModel } from "@sanityloop/core";
import { createDefaultInputs } from "@sanityloop/inputs";
import { jsonlSession } from "@sanityloop/base-storage";
import { wireSwarm } from "@sanityloop/swarm";

const SESSION_ID = process.env.SWARM_SESSION_ID;
if (!SESSION_ID) { console.error("real-worker: SWARM_SESSION_ID required"); process.exit(1); }

const agent = new Agent({
  model: new SimpleModel({
    api: "chat_completions",
    modelId: process.env.SWARM_MODEL || "local-model",
    baseUrl: "http://localhost:58080/v1",
    apiKey: "sk-noauth",
    stream: true,
    maxContext: 128000,
  }),
  agentId: "real-worker",
  description: "REAL swarm worker (llama.cpp @58080)",
});

await wireSwarm(agent, {
  server: process.env.SWARM_SERVER || "ws://127.0.0.1:5317",
  mode: "worker",
  sessionId: SESSION_ID,
  persistent: true,
  storage: jsonlSession(join(process.env.SWARM_SESSIONS_DIR || "sessions", SESSION_ID)),
});

agent.install(createDefaultInputs());
agent.addFilter({
  event: EVENTS.stop,
  id: "real-worker/exit-on-stop",
  priority: 0,
  fn: async () => { queueMicrotask(() => process.exit(0)); },
});
agent.run({ startState: "idle" });
`;

async function main() {
	process.env.SWARM_MODEL = MODEL;

	const home = tmpHome();
	const tdir = join(home, "templates");
	mkdirSync(tdir, { recursive: true });
	writeFileSync(join(tdir, "real-worker.ts"), WORKER_TS);
	writeFileSync(join(tdir, "real-worker.json"), JSON.stringify({ id: "real-worker", file: "real-worker.ts" }));

	// daemon on a free port (58080 is the model server — can't reuse it)
	const server = await startDaemon({ home, templatesDir: tdir, port: 0 });
	const url = `ws://127.0.0.1:${server.port}`;
	console.log(`[demo] daemon listening on ${server.port} (model backend on :58080)`);

	const admin = new WsClient(url);
	await admin.ready();
	admin.send({ op: "register", sessionId: "admin1", agentId: "admin", mode: "admin" });
	await admin.waitFor("welcome");

	console.log("[demo] spawning REAL worker (will call llama.cpp @58080)...");
	const created = (await admin.rpc({ op: "create", template: "real-worker" })).data;
	const sid = created.sessionId;
	console.log(`[demo] spawned session=${sid} pid=${created.pid}`);

	// wait for the worker to actually join
	const joinDeadline = Date.now() + 20000;
	while (Date.now() < joinDeadline) {
		const i = server.api.get(sid);
		if (i && i.status === "online") break;
		await new Promise((r) => setTimeout(r, 50));
	}
	console.log(`[demo] worker status: ${server.api.get(sid)?.status}`);

	// subscribe so we receive the worker's streamed voices
	await admin.rpc({ op: "listen", sessionId: sid, on: true });

	// accumulate streamed text from relayed textDelta events
	let reply = "";
	const onMsg = (raw: Buffer | string) => {
		try {
			const f = JSON.parse(raw.toString());
				if (f.op === "event" && f.target === sid && f.event === "textDelta") {
					reply += f.payload?.streamDelta?.delta ?? f.payload?.content ?? "";
					process.stdout.write(".");
				}
		} catch {
			/* ignore */
		}
	};
	admin.ws.on("message", onMsg);

	console.log('\n[demo] sending REAL prompt -> "Reply with exactly the word: PONG"');
	await admin.rpc({
		op: "input",
		target: sid,
		body: { type: "input_followup", text: "Reply with exactly the word: PONG" },
	});

	// wait until the worker settles its turn (or 40s cap)
	const cap = Date.now() + 40000;
	while (Date.now() < cap) {
		const i = server.api.get(sid);
		if (i && (i.lastEvent === "agentSettled" || i.lastEvent === "turnEnd")) break;
		await new Promise((r) => setTimeout(r, 150));
	}
	admin.ws.off("message", onMsg);

	console.log(`\n[demo] === WORKER REPLY (real llama.cpp @58080) ===`);
	console.log(reply || "(no streamed text captured)");
	console.log(`[demo] worker state: ${server.api.get(sid)?.state}, lastEvent: ${server.api.get(sid)?.lastEvent}`);

	try {
		await admin.rpc({ op: "kill", sessionId: sid });
	} catch {
		/* already gone */
	}
	admin.close();
	rmHome(home);
	await server.stop();
	console.log("[demo] cleaned up.");
}

main().catch((e) => {
	console.error("[demo] FAILED:", e);
	process.exit(1);
});
