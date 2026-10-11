import type { Address } from "viem";
import { z } from "zod";
import { BsktsError, type ErrorCode } from "./errors";
import { execute, type ExecuteResult, type Sender } from "./execute";
import { checkPolicy, type Policy } from "./policy";
import * as s from "./schemas";
import { checkCoverPlan, coverCommits } from "./cover";

export const DEFAULT_API_URL = "https://api.bskts.xyz";

export interface BsktsClientOptions {
  /** default https://api.bskts.xyz */
  baseUrl?: string;
  /** a custom fetch (tests, proxies, Workers service bindings) */
  fetch?: typeof fetch;
  /** client-side guard rails, checked before any plan is built */
  policy?: Policy;
  /** per-request timeout, ms (default 30 s) */
  timeoutMs?: number;
}

type Resolution = "1m" | "1h" | "1d";
type HistoryOpts = { res?: Resolution; days?: number };
/** Exact shares (1e18 base units) or the whole wallet balance. */
export type SharesArg = bigint | "max";

/** A resting order to build: a limit buy, an exit, or a cancel. */
export type OrderArgs =
  | {
      kind: "limit";
      ticker: string;
      address: Address;
      amountUsdg: number;
      triggerNav?: number;
      expiryDays?: number;
    }
  | {
      kind: "exit";
      ticker: string;
      address: Address;
      shares: bigint;
      stopNav?: number;
      tpNav?: number;
      expiryDays?: number;
    }
  | { kind: "cancel"; orderId: `0x${string}`; address?: Address; escrow?: Address };

/** Typed, non-custodial client for the bskts API. Reads return validated data;
 * build* methods return unsigned plans ({ approval, tx, simulation }) for your
 * wallet to sign, via execute(). */
export class BsktsClient {
  readonly baseUrl: string;
  readonly policy: Policy;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(opts: BsktsClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
    this.policy = opts.policy ?? {};
    // wrapped: the global fetch called as a method of this object throws
    // "Illegal invocation" in browsers and Workers
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
  }

  // ---- transport ------------------------------------------------------------

  async #request<T extends z.ZodType>(
    schema: T,
    path: string,
    body?: unknown,
  ): Promise<z.output<T>> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body:
          body === undefined
            ? undefined
            : JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      throw new BsktsError(`request to ${path} failed: ${String(cause)}`, "NETWORK", {
        retryable: true,
        cause,
      });
    }
    const json: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const e = s.apiErrorBody.safeParse(json);
      throw new BsktsError(
        e.success ? e.data.error : `${path} answered ${res.status}`,
        (e.success && (e.data.code as ErrorCode)) || (res.status >= 500 ? "SERVER" : "BAD_REQUEST"),
        {
          status: res.status,
          retryable: e.success && e.data.retryable != null ? e.data.retryable : res.status >= 500,
          detail: json,
        },
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success)
      throw new BsktsError(
        `unexpected response from ${path}: ${z.prettifyError(parsed.error)}`,
        "BAD_RESPONSE",
        { status: res.status, detail: json },
      );
    return parsed.data;
  }

  #qs(params: Record<string, string | number | undefined>) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
    const str = q.toString();
    return str ? `?${str}` : "";
  }

  // ---- reads ----------------------------------------------------------------

  /** Compact marks for every basket: NAV, 24h change, buy cost. ~350 tokens as JSON. */
  markets(opts: { fields?: (keyof s.Market)[]; prices?: boolean } = {}) {
    const fields = (opts.fields ?? ["ticker", "nav", "change24h", "buyCostBps"]).join(",");
    return this.#request(
      s.marketsResponse,
      `/v1/markets${this.#qs({ fields, prices: opts.prices ? undefined : 0 })}`,
    );
  }
  /** Every basket with name, thesis, weights and risk note. `fields` trims each row. */
  baskets(opts: { fields?: (keyof s.BasketSummary)[] } = {}) {
    return this.#request(
      s.basketsResponse,
      `/v1/baskets${this.#qs({ fields: opts.fields?.join(",") })}`,
    );
  }
  /** One basket, with its constituents' addresses, target weights and live prices. */
  basket(ticker: string) {
    return this.#request(s.basketDetail, `/v1/baskets/${encodeURIComponent(ticker)}`);
  }
  /** Protocol totals: basket count, all-time volume, TVL (USD). */
  stats() {
    return this.#request(s.stats, "/v1/stats");
  }
  /** NAV candles. Prefer navSummary() or navCloses() when you don't need OHLC. */
  navHistory(ticker: string, opts: HistoryOpts = {}) {
    return this.#request(
      s.candlesResponse,
      `/v1/nav/${encodeURIComponent(ticker)}/history${this.#qs({ res: opts.res, days: opts.days })}`,
    );
  }
  /** Change, high, low, max drawdown and volatility over the window (fractions). */
  navSummary(ticker: string, opts: HistoryOpts = {}) {
    return this.#request(
      s.navSummaryResponse,
      `/v1/nav/${encodeURIComponent(ticker)}/history${this.#qs({ res: opts.res, days: opts.days, format: "summary" })}`,
    );
  }
  /** [unixSeconds, close] pairs. */
  navCloses(ticker: string, opts: HistoryOpts = {}) {
    return this.#request(
      s.closesResponse,
      `/v1/nav/${encodeURIComponent(ticker)}/history${this.#qs({ res: opts.res, days: opts.days, format: "close" })}`,
    );
  }
  /** ETH (gas) and USDG balances and basket shares held: check before trading. */
  wallet(address: Address) {
    return this.#request(s.wallet, `/v1/wallet/${address}`);
  }
  /** Holdings with value, average entry and PnL. */
  positions(address: Address) {
    return this.#request(s.positionsResponse, `/v1/positions/${address}`);
  }
  /** Open orders: exits (stop / take-profit / bracket) and limit buys. */
  orders(address: Address) {
    return this.#request(s.ordersResponse, `/v1/orders/${address}`);
  }
  strategies(address: Address) {
    return this.#request(s.strategiesResponse, `/v1/strategies/${address}`);
  }
  /** Every public job executable right now, with calldata and the fee it pays
   * whoever sends it. Simulate before sending. */
  jobs() {
    return this.#request(s.jobsResponse, "/v1/jobs");
  }
  /** Swap calls that turn `shares` of a basket into USDG through its pinned
   * pools: the `swaps` argument for liquidations and levered exits. */
  sellRoutes(p: { vault: Address; shares: bigint }) {
    return this.#request(
      s.sellRoutesResponse,
      `/v1/leverage/sell-routes${this.#qs({ vault: p.vault, shares: p.shares.toString() })}`,
    );
  }

  /** Resolve the owner's account and read the key's live on-chain authority.
   * Inactive => owner connects the public key in Portfolio; never auto-renew. */
  async agentSession(p: { owner: Address; key: Address }) {
    const permission = await this.#request(s.agentSession, "/v1/agent/session" + this.#qs(p));
    if (
      permission.owner.toLowerCase() !== p.owner.toLowerCase() ||
      permission.key.toLowerCase() !== p.key.toLowerCase()
    )
      throw new BsktsError(
        "Permission response does not match the requested owner/key.",
        "BAD_RESPONSE",
      );
    return permission;
  }
  /** Unsigned buy/sell Action for a delegated bskts account. Unlike buildBuy,
   * no wallet approval or ETH is needed: a host session signer + relayer execute it. */
  async buildAgentTrade(
    p: { owner: Address; key: Address; ticker: string; slippageBps?: number; feeUsdg?: bigint } & (
      | { side: "buy"; amountUsdg: number }
      | { side: "sell"; shares: bigint }
    ),
  ) {
    checkPolicy(this.policy, {
      ticker: p.ticker,
      slippageBps: p.slippageBps,
      ...(p.side === "buy" ? { usd: p.amountUsdg } : {}),
    });
    if (p.side === "buy" && this.policy.maxBuyCostBps != null) {
      const { buyCostBps } = await this.basket(p.ticker);
      checkPolicy(this.policy, { ticker: p.ticker, buyCostBps });
    }
    const plan = await this.#request(s.agentTradePlan, "/v1/agent/trade", p);
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    if (
      !same(plan.status.owner, p.owner) ||
      !same(plan.action.key, p.key) ||
      !same(plan.status.key, p.key) ||
      !same(plan.action.account, plan.status.account) ||
      plan.ticker.toUpperCase() !== p.ticker.toUpperCase() ||
      plan.action.kind !== (p.side === "buy" ? 0 : 1) ||
      // 2026-10-04: left out, the API uses 0.5% or the grant's maximum if
      // that is lower (a fixed 50 failed every default trade under a tighter grant)
      plan.action.slippageBps !== (p.slippageBps ?? Math.min(50, plan.status.maxSlippageBps)) ||
      plan.action.fee !== (p.feeUsdg ?? 0n) ||
      (p.side === "buy"
        ? plan.action.limit > BigInt(Math.floor(p.amountUsdg * 1e6))
        : plan.action.amount !== p.shares)
    )
      throw new BsktsError("Agent plan does not match the requested trade.", "BAD_RESPONSE");
    // 2026-10-05: omission is resolved against the owner's grant by the API.
    // A fixed 50 rejected valid tight grants; check the effective value too.
    checkPolicy(this.policy, { slippageBps: plan.action.slippageBps });
    if (p.side === "sell" && this.policy.maxUsdPerTrade != null) {
      const detail = await this.basket(p.ticker);
      checkPolicy(this.policy, { usd: (Number(plan.action.amount) / 1e18) * (detail.nav ?? 0) });
    }
    return plan;
  }

  // ---- Weekend Cover (2026-10-11): agents buy it; underwriting is the owner's

  /** The weeks a session may buy cover for (the one trading now and the next
   * two), the contract's terms, a session's price limits, tickers and presets. */
  coverWeeks() {
    return this.#request(s.coverWeeksResponse, "/v1/cover/weeks");
  }
  /** Open offers on a basket's cover by range, each range's payout history
   * (fairPer1k: its average payout a weekend) and, with coverUsd, a quote.
   * `account` (the buyer's bskts account) leaves its own offers out of quotes. */
  coverBook(
    ticker: string,
    q: {
      week?: number;
      coverUsd?: number;
      fromBps?: number;
      toBps?: number;
      account?: Address;
    } = {},
  ) {
    return this.#request(
      s.coverBookResponse,
      `/v1/cover/book/${encodeURIComponent(ticker)}${this.#qs(q)}`,
    );
  }
  /** A bskts account's cover, what each paid out (the keeper pays it), and its
   * open listings. */
  coverPositions(account: Address) {
    return this.#request(s.coverPositionsResponse, `/v1/cover/positions/${account}`);
  }
  /** An unsigned cover action for the account's session key: take offers,
   * request cover, or cancel the account's listing. Checked against the request
   * and the module's bounds (checkCoverPlan) before it is returned; policy's
   * maxUsdPerTrade caps what it commits, allowedTickers its basket. */
  async buildAgentCover(
    p: { owner: Address; key: Address; feeUsdg?: bigint } & (
      | {
          action: "take";
          ticker: string;
          fromBps: number;
          toBps: number;
          coverUsd: number;
          week?: number;
          maxPricePer1k?: number;
          allowPartial?: boolean;
        }
      | {
          action: "request";
          ticker: string;
          fromBps: number;
          toBps: number;
          coverUsd: number;
          pricePer1k: number;
          week?: number;
        }
      | { action: "cancel"; listingId: bigint }
    ),
  ) {
    if (p.action !== "cancel") checkPolicy(this.policy, { ticker: p.ticker });
    if (p.action === "cancel" && p.feeUsdg)
      throw new BsktsError("Cancels are free: send them without a fee.", "BAD_REQUEST");
    const { feeUsdg, ...rest } = p;
    const plan = await this.#request(s.agentCoverPlan, "/v1/agent/cover", {
      ...rest,
      ...(p.action !== "cancel" && feeUsdg !== undefined ? { feeUsdg } : {}),
    });
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const d = checkCoverPlan(plan);
    const mismatch =
      !same(plan.status.owner, p.owner) ||
      !same(plan.action.key, p.key) ||
      !same(plan.status.key, p.key) ||
      !same(plan.action.account, plan.status.account) ||
      plan.intent !== p.action ||
      plan.action.fee !== (p.action === "cancel" ? 0n : (feeUsdg ?? 0n)) ||
      (p.action === "cancel"
        ? d.kind !== "cancel" || d.listingId !== p.listingId
        : plan.ticker?.toUpperCase() !== p.ticker.toUpperCase() ||
          plan.fromBps !== p.fromBps ||
          plan.toBps !== p.toBps ||
          (p.week !== undefined && plan.week !== p.week) ||
          (d.kind === "take" &&
            (p.action !== "take" ||
              d.minCoverUsd > BigInt(p.coverUsd) ||
              (p.allowPartial !== true && d.minCoverUsd !== BigInt(p.coverUsd)))) ||
          (d.kind === "request" &&
            (p.action !== "request" ||
              d.coverUsd !== BigInt(p.coverUsd) ||
              d.pricePer1k !== BigInt(Math.round(p.pricePer1k * 100)) * 10_000n)));
    if (mismatch)
      throw new BsktsError("Cover plan does not match the requested action.", "BAD_RESPONSE");
    checkPolicy(this.policy, { usd: Number(coverCommits(plan)) / 1e6 });
    return plan;
  }

  // ---- construct (unsigned) -------------------------------------------------
  // Every plan carries `simulation`, the API's dry run as the sender, unless
  // `simulate: false`. execute() refuses a plan whose dry run reverted.

  /** Buy a basket with `amountUsdg` dollars of USDG, in one transaction.
   * 422 NO_ROUTE rather than a partial buy. */
  async buildBuy(p: {
    ticker: string;
    amountUsdg: number;
    address: Address;
    slippageBps?: number;
    simulate?: boolean;
  }) {
    checkPolicy(this.policy, { ticker: p.ticker, usd: p.amountUsdg, slippageBps: p.slippageBps });
    if (this.policy.maxBuyCostBps != null) {
      const { buyCostBps } = await this.basket(p.ticker);
      checkPolicy(this.policy, { ticker: p.ticker, buyCostBps });
    }
    return this.#request(s.buyPlan, "/v1/tx/buy", p);
  }
  /** Sell shares for USDG in one transaction: exact shares (walletSharesWei
   * from positions()) or "max"; with "max", `fraction` (0-1] sells part.
   * 422 NO_ROUTE rather than a partial sale. */
  async buildSell(p: {
    ticker: string;
    address: Address;
    shares?: SharesArg;
    fraction?: number;
    slippageBps?: number;
    simulate?: boolean;
  }) {
    checkPolicy(this.policy, { ticker: p.ticker, slippageBps: p.slippageBps });
    const plan = await this.#request(s.sellPlan, "/v1/tx/sell", {
      ...p,
      shares: p.shares ?? "max",
    });
    checkPolicy(this.policy, { usd: Number(plan.expectedUsdg) / 1e6 });
    return plan;
  }
  /** A resting order: a limit buy (fills when the 10-minute average NAV <=
   * triggerNav; none = market), a stop-loss / take-profit / bracket exit, or a
   * cancel. NAV levels in dollars. */
  async buildOrder(p: OrderArgs) {
    if (p.kind === "cancel") return this.#request(s.txPlan, "/v1/tx/cancel", p);
    if (p.kind === "exit") {
      checkPolicy(this.policy, { ticker: p.ticker });
      return this.#request(s.exitPlan, "/v1/tx/exit", p);
    }
    checkPolicy(this.policy, { ticker: p.ticker, usd: p.amountUsdg });
    return this.#request(s.limitPlan, "/v1/tx/limit", p);
  }
  /** Redeem shares in kind: receive the underlying tokens instead of USDG. */
  buildRedeem(p: { ticker: string; address: Address; shares: bigint }) {
    return this.#request(s.redeemPlan, "/v1/tx/redeem", { ...p, mode: "inkind" });
  }

  /** Submit a plan with your signer: approval first (waited on), then the tx.
   * See execute(). */
  execute(
    plan: s.TxPlan,
    sender: Sender,
    opts?: { wait?: boolean; force?: boolean },
  ): Promise<ExecuteResult> {
    return execute(plan, sender, opts);
  }
}
