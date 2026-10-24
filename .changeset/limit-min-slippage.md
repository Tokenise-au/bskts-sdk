---
"@bskts/sdk": patch
"@bskts/mcp": patch
---

Basket and market reads carry `limitMinSlippageBps`, the least `slippageBps` the bskts API accepts for a delegated limit order now (the routing cost or a yield basket's CLM reserve, plus the mint fee, never under 50). The SDK's response schemas dropped unknown keys, so the field was invisible before. Limit docs and the `bskts_agent_order` tool point to it instead of "buyCostBps + 20", which understated yield baskets (a 30 bps cost: 50 vs the 170 required).
