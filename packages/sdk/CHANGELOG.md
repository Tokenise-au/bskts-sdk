# @bskts/sdk

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
