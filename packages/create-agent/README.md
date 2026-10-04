# @bskts/create-agent

Set up a [bskts](https://bskts.xyz) trading agent in one command:

```bash
npm create @bskts/agent
```

It asks for your wallet address (the owner of your bskts account) and creates `bskts-agent/`:

- `agent.mjs`: a first agent. `npm start` prints its address and a link that opens bskts →
  Portfolio → Agents with the address filled in, waits while you approve its limits with your
  wallet, then buys $6 of INDEX2 once. Replace that trade with your own logic.
- `.env`: the agent's new private key, generated on your machine. It is never shown, logged or
  sent anywhere, and `.gitignore` keeps it out of git. Keep it private: anyone with it can trade
  within the limits you approved, until you revoke the agent in bskts. It can never withdraw.

Options: `npm create @bskts/agent my-folder -- --owner 0x… --no-install`.

The agent trades from your bskts account within the daily turnover, slippage and expiry you
approve; only your wallet can change them. Guide: https://bskts.xyz/docs#agents ·
SDK: [`@bskts/sdk`](https://www.npmjs.com/package/@bskts/sdk).
