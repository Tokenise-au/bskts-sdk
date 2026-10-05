# @bskts/create-agent

## 0.2.1

### Patch Changes

- 8a5c870: Persist delegated trade intents before signing, reconcile their original nonces after restart, and retain completed outcomes so the starter's first buy cannot be repeated accidentally. Add optional durable execution and Node file-store helpers for agent hosts. Check resolved slippage against host policy while accepting omitted slippage under tighter owner grants. Update both agent-host guidance and the generated starter, requiring SDK 0.5.0 and Node 20.19 or newer.

## 0.2.0

### Minor Changes

- 025f881: The owner's wallet address moves from `agent.mjs` into `.env` (`BSKTS_OWNER`), so the script holds nothing personal and can be committed or shared. The agent starts right after setup (`--no-start` to skip). Pasting your bskts account's address instead of your wallet is detected on chain and corrected to the account's owner wallet. Without `--owner` and without a terminal to ask in, it stops and says how to pass one.

## 0.1.0

### Minor Changes

- 689fe12: New `@bskts/create-agent`: `npm create @bskts/agent` sets up a ready-to-run trading agent with a freshly generated key in `.env`, which waits for the owner's approval and then trades. SDK: `buildAgentTrade` accepts the API's default slippage (0.5%, or the grant's maximum if lower) when none is given. MCP: `bskts_agent_trade` slippage starts at 1 bps, as the module requires.
