// Zod schemas for every bskts API response. They are the single source of the
// SDK's types (z.infer) and validate what comes back at runtime, so an API
// change surfaces as a clear BAD_RESPONSE error instead of `undefined` deep in
// an agent's logic.
//
// Conventions, applied in the parse:
// - on-chain amounts (anything *Wei, shares in plans, USDG base units) arrive as
//   integer strings and become `bigint`;
// - addresses and calldata are typed as viem's `Address` / `Hex`;
// - dollars, NAVs and fractions stay `number`.
import type { Address, Hex } from "viem";
import { z } from "zod";

export const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected a 0x address")
  .transform((a) => a as Address);
export const hex = z
  .string()
  .regex(/^0x[0-9a-fA-F]*$/, "expected 0x hex")
  .transform((h) => h as Hex);
/** An integer string (base units) as a bigint. */
export const wei = z
  .string()
  .regex(/^\d+$/, "expected an integer string")
  .transform((s) => BigInt(s));

const num = z.number();
const numOrNull = z.number().nullable();

// ---- reads ----------------------------------------------------------------

export const basketSummary = z.object({
  ticker: z.string(),
  name: z.string(),
  thesis: z.string(),
  vault: address,
  rebalance: z.string(),
  mgmtFeeBps: num,
  targetWeights: z.record(z.string(), num),
  nav: numOrNull,
  /** fraction: 0.012 = +1.2% */
  change24h: numOrNull,
  /** the real cost of a buy (pool fees + price impact), bps, on top of the 0.20% mint fee */
  buyCostBps: numOrNull,
  group: z.string(),
  /** plain-language warning for higher-risk baskets */
  risk: z.string().nullable(),
});
export const constituent = z.object({
  symbol: z.string(),
  address: address.nullable(),
  targetWeight: num,
  price: numOrNull,
});
export const basketDetail = basketSummary.extend({ constituents: z.array(constituent) });
export const basketsResponse = z.object({
  indexes: z.array(basketSummary.partial()),
  asOfMs: num,
  live: z.boolean(),
});

export const market = z.object({
  ticker: z.string(),
  nav: numOrNull,
  change24h: numOrNull,
  buyCostBps: numOrNull,
});
export const marketsResponse = z.object({
  markets: z.array(market.partial()),
  prices: z.record(z.string(), num).optional(),
  asOfMs: num,
  live: z.boolean(),
});

export const stats = z.object({
  /** number of live baskets */
  indexes: num,
  volumeAllTime: num,
  tvl: num,
  asOfMs: num,
  live: z.boolean(),
});

export const candle = z.object({ t: num, o: num, h: num, l: num, c: num });
export const candlesResponse = z.object({
  ticker: z.string(),
  resolution: z.string(),
  candles: z.array(candle),
});
export const closesResponse = z.object({
  ticker: z.string(),
  resolution: z.string(),
  close: z.array(z.tuple([num, num])),
});
/** Fractions throughout (0.012 = +1.2%); volatility annualised. */
export const navSummary = z.object({
  candles: num,
  from: num.optional(),
  to: num.optional(),
  open: num.optional(),
  last: num.optional(),
  high: num.optional(),
  low: num.optional(),
  change: num.optional(),
  maxDrawdown: num.optional(),
  volatility: numOrNull.optional(),
});
export const navSummaryResponse = z.object({
  ticker: z.string(),
  resolution: z.string(),
  days: num,
  summary: navSummary,
});

export const wallet = z.object({
  address,
  chainId: num,
  eth: num,
  ethWei: wei,
  usdg: num,
  usdgWei: wei,
  /** basket shares in the wallet (escrowed order shares excluded) */
  holdings: z.array(z.object({ ticker: z.string(), sharesWei: wei })),
  /** ETH one trade (with its approval) needs at twice today's gas price */
  tradeGasEth: num,
  /** false: too little ETH on Robinhood Chain to pay gas */
  gasOk: z.boolean(),
  note: z.string().optional(),
});

export const position = z.object({
  ticker: z.string(),
  /** readable; use sharesWei / walletSharesWei for amounts you send back */
  shares: num,
  walletShares: num,
  escrowedShares: num,
  sharesWei: wei,
  /** what the wallet can sell now (escrowed shares sit in orders) */
  walletSharesWei: wei,
  nav: num,
  value: num,
  costBasis: num,
  avgEntry: numOrNull,
  unrealizedPnl: num,
  realizedPnl: num,
});
export const positionsResponse = z.object({ address, positions: z.array(position) });

export const exitOrder = z.object({
  id: hex,
  escrow: address,
  ticker: z.string().nullable(),
  shares: num,
  stopNav: numOrNull,
  tpNav: numOrNull,
  kind: z.enum(["bracket", "take_profit", "stop_loss"]),
});
export const limitBuyOrder = z.object({
  id: hex,
  escrow: address,
  ticker: z.string().nullable(),
  amountUsdg: num,
  /** null = a market order */
  triggerNav: numOrNull,
  triggerBelow: z.boolean(),
  deadline: num,
  kind: z.literal("limit_buy"),
});
export const order = z.discriminatedUnion("kind", [exitOrder, limitBuyOrder]);
export const ordersResponse = z.object({ address, orders: z.array(order) });

export const strategyRun = z.object({
  id: z.string(),
  ticker: z.string().nullable(),
  buys: num,
  sold: num,
  spentUsd: num,
  receivedUsd: num,
});
export const strategiesResponse = z.object({ address, strategies: z.array(strategyRun) });

// ---- transactions -----------------------------------------------------------

export const txRequest = z.object({ to: address, data: hex, value: wei });
export const simulation = z.union([
  z.object({ ok: z.literal(true), gas: wei.optional() }),
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({ ok: z.null(), skipped: z.string() }),
]);
const planBase = z.object({
  /** send first and wait for it to be mined; null when none is needed */
  approval: z.object({ to: address, data: hex }).nullable(),
  tx: txRequest,
  /** the API's dry run of `tx` as the sender */
  simulation: simulation.optional(),
  /** e.g. the wallet holds less USDG than the plan spends */
  warnings: z.array(z.string()).optional(),
});
export const txPlan = planBase;
export const buyPlan = planBase.extend({
  amountInUsdg: wei,
  minShares: wei,
  estShares: num,
  legs: num,
});
export const sellPlan = planBase.extend({
  sharesWei: wei,
  /** USDG base units (6dp) */
  expectedUsdg: wei,
  minOutUsdg: wei,
  legs: num,
});
export const exitPlan = planBase.extend({ kind: z.string() });
export const limitPlan = planBase.extend({ note: z.string() });
export const redeemPlan = planBase.extend({ mode: z.string() });

export const swapCall = z.object({
  router: address,
  tokenIn: address,
  tokenOut: address,
  amountIn: wei,
  callData: hex,
});
export const sellRoutesResponse = z.object({
  vault: address,
  shares: wei,
  zapper: address,
  router: address,
  swaps: z.array(swapCall),
  legs: z.array(z.object({ symbol: z.string(), token: address, amountIn: wei })),
  unrouted: z.array(address),
  note: z.string(),
});

export const job = z.object({
  type: z.enum(["sell", "limit", "schedule"]),
  contract: address,
  id: hex,
  ticker: z.string().nullable(),
  vault: address.optional(),
  /** the executor's fee, USDG base units */
  feeUsdg: wei,
  /** the fill floor's current slippage, bps */
  slippageBps: num,
  tx: txRequest,
  /** send first if the fill misses its floor (starts the price auction) */
  armData: hex,
});
export const jobsResponse = z.object({
  asOf: z.string(),
  jobs: z.array(job),
  skipped: z.array(z.object({ type: z.string(), id: z.string(), reason: z.string() })),
  note: z.string(),
});

export const apiErrorBody = z.object({
  error: z.string(),
  code: z.string().optional(),
  retryable: z.boolean().optional(),
});

// ---- types ------------------------------------------------------------------

export type BasketSummary = z.infer<typeof basketSummary>;
export type BasketDetail = z.infer<typeof basketDetail>;
export type Constituent = z.infer<typeof constituent>;
export type Market = z.infer<typeof market>;
export type Stats = z.infer<typeof stats>;
export type Candle = z.infer<typeof candle>;
export type NavSummary = z.infer<typeof navSummary>;
export type Wallet = z.infer<typeof wallet>;
export type Position = z.infer<typeof position>;
export type ExitOrder = z.infer<typeof exitOrder>;
export type LimitBuyOrder = z.infer<typeof limitBuyOrder>;
export type Order = z.infer<typeof order>;
export type StrategyRun = z.infer<typeof strategyRun>;
export type TxRequest = z.infer<typeof txRequest>;
export type Simulation = z.infer<typeof simulation>;
export type TxPlan = z.infer<typeof txPlan>;
export type BuyPlan = z.infer<typeof buyPlan>;
export type SellPlan = z.infer<typeof sellPlan>;
export type ExitPlan = z.infer<typeof exitPlan>;
export type LimitPlan = z.infer<typeof limitPlan>;
export type RedeemPlan = z.infer<typeof redeemPlan>;
export type SwapCall = z.infer<typeof swapCall>;
export type Job = z.infer<typeof job>;

// 2026-10-02: delegated plans are Actions, not transactions from the owner's
// wallet. Pin the signing domain so a response cannot change the module.
export const SESSION_MODULE = "0x66a0ba9be3f6779b4f24CE6135Cc93B5559888Da" as const;
const uint256 = wei.refine((n) => n < 2n ** 256n, "exceeds uint256");
export const agentSession = z.object({
  owner: address,
  account: address,
  key: address,
  chainId: z.literal(4663),
  module: z.literal(SESSION_MODULE),
  deployed: z.boolean(),
  moduleEnabled: z.boolean(),
  coverEnabled: z.boolean(),
  active: z.boolean(),
  paused: z.boolean(),
  usdgWei: uint256,
  dailyLimitUsdg: uint256,
  remainingTodayUsdg: uint256,
  maxSlippageBps: z.number().int().min(0).max(1000),
  validUntil: z.number().int().nonnegative(),
  // 2026-10-03: a literal broke every call when the app moved Agents from
  // #agents to ?p=agents. It's only a page for the owner; pin its origin, not
  // its path. relayerUrl and module stay exact: signed Actions go there.
  approvalUrl: z.url().refine((u) => new URL(u).origin === "https://bskts.xyz", "not bskts.xyz"),
  relayerUrl: z.literal("https://bskts.xyz/relay/v1/account/execute"),
  revokeEffect: z.string(),
});
export const sessionAction = z.object({
  account: address,
  key: address,
  kind: z.union([z.literal(0), z.literal(1)]),
  vault: address,
  amount: uint256.refine((n) => n > 0n),
  limit: uint256,
  slippageBps: z.number().int().min(0).max(1000),
  data: hex.refine((h) => h.length % 2 === 0),
  nonce: uint256,
  deadline: z
    .number()
    .int()
    .positive()
    .max(2 ** 48 - 1),
  fee: uint256.refine((n) => n <= 10_000_000n),
});
export const agentTradePlan = z.object({
  ticker: z.string(),
  status: agentSession,
  action: sessionAction,
  relayerUrl: z.literal("https://bskts.xyz/relay/v1/account/execute"),
  simulation,
});
export const sessionReceipt = z.object({
  hash: hex.refine((h) => /^0x[0-9a-fA-F]{64}$/.test(h)),
  blockNumber: z.number().int().nonnegative(),
  gasUsed: z.number().nonnegative(),
  // 2026-10-03: the relayer's current quote for this kind of trade, sent on
  // success too; executeSession signs the next one with it (one signature).
  requiredFee: wei.optional(),
});
export type AgentSession = z.infer<typeof agentSession>;
export type SessionAction = z.infer<typeof sessionAction>;
export type AgentTradePlan = z.infer<typeof agentTradePlan>;
export type SessionReceipt = z.infer<typeof sessionReceipt>;
