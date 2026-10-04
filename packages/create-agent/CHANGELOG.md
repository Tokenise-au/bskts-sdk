# @bskts/create-agent

## 0.1.0

### Minor Changes

- 689fe12: New `@bskts/create-agent`: `npm create @bskts/agent` sets up a ready-to-run trading agent with a freshly generated key in `.env`, which waits for the owner's approval and then trades. SDK: `buildAgentTrade` accepts the API's default slippage (0.5%, or the grant's maximum if lower) when none is given. MCP: `bskts_agent_trade` slippage starts at 1 bps, as the module requires.
