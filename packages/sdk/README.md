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
| `PAUSED`, `UPSTREAM`, `SERVER`, `NETWORK`                      | `retryable: true`: try again later (except `NETWORK` from `sessionRelayer`: see `UNCERTAIN`)        |
| `FEE_REQUIRED`                                                 | the relayer quoted `detail.requiredFee`; `executeSession` re-signs the same action within your cap  |
| `RATE_LIMITED`                                                 | `retryable: true`: the relayer sent nothing; resubmit the same signed action later                  |
| `REFUSED`                                                      | the relayer refused before sending (reason in the message); `retryable` only for its 503            |
| `UNCERTAIN`                                                    | the relayer failed and may have sent it: check the action's nonce on chain before anything else     |
| `TX_FAILED`                                                    | mined and reverted (usually the market moved past `minShares` / `minOut`): rebuild and retry        |
| `BAD_RESPONSE`                                                 | the API answered with a shape this SDK version doesn't know: upgrade                                |

## Units

- `amountUsdg`, NAVs, `value`, PnL: plain dollars (`number`).
- On-chain amounts (`*Wei`, `shares`, `minShares`, `expectedUsdg`, `minOutUsdg`, `feeUsdg`): `bigint` in base units (shares 1e18, USDG 1e6). Pass `walletSharesWei` back as-is.
- `change24h` and NAV summaries: fractions (0.012 = +1.2%). `buyCostBps`, `slippageBps`: basis points.

## Earning fees

Resting orders and scheduled buys are **public jobs**: `jobs()` lists every one executable right now, with calldata and the fee it pays whoever sends it. Simulate first; each fill is held to the order's on-chain floor.

MIT · [API guide for agents](https://api.bskts.xyz/llms.txt) · [bskts docs](https://bskts.xyz/docs.md)

## Delegated agents (bskts accounts)

Use this path for autonomous trades after a one-time owner approval. Direct
wallet `buildBuy/buildSell` plans are a different path and need the wallet's
signer and ETH. A delegated agent trades from the owner's bskts account, never
withdraws, and pays network fees from account USDG.

1. Create an agent signing key in your host wallet or secure signer. Share only
   its public address. The SDK and MCP never accept private keys.
2. Read `client.agentSession({owner, key})`. It resolves the owner's account.
   If inactive, send the owner to the returned `approvalUrl`; in Portfolio they
   connect the public key and review/sign its limits. Fund that account with USDG.
3. Build `client.buildAgentTrade({owner,key,ticker,side:"buy",amountUsdg:6})`
   or `{owner,key,ticker,side:"sell",shares}` (exact bigint base units).
4. Give `executeSession` the host's signer callbacks and an explicit network
   fee ceiling. There is no owner popup per trade or owner/agent ETH requirement.

```ts
import { BsktsClient, executeSession, sessionRelayer } from "@bskts/sdk";
import type { SessionSender } from "@bskts/sdk";

// hostSigner is supplied by your secure host wallet, already configured to
// use the agent key. Never embed a private key in source, prompts or MCP calls.
const client = new BsktsClient();
const key = hostSigner.address;
const permission = await client.agentSession({ owner, key });
if (!permission.active) throw new Error("Owner approval required: " + permission.approvalUrl);

const sender: SessionSender = {
  key,
  sign: (typedData) => hostSigner.signTypedData(typedData),
  submit: sessionRelayer(),
};
const plan = await client.buildAgentTrade({
  owner,
  key,
  ticker: "INDEX2",
  side: "buy",
  amountUsdg: 6,
  slippageBps: 50,
});
const receipt = await executeSession(plan, sender, {
  maxNetworkFeeUsdg: 250_000n, // host explicitly allows at most $0.25 network fee
});
```

Suggested owner limits: 10% of available account USDG (at least $10) capped at $100 of daily
turnover, 0.5% all-in module slippage, seven days. The approved dollar limit
stays fixed after deposits. Only the owner can change/renew it. Some baskets
need more slippage; request owner approval rather than silently widening it.
The relayer needs $5 of basket value after fees/slippage for buys (so a $5 cash
budget can be too small), or the entire sell position.

Session plans are unsigned, so `simulation.ok` is null. The relayer simulates
the signed Action before broadcasting. A 402 `requiredFee` is re-signed only
within the host's fee cap, retaining the same nonce, deadline and trade terms.

Delegated plans bind their basket ticker to the reviewed vault addresses in
`src/agent-vaults.json`. The client rejects a mismatched API response, and
`executeSession` checks again before signing, including plans supplied directly
or changed after parsing. Unknown or redeployed baskets require an SDK upgrade;
addresses never change automatically from a trade response. Maintainers update
the pins from `/v1/baskets` only after comparing them with the main repository's
canonical `src/lib/contracts.ts`, and ship the reviewed change with a changeset.

`executeSession` remembers the fee each kind of trade on each basket last
needed (the relayer quotes on success too) and signs the next one with it, so
a repeat trade is one signature and one relayer round trip. A plan built with
`feeUsdg` keeps that fee, and a remembered fee above your cap is not used. The
memory lives in this process for six hours; pass `fees: new Map()` or your own
`{ get, set }` store to keep it elsewhere (across workers or restarts), or
`fees: false` to always start from the 402 quote.

The SDK does **not** automatically retry a timeout: check
`BsktsSessionModule.nonceUsed(account,nonce)` and the `Executed` event before
resubmitting. Never rebuild a possibly submitted trade with a new nonce.

For a process that can restart, use `executeSessionOnce` (SDK 0.5.0+) and one
durable store per logical trade. It reserves the unsigned plan **before signing**,
retains the original nonce across fee quotes, and records the successful receipt.
Concurrent starts can only reserve one plan. A restart never signs or submits
that operation again: it returns the recorded outcome or reconciles its nonce.
Keys and signatures are never written to this store.

```ts
import { executeSessionOnce, sessionActionState, robinhood } from "@bskts/sdk";
import { fileSessionStore } from "@bskts/sdk/node"; // Node only; no fs in the root SDK
import { createPublicClient, http } from "viem";

const chain = createPublicClient({ chain: robinhood, transport: http("https://bskts.xyz/rpc") });
const result = await executeSessionOnce({
  store: fileSessionStore(".bskts-agent/strategy-operation-001.json"),
  sender, // same secure host callbacks as above
  maxNetworkFeeUsdg: 250_000n,
  build: () => client.buildAgentTrade({ owner, key, ticker: "INDEX2", side: "buy", amountUsdg: 6 }),
  reconcile: (plan) => sessionActionState(chain, plan.action),
});
```

Retain the journal and its `.result` file, including after success. Ignore
`.bskts-agent/` in Git. Custom stores must make `reserve` an exclusive durable
create; an ordinary overwrite does not prevent competing processes from trading.
File storage is for processes sharing that filesystem; independent hosts need a
shared store with the same guarantee. Partial/corrupt records fail closed.

`sessionActionState` reads the pinned module at one RPC block on chain 4663.
An unused nonce remains unresolved at or before its deadline, because a request
may still be in flight. Read failures leave the record intact. A consumed nonce
means no further submission is needed; it does not recover a transaction hash.
An expired unused action is retained as a terminal outcome and is never replaced
automatically. Reconcile the previous operation before choosing a new store ID
for a deliberate new trade. Do not delete records to restart after an error.

When delegated slippage is omitted, the API resolves it to the lower of 50 bps
and the owner's grant maximum. The client checks that resolved value against
`policy.maxSlippageBps`; explicit values over policy are refused before fetching.

Daily turnover includes buys and sells, resets at 00:00 UTC, is separate for
each key and excludes network fees (module hard ceiling $10 per Action).
Revoking blocks new requests once confirmed; existing orders/schedules can
still execute and need separate cancellation. Use a fresh key to reconnect.

The MCP exposes `bskts_agent_session` and `bskts_agent_trade` for the same
flow. It stays unsigned: your agent host must supply the signer and submitter.

Agent keys authorise account trading, including Weekend Cover when it is enabled. Cover spending is counted separately against the same daily limit; underwriting additionally requires the account owner’s allowance. Individual key revocation leaves existing Cover listings open: withdraw them in My cover. The API’s moduleEnabled/coverEnabled fields report the current account setup.

### Weekend Cover (SDK 0.6.0+)

Agents can **buy** Weekend Cover on a basket the account holds, from the same key, once the
owner has turned Cover on (`coverEnabled`). Cover pays the weekend drop between `fromBps` and
`toBps` (300-1000: from -3%, in full at -10%). A session pays at most 3% of the cover (premium +
fee), and cover counts against its own daily limit, apart from trades. Agents never underwrite.

```ts
import { coverActionState, coverRelayer, executeCoverOnce, type CoverPending } from "@bskts/sdk";
import { fileSessionStore } from "@bskts/sdk/node";

const book = await client.coverBook("DIGI64", { coverUsd: 1000, fromBps: 300, toBps: 1000 });
// book.ranges[0].quote.cost, and history.fairPer1k: what the range paid on an average weekend
const result = await executeCoverOnce({
  store: fileSessionStore<CoverPending>(".bskts-agent/cover-digi64-001.json"),
  sender: { key, sign: (td) => signer.signTypedData(td), submit: coverRelayer() },
  maxNetworkFeeUsdg: 250_000n,
  build: () =>
    client.buildAgentCover({
      owner,
      key,
      action: "take",
      ticker: "DIGI64",
      fromBps: 300,
      toBps: 1000,
      coverUsd: 1000,
    }),
  reconcile: (plan) => coverActionState(chain, plan.action),
});
```

`buildAgentCover` also takes `action: "request"` (with `pricePer1k`, locking the premium until
an underwriter fills it) and `action: "cancel"` (with `listingId`, free). `coverPositions(account)`
shows the cover held and its payouts, which the keeper makes automatically.
