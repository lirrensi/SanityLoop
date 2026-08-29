// ============================================================================
// test/e2e/fixtures/mcp-fixture-http-server.ts — A REAL remote MCP server.
// ============================================================================
// The official @modelcontextprotocol/server v2 stack (McpServer +
// createMcpHandler + toNodeHandler) served over plain node:http — zero
// hand-rolled glue, real streamable-HTTP JSON-RPC on the wire.
// Prints "PORT=<n>" once listening so the driver can point the adapter at it.
//
//   mul(a, b) → REAL computation over real streamable HTTP (6 × 7 = 42, of course)

import http from "node:http";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";

function buildServer(): McpServer {
    const mcp = new McpServer({ name: "sanity-fixture-http", version: "0.2.0" });
    mcp.registerTool(
        "mul",
        {
            description: "Multiply two numbers and return the product.",
            inputSchema: z.object({ a: z.number(), b: z.number() }),
        },
        async ({ a, b }) => ({
            content: [
                { type: "text", text: `the product of ${a} and ${b} is ${a * b}` },
            ],
        }),
    );
    return mcp;
}

// fetch-shaped handler (stateless posture by default) → official node glue.
const nodeHandler = toNodeHandler(createMcpHandler(buildServer));

const app = http.createServer(nodeHandler);
app.listen(0, "127.0.0.1", () => {
    const addr = app.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    console.log(`PORT=${port}`);
});
