# @bskts/sdk

Typed, **non-custodial** client for the [bskts API](https://api.bskts.xyz): tokenized index baskets of Stock Tokens and crypto on Robinhood Chain (chainId 4663).

- **Reads**: live NAV, 24h change and buy cost for every basket, wallet balances, positions with PnL, open orders, NAV history or just its summary, and every public job executable right now.
- **Unsigned plans**: `build*` methods return `{ approval, tx, simulation }`. You sign with your own wallet through viem. The SDK never holds keys or funds.
- **Safe by default for agents**: the API dry-runs every plan as your address and `execute()` refuses one that would revert; an optional `policy` caps trade size, baskets, cost and slippage before anything is built; errors carry a stable `code`.
- **Typed from Zod schemas**: every response is validated at runtime. On-chain amounts are `bigint`, addresses and calldata viem's `Address` / `Hex`.

```bash
pnpm add @bskts/sdk viem
```

ESM only, Node 20.19+, browsers, Workers, Deno and Bun. `viem` is a peer dependency.

## The loop

```ts
import { BsktsClient, robinhood, viemSender } from "@bskts/sdk";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.AGENT_KEY as `0x${string}`);
const sender = viemSender(
  createWalletClient({ account, chain: robinhood, transport: http() }),
  createPublicClient({ chain: robinhood, transport: http() }),
);
const me = account.address;

const bskts = new BsktsClient({
  policy: { maxUsdPerTrade: 250, allowedTickers: ["DIGI64", "MAG6"], maxBuyCostBps: 50 },
});

// 1. pick
const { markets } = await bskts.markets(); // ticker, nav, change24h, buyCostBps
const { summary } = await bskts.navSummary("DIGI64", { days: 30 });

// 2. check the wallet: USDG to spend, ETH for gas
const wallet = await bskts.wallet(me);
if (!wallet.gasOk) throw new Error(wallet.note);

// 3. buy $100: approval first if needed (waited on), then the buy
await bskts.execute(
  await bskts.buildBuy({ ticker: "DIGI64", amountUsdg: 100, address: me }),
  sender,
  { wait: true },
);

// 4. hold
const { positions } = await bskts.positions(me); // value, avgEntry, unrealizedPnl, walletSharesWei (bigint)

// 5. sell half, then the rest
await bskts.execute(
  await bskts.buildSell({ ticker: "DIGI64", address: me, fraction: 0.5 }),
  sender,
  { wait: true },
);
await bskts.execute(await bskts.buildSell({ ticker: "DIGI64", address: me }), sender, {
  wait: true,
});
```

In a browser, build the wallet client over the injected provider: `createWalletClient({ account, chain: robinhood, transport: custom(window.ethereum) })`. For another signer library, implement `Sender` (`send(tx)` and `wait(hash)`).

## Orders

```ts
// stop-loss + take-profit, one cancels the other
await bskts.execute(
  await bskts.buildOrder({
    kind: "exit",
    ticker: "INDEX2",
    address: me,
    shares: positions[0].walletSharesWei,
    stopNav: 92,
    tpNav: 112,
  }),
  sender,
);

// a resting limit buy: fills when the 10-minute average NAV drops to the trigger
await bskts.execute(
  await bskts.buildOrder({
    kind: "limit",
    ticker: "MAG6",
    address: me,
    amountUsdg: 250,
    triggerNav: 98,
  }),
  sender,
);

// cancel
const { orders } = await bskts.orders(me);
await bskts.execute(
  await bskts.buildOrder({ kind: "cancel", orderId: orders[0].id, address: me }),
  sender,
);
```

## Errors

Every failure is a `BsktsError` with `code`, `retryable` and `detail`:

| code                                                           | meaning                                                                                             |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `POLICY`                                                       | your client's policy refused it; nothing was requested or sent                                      |
| `SIMULATION_FAILED`                                            | the API's dry run reverted (`detail.reason`); `execute(plan, sender, { force: true })` sends anyway |
| `INSUFFICIENT_SHARES`                                          | selling more than the wallet holds (escrowed shares must be cancelled out of their order first)     |
| `NO_ROUTE`                                                     | a constituent has no route right now: that basket can't be bought or sold through the API           |
| `NO_REFERENCE`                                                 | limit / exit orders unavailable for this basket (market buys and sells work)                        |
| `UNKNOWN_BASKET`, `BAD_REQUEST`, `ORDER_NOT_OPEN`, `NOT_FOUND` | fix the request                                                                                     |
| `PAUSED`, `UPSTREAM`, `SERVER`, `NETWORK`                      | `retryable: true`: try again later                                                                  |
| `TX_FAILED`                                                    | mined and reverted (usually the market moved past `minShares` / `minOut`): rebuild and retry        |
| `BAD_RESPONSE`                                                 | the API answered with a shape this SDK version doesn't know: upgrade                                |

## Units

- `amountUsdg`, NAVs, `value`, PnL: plain dollars (`number`).
- On-chain amounts (`*Wei`, `shares`, `minShares`, `expectedUsdg`, `minOutUsdg`, `feeUsdg`): `bigint` in base units (shares 1e18, USDG 1e6). Pass `walletSharesWei` back as-is.
- `change24h` and NAV summaries: fractions (0.012 = +1.2%). `buyCostBps`, `slippageBps`: basis points.

## Earning fees

Resting orders and scheduled buys are **public jobs**: `jobs()` lists every one executable right now, with calldata and the fee it pays whoever sends it. Simulate first; each fill is held to the order's on-chain floor.

MIT · [API guide for agents](https://api.bskts.xyz/llms.txt) · [bskts docs](https://bskts.xyz/docs.md)
