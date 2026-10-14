// ============================================================================
// @sanityloop/file-rpc/cli — drop a command into a room, print the reply.
// ============================================================================
//   node --experimental-strip-types packages/extras/file-rpc/cli.ts \
//     --lobby /tmp/rpc --to my-agent --type health
//   node .../cli.ts --lobby /tmp/rpc --type get_state --keys state.todos
//   node .../cli.ts --lobby /tmp/rpc --rooms
//   echo '{"id":"a","type":"health"}' | node .../cli.ts --lobby /tmp/rpc --stdin
//
// Exit codes: 0 ok · 1 failure (bad args, no rooms, send error, !success,
// timeout) · 2 ambiguity (many rooms, no --to — re-run with one).
// ============================================================================

import { readFileSync } from "node:fs";
import { FileRpcError, listRoomsSync, sendCommand } from "./sender.ts";

const HELP = `usage:
  file-rpc --lobby DIR [--to ROOM] --type TYPE [--id ID] [--body JSON] [--keys a,b]
           [--timeout MS] [--no-wait]
  file-rpc --lobby DIR --rooms
  file-rpc --lobby DIR [--to ROOM] --stdin < command.json

commands: input (needs --body), control (needs --body '{"op":"stop"}'),
          health, get_state (--keys a,b), awaits, questions, tools,
          capabilities, or any input_* type passed through as-is.`;

interface CliArgs {
  lobby: string;
  to?: string;
  type?: string;
  id?: string;
  body?: string;
  keys?: string;
  timeout?: string;
  noWait: boolean;
  rooms: boolean;
  stdin: boolean;
  help: boolean;
}

function parseArgv(argv: string[]): CliArgs {
  const out: CliArgs = {
    lobby: "",
    noWait: false,
    rooms: false,
    stdin: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--rooms") {
      out.rooms = true;
    } else if (arg === "--no-wait") {
      out.noWait = true;
    } else if (arg === "--stdin") {
      out.stdin = true;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        console.error(`flag ${arg} needs a value\n${HELP}`);
        process.exit(1);
      }
      i++;
      if (key === "lobby") out.lobby = value;
      else if (key === "to") out.to = value;
      else if (key === "type") out.type = value;
      else if (key === "id") out.id = value;
      else if (key === "body") out.body = value;
      else if (key === "keys") out.keys = value;
      else if (key === "timeout") out.timeout = value;
      else {
        console.error(`unknown flag ${arg}\n${HELP}`);
        process.exit(1);
      }
    } else {
      console.error(`unexpected argument ${arg}\n${HELP}`);
      process.exit(1);
    }
  }
  return out;
}

async function main(): Promise<void> {
  // process.argv under `--experimental-strip-types cli.ts` is
  // [node, cli.ts, ...user] — but some runners inject an extra "--"
  // separator (node -e analog): skip a lone leading "--".
  const raw = process.argv.slice(2);
  const args = parseArgv(raw.length > 0 && raw[0] === "--" ? raw.slice(1) : raw);
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (!args.lobby) {
    console.error(`--lobby DIR is required\n${HELP}`);
    process.exit(1);
  }
  if (args.rooms) {
    const rooms = listRoomsSync(args.lobby);
    for (const r of rooms) {
      console.log(
        `${r.live ? "live " : "stale"} ${r.id} pid=${r.card?.pid ?? "?"} room=${r.room}`,
      );
    }
    if (rooms.length === 0) console.log(`(no rooms in ${args.lobby})`);
    return;
  }

  let body: Record<string, unknown>;
  if (args.stdin) {
    const raw = readFileSync(0, "utf8");
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      console.error("stdin is not JSON");
      process.exit(1);
    }
  } else {
    if (!args.type) {
      console.error(`--type TYPE is required (or --stdin)\n${HELP}`);
      process.exit(1);
    }
    if (args.body) {
      try {
        body = JSON.parse(args.body) as Record<string, unknown>;
      } catch {
        console.error("--body is not JSON");
        process.exit(1);
      }
      if (typeof body["type"] !== "string") body["type"] = args.type;
    } else {
      body = { type: args.type };
    }
    if (args.id !== undefined) body["id"] = args.id;
    if (args.keys !== undefined && body["type"] === "get_state") {
      body["keys"] = args.keys
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (typeof body["type"] !== "string") {
      console.error("command requires a string `type`");
      process.exit(1);
    }
  }
  if (args.to !== undefined) {
    // keep --to explicit even when body arrived via --stdin
  }

  const timeoutMs = args.timeout !== undefined ? Number(args.timeout) : 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    console.error("--timeout must be a non-negative number of ms");
    process.exit(1);
  }
  try {
    const res = await sendCommand(args.lobby, {
      to: args.to,
      body,
      wait: !args.noWait,
      timeoutMs,
    });
    if (res) {
      console.log(JSON.stringify(res, null, 2));
      if (!res.success) process.exit(1);
    } else {
      console.log(JSON.stringify({ ok: true, dropped: body }, null, 2));
    }
  } catch (err) {
    if (err instanceof FileRpcError) {
      console.error(`[file-rpc] ${err.message}`);
      process.exit(err.code === "ROOMS_AVAILABLE" ? 2 : 1);
    }
    throw err;
  }
}

await main();
