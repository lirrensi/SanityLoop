// ============================================================================
// test/e2e/fixtures/mcp-fixture-server.ts — A REAL MCP stdio server (SDK v2).
// ============================================================================
// Not a mock, not a stub — the official @modelcontextprotocol/server v2
// McpServer speaking genuine JSON-RPC over stdio, spawned as a real child
// process by the MCP adapter. It exists to prove the adapter against a live
// peer:
//
//   add(a, b)        → REAL computation over the wire (assert the sum lands)
//   fail_now(reason) → isError:true result (error-as-text path, never throw)
//   install_extra()  → registers bonus_time MID-SESSION + fires
//                      notifications/tools/list_changed (live re-list path)
//   bonus_time()     → only callable AFTER install_extra mutated the list

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const server = new McpServer({ name: "sanity-fixture", version: "0.2.0" });

server.registerTool(
    "add",
    {
        description: "Add two numbers and return the sum.",
        inputSchema: z.object({ a: z.number(), b: z.number() }),
    },
    async ({ a, b }) => ({
        content: [{ type: "text", text: `the sum of ${a} and ${b} is ${a + b}` }],
    }),
);

server.registerTool(
    "fail_now",
    {
        description: "Always fails with isError — for testing error paths.",
        inputSchema: z.object({ reason: z.string() }),
    },
    async ({ reason }) => ({
        // The MCP way of failing: a RESULT with isError — not a protocol error.
        content: [{ type: "text", text: `deliberate failure: ${reason}` }],
        isError: true,
    }),
);

server.registerTool(
    "install_extra",
    {
        description:
            "Register a new tool (bonus_time) at runtime and notify that the tool list changed.",
        inputSchema: z.object({}),
    },
    async () => {
        server.registerTool(
            "bonus_time",
            {
                description: "Dynamically installed bonus tool.",
                inputSchema: z.object({}),
            },
            async () => ({
                content: [
                    { type: "text", text: "bonus delivered from the dynamic tool" },
                ],
            }),
        );
        // THE dynamic moment: announce list_changed. The client (our adapter)
        // must re-list and pick up bonus_time live.
        await server.sendToolListChanged();
        return {
            content: [
                {
                    type: "text",
                    text: "bonus_time installed — tools/list_changed notification sent",
                },
            ],
        };
    },
);

await server.connect(new StdioServerTransport());
// stdio stays open; the adapter owns this process's lifetime.
