#!/usr/bin/env node
// bskts-mcp: the bskts MCP server over stdio.
//
//   npx -y @bskts/mcp
//
// Optional limits (the user's own guard rails, checked before anything is
// built): BSKTS_MAX_USD_PER_TRADE, BSKTS_ALLOWED_TICKERS, BSKTS_MAX_BUY_COST_BPS,
// BSKTS_MAX_SLIPPAGE_BPS. BSKTS_API_URL points at another API.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { policyFromEnv } from "@bskts/sdk";
import { createBsktsServer } from "./index";

const policy = policyFromEnv(process.env);
const baseUrl = process.env["BSKTS_API_URL"];
const server = createBsktsServer({ policy, ...(baseUrl ? { baseUrl } : {}) });
await server.connect(new StdioServerTransport());
// stdout is the protocol: anything human goes to stderr
process.stderr.write(
  `bskts MCP server on stdio${Object.keys(policy).length ? `, policy ${JSON.stringify(policy)}` : ""}\n`,
);
