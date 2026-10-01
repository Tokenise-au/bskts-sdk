# @bskts/mcp

## 0.1.3

### Patch Changes

- 4e3ded8: Accept `viem@^2.55.0` (was `^2.57.0`): 2.55.0 is the first viem with the `robinhood` chain the SDK re-exports, so projects on viem 2.55 or 2.56 no longer get an unmet peer dependency.
- Updated dependencies [4e3ded8]
  - @bskts/sdk@0.3.2

## 0.1.2

### Patch Changes

- be1b308: Report the real package version in the MCP server's info and in `VERSION` (0.1.1 reported "0.1.0").

## 0.1.1

### Patch Changes

- 6ad56ae: Fix installs: `@bskts/sdk` 0.3.0 pinned its viem peer to exactly `2.30.0` (a range was intended), so it could not be installed next to any other viem, and `@bskts/mcp` 0.1.0 depended on that exact SDK. The SDK now accepts `viem@^2.57.0`, and the MCP server any `@bskts/sdk` 0.3.x.
- Updated dependencies [6ad56ae]
  - @bskts/sdk@0.3.1
