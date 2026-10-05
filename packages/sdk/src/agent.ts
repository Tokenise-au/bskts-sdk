import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import { BsktsError, type ErrorCode } from "./errors";
import { isAgentVault } from "./agent-vaults";
import {
  SESSION_MODULE,
  sessionReceipt,
  type AgentTradePlan,
  type SessionAction,
  type SessionReceipt,
} from "./schemas";

// 2026-10-02: reconstruct this locally rather than trusting server-supplied
// types/domain. Only buy/sell Actions can reach the host's delegated signer.
export const SESSION_ACTION_TYPES = {
  Action: [
    { name: "account", type: "address" },
    { name: "key", type: "address" },
    { name: "kind", type: "uint8" },
    { name: "vault", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "limit", type: "uint256" },
    { name: "slippageBps", type: "uint16" },
    { name: "data", type: "bytes" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint48" },
    { name: "fee", type: "uint256" },
  ],
} as const;
export function agentTypedData(action: SessionAction) {
  return {
    domain: {
      name: "bskts account",
      version: "1",
      chainId: 4663,
      verifyingContract: SESSION_MODULE,
    },
    types: SESSION_ACTION_TYPES,
    primaryType: "Action",
    message: action,
  } as const;
}
export type AgentTypedData = ReturnType<typeof agentTypedData>;
/** The agent host owns this signer. Pass callbacks, never a private key. */
export interface SessionSender {
  key: Address;
  sign(typedData: AgentTypedData): Promise<Hex>;
  submit(body: { action: SessionAction; signature: Hex }): Promise<SessionReceipt>;
}
/** POST already-signed Actions; this adapter never receives signing material.
 * A timeout is an uncertain submission: it is never retried automatically. */
export function sessionRelayer(
  options: { url?: string; fetch?: typeof fetch; timeoutMs?: number } = {},
): SessionSender["submit"] {
  const url = options.url ?? "https://bskts.xyz/relay/v1/account/execute";
  const endpoint = new URL(url);
  if (
    endpoint.protocol !== "https:" &&
    !(
      endpoint.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
    )
  )
    throw new BsktsError("Relayer must use HTTPS (HTTP allowed only on localhost).", "BAD_REQUEST");
  const request = options.fetch ?? ((input, init) => fetch(input, init));
  return async (body) => {
    let response: Response;
    try {
      response = await request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
    } catch {
      throw new BsktsError(
        "Relayer response was not received. Check this action nonce on chain before resubmitting; do not build a replacement trade.",
        "NETWORK",
      );
    }
    const out = await response.json().catch(() => undefined);
    if (!response.ok) {
      // 2026-10-03: every refusal read "Relayer refused the signed action." and
      // a 429 came back as TX_FAILED ("mined and reverted"), so hosts could not
      // tell a fee quote, a rate limit, a revert reason or a lost send apart.
      // The relayer refuses (4xx, and 503 for its gas budget) before sending; an
      // unexpected 5xx, or the proxy's 502/504, may come after the broadcast.
      const error = (out as { error?: unknown } | undefined)?.error;
      const reason = typeof error === "string" ? error.slice(0, 300) : `HTTP ${response.status}`;
      const status = response.status;
      const [code, retryable, message]: [ErrorCode, boolean, string] =
        status === 402
          ? ["FEE_REQUIRED", false, `Relayer quoted a network fee: ${reason}`]
          : status === 429
            ? ["RATE_LIMITED", true, `Relayer rate limit; nothing was sent: ${reason}`]
            : status < 500 || status === 503
              ? ["REFUSED", status === 503, `Relayer refused the signed action: ${reason}`]
              : [
                  "UNCERTAIN",
                  false,
                  `Relayer failed and may have sent the action (${reason}). Check this action nonce on chain before resubmitting; do not build a replacement trade.`,
                ];
      throw new BsktsError(message, code, { status, retryable, detail: out });
    }
    const parsed = sessionReceipt.safeParse(out);
    if (!parsed.success)
      throw new BsktsError(
        "Relayer returned an invalid receipt. Check the nonce before retrying.",
        "BAD_RESPONSE",
      );
    return parsed.data;
  };
}
/** Where executeSession keeps the network fee each kind of trade last needed.
 * A plain Map<string, bigint> works; pass your own to share it across
 * processes or keep it over restarts. */
export interface FeeMemory {
  get(key: string): bigint | undefined;
  set(key: string, fee: bigint): unknown;
}
/** In memory, forgotten after `ttlMs` (the app's six hours by default). */
export function feeMemory(ttlMs = 6 * 3_600_000): FeeMemory {
  const fees = new Map<string, { fee: bigint; at: number }>();
  return {
    get: (key) => {
      const v = fees.get(key);
      return v && Date.now() - v.at < ttlMs ? v.fee : undefined;
    },
    set: (key, fee) => fees.set(key, { fee, at: Date.now() }),
  };
}
const processFees = feeMemory();
/** Gas, and so the fee, follows the kind of trade and the basket's routes. */
export const feeKey = (action: Pick<SessionAction, "kind" | "vault">) =>
  `${action.kind}:${action.vault.toLowerCase()}`;

/** Execute using the caller's delegated signer and transport. Authority is
 * never granted/renewed here. Fee retries retain the identical action nonce
 * and terms, and require an explicit host fee ceiling in USDG base units.
 * `fees` (default: this process's memory; false: none) signs with the fee this
 * kind of trade last needed, so a repeat trade is usually one signature. */
export async function executeSession(
  plan: AgentTradePlan,
  sender: SessionSender,
  options: { maxNetworkFeeUsdg: bigint; fees?: FeeMemory | false },
): Promise<SessionReceipt> {
  const maxFee = options.maxNetworkFeeUsdg;
  // 2026-10-05: hosts can pass parsed plans directly, or mutate a client plan.
  // Recheck the reviewed vault binding before any signer callback runs.
  if (!isAgentVault(plan.ticker, plan.action.vault))
    throw new BsktsError(
      "Action vault does not match the reviewed basket address.",
      "BAD_RESPONSE",
    );
  const fees = options.fees === false ? undefined : (options.fees ?? processFees);
  if (maxFee < 0n || maxFee > 10_000_000n)
    throw new BsktsError("Set a network fee ceiling between $0 and $10.", "POLICY");
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (
    !same(sender.key, plan.action.key) ||
    !same(plan.status.key, plan.action.key) ||
    !same(plan.status.account, plan.action.account) ||
    !plan.status.active ||
    !plan.status.deployed ||
    !plan.status.moduleEnabled ||
    plan.status.paused
  )
    throw new BsktsError(
      "A matching active owner-approved session is required.",
      "SESSION_INACTIVE",
    );
  if (plan.simulation.ok === false)
    throw new BsktsError("Plan simulation failed; not signing.", "SIMULATION_FAILED");
  if (plan.action.slippageBps > plan.status.maxSlippageBps)
    throw new BsktsError("Slippage exceeds owner permission.", "POLICY");
  let action = { ...plan.action };
  // 2026-10-03: signing fee 0 always drew a 402 quote, then a second signature
  // and a second full relayer check (~1-2 s each). The app has started from
  // the last fee it needed since 2026-09-26; the relayer accepts from the cost
  // to 1.5x its quote, so a remembered fee usually passes as gas drifts, and a
  // stale one just falls back to the quote. Only a fee the plan left at 0, and
  // never one above the host's cap.
  const key = feeKey(action);
  const remembered = fees?.get(key);
  if (action.fee === 0n && remembered !== undefined && remembered <= maxFee)
    action = { ...action, fee: remembered };
  for (let attempt = 0; attempt < 4; attempt++) {
    if (action.fee > maxFee)
      throw new BsktsError("Network fee exceeds the host's fee ceiling; not signing.", "POLICY");
    if (
      action.deadline <= Math.floor(Date.now() / 1000) ||
      action.deadline > plan.status.validUntil
    )
      throw new BsktsError(
        "Plan expired; rebuild only if it was never submitted.",
        "SESSION_INACTIVE",
      );
    const typedData = agentTypedData(action);
    const signature = await sender.sign(typedData);
    if (!same(await recoverTypedDataAddress({ ...typedData, signature }), sender.key))
      throw new BsktsError("Signer returned a signature from a different key.", "BAD_RESPONSE");
    try {
      const receipt = await sender.submit({ action, signature });
      // the relayer quotes on success too: the memory follows gas down as well
      if (receipt.requiredFee !== undefined) fees?.set(key, receipt.requiredFee);
      return receipt;
    } catch (e) {
      if (
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
