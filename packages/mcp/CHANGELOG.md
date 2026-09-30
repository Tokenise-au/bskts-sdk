# @bskts/mcp

## 0.1.1

### Patch Changes

- 6ad56ae: Fix installs: `@bskts/sdk` 0.3.0 pinned its viem peer to exactly `2.30.0` (a range was intended), so it could not be installed next to any other viem, and `@bskts/mcp` 0.1.0 depended on that exact SDK. The SDK now accepts `viem@^2.57.0`, and the MCP server any `@bskts/sdk` 0.3.x.
- Updated dependencies [6ad56ae]
  - @bskts/sdk@0.3.1
