# bskts SDK

Tools for trading [bskts](https://bskts.xyz), tokenized index baskets of Stock Tokens and crypto on Robinhood Chain, from code and from AI agents. Everything here is **non-custodial**: it reads the [bskts API](https://api.bskts.xyz) and builds unsigned transactions that your own wallet signs.

| Package                                        | What it is                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [`@bskts/sdk`](packages/sdk)                   | Typed TypeScript client: reads, unsigned buy / sell / order plans, dry runs, a policy guard, viem signing     |
| [`@bskts/mcp`](packages/mcp)                   | MCP server: the same as tools for Claude, ChatGPT, Cursor and other agents (stdio and Streamable HTTP)        |
| [`@bskts/create-agent`](packages/create-agent) | `npm create @bskts/agent`: a ready-to-run trading agent with its own key, approved once by the owner in bskts |

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

### API contract

`contract/` holds a snapshot of the bskts API: its [openapi.json](https://api.bskts.xyz/openapi.json) and one live response from each public read the SDK parses. The contract tests (`packages/*/src/contract.test.ts`) check the SDK and the MCP tools against it, offline:

- **Requests** (`AgentOrderRequest` for `POST /v1/agent/order`, so far): the SDK's argument types must require exactly the fields the API requires, and the SDK and the `bskts_agent_order` tool must refuse, before sending, every value the API refuses (each bound, integers, and for the tool required fields and patterns), and send every value it accepts. Where a client is deliberately stricter, the test names the case and the reason.
- **Responses**: parsing each snapshot must not strip a field. A new field the API sends fails until it is in `packages/sdk/src/schemas.ts`.

When the API changes, refresh the snapshot before changing the SDK to match, and commit `contract/` with the change:

```bash
pnpm run contract:refresh
```

The `API contract (live)` workflow (`.github/workflows/contract.yml`) does the same every day against the live API, and fails when the SDK no longer matches it or when `openapi.json` has moved on from the snapshot.

A change users would notice needs a changeset (`pnpm changeset`); see [.changeset/README.md](.changeset/README.md). Releases are staged from CI with npm trusted publishing and go live when a maintainer approves them with 2FA.

## Security

The SDK and server never hold keys or send transactions. Report a vulnerability through a private [GitHub security advisory](https://github.com/Tokenise-au/bskts-sdk/security/advisories/new), not a public issue.

MIT

## Delegated agents

For autonomous account trading after owner approval, use `agentSession` and
`buildAgentTrade` or `buildAgentOrder`, then `executeSession` with a host-provided signer and an
explicit network-fee ceiling. MCP exposes `bskts_agent_session` and
`bskts_agent_trade` and `bskts_agent_order`, remains unsigned, and never accepts private keys. See the
[SDK account guide](packages/sdk/README.md#delegated-agents-bskts-accounts) and
[MCP account guide](packages/mcp/README.md#autonomous-account-path).

Agents can place and cancel limit buys (`@bskts/sdk` 0.7.2+, `@bskts/mcp` 0.4.2+, skill 1.1.2+), and stop-losses, take-profits, brackets and buy-above limits, each with a preview of what its triggers mean (`@bskts/sdk` 0.8.0+, `@bskts/mcp` 0.5.0+, skill 1.2.0+). TWAP and Subscribe creation remain unsupported through agent tools.
