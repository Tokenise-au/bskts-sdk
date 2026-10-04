# @bskts/create-agent

## 0.2.0

### Minor Changes

- 025f881: The owner's wallet address moves from `agent.mjs` into `.env` (`BSKTS_OWNER`), so the script holds nothing personal and can be committed or shared. The agent starts right after setup (`--no-start` to skip). Pasting your bskts account's address instead of your wallet is detected on chain and corrected to the account's owner wallet. Without `--owner` and without a terminal to ask in, it stops and says how to pass one.

## 0.1.0

### Minor Changes

- 689fe12: New `@bskts/create-agent`: `npm create @bskts/agent` sets up a ready-to-run trading agent with a freshly generated key in `.env`, which waits for the owner's approval and then trades. SDK: `buildAgentTrade` accepts the API's default slippage (0.5%, or the grant's maximum if lower) when none is given. MCP: `bskts_agent_trade` slippage starts at 1 bps, as the module requires.
