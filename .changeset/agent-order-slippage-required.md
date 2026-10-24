---
"@bskts/sdk": patch
"@bskts/mcp": patch
---

Agent limit orders require `slippageBps`, matching the bskts API (`POST /v1/agent/order`). Its old 50 bps default sat below a yield basket's fill cost, so those orders could never fill. `buildAgentOrder`'s limit type and the `bskts_agent_order` MCP tool now require it (50-1000 bps, within the session's `maxSlippageBps`, at least the basket's `buyCostBps` + 20), and the READMEs no longer describe a default.
