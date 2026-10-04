// 2026-10-04: the bskts Agents tab handed out a key command and an agent.mjs to
// paste, and the owner's live test needed both plus a second run after
// approving. `npm create @bskts/agent` makes the folder in one step. Pure
// functions here; cli.ts does the prompting, writing and installing.
import { randomBytes } from "node:crypto";

/** secp256k1's group order: a private key must be in [1, N). */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** A fresh agent key from the OS's CSPRNG. Written to .env, never printed. */
export function newPrivateKey(random: (n: number) => Uint8Array = randomBytes): `0x${string}` {
  for (;;) {
    const hex = Buffer.from(random(32)).toString("hex");
    const k = BigInt(`0x${hex}`);
    if (k > 0n && k < N) return `0x${hex}`;
  }
}

export interface Options {
  dir: string;
  owner?: string;
  install: boolean;
}

export function parseArgs(argv: string[]): Options {
  const out: Options = { dir: "bskts-agent", install: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--owner") out.owner = argv[++i];
    else if (a.startsWith("--owner=")) out.owner = a.slice("--owner=".length);
    else if (a === "--no-install") out.install = false;
    else if (a.startsWith("-")) throw new Error(`Unknown option ${a}`);
    else out.dir = a;
  }
  return out;
}

/** The owner's public wallet address. A private key (64 hex) is refused loudly:
 * someone pasting one here has the wrong thing in their clipboard. */
export function ownerAddress(value: string | undefined): `0x${string}` {
  const v = (value ?? "").trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(v) || v.split(/\s+/).length >= 12)
    throw new Error(
      "That looks like a private key or recovery phrase. Never share it. Enter your wallet's public address: 0x followed by 40 characters.",
    );
  if (!/^0x[0-9a-fA-F]{40}$/.test(v))
    throw new Error("Enter your wallet's public address: 0x followed by 40 characters.");
  return v as `0x${string}`;
}

/** The same first agent as the bskts Agents tab's (src/lib/agent-permissions.ts
 * agentStarter in the bskts repo): waits for the owner's approval, buys $6 once. */
export function agentScript(owner: string): string {
  return `// agent.mjs — run with: npm start (node --env-file=.env agent.mjs)
import { BsktsClient, executeSession, sessionRelayer } from "@bskts/sdk";
import { privateKeyToAccount } from "viem/accounts";

const owner = "${owner}"; // your wallet
if (!process.env.AGENT_KEY) throw new Error("No AGENT_KEY in .env");
const agent = privateKeyToAccount(process.env.AGENT_KEY);
const bskts = new BsktsClient();

// waits here (up to 15 minutes) while you approve it in bskts, then trades once
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
  console.log("Approved. Buying $6 of INDEX2...");
}

// Your strategy goes here: decide what to trade. bskts.markets() has every
// basket's price, 24h change and buy cost. This first agent makes one buy.
const plan = await bskts.buildAgentTrade({
  owner, key: agent.address, ticker: "INDEX2", side: "buy", amountUsdg: 6,
});
const receipt = await executeSession(
  plan,
  { key: agent.address, sign: (data) => agent.signTypedData(data), submit: sessionRelayer() },
  { maxNetworkFeeUsdg: 250_000n }, // pay at most $0.25 network fee per trade
);
console.log("Bought INDEX2:", receipt.hash);
`;
}

/** Every file the starter writes, by path. Only .env holds the key. */
export function starterFiles(p: { name: string; owner: string; key: string }) {
  return {
    "package.json": `${JSON.stringify(
      {
        name: p.name,
        private: true,
        type: "module",
        scripts: { start: "node --env-file=.env agent.mjs" },
        engines: { node: ">=20.6" },
        dependencies: { "@bskts/sdk": "^0.4.0", viem: "^2.55.0" },
      },
      null,
      2,
    )}\n`,
    "agent.mjs": agentScript(p.owner),
    ".env": `# This agent's private key. Anyone with it can trade within the limits you
# approve in bskts until you revoke it there (it can never withdraw).
# Never share or commit this file.
AGENT_KEY=${p.key}
`,
    ".gitignore": ".env\nnode_modules/\n",
    "README.md": `# ${p.name}

A bskts trading agent, made with \`npm create @bskts/agent\`.

1. \`npm start\` prints the agent's address and an approval link.
2. Open the link (bskts.xyz → Portfolio → Agents, address filled in), check the
   daily limit, slippage and expiry, and approve with your wallet.
3. The script sees the approval and buys $6 of INDEX2 once.

Then make it yours: replace the trade in \`agent.mjs\` with your own logic.
Guide: https://bskts.xyz/docs#agents · SDK: https://www.npmjs.com/package/@bskts/sdk

\`.env\` holds the agent's key. Keep it private. To stop the agent, revoke it in
the Agents tab; your holdings stay in your account.
`,
  };
}

/** The package manager the user ran us with (npm_config_user_agent). */
export function packageManager(userAgent: string | undefined): "npm" | "pnpm" | "yarn" | "bun" {
  const name = (userAgent ?? "").split("/")[0];
  return name === "pnpm" || name === "yarn" || name === "bun" ? name : "npm";
}
