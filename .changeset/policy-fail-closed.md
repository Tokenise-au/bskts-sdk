---
"@bskts/sdk": patch
"@bskts/mcp": patch
---

Policy fails closed on an unknown buy cost: with `maxBuyCostBps` (MCP: `BSKTS_MAX_BUY_COST_BPS`) set, a wallet buy, wallet limit buy, agent buy or agent limit order is refused with `POLICY` when the API cannot price the buy (`buyCostBps: null`), instead of skipping the check. Wallet limit buys now also refuse known costs above the cap. This checks the current buy cost when placing the order; the order's on-chain slippage floor governs its later fill. `buildRedeem` now applies `allowedTickers`, like every other plan builder.
