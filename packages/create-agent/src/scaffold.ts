// 2026-10-04: the bskts Agents tab handed out a key command and an agent.mjs to
// paste, and the owner's live test needed both plus a second run after
// approving. `npm create @bskts/agent` makes the folder in one step. Pure
// functions here (the chain read takes its transport); cli.ts does the
// prompting, writing, installing and starting.
import { randomBytes } from "node:crypto";
import { agentTemplate } from "./agent-template";

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
  start: boolean;
}

export function parseArgs(argv: string[]): Options {
  const out: Options = { dir: "bskts-agent", install: true, start: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--owner") out.owner = argv[++i];
    else if (a.startsWith("--owner=")) out.owner = a.slice("--owner=".length);
    else if (a === "--no-install") out.install = false;
    else if (a === "--no-start") out.start = false;
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

// 2026-10-04: the likeliest slip is pasting the bskts ACCOUNT's address (the app
// shows it) instead of the wallet that owns it. The agent would then wait for an
// approval that can never come: that address has no account of its own. A bskts
// account is a 1-of-1 Safe the factory made for its owner, so two reads tell
// for certain: the Safe's one owner, and that owner's account per the factory.
export const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const ACCOUNT_FACTORY = "0xd9424BcFD33fBEF67019b736672626D7DAB954A3";
export const GET_OWNERS = "0xa0e67e2b"; // getOwners()
export const ACCOUNT_OF = "0x8086b8ba"; // accountOf(address)

export type EthCall = (to: string, data: string) => Promise<string>;

/** eth_call against the public RPC, 8 s at most. */
export const publicCall: EthCall = async (to, data) => {
  const res = await fetch(PUBLIC_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
    signal: AbortSignal.timeout(8_000),
  });
  const out = (await res.json()) as { result?: string; error?: unknown };
  if (typeof out.result !== "string") throw new Error("eth_call failed");
  return out.result;
};

const word = (hex: string, i: number) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
const addressOf = (w: string) => `0x${w.slice(24)}`.toLowerCase();

/** If `address` is a bskts account, its owner's wallet; otherwise undefined.
 * A wallet, an unrelated Safe or a failed read all come back undefined. */
export async function walletOfAccount(
  address: string,
  call: EthCall = publicCall,
): Promise<`0x${string}` | undefined> {
  let owners: string;
  try {
    owners = await call(address, GET_OWNERS);
  } catch {
    return undefined;
  }
  // address[] of one: offset, length 1, the address
  if (owners.length !== 2 + 64 * 3 || BigInt(`0x${word(owners, 1)}`) !== 1n) return undefined;
  const owner = addressOf(word(owners, 2));
  try {
    const account = await call(ACCOUNT_FACTORY, ACCOUNT_OF + owner.slice(2).padStart(64, "0"));
    return addressOf(word(account, 0)) === address.toLowerCase()
      ? (owner as `0x${string}`)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The same first agent as the bskts Agents tab's (src/lib/agent-permissions.ts
 * agentStarter in the bskts repo): waits for the owner's approval, buys $6 once.
 * Nothing personal in it: the owner's address and the key are both in .env, so
 * the script can be committed or shared as it is. */
export function agentScript(): string {
  return agentTemplate();
}

/** Every file the starter writes, by path. Only .env holds the key and the
 * owner's address. */
export function starterFiles(p: { name: string; owner: string; key: string }) {
  return {
    "package.json": `${JSON.stringify(
      {
        name: p.name,
        private: true,
        type: "module",
        scripts: {
          start: "node --env-file=.env agent.mjs",
          live: "node --env-file=.env agent.mjs --live",
        },
        engines: { node: ">=20.19" },
        dependencies: { "@bskts/sdk": "^0.5.0", viem: "^2.55.0" },
      },
      null,
      2,
    )}\n`,
    "agent.mjs": agentScript(),
    ".env": `# Your wallet: the owner of the bskts account this agent trades from.
BSKTS_OWNER=${p.owner}

# This agent's private key. Anyone with it can trade within the limits you
# approve in bskts until you revoke it there (it can never withdraw).
# Never share or commit this file.
AGENT_KEY=${p.key}
`,
    ".gitignore": ".env\nnode_modules/\n.bskts-agent/\n",
    "README.md": `# ${p.name}

A bskts trading agent, made with \`npm create @bskts/agent\`.

1. \`npm start\` prints the agent's address and an approval link.
2. Open the link (bskts.xyz → Portfolio → Agents, address filled in), check the
   daily limit, slippage and expiry, and approve with your wallet.
3. The script sees the approval and DRY RUNS a $6 buy of INDEX2: it builds the
   trade, bskts simulates it from your account, and nothing is sent.
4. \`npm run live\` sends that buy for real, once.

Then make it yours: replace the trade in \`agent.mjs\` with your own logic.
The live trade's public plan and outcome stay in \`.bskts-agent/\`.
Restarting checks that same nonce and never buys again automatically, even
after success. Keep these files: deleting them removes the duplicate protection.
An unresolved submission stops; restart to recheck it. An unused nonce at or
before its deadline may still execute. Only after reconciliation should you
use a new journal path for a deliberate new strategy trade.
Guide: https://bskts.xyz/docs#agents · SDK: https://www.npmjs.com/package/@bskts/sdk

\`.env\` holds your wallet address (\`BSKTS_OWNER\`) and the agent's key
(\`AGENT_KEY\`). Keep it private; \`agent.mjs\` has nothing personal in it. To stop
the agent, revoke it in the Agents tab; your holdings stay in your account.
`,
  };
}

/** The package manager the user ran us with (npm_config_user_agent). */
export function packageManager(userAgent: string | undefined): "npm" | "pnpm" | "yarn" | "bun" {
  const name = (userAgent ?? "").split("/")[0];
  return name === "pnpm" || name === "yarn" || name === "bun" ? name : "npm";
}
