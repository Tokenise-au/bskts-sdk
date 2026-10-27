import {
  decodeAbiParameters,
  decodeEventLog,
  encodeAbiParameters,
  parseAbi,
  parseAbiParameters,
  type Hex,
} from "viem";
import { BsktsError } from "./errors";
import type { AgentOrderPlan, AgentOrderPreview } from "./schemas";

// 2026-10-21: order terms are inside signed bytes. Decode and check them
// before any host signer; display metadata is never spending authority.
export const limitTermsAbi = parseAbiParameters(
  "(uint256 triggerNavE18,bool triggerBelow,uint64 deadline,uint16 maxSlippageBps,uint16 fillerFeeBps,uint16 startSlippageBps)",
);
// 2026-10-25: exits (stop-loss / take-profit / bracket), BsktsSessionModule.ExitParams.
export const exitTermsAbi = parseAbiParameters(
  "(uint256 stopNavE18,uint256 tpNavE18,uint64 deadline,uint16 maxSlippageBps,uint16 fillerFeeBps,uint16 startSlippageBps)",
);
export function decodeAgentOrder(plan: AgentOrderPlan) {
  const fail = () => new BsktsError("Invalid delegated order terms.", "BAD_RESPONSE");
  const a = plan.action;
  /** The terms both escrows share, against the session that signs them. */
  const badTerms = (t: {
    deadline: bigint;
    maxSlippageBps: number;
    fillerFeeBps: number;
    startSlippageBps: number;
  }) =>
    t.deadline > BigInt(plan.status.validUntil) ||
    t.deadline < BigInt(a.deadline) ||
    t.maxSlippageBps < 50 ||
    t.maxSlippageBps > plan.status.maxSlippageBps ||
    t.maxSlippageBps !== a.slippageBps ||
    t.fillerFeeBps > 100 ||
    t.startSlippageBps < 50 ||
    t.startSlippageBps > t.maxSlippageBps;
  try {
    if (a.limit !== 0n) throw fail();
    if (a.kind === 4 || a.kind === 5) {
      const [orderId] = decodeAbiParameters([{ type: "bytes32" }], a.data);
      if (
        a.amount !== 0n ||
        a.slippageBps !== 0 ||
        a.data.toLowerCase() !== encodeAbiParameters([{ type: "bytes32" }], [orderId]).toLowerCase()
      )
        throw fail();
      return a.kind === 4
        ? { kind: "cancel" as const, orderId }
        : { kind: "cancel-exit" as const, orderId };
    }
    if (a.kind === 3) {
      // An exit escrows shares (amount); its turnover is their value, which the
      // module counts at the higher of spot and TwapNav and checks itself. Its
      // network fee is paid from the account's USDG: shares never pay it.
      const [terms] = decodeAbiParameters(exitTermsAbi, a.data);
      if (
        encodeAbiParameters(exitTermsAbi, [terms]).toLowerCase() !== a.data.toLowerCase() ||
        a.amount === 0n ||
        (terms.stopNavE18 === 0n && terms.tpNavE18 === 0n) ||
        (terms.stopNavE18 !== 0n && terms.tpNavE18 !== 0n && terms.stopNavE18 >= terms.tpNavE18) ||
        badTerms(terms) ||
        a.fee > plan.status.usdgWei
      )
        throw fail();
      return { kind: "exit" as const, ...terms };
    }
    if (a.kind !== 2 || a.amount < 5_000_000n) throw fail();
    const [terms] = decodeAbiParameters(limitTermsAbi, a.data);
    if (
      encodeAbiParameters(limitTermsAbi, [terms]).toLowerCase() !== a.data.toLowerCase() ||
      terms.triggerNavE18 <= 0n ||
      badTerms(terms) ||
      a.amount > plan.status.remainingTodayUsdg ||
      a.amount + a.fee > plan.status.usdgWei
    )
      throw fail();
    return { kind: "limit" as const, ...terms };
  } catch {
    throw fail();
  }
}

export const LIMIT_ESCROW = "0x5e267dBD5d0540be1b6EADe920F288fF50EB76Db";
/** SellEscrowV4: the escrow BsktsSessionModule places and cancels exits on. */
export const SELL_ESCROW = "0x7e0B140162ed713398842e25e18c7371230669e0";
const createdAbi = parseAbi([
  "event OrderCreated(bytes32 indexed id,address indexed recipient,address vault,uint256 amount,uint256 triggerNavE18,bool triggerBelow,uint64 deadline,uint16 maxSlippageBps,uint16 fillerFeeBps)",
]);
const exitCreatedAbi = parseAbi([
  "event SellIntentCreated(bytes32 indexed id,address indexed recipient,address vault,uint256 shares,uint256 stopNavE18,uint256 tpNavE18,uint64 deadline,uint16 maxSlippageBps,uint16 fillerFeeBps)",
]);
type Log = { address: string; data: Hex; topics: readonly Hex[] };
function idFrom(
  logs: readonly Log[],
  escrow: string,
  abi: typeof createdAbi | typeof exitCreatedAbi,
): Hex | undefined {
  for (const log of logs) {
    if (log.address.toLowerCase() !== escrow.toLowerCase()) continue;
    try {
      const event = decodeEventLog({
        abi,
        data: log.data,
        topics: [...log.topics] as [Hex, ...Hex[]],
      });
      return event.args.id;
    } catch {
      /* other escrow event */
    }
  }
  return undefined;
}
/** Read the order ID from a placement receipt, without relying on indexer lag. */
export const limitOrderId = (logs: readonly Log[]) => idFrom(logs, LIMIT_ESCROW, createdAbi);
/** An exit's ID from its placement receipt. Limit and exit IDs are each
 * escrow's own counter and can be equal: cancel with the matching kind. */
export const exitOrderId = (logs: readonly Log[]) => idFrom(logs, SELL_ESCROW, exitCreatedAbi);

const signed = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
const nav = (n: number) => `NAV ${Number(n.toPrecision(8))}`;
/** 2026-10-27 (bskts agent audit F6): the API's worst* fields are a fill AT
 * the trigger at the widest floor, not a bound: the escrows price the floor
 * from the NAV when the order fills, so a stop after a gap down sells lower and
 * a buy-above after a gap up pays more. "worst net" read as a promise the
 * contracts do not make. The field names stay (they are the API's); the words
 * printed around them say "at the trigger". The API's basis carries the gap
 * caveat since bskts PR 256; these lines add it only when the basis lacks it. */
const STOP_GAP =
  "Not a bound: a stop fills at the NAV when it fills, so after a gap down it sells below its trigger and below these proceeds.";
const ABOVE_GAP =
  "Not a cap: a buy-above fills at the NAV when it fills, so after a gap up it pays more per share than this.";
const hasGapNote = (basis: string) => /not a (bound|cap)/i.test(basis);

/** 2026-10-25: the plan's preview as plain lines, so the MCP tool and the skill
 * print the same words around the API's numbers. Triggers are on NAV: each line
 * is a price move, with what reaches the account after costs beside it. */
export function describePreview(p: AgentOrderPreview): string[] {
  const now =
    p.navNow === null ? "NAV now unavailable" : `${nav(p.navNow)} now (10-minute pool average)`;
  if (p.kind === "limit")
    return [
      `Limit buy when ${p.direction === "below" ? "NAV <=" : "NAV >="} ${Number(p.triggerNav.toPrecision(8))}: ${signed(p.fromNowPct)} from ${now}.`,
      `Most per share at the trigger (widest floor): ${Number(p.worstPricePerShare.toPrecision(8))} (${signed(p.worstFromNowPct)} from now; max slippage ${p.costs.maxSlippageBps} bps incl. the ${p.costs.mintFeeBps} bps mint fee, filler fee ${p.costs.fillerFeeBps} bps).`,
      ...(p.direction === "above" && !hasGapNote(p.basis) ? [ABOVE_GAP] : []),
      ...(p.fillsNow ? ["The trigger is already met: it can fill as soon as it is placed."] : []),
      p.basis,
    ];
  if (p.kind === "exit")
    return [
      `Exit ${Number(p.shares.toPrecision(8))} shares; ${now}${p.avgEntry === null ? "; no entry history" : `; average entry ${nav(p.avgEntry)}`}.`,
      ...p.triggers.map(
        (t) =>
          `${t.edge === "stop" ? "Stop-loss" : "Take-profit"} at ${nav(t.nav)}: ${signed(t.fromNowPct)} from now` +
          (t.priceReturnPct === null
            ? `; ${t.worstProceedsUsdg} USDG at the trigger's widest floor.`
            : `; vs entry ${signed(t.priceReturnPct)} price, ${t.estNetReturnPct === null ? "n/a" : signed(t.estNetReturnPct)} est. net, ${t.worstNetReturnPct === null ? "n/a" : signed(t.worstNetReturnPct)} at the trigger's widest floor (${t.worstProceedsUsdg} USDG).`),
      ),
      ...(p.breakEvenNav === null
        ? []
        : [`Break-even after estimated costs: ${nav(p.breakEvenNav)}.`]),
      ...(p.triggers.some((t) => t.edge === "stop") && !hasGapNote(p.basis) ? [STOP_GAP] : []),
      p.basis,
    ];
  if (p.kind === "cancel")
    return [
      `Cancel a limit buy at NAV ${p.direction === "below" ? "<=" : ">="} ${Number(p.triggerNav.toPrecision(8))}${p.fromNowPct === null ? "" : ` (${signed(p.fromNowPct)} from now)`}; ${p.refundUsdg} USDG returns to the account.`,
    ];
  const edge = (name: string, e: { nav: number; fromNowPct: number | null } | null) =>
    e === null
      ? []
      : [
          `${name} ${nav(e.nav)}${e.fromNowPct === null ? "" : ` (${signed(e.fromNowPct)} from now)`}`,
        ];
  return [
    `Cancel an exit (${[...edge("stop", p.stop), ...edge("take-profit", p.takeProfit)].join(", ")}); ${Number(p.returnsShares.toPrecision(8))} shares return to the account.`,
  ];
}
