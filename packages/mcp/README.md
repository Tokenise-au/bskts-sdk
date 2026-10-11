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

## Autonomous account path

Four additional unsigned tools expose delegated accounts:

| Tool                  | Purpose                                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bskts_agent_session` | Resolve the owner's account and read a public agent key's active status, USDG, daily remaining turnover, slippage and expiry. Returns owner approval and relayer URLs. |
| `bskts_agent_trade`   | Build a buy/sell Action with EIP-712 typedData inside the owner's live limits. The host's matching session signer signs and submits it.                                |
| `bskts_cover`         | Weekend Cover reads: the weeks a session may buy, a basket's offers by range with payout history and a quote, an account's cover and payouts.                          |
| `bskts_agent_cover`   | Build a cover purchase (take offers, request cover, or cancel the account's listing) with typedData under the cover module's own domain. Never underwrites.            |

Create the signing key in your agent host wallet/secure signer; share only its
public address. The owner connects that address in Portfolio once, reviews
limits and signs. Suggested defaults: 10% available USDG (at least $10) capped $100/day,
0.5% all-in slippage and seven days, fixed dollars until the owner approves a
change. A funded bskts account is required; owner/agent ETH is not.

This MCP server stays unsigned. It does not generate/store private keys,
grant permissions, sign, submit trades or withdraw. Autonomous execution
requires a host signer/submitter; `@bskts/sdk` provides `executeSession` and
`sessionRelayer` for that host. Revocation blocks new requests after confirmation;
existing orders/schedules require separate cancellation. Reconnect with a
fresh key. On a 402 fee quote preserve nonce and trade terms, re-sign only
the fee within the host's explicit fee cap. Never automatically replace an
ambiguous submission with a new nonce.

Persist the unsigned plan before the host signs or submits it. On restart,
reconcile that original nonce and stop while it is unresolved. SDK 0.5.0 hosts
can use `executeSessionOnce` with a durable store and `sessionActionState`;
Node hosts can import `fileSessionStore` from `@bskts/sdk/node`. Keep completed
records so restarting an operation cannot repeat its trade. MCP continues to
return unsigned plans; persistence, signing and reconciliation belong to the host.

Agent keys authorise account trading, including Weekend Cover when it is enabled. Cover spending is counted separately against the same daily limit; underwriting additionally requires the account owner’s allowance. Individual key revocation leaves existing Cover listings open: withdraw them in My cover. The API’s moduleEnabled/coverEnabled fields report the current account setup.
