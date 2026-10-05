import { parseAbi, type PublicClient } from "viem";
import { z } from "zod";
import { executeSession, type SessionSender } from "./agent";
import { BsktsError } from "./errors";
import {
  agentTradePlan,
  sessionReceipt,
  SESSION_MODULE,
  wei,
  type AgentTradePlan,
  type SessionAction,
} from "./schemas";

const pending = z.object({
  version: z.literal(1),
  plan: agentTradePlan,
  maxNetworkFeeUsdg: wei.refine((n) => n <= 10_000_000n),
});
const outcome = z.discriminatedUnion("state", [
  z.object({ state: z.literal("confirmed"), receipt: sessionReceipt }),
  z.object({ state: z.literal("consumed") }),
  z.object({ state: z.literal("expired") }),
]);
export type SessionPending = z.infer<typeof pending>;
export type SessionOutcome = z.infer<typeof outcome>;
/** One durable store per logical trade. reserve must exclusively create the
 * record, durably, before returning true. Never store keys or signatures.
 * Records and outcomes are retained: a completed operation is never rerun. */
export interface SessionStore {
  load(): Promise<unknown | undefined>;
  loadOutcome(): Promise<unknown | undefined>;
  reserve(record: SessionPending): Promise<boolean>;
  complete(result: SessionOutcome): Promise<void>;
}
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  // Parsed plans have bigints; disk records have integer strings. Normalise
  // both through the same response schemas before trusting a journal.
  let input: unknown;
  try {
    input =
      value === undefined
        ? undefined
        : JSON.parse(JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  } catch {
    throw new BsktsError(
      "Invalid session journal; retain it before reconciliation.",
      "BAD_RESPONSE",
    );
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new BsktsError(
      "Invalid session journal; do not remove it or replace the trade before reconciliation.",
      "BAD_RESPONSE",
    );
  return parsed.data;
};
const nonceAbi = parseAbi(["function nonceUsed(address,uint256) view returns (bool)"]);
/** Read-only reconciliation at one Robinhood Chain block. An unused nonce is
 * still pending until the chain's timestamp is strictly past its deadline.
 * No signature or resubmission is made here. */
export async function sessionActionState(
  client: Pick<PublicClient, "getChainId" | "getBlock" | "readContract">,
  action: Pick<SessionAction, "account" | "nonce" | "deadline">,
): Promise<"pending" | "consumed" | "expired"> {
  if ((await client.getChainId()) !== 4663)
    throw new BsktsError("Reconciliation requires Robinhood Chain (4663).", "BAD_RESPONSE");
  const block = await client.getBlock({ blockTag: "latest" });
  if (block.number === null)
    throw new BsktsError("Reconciliation block is not mined.", "BAD_RESPONSE");
  const used = await client.readContract({
    address: SESSION_MODULE,
    abi: nonceAbi,
    functionName: "nonceUsed",
    args: [action.account, action.nonce],
    blockNumber: block.number,
  });
  return used ? "consumed" : block.timestamp > BigInt(action.deadline) ? "expired" : "pending";
}

/** Execute one logical trade at most once. A restart reconciles the stored
 * nonce, and never signs, resubmits or builds a replacement. Use a new store
 * only for a deliberate new trade after resolving the previous operation. */
export async function executeSessionOnce(options: {
  store: SessionStore;
  build(): Promise<AgentTradePlan>;
  sender: SessionSender;
  maxNetworkFeeUsdg: bigint;
  reconcile(plan: AgentTradePlan): Promise<"pending" | "consumed" | "expired">;
}): Promise<SessionOutcome> {
  const { store, sender } = options;
  let saved = await store.load();
  let fresh = false;
  if (saved === undefined) {
    if ((await store.loadOutcome()) !== undefined)
      throw new BsktsError(
        "Session outcome has no matching journal; do not build a replacement.",
        "BAD_RESPONSE",
      );
    const record = parse(pending, {
      version: 1,
      plan: await options.build(),
      maxNetworkFeeUsdg: options.maxNetworkFeeUsdg,
    });
    // 2026-10-05: both starters lost the nonce on timeout, and npm start made
    // another buy. A competing process may reserve first; only its plan wins.
    fresh = await store.reserve(record);
    saved = fresh ? record : await store.load();
  }
  const record = parse(pending, saved);
  if (record.plan.action.key.toLowerCase() !== sender.key.toLowerCase())
    throw new BsktsError(
      "Journal belongs to another signing key; do not replace it.",
      "BAD_RESPONSE",
    );
  const completed = await store.loadOutcome();
  if (completed !== undefined) return parse(outcome, completed);
  const nonce = record.plan.action.nonce.toString();
  if (!fresh) {
    const state = await options.reconcile(record.plan);
    if (state !== "consumed" && state !== "expired")
      throw new BsktsError(
        `Action nonce ${nonce} for account ${record.plan.action.account} is unresolved. No replacement or resubmission was made. Restart to recheck; retain the journal.`,
        "UNCERTAIN",
      );
    const result = { state };
    await store.complete(result);
    return result;
  }
  try {
    const receipt = await executeSession(record.plan, sender, {
      maxNetworkFeeUsdg: record.maxNetworkFeeUsdg,
    });
    const result = parse(outcome, { state: "confirmed", receipt });
    await store.complete(result);
    return result;
  } catch (e) {
    // The record survives even a signer, storage or transport failure. Absence
    // of a receipt is not evidence that nothing reached the relayer.
    throw new BsktsError(
      `Action nonce ${nonce} for account ${record.plan.action.account} remains recorded. Restart to reconcile it before any new trade.`,
      e instanceof BsktsError ? e.code : "UNCERTAIN",
      { cause: e },
    );
  }
}
