import { BsktsError } from "./errors";

/** Client-side guard rails, checked before a plan is built. For an agent
 * trading real funds: a hallucinated "buy $10,000" stops here. The chain's own
 * floors (minShares / minOut) still protect every trade regardless. */
export interface Policy {
  /** largest buy, limit buy or sale, in USD */
  maxUsdPerTrade?: number;
  /** only these tickers may be traded (case-insensitive) */
  allowedTickers?: readonly string[];
  /** refuse a buy whose live buyCostBps is above this */
  maxBuyCostBps?: number;
  /** cap on the slippageBps passed to buy / sell */
  maxSlippageBps?: number;
}

const refuse = (message: string) => new BsktsError(`policy: ${message}`, "POLICY");

export function checkPolicy(
  policy: Policy,
  p: { ticker?: string; usd?: number; slippageBps?: number; buyCostBps?: number | null },
) {
  const t = p.ticker?.toUpperCase();
  if (t && policy.allowedTickers && !policy.allowedTickers.some((x) => x.toUpperCase() === t))
    throw refuse(`${t} is not in allowedTickers`);
  if (p.usd != null && policy.maxUsdPerTrade != null && p.usd > policy.maxUsdPerTrade)
    throw refuse(`$${p.usd.toFixed(2)} is over maxUsdPerTrade ($${policy.maxUsdPerTrade})`);
  if (
    p.slippageBps != null &&
    policy.maxSlippageBps != null &&
    p.slippageBps > policy.maxSlippageBps
  )
    throw refuse(`slippageBps ${p.slippageBps} is over maxSlippageBps (${policy.maxSlippageBps})`);
  if (p.buyCostBps != null && policy.maxBuyCostBps != null && p.buyCostBps > policy.maxBuyCostBps)
    throw refuse(
      `${t ?? "this basket"} costs ${p.buyCostBps.toFixed(1)} bps to buy, over maxBuyCostBps (${policy.maxBuyCostBps})`,
    );
}

/** Policy from environment variables (BSKTS_MAX_USD_PER_TRADE,
 * BSKTS_ALLOWED_TICKERS, BSKTS_MAX_BUY_COST_BPS, BSKTS_MAX_SLIPPAGE_BPS). */
export function policyFromEnv(env: Record<string, string | undefined>): Policy {
  const n = (k: string) => {
    const v = env[k];
    if (v == null || v === "") return undefined;
    const x = Number(v);
    if (!Number.isFinite(x)) throw new Error(`${k} must be a number, got "${v}"`);
    return x;
  };
  const p: Policy = {};
  const max = n("BSKTS_MAX_USD_PER_TRADE");
  const cost = n("BSKTS_MAX_BUY_COST_BPS");
  const slip = n("BSKTS_MAX_SLIPPAGE_BPS");
  if (max != null) p.maxUsdPerTrade = max;
  if (cost != null) p.maxBuyCostBps = cost;
  if (slip != null) p.maxSlippageBps = slip;
  const tickers = env["BSKTS_ALLOWED_TICKERS"]
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (tickers?.length) p.allowedTickers = tickers;
  return p;
}
