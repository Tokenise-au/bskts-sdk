# Changesets

Every change a user of `@bskts/sdk` or `@bskts/mcp` would notice gets a changeset:

```bash
pnpm changeset
```

Pick the packages and the bump (a breaking change to the SDK's API is a major; the SDK follows the API's contract), and describe the change for the changelog. The release workflow turns merged changesets into a "Version packages" PR; merging that PR publishes to npm.
