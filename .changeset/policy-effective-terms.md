---
"@bskts/sdk": minor
"@bskts/mcp": patch
---

Host policy now checks what a plan will actually do (bskts agent audit F5, 2026-10-27).

- `buildBuy` and `buildSell` resolve an omitted `slippageBps` to the API's default (50), send it explicitly and check it against `maxSlippageBps`.
- Wallet limit buys and exits (`buildOrder`) are held to `maxSlippageBps` at their fixed 3% widest floor (`WALLET_ORDER_MAX_SLIPPAGE_BPS`). A policy with `maxSlippageBps` under 300 now refuses them, where before it let them through unchecked.
- A wallet exit's shares are sized at NAV against `maxUsdPerTrade`.
- With `maxUsdPerTrade` set, a sale or exit the client cannot value (no NAV) is refused with `POLICY`, instead of being valued at $0.
- Exported `DEFAULT_SLIPPAGE_BPS` and `WALLET_ORDER_MAX_SLIPPAGE_BPS`.

Order previews (`describePreview`) say "at the trigger's widest floor" instead of "worst net" / "worst proceeds". These figures are at the trigger, not bounds: after a gap a stop sells lower and a buy-above pays more. The API's field names are unchanged.

`jobs({ cursor })` pages through `/v1/jobs`. The response keeps the API's new `complete`, `next` and `scan` fields (optional, since older API deployments don't send them), so `complete: false` can be told apart from "no jobs" (audit F7).
