import {
  decodeAbiParameters,
  parseAbi,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { feeMemory, signedPoster, type FeeMemory, type RelayerOptions } from "./agent";
import { isAgentVault } from "./agent-vaults";
import { BsktsError } from "./errors";
import {
  COVER_KINDS,
  COVER_MODULE,
  COVER_RELAYER_URL,
  agentCoverPlan,
  type AgentCoverPlan,
  type CoverAction,
  type SessionReceipt,
} from "./schemas";
import { journalOf, runOnce, type JournalStore, type SessionOutcome } from "./session-once";

// Weekend Cover for agents (2026-10-11): BUYING cover on a basket the account
// holds, from the same owner-approved session key that trades. The plan comes
// from POST /v1/agent/cover; this signs nothing itself. As with trades the
// typed data is rebuilt here, never taken from the response, and pinned to
// BsktsCoverModule's own domain ("bskts cover"), so a cover signature can never
// run as a trade or the other way round. The module bounds what a stolen key can
// do (premium + fee at most 3% of the cover, cover's own daily limit, holders
// only); the checks below refuse a plan that would break those bounds before the
// host's signer is ever asked.

export const COVER_ACTION_TYPES = {
  CoverAction: [
    { name: "account", type: "address" },
    { name: "key", type: "address" },
    { name: "kind", type: "uint8" },
    { name: "data", type: "bytes" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint48" },
    { name: "fee", type: "uint256" },
  ],
} as const;
export function coverTypedData(action: CoverAction) {
  return {
    domain: { name: "bskts cover", version: "1", chainId: 4663, verifyingContract: COVER_MODULE },
    types: COVER_ACTION_TYPES,
    primaryType: "CoverAction",
    message: action,
  } as const;
}
export type CoverTypedData = ReturnType<typeof coverTypedData>;

/** The agent host owns this signer, the same key as its SessionSender. */
export interface CoverSender {
  key: Address;
  sign(typedData: CoverTypedData): Promise<Hex>;
  submit(body: { action: CoverAction; signature: Hex }): Promise<SessionReceipt>;
}
/** POST already-signed cover actions to the relayer's cover route. A timeout
 * is an uncertain submission: it is never retried automatically. */
export function coverRelayer(options: RelayerOptions = {}): CoverSender["submit"] {
  return signedPoster(options, COVER_RELAYER_URL);
}

const MAX_PREMIUM_BPS = 300n;
const BPS = 10_000n;
const ONE = 1_000_000n;
const batchAbi = [
  {
    type: "tuple",
    components: [
      { name: "ids", type: "uint256[]" },
      { name: "coverUsd", type: "uint64[]" },
      { name: "minCoverUsd", type: "uint256" },
      { name: "limit", type: "uint256" },
    ],
  },
] as const;
const listingAbi = [
  {
    type: "tuple",
    components: [
      { name: "week", type: "uint32" },
      { name: "vault", type: "address" },
      { name: "fromBps", type: "uint16" },
      { name: "toBps", type: "uint16" },
      { name: "coverUsd", type: "uint64" },
      { name: "pricePer1k", type: "uint128" },
    ],
  },
] as const;

/** What a cover action's data commits to, decoded. Throws BAD_RESPONSE on data
 * that doesn't decode as its kind. */
export function decodeCoverAction(action: Pick<CoverAction, "kind" | "data">) {
  try {
    if (action.kind === COVER_KINDS.take) {
      const [b] = decodeAbiParameters(batchAbi, action.data);
      return { kind: "take" as const, ...b };
    }
    if (action.kind === COVER_KINDS.request) {
      const [l] = decodeAbiParameters(listingAbi, action.data);
      return { kind: "request" as const, ...l };
    }
    const [id] = decodeAbiParameters([{ type: "uint256" }], action.data);
    return { kind: "cancel" as const, listingId: id };
  } catch {
    throw new BsktsError("Cover action data does not decode as its kind.", "BAD_RESPONSE");
  }
}

/** The bounds the module enforces, checked on the plan itself: a take may cost
 * (its limit) at most 3% of the cover it buys, and buys all of it; a request
 * offers at most $30 per $1,000, on the reviewed vault of its basket. A plan
 * that fails here is never signed, whatever the API said. */
export function checkCoverPlan(plan: AgentCoverPlan) {
  const d = decodeCoverAction(plan.action);
  if (d.kind !== plan.intent)
    throw new BsktsError("Cover action does not match its intent.", "BAD_RESPONSE");
  if (d.kind === "take") {
    if (d.ids.length === 0 || d.ids.length !== d.coverUsd.length)
      throw new BsktsError("Cover take lists no offers.", "BAD_RESPONSE");
    const cover = d.coverUsd.reduce((a, c) => a + c, 0n);
    if (d.minCoverUsd !== cover)
      throw new BsktsError("Cover take may buy less than it lists.", "BAD_RESPONSE");
    if (d.limit * BPS > cover * ONE * MAX_PREMIUM_BPS)
      throw new BsktsError("Cover take may cost more than 3% of the cover.", "POLICY");
  } else if (d.kind === "request") {
    if (!plan.ticker || !isAgentVault(plan.ticker, d.vault))
      throw new BsktsError(
        "Cover request vault does not match the reviewed basket address.",
        "BAD_RESPONSE",
      );
    if (d.pricePer1k > (ONE * 1000n * MAX_PREMIUM_BPS) / BPS)
      throw new BsktsError("Cover request offers more than 3% of the cover.", "POLICY");
    if (plan.week !== undefined && d.week !== plan.week)
      throw new BsktsError("Cover request week does not match the plan.", "BAD_RESPONSE");
    if (plan.fromBps !== undefined && (d.fromBps !== plan.fromBps || d.toBps !== plan.toBps))
      throw new BsktsError("Cover request range does not match the plan.", "BAD_RESPONSE");
  }
  return d;
}
/** What the action commits from the account, in USDG base units: a take's
 * cost limit, a request's locked premium; a cancel commits nothing. */
export function coverCommits(plan: AgentCoverPlan): bigint {
  const d = decodeCoverAction(plan.action);
  if (d.kind === "take") return d.limit;
  if (d.kind === "request") return (d.pricePer1k * d.coverUsd) / 1000n;
  return 0n;
}

const processFees = feeMemory();
/** The relayer's fee follows the kind of action (the app keeps the same keys). */
export const coverFeeKey = (action: Pick<CoverAction, "kind">) => `cover:${action.kind}`;

/** Execute a cover plan with the host's signer and transport. Never grants or
 * renews authority. Take and request repay their gas: a 402 quote is re-signed
 * with only the fee changed (same nonce and terms), within the host's explicit
 * ceiling. Cancels are free and never carry a fee. */
export async function executeCover(
  plan: AgentCoverPlan,
  sender: CoverSender,
  options: { maxNetworkFeeUsdg: bigint; fees?: FeeMemory | false },
): Promise<SessionReceipt> {
  const maxFee = options.maxNetworkFeeUsdg;
  if (maxFee < 0n || maxFee > 10_000_000n)
    throw new BsktsError("Set a network fee ceiling between $0 and $10.", "POLICY");
  // hosts can pass parsed plans directly, or mutate one: recheck before signing
  const parsed = agentCoverPlan.safeParse(
    JSON.parse(JSON.stringify(plan, (_, v) => (typeof v === "bigint" ? v.toString() : v))),
  );
  if (!parsed.success) throw new BsktsError("Invalid cover plan; not signing.", "BAD_RESPONSE");
  checkCoverPlan(plan);
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const s = plan.status;
  const cancel = plan.intent === "cancel";
  if (
    !same(sender.key, plan.action.key) ||
    !same(s.key, plan.action.key) ||
    !same(s.account, plan.action.account) ||
    !s.active ||
    !s.deployed ||
    !s.coverEnabled ||
    // a pause stops buying, never a cancel (it only returns the account's money)
    (s.paused && !cancel)
  )
    throw new BsktsError(
      "A matching active owner-approved session with Cover enabled is required.",
      "SESSION_INACTIVE",
    );
  if (plan.simulation.ok === false)
    throw new BsktsError("Plan simulation failed; not signing.", "SIMULATION_FAILED");
  const fees = cancel || options.fees === false ? undefined : (options.fees ?? processFees);
  let action = { ...plan.action };
  const key = coverFeeKey(action);
  const remembered = fees?.get(key);
  if (!cancel && action.fee === 0n && remembered !== undefined && remembered <= maxFee)
    action = { ...action, fee: remembered };
  for (let attempt = 0; attempt < 4; attempt++) {
    if (action.fee > maxFee)
      throw new BsktsError("Network fee exceeds the host's fee ceiling; not signing.", "POLICY");
    if (action.deadline <= Math.floor(Date.now() / 1000) || action.deadline > s.validUntil)
      throw new BsktsError(
        "Plan expired; rebuild only if it was never submitted.",
        "SESSION_INACTIVE",
      );
    const typedData = coverTypedData(action);
    const signature = await sender.sign(typedData);
    if (!same(await recoverTypedDataAddress({ ...typedData, signature }), sender.key))
      throw new BsktsError("Signer returned a signature from a different key.", "BAD_RESPONSE");
    try {
      const receipt = await sender.submit({ action, signature });
      if (receipt.requiredFee !== undefined) fees?.set(key, receipt.requiredFee);
      return receipt;
    } catch (e) {
      if (
        cancel ||
        !(e instanceof BsktsError) ||
        e.code !== "FEE_REQUIRED" ||
        e.status !== 402 ||
        attempt === 3
      )
        throw e;
      const quote = e.detail as { requiredFee?: unknown } | undefined;
      if (!quote || typeof quote.requiredFee !== "string" || !/^\d+$/.test(quote.requiredFee))
        throw new BsktsError("Invalid relayer fee quote; not retrying.", "BAD_RESPONSE");
      const fee = BigInt(quote.requiredFee);
      fees?.set(key, fee);
      if (fee === action.fee) throw e;
      action = { ...action, fee };
    }
  }
  throw new BsktsError("Fee retries exhausted.", "TX_FAILED");
}

const nonceAbi = parseAbi(["function nonceUsed(address,uint256) view returns (bool)"]);
/** Read-only reconciliation of a cover action at one Robinhood Chain block, on
 * the COVER module's nonces (a trade's are the session module's). An unused
 * nonce is pending until the chain's time is strictly past its deadline. */
export async function coverActionState(
  client: Pick<PublicClient, "getChainId" | "getBlock" | "readContract">,
  action: Pick<CoverAction, "account" | "nonce" | "deadline">,
): Promise<"pending" | "consumed" | "expired"> {
  if ((await client.getChainId()) !== 4663)
    throw new BsktsError("Reconciliation requires Robinhood Chain (4663).", "BAD_RESPONSE");
  const block = await client.getBlock({ blockTag: "latest" });
  if (block.number === null)
    throw new BsktsError("Reconciliation block is not mined.", "BAD_RESPONSE");
  const used = await client.readContract({
    address: COVER_MODULE,
    abi: nonceAbi,
    functionName: "nonceUsed",
    args: [action.account, action.nonce],
    blockNumber: block.number,
  });
  return used ? "consumed" : block.timestamp > BigInt(action.deadline) ? "expired" : "pending";
}

const coverPending = journalOf(agentCoverPlan);
export type CoverPending = { version: 1; plan: AgentCoverPlan; maxNetworkFeeUsdg: bigint };
export type CoverStore = JournalStore<CoverPending>;

/** Execute one cover action at most once, as executeSessionOnce does for
 * trades: the unsigned plan is journalled before signing, and a restart only
 * reconciles its nonce (coverActionState), never signs, resubmits or builds a
 * replacement. Node: fileSessionStore<CoverPending> from @bskts/sdk/node. */
export function executeCoverOnce(options: {
  store: CoverStore;
  build(): Promise<AgentCoverPlan>;
  sender: CoverSender;
  maxNetworkFeeUsdg: bigint;
  reconcile(plan: AgentCoverPlan): Promise<"pending" | "consumed" | "expired">;
}): Promise<SessionOutcome> {
  return runOnce({
    store: options.store,
    schema: coverPending,
    build: options.build,
    signerKey: options.sender.key,
    maxNetworkFeeUsdg: options.maxNetworkFeeUsdg,
    reconcile: options.reconcile,
    run: (plan, maxNetworkFeeUsdg) => executeCover(plan, options.sender, { maxNetworkFeeUsdg }),
  });
}
