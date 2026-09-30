/**
 * @bskts/mcp: the bskts API as MCP tools. Read markets and accounts and build
 * unsigned buys, sells and orders on Robinhood Chain; the user's wallet signs.
 *
 * - `bskts-mcp` (bin): stdio, for local clients (Claude Code, Claude Desktop, Cursor).
 * - createBsktsMcpHandler(): Streamable HTTP, stateless, for a fetch-style
 *   runtime (Cloudflare Workers, Deno, Bun, Node with a fetch adapter).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { BsktsClient, type BsktsClientOptions } from "@bskts/sdk";
import { INSTRUCTIONS, registerBsktsTools } from "./tools";

export { INSTRUCTIONS, registerBsktsTools } from "./tools";

export const VERSION = "0.1.0";

export interface BsktsMcpOptions extends BsktsClientOptions {
  /** reuse a client instead of building one from the options */
  client?: BsktsClient;
}

/** An McpServer with the bskts tools registered. */
export function createBsktsServer(opts: BsktsMcpOptions = {}): McpServer {
  const server = new McpServer(
    { name: "bskts", title: "bskts", version: VERSION },
    { instructions: INSTRUCTIONS, capabilities: { tools: {} } },
  );
  registerBsktsTools(server, opts.client ?? new BsktsClient(opts));
  return server;
}

/** A stateless Streamable HTTP handler: (Request) => Response. Every request
 * gets a fresh server and transport (no sessions to keep), JSON responses (no
 * long-lived streams), which suits Workers.
 *
 *   export default { fetch: createBsktsMcpHandler() } // POST /mcp
 */
export function createBsktsMcpHandler(opts: BsktsMcpOptions = {}) {
  const client = opts.client ?? new BsktsClient(opts);
  return async (req: Request): Promise<Response> => {
    const server = createBsktsServer({ client });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      // JSON mode has answered in full by now; drop this request's server
      void server.close();
    }
  };
}
