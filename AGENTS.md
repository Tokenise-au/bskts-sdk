# AGENTS.md — instructions for AI coding assistants

Public pnpm workspace for **@bskts/sdk** (typed client for the bskts API) and **@bskts/mcp**
(MCP server over it). bskts is live on Robinhood Chain mainnet with real funds; these packages
are how agents and developers trade it.

## Never

- **Hold, accept or log a private key, or send a transaction.** Both packages are unsigned only:
  they build plans, the user's wallet signs. The MCP server stays that way.
- **Resolve a token by symbol.** Addresses come from the API only; the chain has impostor tokens.
- **Use a price feed or third-party price API.** Prices come from the bskts API (on-chain pools).
- **Hand-edit `CHANGELOG.md` or package versions.** Changesets owns them.
- **Add to `onlyBuiltDependencies`** or lower `minimumReleaseAge` in `pnpm-workspace.yaml`
  without a maintainer's go-ahead; they are supply-chain guards.

## Always

- Response shapes live in `packages/sdk/src/schemas.ts` (Zod); types come from them. When the
  API changes, change the schema, not a hand-written interface.
- On-chain amounts are `bigint`; dollars and fractions are `number`.
- New pure logic gets a Vitest test next to it (`*.test.ts`), no network.
- Before finishing: `pnpm run build && pnpm run typecheck && pnpm test && pnpm run lint &&
pnpm run format:check && pnpm run check:packages`.
- A user-visible change gets a changeset (`pnpm changeset`).
- Commit messages: conventional with a scope, e.g. `feat(sdk): …`, `fix(mcp): …`.
