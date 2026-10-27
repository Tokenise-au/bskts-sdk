---
"@bskts/sdk": patch
"@bskts/mcp": patch
---

Wallet cancels name their escrow, and agents can trade the yield baskets. The MCP's `bskts_order` takes an optional `escrow` for `kind: "cancel"` (the escrow from `bskts_account`; recommended) and forwards it. Every escrow numbers its orders from 1, so one order id is often open on several escrows, and the API now refuses a cancel without `escrow` in that case with `ORDER_AMBIGUOUS` (a new `ErrorCode`) instead of guessing; the tool's error tells the caller to call again with `escrow`. The SDK pins the WAFER and COMET vaults, so delegated trades, orders and Cover on the two yield baskets are no longer refused as unreviewed.
