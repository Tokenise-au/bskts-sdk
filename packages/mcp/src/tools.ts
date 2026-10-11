// The bskts tools, registered on an McpServer. Shared by the stdio CLI and the
// Streamable HTTP handler, so both expose exactly the same surface.
//
// Unsigned only: build tools return the transactions for the user's own wallet
// to sign; nothing here holds a key or sends anything.
//
// Token budget: eleven tools (2026-10-11: + bskts_cover, bskts_agent_cover). The rules an agent must follow (units, approval
// order, never send a failed dry run) live in the descriptions, so they arrive
// with the tools instead of costing a docs read.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type BsktsClient, BsktsError, agentTypedData, coverTypedData } from "@bskts/sdk";
import type { Address } from "viem";
import { z } from "zod";

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .describe("wallet address (0x...) on Robinhood Chain")
  .transform((a) => a as Address);
const ticker = z.string().min(1).describe("basket ticker, e.g. DIGI64 (bskts_markets lists them)");
const shares = z
  .string()
  .regex(/^(max|\d+)$/)
  .describe('"max", or an exact walletSharesWei string from bskts_account (never a float x 1e18)');
const slippageBps = z
  .number()
  .int()
  .min(0)
  .max(1000)
  .optional()
  .describe("tolerance beyond the quoted cost, bps (default 50)");

/** JSON for the model: bigints as decimal strings. */
const json = (v: unknown) =>
  JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

async function run(fn: () => Promise<unknown> | unknown): Promise<CallToolResult> {
  try {
    const out = await fn();
    return { content: [{ type: "text", text: typeof out === "string" ? out : json(out) }] };
  } catch (e) {
    // a tool error the model can read and act on, not a protocol error
    const b = e instanceof BsktsError ? e : undefined;
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: json({
            error: (e as Error).message,
            ...(b ? { code: b.code, retryable: b.retryable } : {}),
          }),
        },
      ],
    };
  }
}

const READ = { readOnlyHint: true, openWorldHint: true } as const;
// builds read too: they return data and send nothing
const BUILD = { readOnlyHint: true, openWorldHint: true, idempotentHint: false } as const;

export const INSTRUCTIONS =
  "bskts: tokenized baskets on Robinhood Chain (4663). UNSIGNED tools; no keys, signing or sending here. Two paths: (1) wallet tools return approval then tx; owner pays ETH gas. (2) autonomous agents: bskts_agent_session resolves the owner account and checks public agent key authority; owner approves it once in Portfolio (10% available USDG, at least $10, capped $100/day, 0.5% slippage, 7 days, fixed dollars). bskts_agent_trade returns Action typedData for the host session signer and gasless USDG-fee relayer. No owner popup per delegated trade. Owner signature required to change/renew limits. Agents may BUY Weekend Cover on held baskets (bskts_cover to read, bskts_agent_cover to build) once the owner enabled Cover; spending counts separately, at most 3% of the cover; never underwrite. Revoking blocks new requests; existing orders/schedules require separate cancellation. Never request a private key or reuse a revoked key. Check basket risk and buyCostBps; never send failed simulations. Preserve nonce on bounded 402 fee retries; do not retry uncertain submissions with a new nonce.";

export function registerBsktsTools(server: McpServer, client: BsktsClient) {
  server.registerTool(
    "bskts_markets",
    {
      title: "bskts markets",
      description:
        "Every basket with live NAV (USD per share), change24h (fraction, 0.01 = +1%) and buyCostBps (real cost of a buy: pool fees + price impact, bps, on top of the 0.20% mint fee). Start here.",
      annotations: READ,
    },
    () => run(async () => (await client.markets()).markets),
  );

  server.registerTool(
    "bskts_basket",
    {
      title: "bskts basket",
      description:
        "One basket: name, thesis, constituents (address, target weight, price), fees, rebalance schedule, and `risk` (read it before buying). With `days`, also a NAV summary (change, high, low, maxDrawdown, volatility; fractions).",
      inputSchema: {
        ticker,
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe("summarise NAV over this many days"),
      },
      annotations: READ,
    },
    ({ ticker, days }) =>
      run(async () => {
        const [detail, nav] = await Promise.all([
          client.basket(ticker),
          days ? client.navSummary(ticker, { days }) : undefined,
        ]);
        return nav ? { ...detail, navSummary: nav.summary } : detail;
      }),
  );

  server.registerTool(
    "bskts_account",
    {
      title: "bskts account",
      description:
        "What an address holds: ETH (gas) and USDG balances, gasOk (false = too little ETH on Robinhood Chain for a trade), positions with value and PnL, and open orders. walletSharesWei is the exact share count to sell.",
      inputSchema: { address },
      annotations: READ,
    },
    ({ address }) =>
      run(async () => {
        const [wallet, { positions }, { orders }] = await Promise.all([
          client.wallet(address),
          client.positions(address),
          client.orders(address),
        ]);
        const { holdings: _dup, ...w } = wallet; // positions carries the same, with value and PnL
        return { ...w, positions, orders };
      }),
  );

  server.registerTool(
    "bskts_buy",
    {
      title: "Build a bskts buy",
      description:
        "Build an UNSIGNED buy of a basket for USDG. Returns {approval, tx, simulation, minShares, estShares}. Nothing is sent: the user's wallet signs `approval` (if not null, wait for it to be mined) then `tx`. simulation.ok false = it would revert: do not send.",
      inputSchema: {
        ticker,
        amountUsdg: z.number().positive().describe("dollars of USDG to spend"),
        address,
        slippageBps,
      },
      annotations: BUILD,
    },
    (a) => run(() => client.buildBuy(a)),
  );

  server.registerTool(
    "bskts_sell",
    {
      title: "Build a bskts sale",
      description:
        'Build an UNSIGNED sale of basket shares for USDG, in one transaction. shares defaults to "max"; fraction (0-1] with "max" sells part. Returns {approval, tx, simulation, expectedUsdg, minOutUsdg} (USDG in 1e6 base units). Same signing order as bskts_buy.',
      inputSchema: {
        ticker,
        address,
        shares: shares.optional(),
        fraction: z
          .number()
          .gt(0)
          .max(1)
          .optional()
          .describe('with shares "max": the part to sell'),
        slippageBps,
      },
      annotations: BUILD,
    },
    ({ shares, ...a }) =>
      run(() =>
        client.buildSell({ ...a, shares: !shares || shares === "max" ? "max" : BigInt(shares) }),
      ),
  );

  server.registerTool(
    "bskts_order",
    {
      title: "Build a bskts order",
      description:
        "Build an UNSIGNED resting order. limit: buy amountUsdg when the 10-minute average NAV <= triggerNav (omit for market; USDG escrowed until filled or cancelled). exit: stop-loss (stopNav), take-profit (tpNav) or both on exact `shares`. cancel: withdraw orderId (from bskts_account). NAV levels in dollars. Same signing order as bskts_buy.",
      inputSchema: {
        kind: z.enum(["limit", "exit", "cancel"]),
        address,
        ticker: ticker.optional(),
        amountUsdg: z.number().positive().optional().describe("limit: dollars to spend"),
        triggerNav: z.number().positive().optional().describe("limit: fill at or below this NAV"),
        shares: z.string().regex(/^\d+$/).optional().describe("exit: exact 1e18 integer string"),
        stopNav: z.number().positive().optional().describe("exit: sell if NAV falls to this"),
        tpNav: z.number().positive().optional().describe("exit: sell if NAV rises to this"),
        expiryDays: z.number().int().min(1).max(90).optional().describe("limit / exit: default 30"),
        orderId: z
          .string()
          .regex(/^0x[0-9a-fA-F]{64}$/)
          .optional()
          .describe("cancel: the order id"),
      },
      annotations: BUILD,
    },
    (a) =>
      run(() => {
        const need = (v: unknown, name: string) => {
          if (v == null) throw new BsktsError(`${a.kind} needs ${name}`, "BAD_REQUEST");
        };
        if (a.kind === "cancel") {
          need(a.orderId, "orderId");
          return client.buildOrder({
            kind: "cancel",
            orderId: a.orderId as `0x${string}`,
            address: a.address,
          });
        }
        need(a.ticker, "ticker");
        if (a.kind === "exit") {
          need(a.shares, "shares");
          return client.buildOrder({
            kind: "exit",
            ticker: a.ticker!,
            address: a.address,
            shares: BigInt(a.shares!),
            stopNav: a.stopNav,
            tpNav: a.tpNav,
            expiryDays: a.expiryDays,
          });
        }
        need(a.amountUsdg, "amountUsdg");
        return client.buildOrder({
          kind: "limit",
          ticker: a.ticker!,
          address: a.address,
          amountUsdg: a.amountUsdg!,
          triggerNav: a.triggerNav,
          expiryDays: a.expiryDays,
        });
      }),
  );

  server.registerTool(
    "bskts_agent_session",
    {
      title: "Agent account permissions",
      description:
        "Resolve a wallet owner's bskts account and read an agent public key's live authority: active, moduleEnabled, coverEnabled, USDG, basket turnover remaining, max slippage, expiry and owner approval URL. Cover spending counts separately. Start here for autonomous gasless trading. No ETH needed. Inactive => owner connects this public key in Portfolio; never request private keys or silently renew/increase limits.",
      inputSchema: { owner: address, key: address },
      annotations: READ,
    },
    (p) => run(() => client.agentSession(p)),
  );
  server.registerTool(
    "bskts_agent_trade",
    {
      title: "Build a delegated agent trade",
      description:
        "Build an UNSIGNED buy/sell Action inside owner-approved permissions. Returns action, typedData and relayer URL. The agent host's matching session signer signs typedData; POST {action,signature} to the relayer. No wallet approval per trade, no ETH. A 402 fee quote requires a new signature within the host's explicit fee cap; preserve nonce and all trade terms. Persist the unsigned plan before signing; on restart reconcile its original nonce and stop while unresolved. SDK hosts can use executeSessionOnce with a durable store. Never retry ambiguous timeouts with a new nonce. Existing wallet/order tools are a separate path.",
      inputSchema: {
        owner: address,
        key: address,
        ticker,
        side: z.enum(["buy", "sell"]),
        amountUsdg: z.number().min(5).optional().describe("buy: USDG dollars, minimum $5"),
        shares: z
          .string()
          .regex(/^\d+$/)
          .optional()
          .describe("sell: exact account shares, 1e18 base units"),
        slippageBps: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe(
            "all-in module tolerance; default 50 bps, or the grant maximum if lower; never above owner approval",
          ),
        feeUsdg: z
          .string()
          .regex(/^\d+$/)
          .optional()
          .describe("network fee base units; default 0 for quote, never above host fee cap"),
      },
      annotations: BUILD,
    },
    (p) =>
      run(async () => {
        if (p.side === "buy" && (p.amountUsdg == null || p.shares != null))
          throw new BsktsError("Buy needs amountUsdg and no shares.", "BAD_REQUEST");
        if (p.side === "sell" && (p.shares == null || p.amountUsdg != null))
          throw new BsktsError("Sell needs exact shares and no amountUsdg.", "BAD_REQUEST");
        const base = {
          owner: p.owner,
          key: p.key,
          ticker: p.ticker,
          slippageBps: p.slippageBps,
          feeUsdg: p.feeUsdg == null ? undefined : BigInt(p.feeUsdg),
        };
        const plan = await client.buildAgentTrade(
          p.side === "buy"
            ? { ...base, side: "buy", amountUsdg: p.amountUsdg! }
            : { ...base, side: "sell", shares: BigInt(p.shares!) },
        );
        return { ...plan, typedData: agentTypedData(plan.action) };
      }),
  );

  // 2026-10-11: Weekend Cover, buying only. One read tool with three views
  // keeps the tool list (and every cold start's tokens) short.
  const bps = z.number().int().min(1).max(3000);
  server.registerTool(
    "bskts_cover",
    {
      title: "Weekend Cover",
      description:
        "Weekend Cover pays a held basket's weekend drop between fromBps and toBps (300-1000: from -3%, full at -10%). Prices: $ per $1,000 of cover, +1% fee. weeks: buyable weeks, terms, limits. book (ticker): offers by range, history.fairPer1k (average payout), quote for coverUsd. positions (bskts account): cover, payouts, listings.",
      inputSchema: {
        view: z.enum(["weeks", "book", "positions"]),
        ticker: ticker.optional(),
        account: address.optional(),
        coverUsd: z.number().int().min(1).optional(),
        fromBps: bps.optional(),
        toBps: bps.optional(),
        week: z.number().int().min(0).optional(),
      },
      annotations: READ,
    },
    (p) =>
      run(() => {
        if (p.view === "weeks") return client.coverWeeks();
        if (p.view === "positions") {
          if (!p.account) throw new BsktsError("positions needs account.", "BAD_REQUEST");
          return client.coverPositions(p.account);
        }
        if (!p.ticker) throw new BsktsError("book needs ticker.", "BAD_REQUEST");
        const { view: _v, ticker: t, ...q } = p;
        return client.coverBook(t, q);
      }),
  );
  server.registerTool(
    "bskts_agent_cover",
    {
      title: "Build a delegated cover purchase",
      description:
        "UNSIGNED Weekend Cover action for the agent session key: take offers (all of coverUsd unless allowPartial), request at pricePer1k, or cancel listingId (free). Never underwrites. Needs owner-enabled Cover and basket holdings; premium + fee <= 3% of cover. Sign typedData, POST {action,signature} to relayerUrl; 402: re-sign the fee only, within the host cap.",
      inputSchema: {
        owner: address,
        key: address,
        action: z.enum(["take", "request", "cancel"]),
        ticker: ticker.optional(),
        fromBps: bps.optional(),
        toBps: bps.optional(),
        coverUsd: z.number().int().min(1).optional(),
        week: z.number().int().min(0).optional(),
        maxPricePer1k: z.number().positive().optional(),
        allowPartial: z.boolean().optional(),
        pricePer1k: z.number().positive().optional(),
        listingId: z.string().regex(/^\d+$/).optional(),
        feeUsdg: z.string().regex(/^\d+$/).optional(),
      },
      annotations: BUILD,
    },
    (p) =>
      run(async () => {
        const who = { owner: p.owner, key: p.key };
        const fee = p.feeUsdg == null ? {} : { feeUsdg: BigInt(p.feeUsdg) };
        const opt = <K extends string, V>(k: K, v: V | undefined) =>
          (v === undefined ? {} : { [k]: v }) as Partial<Record<K, V>>;
        let plan;
        if (p.action === "cancel") {
          if (!p.listingId) throw new BsktsError("cancel needs listingId.", "BAD_REQUEST");
          plan = await client.buildAgentCover({
            ...who,
            action: "cancel",
            listingId: BigInt(p.listingId),
          });
        } else {
          if (!p.ticker || p.fromBps == null || p.toBps == null || p.coverUsd == null)
            throw new BsktsError(
              `${p.action} needs ticker, fromBps, toBps and coverUsd.`,
              "BAD_REQUEST",
            );
          const terms = {
            ...who,
            ...fee,
            ticker: p.ticker,
            fromBps: p.fromBps,
            toBps: p.toBps,
            coverUsd: p.coverUsd,
            ...opt("week", p.week),
          };
          if (p.action === "take")
            plan = await client.buildAgentCover({
              ...terms,
              action: "take",
              ...opt("maxPricePer1k", p.maxPricePer1k),
              ...opt("allowPartial", p.allowPartial),
            });
          else {
            if (p.pricePer1k == null)
              throw new BsktsError("request needs pricePer1k.", "BAD_REQUEST");
            plan = await client.buildAgentCover({
              ...terms,
              action: "request",
              pricePer1k: p.pricePer1k,
            });
          }
        }
        return { ...plan, typedData: coverTypedData(plan.action) };
      }),
  );

  server.registerTool(
    "bskts_guide",
    {
      title: "bskts trading guide",
      description:
        "The full trading guide: chain setup, units, fees, error codes, public jobs that pay fees. Read once if a result is unclear (~1.2k tokens).",
      annotations: READ,
    },
    () =>
      run(async () => {
        const r = await fetch(`${client.baseUrl}/llms.txt`);
        if (!r.ok)
          throw new BsktsError(`guide unavailable (${r.status})`, "UPSTREAM", { retryable: true });
        return r.text();
      }),
  );
}
