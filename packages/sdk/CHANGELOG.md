# @bskts/sdk

## 0.3.2

### Patch Changes

- 4e3ded8: Accept `viem@^2.55.0` (was `^2.57.0`): 2.55.0 is the first viem with the `robinhood` chain the SDK re-exports, so projects on viem 2.55 or 2.56 no longer get an unmet peer dependency.

## 0.3.1

### Patch Changes

- 6ad56ae: Fix installs: `@bskts/sdk` 0.3.0 pinned its viem peer to exactly `2.30.0` (a range was intended), so it could not be installed next to any other viem, and `@bskts/mcp` 0.1.0 depended on that exact SDK. The SDK now accepts `viem@^2.57.0`, and the MCP server any `@bskts/sdk` 0.3.x.
