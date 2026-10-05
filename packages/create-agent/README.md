# @bskts/create-agent

Set up a [bskts](https://bskts.xyz) trading agent in one command:

```bash
npm create @bskts/agent
```

The easiest start is bskts → Portfolio → **Agents**: it shows this command with your wallet
address already filled in (`npm create @bskts/agent -- --owner 0x…`). Run on its own, it asks for
the address. Paste the wallet you log in with; if you paste your bskts account's address instead,
it finds the account's owner wallet and uses that.

It creates `bskts-agent/`, installs it, and starts the agent:

- `agent.mjs`: a first agent. It prints its address and a link that opens bskts → Portfolio →
  Agents with the address filled in, waits while you approve its limits with your wallet, then
  buys $6 of INDEX2 once. Replace that trade with your own logic. It holds nothing personal, so
  you can commit or share it.
- `.env`: your wallet address (`BSKTS_OWNER`) and the agent's new private key (`AGENT_KEY`),
  generated on your machine. The key is never shown, logged or sent anywhere, and `.gitignore`
  keeps the file out of git. Keep it private: anyone with the key can trade within the limits you
  approved, until you revoke the agent in bskts. It can never withdraw.

Run it again later with `npm start` in the folder. The first buy's record stays
in `.bskts-agent/` (Git ignored): restarting reconciles that nonce and never
buys again automatically, including after a lost response or confirmed success.
Keep these files. If the outcome is unresolved, restart to recheck it; never
delete the record or change its ID to retry. After reconciliation, your strategy
can choose a new journal path for a deliberate new trade. This starter requires
SDK 0.5.0 and Node 20.19 or newer.

Options:
`npm create @bskts/agent my-folder -- --owner 0x… --no-install --no-start`.

The agent trades from your bskts account within the daily turnover, slippage and expiry you
approve; only your wallet can change them. Guide: https://bskts.xyz/docs#agents ·
SDK: [`@bskts/sdk`](https://www.npmjs.com/package/@bskts/sdk).
