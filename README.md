# bskts SDK

Tools for trading [bskts](https://bskts.xyz), tokenized index baskets of Stock Tokens and crypto on Robinhood Chain, from code and from AI agents. Everything here is **non-custodial**: it reads the [bskts API](https://api.bskts.xyz) and builds unsigned transactions that your own wallet signs.

| Package                      | What it is                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| [`@bskts/sdk`](packages/sdk) | Typed TypeScript client: reads, unsigned buy / sell / order plans, dry runs, a policy guard, viem signing |
| [`@bskts/mcp`](packages/mcp) | MCP server: the same as tools for Claude, ChatGPT, Cursor and other agents (stdio and Streamable HTTP)    |

No code at all? The REST API is plain JSON: [api.bskts.xyz/llms.txt](https://api.bskts.xyz/llms.txt) is the guide for agents, [openapi.json](https://api.bskts.xyz/openapi.json) the spec.

## Development

pnpm workspace, Node 24 (`.node-version`).

```bash
pnpm install
pnpm run build        # tsdown, both packages
pnpm test             # Vitest, offline
pnpm run typecheck
pnpm run lint         # oxlint
pnpm run format       # oxfmt
pnpm run check:packages  # publint + arethetypeswrong on the built packages
```

A change users would notice needs a changeset (`pnpm changeset`); see [.changeset/README.md](.changeset/README.md). Releases are staged from CI with npm trusted publishing and go live when a maintainer approves them with 2FA.

## Security

The SDK and server never hold keys or send transactions. Report a vulnerability through a private [GitHub security advisory](https://github.com/Tokenise-au/bskts-sdk/security/advisories/new), not a public issue.

MIT

## Delegated agents

For autonomous account trading after owner approval, use `agentSession` and
`buildAgentTrade`, then `executeSession` with a host-provided signer and an
explicit network-fee ceiling. MCP exposes `bskts_agent_session` and
`bskts_agent_trade`, remains unsigned, and never accepts private keys. See the
[SDK account guide](packages/sdk/README.md#delegated-agents-bskts-accounts) and
[MCP account guide](packages/mcp/README.md#autonomous-account-path).
