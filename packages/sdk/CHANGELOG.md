# @bskts/sdk

## 0.9.1

### Patch Changes

- f1ff76d: `jobs()` keeps the API's `vaults` count, which the schema used to drop. The vendored API contract now includes `GET /v1/jobs`, so a field the SDK drops from it fails a test.

## 0.9.0

### Minor Changes

- 8fa87b4: Host policy now checks what a plan will actually do (bskts agent audit F5, 2026-10-27).
  
  - `buildBuy` and `buildSell` resolve an omitted `slippageBps` to the API's default (50), send it explicitly and check it against `maxSlippageBps`.
  - Wallet limit buys and exits (`buildOrder`) are held to `maxSlippageBps` at their fixed 3% widest floor (`WALLET_ORDER_MAX_SLIPPAGE_BPS`). A policy with `maxSlippageBps` under 300 now refuses them, where before it let them through unchecked.
  - A wallet exit's shares are sized at NAV against `maxUsdPerTrade`.
  - With `maxUsdPerTrade` set, a sale or exit the client cannot value (no NAV) is refused with `POLICY`, instead of being valued at $0.
  - Exported `DEFAULT_SLIPPAGE_BPS` and `WALLET_ORDER_MAX_SLIPPAGE_BPS`.
  
  Order previews (`describePreview`) say "at the trigger's widest floor" instead of "worst net" / "worst proceeds". These figures are at the trigger, not bounds: after a gap a stop sells lower and a buy-above pays more. The API's field names are unchanged.
  
  `jobs({ cursor })` pages through `/v1/jobs`. The response keeps the API's new `complete`, `next` and `scan` fields (optional, since older API deployments don't send them), so `complete: false` can be told apart from "no jobs" (audit F7).

## 0.8.1

### Patch Changes

- 664f8cc: Wallet cancels name their escrow, and agents can trade the yield baskets. The MCP's `bskts_order` takes an optional `escrow` for `kind: "cancel"` (the escrow from `bskts_account`; recommended) and forwards it. Every escrow numbers its orders from 1, so one order id is often open on several escrows, and the API now refuses a cancel without `escrow` in that case with `ORDER_AMBIGUOUS` (a new `ErrorCode`) instead of guessing; the tool's error tells the caller to call again with `escrow`. The SDK pins the WAFER and COMET vaults, so delegated trades, orders and Cover on the two yield baskets are no longer refused as unreviewed.

## 0.8.0

### Minor Changes

- 5ac9fa2: Delegated exits and order previews. `buildAgentOrder` (and the MCP's `bskts_agent_order`) builds stop-loss, take-profit and bracket orders (`kind: "exit"`) and their cancellation (`kind: "cancel-exit"`) for approved agent keys, and buy-above limits (`triggerBelow: false`). Every order plan now carries the API's `preview`: the current 10-minute NAV, each trigger's distance from it, an exit's return against the account's average entry before and after costs, and a limit's worst price per share. Triggers are on NAV, so they are price returns, not net profit. New: `exitOrderId`, `describePreview`, `exitMinSlippageBps` on markets and baskets.

## 0.7.2

### Patch Changes

- 6ca4290: Basket and market reads carry `limitMinSlippageBps`, the least `slippageBps` the bskts API accepts for a delegated limit order now (the routing cost or a yield basket's CLM reserve, plus the mint fee, never under 50). The SDK's response schemas dropped unknown keys, so the field was invisible before. Limit docs and the `bskts_agent_order` tool point to it instead of "buyCostBps + 20", which understated yield baskets (a 30 bps cost: 50 vs the 170 required).

## 0.7.1

### Patch Changes

- bae1a4b: Agent limit orders require `slippageBps`, matching the bskts API (`POST /v1/agent/order`). Its old 50 bps default sat below a yield basket's fill cost, so those orders could never fill. `buildAgentOrder`'s limit type and the `bskts_agent_order` MCP tool now require it (50-1000 bps, within the session's `maxSlippageBps`, at least the basket's `buyCostBps` + 20), and the READMEs no longer describe a default.

## 0.7.0

### Minor Changes

- 08b9e9a: Add delegated limit-buy creation and cancellation, validate encoded order terms before signing, and retain durable nonce recovery. Expose unsigned MCP order tools and skill limit/orders/cancel commands.

## 0.6.0

### Minor Changes

- d4e3f63: Agents can buy Weekend Cover on baskets their bskts account holds, from the same owner-approved session key that trades. The SDK adds `coverWeeks`, `coverBook` and `coverPositions` reads, `buildAgentCover` (take offers, request cover, or cancel the account's listing; checked against the request and the cover module's 3% premium ceiling before it is returned), `coverTypedData` pinned to the cover module's own EIP-712 domain, `coverRelayer`, `executeCover` (402 fee retries re-sign only the fee; cancels are free), and once-only `executeCoverOnce` with `coverActionState` reconciliation. `fileSessionStore` now holds cover journals too, and the once-only runner is shared with `executeSessionOnce`. The MCP server adds `bskts_cover` (weeks, book, positions) and `bskts_agent_cover`, both unsigned. Underwriting stays with the owner and is not an agent action.

## 0.5.0

### Minor Changes

- 8a5c870: Persist delegated trade intents before signing, reconcile their original nonces after restart, and retain completed outcomes so the starter's first buy cannot be repeated accidentally. Add optional durable execution and Node file-store helpers for agent hosts. Check resolved slippage against host policy while accepting omitted slippage under tighter owner grants. Update both agent-host guidance and the generated starter, requiring SDK 0.5.0 and Node 20.19 or newer.

## 0.4.2

### Patch Changes

- d079ce3: Bind delegated agent plans to reviewed basket vault addresses, and recheck the binding before signing. Reject mismatched and unknown baskets rather than trusting a response's ticker label.

## 0.4.1

### Patch Changes

- 689fe12: New `@bskts/create-agent`: `npm create @bskts/agent` sets up a ready-to-run trading agent with a freshly generated key in `.env`, which waits for the owner's approval and then trades. SDK: `buildAgentTrade` accepts the API's default slippage (0.5%, or the grant's maximum if lower) when none is given. MCP: `bskts_agent_trade` slippage starts at 1 bps, as the module requires.

## 0.4.0

### Minor Changes

- e6f4910: Add live agent permission discovery, unsigned account buy/sell Actions, and caller-supplied session execution with bounded network fees. Repeat trades sign once with the fee the last one needed (`fees` option). Relayer refusals carry their reason and distinct codes (`FEE_REQUIRED`, `RATE_LIMITED`, `REFUSED`, `UNCERTAIN`). MCP stays unsigned and exposes both wallet and delegated account onboarding paths.

## 0.3.2

### Patch Changes

- 4e3ded8: Accept `viem@^2.55.0` (was `^2.57.0`): 2.55.0 is the first viem with the `robinhood` chain the SDK re-exports, so projects on viem 2.55 or 2.56 no longer get an unmet peer dependency.

## 0.3.1

### Patch Changes

- 6ad56ae: Fix installs: `@bskts/sdk` 0.3.0 pinned its viem peer to exactly `2.30.0` (a range was intended), so it could not be installed next to any other viem, and `@bskts/mcp` 0.1.0 depended on that exact SDK. The SDK now accepts `viem@^2.57.0`, and the MCP server any `@bskts/sdk` 0.3.x.
