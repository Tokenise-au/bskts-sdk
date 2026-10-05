// 2026-10-05: keep approval inside build(), so a restart reconciles the saved
// action even after revocation/expiry, without waiting for another grant.
export function agentTemplate(): string {
  return `// agent.mjs — start it with: node --env-file=.env agent.mjs
import { BsktsClient, executeSessionOnce, sessionActionState, sessionRelayer, robinhood } from "@bskts/sdk";
import { fileSessionStore } from "@bskts/sdk/node";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const owner = process.env.BSKTS_OWNER; // your wallet, from .env
if (!owner) throw new Error("No BSKTS_OWNER in .env: add your wallet address");
if (!process.env.AGENT_KEY) throw new Error("No AGENT_KEY in .env");
const agent = privateKeyToAccount(process.env.AGENT_KEY);
const bskts = new BsktsClient();
const chain = createPublicClient({ chain: robinhood, transport: http("https://bskts.xyz/rpc") });

// Keep this path for this logical trade, even after success. A restart checks
// its nonce and never creates another buy. New strategy trades need new IDs;
// never delete unresolved records or use a new ID to retry a lost response.
const store = fileSessionStore(".bskts-agent/first-index2-buy.json");
const result = await executeSessionOnce({
  store,
  sender: { key: agent.address, sign: (data) => agent.signTypedData(data), submit: sessionRelayer() },
  maxNetworkFeeUsdg: 250_000n, // pay at most $0.25 network fee per trade
  reconcile: (plan) => sessionActionState(chain, plan.action),
  build: async () => {
    console.log("Checking the agent's approval in bskts...");
    let status = await bskts.agentSession({ owner, key: agent.address });
    if (!status.active) {
      console.log("Agent address:", agent.address);
      console.log("Approve it in bskts (opens with the address filled in):");
      console.log(status.approvalUrl);
      console.log("Waiting for your approval... (Ctrl+C to stop)");
      for (let i = 0; i < 90 && !status.active; i++) {
        await new Promise((r) => setTimeout(r, 10_000));
        status = await bskts.agentSession({ owner, key: agent.address });
      }
      if (!status.active) throw new Error("Not approved within 15 minutes: run it again to keep waiting");
    }
    // Your strategy goes here. This first operation makes one $6 buy.
    return bskts.buildAgentTrade({
      owner, key: agent.address, ticker: "INDEX2", side: "buy", amountUsdg: 6,
    });
  },
});
if (result.state === "confirmed") console.log("INDEX2 trade recorded:", result.receipt.hash);
else if (result.state === "consumed") console.log("Stored action nonce is consumed on chain; no additional trade was made.");
else console.log("Stored action expired unexecuted; no replacement was made. Review it before a deliberate new trade.");
`;
}
