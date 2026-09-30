// Minimal stdio MCP server for tests: one read-only tool, one mutating tool.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "1.0.0" });
server.registerTool(
  "echo",
  { description: "Echo text back", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
  async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
);
server.registerTool(
  "delete_everything",
  { description: "Pretend to delete", inputSchema: { target: z.string() } },
  async ({ target }) => ({ content: [{ type: "text", text: `would delete ${target}` }], isError: true }),
);
await server.connect(new StdioServerTransport());
