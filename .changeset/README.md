# Changesets

Every change a user of `@bskts/sdk` or `@bskts/mcp` would notice gets a changeset:

```bash
pnpm changeset
```

A change that follows the bskts API (a new response field, a newly required argument) starts with `pnpm run contract:refresh`, so the contract tests compare the SDK and MCP with the API as it is now; commit the refreshed `contract/` in the same PR. See "API contract" in the root README.

Pick the packages and the bump (a breaking change to the SDK's API is a major; the SDK follows the API's contract), and describe the change for the changelog. The release workflow turns merged changesets into a "Version packages" PR. Merging that PR **stages** the new versions on npm; they go live when a maintainer approves each one with 2FA on npmjs.com (or `npm stage approve <stage-id>`). Approve `@bskts/sdk` before `@bskts/mcp`, which depends on it.

`pnpm run release:dry` shows what the next release would stage.
