---
"@bskts/sdk": minor
"@bskts/mcp": minor
---

Delegated exits and order previews. `buildAgentOrder` (and the MCP's `bskts_agent_order`) builds stop-loss, take-profit and bracket orders (`kind: "exit"`) and their cancellation (`kind: "cancel-exit"`) for approved agent keys, and buy-above limits (`triggerBelow: false`). Every order plan now carries the API's `preview`: the current 10-minute NAV, each trigger's distance from it, an exit's return against the account's average entry before and after costs, and a limit's worst price per share. Triggers are on NAV, so they are price returns, not net profit. New: `exitOrderId`, `describePreview`, `exitMinSlippageBps` on markets and baskets.
