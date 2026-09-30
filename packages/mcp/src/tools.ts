// The bskts tools, registered on an McpServer. Shared by the stdio CLI and the
// Streamable HTTP handler, so both expose exactly the same surface.
//
// Unsigned only: build tools return the transactions for the user's own wallet
// to sign; nothing here holds a key or sends anything.
//
// Token budget: seven tools. The rules an agent must follow (units, approval
// order, never send a failed dry run) live in the descriptions, so they arrive
// with the tools instead of costing a docs read.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type BsktsClient, BsktsError } from "@bskts/sdk";
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
  "bskts: tokenized index baskets of Stock Tokens and crypto on Robinhood Chain (chainId 4663). Tools read markets and accounts and build UNSIGNED transactions for the user's own wallet; nothing is signed or sent here. Before a trade: check bskts_account (gasOk, USDG), read the basket's risk note and buyCostBps. Sign `approval` first (wait for it to be mined), then `tx`. Never send a plan whose simulation.ok is false.";

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
