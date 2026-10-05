---
"@bskts/sdk": minor
"@bskts/create-agent": patch
"@bskts/mcp": patch
---

Persist delegated trade intents before signing, reconcile their original nonces after restart, and retain completed outcomes so the starter's first buy cannot be repeated accidentally. Add optional durable execution and Node file-store helpers for agent hosts. Check resolved slippage against host policy while accepting omitted slippage under tighter owner grants. Update both agent-host guidance and the generated starter, requiring SDK 0.5.0 and Node 20.19 or newer.
