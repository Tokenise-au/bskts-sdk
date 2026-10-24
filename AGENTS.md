# AGENTS.md — instructions for AI coding assistants

Public pnpm workspace for **@bskts/sdk** (typed client for the bskts API) and **@bskts/mcp**
(MCP server over it). bskts is live on Robinhood Chain mainnet with real funds; these packages
are how agents and developers trade it.

## Never

- **Hold, accept or log a private key, or send a transaction.** The SDK and MCP are unsigned
  only: they build plans, the user's wallet or host signer signs. The MCP server stays that way.
  The exceptions are `@bskts/create-agent` (2026-10-04) and the agent skill (`skills/bskts`,
  2026-10-10): each generates a NEW agent key on the user's machine and writes it, with the
  owner's public wallet address, to a `.env` (mode 0600; the starter's is git-ignored, the
  skill's is `~/.bskts-agent/.env`). Neither prints, logs or sends the key, nor accepts an
  existing one. The skill signs and relays its own key's trades only with `--send`.
- **Edit `skills/bskts/scripts/bskts.mjs`.** It is generated (2026-10-12): edit
  `packages/skill/src/bskts.mjs` and run `pnpm run build`; CI's `check:skill` fails on a stale
  bundle. The skill installs nothing at runtime; keep it that way (no child processes, no
  downloads). Every merge to `main` that touches `skills/` reaches users on their next
  `npx skills update`, so treat it as a release: bump `version:` in `SKILL.md` and
  `SKILL_VERSION` in the source together (a test keeps them equal), then tag `skill-v<version>`.
- **Resolve a token by symbol.** Addresses come from the API only; the chain has impostor tokens.
- **Use a price feed or third-party price API.** Prices come from the bskts API (on-chain pools).
- **Hand-edit `CHANGELOG.md` or package versions.** Changesets owns them.
- **Add to `onlyBuiltDependencies`** or lower `minimumReleaseAge` in `pnpm-workspace.yaml`
  without a maintainer's go-ahead; they are supply-chain guards.

## Always

- Response shapes live in `packages/sdk/src/schemas.ts` (Zod); types come from them. When the
  API changes, change the schema, not a hand-written interface. Run `pnpm run contract:refresh`
  first (README "API contract"): the contract tests fail until the SDK and MCP match the API.
- On-chain amounts are `bigint`; dollars and fractions are `number`.
- New pure logic gets a Vitest test next to it (`*.test.ts`), no network.
- Before finishing: `pnpm run build && pnpm run typecheck && pnpm test && pnpm run lint &&
pnpm run format:check && pnpm run check:packages`.
- A user-visible change gets a changeset (`pnpm changeset`).
- Commit messages: conventional with a scope, e.g. `feat(sdk): …`, `fix(mcp): …`.
