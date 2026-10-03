---
"@bskts/sdk": minor
"@bskts/mcp": minor
---

Add live agent permission discovery, unsigned account buy/sell Actions, and caller-supplied session execution with bounded network fees. Repeat trades sign once with the fee the last one needed (`fees` option). Relayer refusals carry their reason and distinct codes (`FEE_REQUIRED`, `RATE_LIMITED`, `REFUSED`, `UNCERTAIN`). MCP stays unsigned and exposes both wallet and delegated account onboarding paths.
