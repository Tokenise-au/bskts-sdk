# @bskts/mcp

The [bskts API](https://api.bskts.xyz) as tools for Claude, ChatGPT, Cursor and any other [MCP](https://modelcontextprotocol.io) client: read tokenized index baskets on Robinhood Chain, check an account, and build buys, sells and orders.

**Unsigned only.** Build tools return the transactions (`approval`, then `tx`) for the user's own wallet to sign. The server holds no key and sends nothing. Built on the official MCP TypeScript SDK and [`@bskts/sdk`](../sdk).

## Tools

| Tool            | What it does                                                                           |
| --------------- | -------------------------------------------------------------------------------------- |
| `bskts_markets` | every basket: NAV, 24h change, buy cost                                                |
| `bskts_basket`  | one basket: constituents, risk note, fees; optional NAV summary over N days            |
| `bskts_account` | an address's ETH / USDG, gasOk, positions with PnL, open orders                        |
| `bskts_buy`     | unsigned buy for USDG, with the API's dry run                                          |
| `bskts_sell`    | unsigned sale for USDG (`shares: "max"` by default, or exact wei; optional `fraction`) |
| `bskts_order`   | unsigned limit buy, stop-loss / take-profit, or cancel                                 |
| `bskts_guide`   | the full trading guide, on demand                                                      |

All tools are annotated read-only: even the build tools only return data. The rules an agent needs (units, approval order, never send a failed dry run) are in the descriptions and the server instructions.

## Local (stdio)

Claude Code:

```bash
claude mcp add bskts -e BSKTS_MAX_USD_PER_TRADE=100 -- npx -y @bskts/mcp
```

Claude Desktop, Cursor and other clients (`mcpServers` in their config):

```json
{
  "mcpServers": {
    "bskts": {
      "command": "npx",
      "args": ["-y", "@bskts/mcp"],
      "env": { "BSKTS_MAX_USD_PER_TRADE": "100" }
    }
  }
}
```

## Remote (Streamable HTTP)

`createBsktsMcpHandler()` is a stateless `(Request) => Response` handler for any fetch-style runtime:

```ts
import { createBsktsMcpHandler } from "@bskts/mcp";

const mcp = createBsktsMcpHandler({ policy: { maxUsdPerTrade: 100 } });
export default {
  fetch: (req: Request) =>
    new URL(req.url).pathname === "/mcp" ? mcp(req) : new Response("not found", { status: 404 }),
};
```

## Limits

The user's own guard rails, checked before anything is built (environment variables for the CLI, `policy` for the handler):

| Variable                  | Effect                                            |
| ------------------------- | ------------------------------------------------- |
| `BSKTS_MAX_USD_PER_TRADE` | largest buy, limit buy or sale, in USD            |
| `BSKTS_ALLOWED_TICKERS`   | comma-separated baskets the agent may trade       |
| `BSKTS_MAX_BUY_COST_BPS`  | refuse buys whose live buy cost is above this     |
| `BSKTS_MAX_SLIPPAGE_BPS`  | cap on the slippage an agent may ask for          |
| `BSKTS_API_URL`           | a different API (default `https://api.bskts.xyz`) |

MIT
