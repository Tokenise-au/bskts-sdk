#!/usr/bin/env node
// bskts skill CLI (2026-10-10): the signer that agents with a shell (OpenClaw,
// Hermes, Claude Code) were missing. The MCP server and API stay unsigned; chat
// assistants could read markets and build trades but never send one. This
// script holds the agent's OWN key (never the owner's wallet), signs the
// delegated Action and hands it to the bskts relayer, inside the limits the
// owner approved on chain. Every live trade goes through executeSessionOnce
// with a journal per trade ID, so a stalled model turn, a timeout or a restart
// can never send the same trade twice.
//
// Output is JSON on stdout so the model can read it; progress goes to stderr.
// The key is generated here, written to <home>/.env (0600) and never printed.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = resolve(process.env.BSKTS_AGENT_HOME || join(homedir(), ".bskts-agent"));
const ENV_FILE = join(HOME, ".env");
const TRADES_DIR = join(HOME, "trades");
// The same RPC the create-agent starter reconciles against.
const RPC = "https://bskts.xyz/rpc";

const USAGE = `bskts skill CLI. Commands (all print JSON):
  setup --owner 0xWALLET     create this agent's key (once) and print its approval link
  status                     live permission: active, limits, remaining today, account USDG
  markets                    every basket: NAV, 24h change, buy cost
  basket TICKER              one basket: thesis, constituents, risk
  positions                  the bskts account's holdings and PnL
  buy TICKER USD [--slippage BPS]                          dry run: builds and simulates, sends nothing
  sell TICKER (--shares WEI|max | --fraction 0.5) [...]     dry run
  buy|sell ... --send --id ID                               the live trade, once per ID
  trade-status --id ID       outcome of a journalled trade or cover action, never sends anything
Weekend Cover (buying only; the owner must have turned Cover on). Actions dry run unless --send --id:
  cover-weeks                weeks open to buy, terms, limits, preset ranges
  cover-book TICKER [--cover USD] [--from BPS --to BPS] [--week N]
  cover-positions            the account's cover, payouts and open listings
  cover-buy TICKER USD --from BPS --to BPS [--max-price P] [--partial] [--week N]
  cover-request TICKER USD --from BPS --to BPS --price P [--week N]
  cover-cancel LISTING_ID
Home: ${HOME} (set BSKTS_AGENT_HOME to move it).`;

// ---- small helpers ----------------------------------------------------------

const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);
const out = (v) => console.log(json(v));
const log = (...a) => console.error(...a);
const usd6 = (wei) => Number(wei) / 1e6;

class CliError extends Error {
  constructor(message, code = "BAD_REQUEST") {
    super(message);
    this.code = code;
  }
}

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) pos.push(a);
    else if (a.includes("=")) flags[a.slice(2, a.indexOf("="))] = a.slice(a.indexOf("=") + 1);
    else if (a === "--dry" || a === "--send" || a === "--partial") flags[a.slice(2)] = true;
    else flags[a.slice(2)] = argv[++i];
  }
  return { pos, flags };
}

// Same refusal as @bskts/create-agent: a private key or seed phrase pasted as
// the owner means the wrong thing is in someone's clipboard.
function ownerAddress(value) {
  const v = String(value ?? "").trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(v) || v.split(/\s+/).length >= 12)
    throw new CliError(
      "That looks like a private key or recovery phrase. Never share it. The owner is the wallet's PUBLIC address: 0x followed by 40 characters.",
    );
  if (!/^0x[0-9a-fA-F]{40}$/.test(v))
    throw new CliError(
      "--owner must be the wallet's public address: 0x followed by 40 characters.",
    );
  return v;
}

// One journal per logical trade. The ID is the duplicate guard, so it must be
// stable for the trade and filesystem-safe.
function tradeId(v) {
  if (!v)
    throw new CliError(
      "--send needs --id: a new ID per deliberate trade, e.g. buy-index2-20261010-1.",
    );
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(v))
    throw new CliError("--id may use a-z, 0-9 and '-', up to 64 characters.");
  return v;
}

function readEnv() {
  if (!existsSync(ENV_FILE))
    throw new CliError(`No agent yet. Run: setup --owner 0xYOUR_WALLET`, "NOT_SET_UP");
  const env = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) env[m[1]] = m[2];
  }
  if (!env.BSKTS_OWNER || !env.AGENT_KEY)
    throw new CliError(`${ENV_FILE} is missing BSKTS_OWNER or AGENT_KEY.`, "NOT_SET_UP");
  return env;
}

// Dependencies install into the skill folder on first use, without install
// scripts (supply-chain guard: neither package needs one).
function ensureDeps() {
  if (existsSync(join(SKILL_DIR, "node_modules", "@bskts", "sdk", "package.json"))) return;
  log("Installing @bskts/sdk and viem into the skill folder (first run only)...");
  const args = "install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error";
  const opts = { cwd: SKILL_DIR, stdio: ["ignore", "inherit", "inherit"] };
  // Windows: npm is npm.cmd, which Node only spawns through a shell; one fixed
  // string, since args alongside shell:true are deprecated (DEP0190).
  const r =
    process.platform === "win32"
      ? spawnSync(`npm ${args}`, { ...opts, shell: true })
      : spawnSync("npm", args.split(" "), opts);
  if (r.status !== 0) throw new CliError("npm install failed in the skill folder.", "SETUP_FAILED");
}

async function load() {
  ensureDeps();
  const sdk = await import("@bskts/sdk");
  const { fileSessionStore } = await import("@bskts/sdk/node");
  const viem = await import("viem");
  const accounts = await import("viem/accounts");
  const policy = {};
  if (process.env.BSKTS_MAX_USD_PER_TRADE)
    policy.maxUsdPerTrade = Number(process.env.BSKTS_MAX_USD_PER_TRADE);
  if (process.env.BSKTS_ALLOWED_TICKERS)
    policy.allowedTickers = process.env.BSKTS_ALLOWED_TICKERS.split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  return { sdk, fileSessionStore, viem, accounts, client: new sdk.BsktsClient({ policy }) };
}

function sessionView(s) {
  return {
    active: s.active,
    paused: s.paused,
    owner: s.owner,
    account: s.account,
    agent: s.key,
    accountUsdg: usd6(s.usdgWei),
    dailyLimitUsdg: usd6(s.dailyLimitUsdg),
    remainingTodayUsdg: usd6(s.remainingTodayUsdg),
    maxSlippageBps: s.maxSlippageBps,
    validUntil: s.validUntil ? new Date(s.validUntil * 1000).toISOString() : null,
    ...(s.active ? {} : { approvalUrl: s.approvalUrl }),
  };
}

function planView(plan, side) {
  const a = plan.action;
  return {
    ticker: plan.ticker,
    side,
    ...(side === "buy"
      ? { sharesWei: a.amount, maxUsdgIn: usd6(a.limit) }
      : { sharesWei: a.amount, minUsdgOut: usd6(a.limit) }),
    slippageBps: a.slippageBps,
    simulation: plan.simulation,
    remainingTodayUsdg: usd6(plan.status.remainingTodayUsdg),
  };
}

// ---- commands ---------------------------------------------------------------

async function setup(flags) {
  const owner = ownerAddress(flags.owner);
  const { client, accounts } = await load();
  if (existsSync(ENV_FILE)) {
    const env = readEnv();
    if (env.BSKTS_OWNER.toLowerCase() !== owner.toLowerCase())
      throw new CliError(
        `This host already has an agent for ${env.BSKTS_OWNER}. Use BSKTS_AGENT_HOME for a second owner; never overwrite a key.`,
        "ALREADY_SET_UP",
      );
    log("Agent already set up; reusing its key.");
  } else {
    mkdirSync(HOME, { recursive: true, mode: 0o700 });
    const key = accounts.generatePrivateKey();
    writeFileSync(
      ENV_FILE,
      `# bskts agent. BSKTS_OWNER is the wallet that approves it; AGENT_KEY is this
# agent's own key. Anyone with this file can trade within the owner's approved
# limits until the owner revokes it in bskts (it can never withdraw). Never
# share, print or commit it.
BSKTS_OWNER=${owner}
AGENT_KEY=${key}
`,
      { mode: 0o600, flag: "wx" },
    );
  }
  const env = readEnv();
  const agent = accounts.privateKeyToAccount(env.AGENT_KEY).address;
  // 2026-10-10: the first test hit an API outage here and printed only the
  // error, so the owner never learned the address to approve. The key exists
  // by now: always hand back the address and the approval link.
  let s;
  try {
    s = await client.agentSession({ owner, key: agent });
  } catch (e) {
    return out({
      ok: true,
      agent,
      owner,
      approvalUrl: `https://bskts.xyz/portfolio?tab=agents&key=${agent}`,
      warning: `Could not read the live permission (${e?.code ?? "ERROR"}: ${String(e?.message ?? e).slice(0, 200)}). Run status later.`,
      next: "Send the owner approvalUrl. They check the limits and sign once with their wallet; then run status.",
    });
  }
  out({
    ok: true,
    agent,
    ...sessionView(s),
    next: s.active
      ? "Approved. The agent can trade within these limits."
      : "Send the owner approvalUrl. They check the limits and sign once with their wallet; then run status.",
  });
}

async function withAgent(fn) {
  const env = readEnv();
  const ctx = await load();
  const agent = ctx.accounts.privateKeyToAccount(env.AGENT_KEY);
  return fn({ ...ctx, owner: env.BSKTS_OWNER, agent });
}

const status = () =>
  withAgent(async ({ client, owner, agent }) =>
    out({ ok: true, ...sessionView(await client.agentSession({ owner, key: agent.address })) }),
  );

const markets = async () => {
  const { client } = await load();
  out({ ok: true, ...(await client.markets()) });
};

const basket = async (pos) => {
  if (!pos[1]) throw new CliError("basket TICKER");
  const { client } = await load();
  out({ ok: true, ...(await client.basket(pos[1].toUpperCase())) });
};

const positions = () =>
  withAgent(async ({ client, owner, agent }) => {
    const s = await client.agentSession({ owner, key: agent.address });
    out({ ok: true, account: s.account, ...(await client.positions(s.account)) });
  });

async function sellShares(client, account, ticker, flags) {
  if (flags.fraction != null) {
    const f = Number(flags.fraction);
    if (!(f > 0 && f <= 1)) throw new CliError("--fraction must be in (0, 1].");
    const held = await heldShares(client, account, ticker);
    // integer basis points: never float x 1e18, which rounds past the balance
    return (held * BigInt(Math.floor(f * 10_000))) / 10_000n;
  }
  if (flags.shares === "max") return heldShares(client, account, ticker);
  if (!/^\d+$/.test(String(flags.shares ?? "")))
    throw new CliError(
      "sell needs --shares WEI (integer, 1e18 units), --shares max or --fraction.",
    );
  return BigInt(flags.shares);
}

async function heldShares(client, account, ticker) {
  const { positions: rows } = await client.positions(account);
  const p = rows.find((r) => r.ticker.toUpperCase() === ticker);
  if (!p || p.walletSharesWei === 0n)
    throw new CliError(`The account holds no ${ticker}.`, "INSUFFICIENT_SHARES");
  return p.walletSharesWei;
}

function trade(side) {
  return (pos, flags) =>
    withAgent(async ({ sdk, fileSessionStore, viem, client, owner, agent }) => {
      const ticker = String(pos[1] ?? "").toUpperCase();
      if (!/^[A-Z0-9]{2,12}$/.test(ticker)) throw new CliError(`${side} needs a basket ticker.`);
      const slippageBps = flags.slippage != null ? Number(flags.slippage) : undefined;
      let amountUsdg;
      if (side === "buy") {
        amountUsdg = Number(pos[2]);
        if (!(amountUsdg > 0))
          throw new CliError("buy TICKER USD: USD is a dollar amount, e.g. 10.");
      }
      // 2026-10-11: dry run unless --send (owner: "replace the starter and the
      // skill with dry run logic"). Live used to be the default and --dry the
      // opt-in, so a model that dropped one flag spent real money.
      if (flags.send && flags.dry) throw new CliError("Use --send or --dry, not both.");
      const live = flags.send === true;
      const id = live ? tradeId(flags.id) : null;
      const store = id && fileSessionStore(join(TRADES_DIR, `${id}.json`));

      const build = async () => {
        const s = await client.agentSession({ owner, key: agent.address });
        if (!s.active)
          throw new CliError(
            `Agent not approved (or expired). Owner approves at ${s.approvalUrl}`,
            "SESSION_INACTIVE",
          );
        const args = {
          owner,
          key: agent.address,
          ticker,
          ...(slippageBps != null ? { slippageBps } : {}),
        };
        return side === "buy"
          ? client.buildAgentTrade({ ...args, side, amountUsdg })
          : client.buildAgentTrade({
              ...args,
              side,
              shares: await sellShares(client, s.account, ticker, flags),
            });
      };

      if (!live) {
        const plan = await build();
        return out({
          ok: true,
          dry: true,
          sent: false,
          ...planView(plan, side),
          next: "Dry run only. To trade for real: the same command with --send --id <new id>.",
        });
      }

      // A journal that already exists means this ID was used: report it, never trade again.
      const existing = await store.loadOutcome();
      const chain = viem.createPublicClient({ chain: sdk.robinhood, transport: viem.http(RPC) });
      const result = await sdk.executeSessionOnce({
        store,
        sender: {
          key: agent.address,
          sign: (data) => agent.signTypedData(data),
          submit: sdk.sessionRelayer(),
        },
        maxNetworkFeeUsdg: BigInt(Math.round(Number(process.env.BSKTS_MAX_FEE_USDG || 0.25) * 1e6)),
        reconcile: (plan) => sdk.sessionActionState(chain, plan.action),
        build,
      });
      out(outcomeView(id, result, existing !== undefined));
    });
}

function outcomeView(id, result, alreadyRecorded) {
  const base = { ok: true, id, state: result.state, alreadyRecorded };
  if (result.state === "confirmed")
    return {
      ...base,
      tx: result.receipt.hash,
      explorer: `https://robinhoodchain.blockscout.com/tx/${result.receipt.hash}`,
      note: alreadyRecorded
        ? "This ID was already traded; nothing new was sent."
        : "Trade confirmed on chain.",
    };
  if (result.state === "consumed")
    return {
      ...base,
      note: "The journalled action's nonce is used on chain; no new trade was sent.",
    };
  return {
    ...base,
    note: "The journalled action expired unexecuted; nothing was spent. Use a NEW --id for a deliberate retry.",
  };
}

const tradeStatus = (_, flags) =>
  withAgent(async ({ fileSessionStore }) => {
    const id = tradeId(flags.id);
    const store = fileSessionStore(join(TRADES_DIR, `${id}.json`));
    const done = await store.loadOutcome();
    if (done) return out(outcomeView(id, done, true));
    const pending = await store.load();
    out({
      ok: true,
      id,
      state: pending ? "unresolved" : "unknown",
      note: pending
        ? "Submitted or about to be; outcome not recorded. Re-run the SAME buy/sell command with this --id to reconcile. Never use a new ID to retry it."
        : "No trade with this ID.",
    });
  });

// ---- Weekend Cover (2026-10-11) --------------------------------------------
// Buying only: take offers, request cover, cancel the account's own listing.
// Same key, same journal guard as trades (executeCoverOnce, one file per --id,
// in the same folder, so trade-status reports both). Underwriting is never an
// agent action: it needs the owner's own allowance.

function needsCoverSdk(sdk) {
  if (typeof sdk.executeCoverOnce !== "function")
    throw new CliError(
      "This skill's @bskts/sdk predates Weekend Cover. Update the skill (it needs @bskts/sdk 0.6.0 or later).",
      "SETUP_FAILED",
    );
}
const int = (v, name) => {
  const n = Number(v);
  if (v == null || v === "" || !Number.isInteger(n) || n < 0)
    throw new CliError(`${name} must be a whole number.`);
  return n;
};
const opt = (k, v) => (v === undefined ? {} : { [k]: v });

const coverWeeks = async () => {
  const { sdk, client } = await load();
  needsCoverSdk(sdk);
  out({ ok: true, ...(await client.coverWeeks()) });
};

const coverBook = (pos, flags) =>
  withAgent(async ({ sdk, client, owner, agent }) => {
    needsCoverSdk(sdk);
    const ticker = String(pos[1] ?? "").toUpperCase();
    if (!/^[A-Z0-9]{2,12}$/.test(ticker)) throw new CliError("cover-book TICKER");
    if ((flags.from == null) !== (flags.to == null))
      throw new CliError("Pass --from and --to together (basis points of a drop, e.g. 300 1000).");
    const s = await client.agentSession({ owner, key: agent.address });
    out({
      ok: true,
      ...(await client.coverBook(ticker, {
        account: s.account,
        ...opt("coverUsd", flags.cover == null ? undefined : int(flags.cover, "--cover")),
        ...opt("fromBps", flags.from == null ? undefined : int(flags.from, "--from")),
        ...opt("toBps", flags.to == null ? undefined : int(flags.to, "--to")),
        ...opt("week", flags.week == null ? undefined : int(flags.week, "--week")),
      })),
    });
  });

const coverPositions = () =>
  withAgent(async ({ sdk, client, owner, agent }) => {
    needsCoverSdk(sdk);
    const s = await client.agentSession({ owner, key: agent.address });
    out({ ok: true, ...(await client.coverPositions(s.account)) });
  });

function coverView(plan) {
  return {
    intent: plan.intent,
    ...opt("ticker", plan.ticker),
    ...opt("week", plan.week),
    ...opt("fromBps", plan.fromBps),
    ...opt("toBps", plan.toBps),
    ...plan.summary,
    coverRemainingTodayUsdg: usd6(plan.coverRemainingTodayUsdg),
    simulation: plan.simulation,
  };
}

function cover(intent) {
  return (pos, flags) =>
    withAgent(async ({ sdk, fileSessionStore, viem, client, owner, agent }) => {
      needsCoverSdk(sdk);
      let args;
      if (intent === "cancel") {
        if (!/^\d+$/.test(String(pos[1] ?? "")))
          throw new CliError("cover-cancel LISTING_ID (from cover-positions' listings).");
        args = { action: "cancel", listingId: BigInt(pos[1]) };
      } else {
        const ticker = String(pos[1] ?? "").toUpperCase();
        if (!/^[A-Z0-9]{2,12}$/.test(ticker))
          throw new CliError(`cover-${intent === "take" ? "buy" : intent} needs a basket ticker.`);
        const terms = {
          ticker,
          coverUsd: int(pos[2], "USD (whole dollars of cover)"),
          fromBps: int(flags.from, "--from"),
          toBps: int(flags.to, "--to"),
          ...opt("week", flags.week == null ? undefined : int(flags.week, "--week")),
        };
        if (intent === "take")
          args = {
            action: "take",
            ...terms,
            ...opt(
              "maxPricePer1k",
              flags["max-price"] == null ? undefined : Number(flags["max-price"]),
            ),
            ...opt("allowPartial", flags.partial ? true : undefined),
          };
        else {
          const price = Number(flags.price);
          if (!(price > 0)) throw new CliError("cover-request needs --price ($ per $1,000).");
          args = { action: "request", ...terms, pricePer1k: price };
        }
      }
      const build = async () => {
        const s = await client.agentSession({ owner, key: agent.address });
        if (!s.active)
          throw new CliError(
            `Agent not approved (or expired). Owner approves at ${s.approvalUrl}`,
            "SESSION_INACTIVE",
          );
        if (!s.coverEnabled)
          throw new CliError(
            "Weekend Cover isn't turned on for this account. Ask the owner to turn it on in bskts (My cover); never try to enable it yourself.",
            "SESSION_INACTIVE",
          );
        return client.buildAgentCover({ owner, key: agent.address, ...args });
      };

      // dry run unless --send, as for trades (2026-10-11)
      if (flags.send && flags.dry) throw new CliError("Use --send or --dry, not both.");
      if (!flags.send)
        return out({
          ok: true,
          dry: true,
          sent: false,
          ...coverView(await build()),
          next: "Dry run only. To act for real: the same command with --send --id <new id>.",
        });

      const id = tradeId(flags.id);
      const store = fileSessionStore(join(TRADES_DIR, `${id}.json`));
      const existing = await store.loadOutcome();
      const chain = viem.createPublicClient({ chain: sdk.robinhood, transport: viem.http(RPC) });
      const result = await sdk.executeCoverOnce({
        store,
        sender: {
          key: agent.address,
          sign: (data) => agent.signTypedData(data),
          submit: sdk.coverRelayer(),
        },
        // cancels are free; take and request repay gas like a trade
        maxNetworkFeeUsdg:
          intent === "cancel"
            ? 0n
            : BigInt(Math.round(Number(process.env.BSKTS_MAX_FEE_USDG || 0.25) * 1e6)),
        reconcile: (plan) => sdk.coverActionState(chain, plan.action),
        build,
      });
      out(outcomeView(id, result, existing !== undefined));
    });
}

// ---- main -------------------------------------------------------------------

const COMMANDS = {
  setup: (_, f) => setup(f),
  status,
  markets,
  basket,
  positions,
  buy: trade("buy"),
  sell: trade("sell"),
  "trade-status": tradeStatus,
  "cover-weeks": coverWeeks,
  "cover-book": coverBook,
  "cover-positions": coverPositions,
  "cover-buy": cover("take"),
  "cover-request": cover("request"),
  "cover-cancel": cover("cancel"),
};

const { pos, flags } = parseArgs(process.argv.slice(2));
const cmd = COMMANDS[pos[0]];
if (!cmd) {
  console.log(USAGE);
  process.exit(pos[0] ? 1 : 0);
}
try {
  await cmd(pos, flags);
} catch (e) {
  out({
    ok: false,
    code: e?.code ?? "ERROR",
    retryable: e?.retryable ?? false,
    error: String(e?.message ?? e).slice(0, 600),
  });
  process.exit(1);
}
