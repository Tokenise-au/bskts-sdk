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
//
// 2026-10-12: bundled. This is the SOURCE; skills/bskts/scripts/bskts.mjs is
// generated from it by `pnpm run build` (packages/skill), with @bskts/sdk,
// viem and zod inlined at the versions in this repo's lockfile. The skill
// used to `npm install` them into its own folder on first run (a child process),
// which skills.sh's scanners flagged as runtime downloads and command
// execution, and which was one more thing to go wrong on a user's machine.
// Now nothing is downloaded or spawned: node runs one file.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as sdk from "@bskts/sdk";
import { fileSessionStore } from "@bskts/sdk/node";
import { createPublicClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { latestRelease, updateView } from "./update.mjs";

const HOME = resolve(process.env.BSKTS_AGENT_HOME || join(homedir(), ".bskts-agent"));
const ENV_FILE = join(HOME, ".env");
const TRADES_DIR = join(HOME, "trades");
// The same RPC the create-agent starter reconciles against.
const RPC = "https://bskts.xyz/rpc";
// 2026-10-12: the skill's version, also in SKILL.md's frontmatter (a test
// keeps them equal). skills.sh tracks installs by content hash only, so this
// is how a person or agent tells which build is running when debugging.
// Bump it with any change under skills/ and tag main skill-v<version>.
// 2026-10-27: then, once it's on main, AGENT_SKILL_LATEST in the bskts repo
// (src/lib/agent-skill.ts): installed copies compare themselves with it.
const SKILL_VERSION = "1.3.3";

const USAGE = `bskts skill CLI ${SKILL_VERSION}. Commands (all print JSON):
  version                    this skill's version, and \`update\` if a newer one is out
  setup --owner 0xWALLET     create this agent's key (once) and print its approval link
  status                     live permission: active, limits, remaining today, account USDG;
                             \`update\` if a newer skill is out
  markets                    every basket: NAV, 24h change, buy cost
  basket TICKER              one basket: thesis, constituents, risk
  positions                  the bskts account's holdings and PnL
  buy TICKER USD [--slippage BPS]                          dry run: builds and simulates, sends nothing
  sell TICKER (--shares WEI|max | --fraction 0.5) [...]     dry run
  buy|sell ... --send --id ID                               the live trade, once per ID
  limit TICKER USD --nav NAV --slippage BPS [--above] [--days N]   dry run + preview; --send --id to place
  exit TICKER (--shares WEI|max | --fraction 0.5) [--stop NAV] [--tp NAV] --slippage BPS [--days N]
                             stop-loss / take-profit / bracket: dry run + preview; --send --id to place
  orders                     open account limit and exit orders
  cancel ORDER_ID            dry run; --send --id to cancel a limit (kind limit_buy)
  cancel-exit ORDER_ID       dry run; --send --id to cancel an exit (stop_loss / take_profit / bracket)
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
    else if (a === "--dry" || a === "--send" || a === "--partial" || a === "--above")
      flags[a.slice(2)] = true;
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

async function load() {
  const viem = { createPublicClient, http };
  const accounts = { generatePrivateKey, privateKeyToAccount };
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
    skillVersion: SKILL_VERSION,
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

// 2026-10-12: an agent's plan is unsigned, so the API can't simulate it
// (simulation.ok null, "skipped"); the relayer simulates the SIGNED action
// just before broadcasting and refuses one that would fail. SKILL.md said
// "send only if simulation.ok is true", which a dry run can never meet: a
// fresh Claude Code agent stopped on it, and Fen reported the skipped
// simulation as "OK". Say plainly what a dry run did and didn't check.
function simulationView(sim) {
  if (sim?.ok === true) return { simulated: true, simulation: sim };
  if (sim?.ok === false) return { simulated: true, wouldFail: true, simulation: sim };
  return {
    simulated: false,
    simulation: sim,
    simulationNote:
      "Not simulated: an unsigned agent trade can't be. This dry run checked approval, limits, size, route and price. With --send the relayer simulates the signed trade before broadcasting and refuses it, spending nothing, if it would fail. Report this as 'not simulated', never as passed.",
  };
}

// 2026-10-25: an order's dry run leads with the API's preview, as the same
// lines the MCP tool prints (sdk.describePreview): triggers are on NAV, a price
// return, and "sell when it makes 5%" was read as net profit.
function planView(plan, side) {
  const a = plan.action;
  if (a.kind >= 2)
    return {
      ...(plan.preview
        ? { previewText: sdk.describePreview(plan.preview), preview: plan.preview }
        : {}),
      ticker: plan.ticker,
      side,
      ...(a.kind === 2 ? { amountUsdg: usd6(a.amount) } : {}),
      ...(a.kind === 3 ? { shares: Number(a.amount) / 1e18, sharesWei: a.amount } : {}),
      terms: sdk.decodeAgentOrder(plan),
      slippageBps: a.slippageBps,
      remainingTodayUsdg: usd6(plan.status.remainingTodayUsdg),
      ...simulationView(plan.simulation),
      ...(plan.simulation?.ok === null
        ? {
            simulationNote:
              "Not simulated: this unsigned plan checked permissions, budget and order terms. The relayer simulates the signed action before submission. Placement does not simulate a future fill.",
          }
        : {}),
    };
  return {
    ticker: plan.ticker,
    side,
    ...(side === "buy"
      ? { shares: Number(a.amount) / 1e18, sharesWei: a.amount, maxUsdgIn: usd6(a.limit) }
      : { shares: Number(a.amount) / 1e18, sharesWei: a.amount, minUsdgOut: usd6(a.limit) }),
    slippageBps: a.slippageBps,
    ...simulationView(plan.simulation),
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
      // agent=, not key=: OpenClaw masks what follows key= in its output, and
      // the owner got "&key=***" (2026-10-11); the app reads both
      approvalUrl: `https://bskts.xyz/portfolio?tab=agents&agent=${agent}`,
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

// 2026-10-27: status also says when a newer skill is out (update.mjs), read
// alongside the session so it adds no wait; a check that fails is left out.
const status = () =>
  withAgent(async ({ client, owner, agent }) => {
    const [s, release] = await Promise.all([
      client.agentSession({ owner, key: agent.address }),
      latestRelease(client.baseUrl),
    ]);
    const update = updateView(SKILL_VERSION, release);
    out({ ok: true, ...sessionView(s), ...(update ? { update } : {}) });
  });

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
      const cancelling = side === "cancel" || side === "cancel-exit";
      if (!cancelling && !/^[A-Z0-9]{2,12}$/.test(ticker))
        throw new CliError(`${side} needs a basket ticker.`);
      const slippageBps = flags.slippage != null ? Number(flags.slippage) : undefined;
      let amountUsdg;
      if (side === "buy" || side === "limit") {
        amountUsdg = Number(pos[2]);
        if (!(amountUsdg > 0))
          throw new CliError("buy TICKER USD: USD is a dollar amount, e.g. 10.");
      }
      // 2026-10-24: the API requires a limit's slippage. Its old 50 bps default
      // sat below yield baskets' fill cost, so their orders never filled.
      if (side === "limit" && slippageBps == null)
        throw new CliError(
          "limit needs --slippage BPS: at least the basket's limitMinSlippageBps (basket TICKER) and at most status's maxSlippageBps.",
        );
      if (side === "exit") {
        if (slippageBps == null)
          throw new CliError(
            "exit needs --slippage BPS: at least the basket's exitMinSlippageBps (basket TICKER) and at most status's maxSlippageBps.",
          );
        if (flags.stop == null && flags.tp == null)
          throw new CliError("exit needs --stop NAV, --tp NAV or both (a bracket).");
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
        if (cancelling)
          return client.buildAgentOrder({
            kind: side,
            owner,
            key: agent.address,
            orderId: pos[1],
          });
        const expiryDays = flags.days !== undefined ? Number(flags.days) : undefined;
        if (side === "limit")
          return client.buildAgentOrder({
            ...args,
            kind: "limit",
            amountUsdg,
            triggerNav: Number(flags.nav),
            ...(flags.above === true ? { triggerBelow: false } : {}),
            expiryDays,
          });
        if (side === "exit")
          return client.buildAgentOrder({
            ...args,
            kind: "exit",
            // "max": the API reads the account's balance on chain at build time
            shares:
              flags.shares === "max" ? "max" : await sellShares(client, s.account, ticker, flags),
            ...(flags.stop != null ? { stopNav: Number(flags.stop) } : {}),
            ...(flags.tp != null ? { tpNav: Number(flags.tp) } : {}),
            expiryDays,
          });
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
      const recordedKind = Number((await store.load())?.plan?.action?.kind);
      let orderId;
      if ((recordedKind === 2 || recordedKind === 3) && result.state === "confirmed") {
        try {
          const { logs } = await chain.getTransactionReceipt({ hash: result.receipt.hash });
          orderId = recordedKind === 2 ? sdk.limitOrderId(logs) : sdk.exitOrderId(logs);
        } catch {
          /* confirmation is still valid if the receipt lookup is temporarily unavailable */
        }
      }
      const view = outcomeView(id, result, existing !== undefined);
      out({
        ...view,
        ...(orderId ? { orderId } : {}),
        ...(result.state === "confirmed" && recordedKind === 2
          ? {
              note: "Limit placement confirmed. This is not confirmation of a fill; check orders and the transaction receipt.",
            }
          : {}),
        ...(result.state === "confirmed" && recordedKind === 3
          ? {
              note: "Exit placement confirmed: the shares are escrowed. This is not confirmation of a sale; check orders and the transaction receipt. Cancel it with cancel-exit.",
            }
          : {}),
        ...(result.state === "confirmed" && recordedKind === 4
          ? { note: "Limit cancellation confirmed; escrow returned to the account." }
          : {}),
        ...(result.state === "confirmed" && recordedKind === 5
          ? { note: "Exit cancellation confirmed; the shares returned to the account." }
          : {}),
      });
    });
}

function outcomeView(id, result, alreadyRecorded) {
  const base = { ok: true, id, state: result.state, alreadyRecorded };
  if (result.state === "confirmed")
    return {
      ...base,
      tx: result.receipt.hash,
      // bskts.xyz/tx redirects to the chain's explorer (2026-10-12)
      explorer: `https://bskts.xyz/tx/${result.receipt.hash}`,
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
    ...simulationView(plan.simulation),
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
  version: async () => {
    const update = updateView(SKILL_VERSION, await latestRelease(sdk.DEFAULT_API_URL));
    out({ ok: true, skillVersion: SKILL_VERSION, ...(update ? { update } : {}) });
  },
  setup: (_, f) => setup(f),
  status,
  markets,
  basket,
  positions,
  limit: trade("limit"),
  exit: trade("exit"),
  cancel: trade("cancel"),
  "cancel-exit": trade("cancel-exit"),
  orders: () =>
    withAgent(async ({ client, owner, agent }) => {
      const s = await client.agentSession({ owner, key: agent.address });
      out({ ok: true, account: s.account, ...(await client.orders(s.account)) });
    }),
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
