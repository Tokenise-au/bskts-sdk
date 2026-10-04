---
"@bskts/create-agent": minor
---

The owner's wallet address moves from `agent.mjs` into `.env` (`BSKTS_OWNER`), so the script holds nothing personal and can be committed or shared. The agent starts right after setup (`--no-start` to skip). Pasting your bskts account's address instead of your wallet is detected on chain and corrected to the account's owner wallet. Without `--owner` and without a terminal to ask in, it stops and says how to pass one.
