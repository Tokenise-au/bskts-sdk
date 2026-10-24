import {
  decodeAbiParameters,
  decodeEventLog,
  encodeAbiParameters,
  parseAbi,
  parseAbiParameters,
  type Hex,
} from "viem";
import { BsktsError } from "./errors";
import type { AgentOrderPlan } from "./schemas";

// 2026-10-21: order terms are inside signed bytes. Decode and check them
// before any host signer; display metadata is never spending authority.
export const limitTermsAbi = parseAbiParameters(
  "(uint256 triggerNavE18,bool triggerBelow,uint64 deadline,uint16 maxSlippageBps,uint16 fillerFeeBps,uint16 startSlippageBps)",
);
export function decodeAgentOrder(plan: AgentOrderPlan) {
  const fail = () => new BsktsError("Invalid delegated limit-order terms.", "BAD_RESPONSE");
  const a = plan.action;
  try {
    if (a.limit !== 0n) throw fail();
    if (a.kind === 4) {
      const [orderId] = decodeAbiParameters([{ type: "bytes32" }], a.data);
      if (
        a.amount !== 0n ||
        a.slippageBps !== 0 ||
        a.data.toLowerCase() !== encodeAbiParameters([{ type: "bytes32" }], [orderId]).toLowerCase()
      )
        throw fail();
      return { kind: "cancel" as const, orderId };
    }
    if (a.kind !== 2 || a.amount < 5_000_000n) throw fail();
    const [terms] = decodeAbiParameters(limitTermsAbi, a.data);
    if (
      encodeAbiParameters(limitTermsAbi, [terms]).toLowerCase() !== a.data.toLowerCase() ||
      !terms.triggerBelow ||
      terms.triggerNavE18 <= 0n ||
      terms.deadline > BigInt(plan.status.validUntil) ||
      terms.deadline < BigInt(a.deadline) ||
      terms.maxSlippageBps < 50 ||
      terms.maxSlippageBps > plan.status.maxSlippageBps ||
      terms.maxSlippageBps !== a.slippageBps ||
      terms.fillerFeeBps > 100 ||
      terms.startSlippageBps < 50 ||
      terms.startSlippageBps > terms.maxSlippageBps ||
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
const createdAbi = parseAbi([
  "event OrderCreated(bytes32 indexed id,address indexed recipient,address vault,uint256 amount,uint256 triggerNavE18,bool triggerBelow,uint64 deadline,uint16 maxSlippageBps,uint16 fillerFeeBps)",
]);
/** Read the order ID from a placement receipt, without relying on indexer lag. */
export function limitOrderId(
  logs: readonly { address: string; data: Hex; topics: readonly Hex[] }[],
): Hex | undefined {
  for (const log of logs) {
    if (log.address.toLowerCase() !== LIMIT_ESCROW.toLowerCase()) continue;
    try {
      const event = decodeEventLog({
        abi: createdAbi,
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
