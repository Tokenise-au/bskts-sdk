---
"@bskts/sdk": minor
"@bskts/mcp": minor
---

Agents can buy Weekend Cover on baskets their bskts account holds, from the same owner-approved session key that trades. The SDK adds `coverWeeks`, `coverBook` and `coverPositions` reads, `buildAgentCover` (take offers, request cover, or cancel the account's listing; checked against the request and the cover module's 3% premium ceiling before it is returned), `coverTypedData` pinned to the cover module's own EIP-712 domain, `coverRelayer`, `executeCover` (402 fee retries re-sign only the fee; cancels are free), and once-only `executeCoverOnce` with `coverActionState` reconciliation. `fileSessionStore` now holds cover journals too, and the once-only runner is shared with `executeSessionOnce`. The MCP server adds `bskts_cover` (weeks, book, positions) and `bskts_agent_cover`, both unsigned. Underwriting stays with the owner and is not an agent action.
