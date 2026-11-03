---
"@bskts/sdk": patch
"@bskts/mcp": patch
---

Policy fails closed on an unknown buy cost: with `maxBuyCostBps` (MCP: `BSKTS_MAX_BUY_COST_BPS`) set, a buy, agent buy or agent limit order is refused with `POLICY` when the API cannot price the buy (`buyCostBps: null`), instead of skipping the check. `buildRedeem` now applies `allowedTickers`, like every other plan builder.
