import type {
  Account,
  Chain,
  Hex,
  PublicClient,
  TransactionReceipt,
  Transport,
  WalletClient,
} from "viem";
import { BsktsError } from "./errors";
import type { TxPlan, TxRequest } from "./schemas";

/** Sends a transaction and waits for it. viemSender() builds one from viem
 * clients; implement it yourself for ethers or any other signer. */
export interface Sender {
  send(tx: TxRequest): Promise<Hex>;
  /** resolves when mined; throws when it reverted */
  wait(hash: Hex): Promise<TransactionReceipt | void>;
}

/** A Sender over viem clients. The wallet client must carry its account and
 * chain (`createWalletClient({ account, chain: robinhood, transport })`); in a
 * browser, `transport: custom(window.ethereum)`. */
export function viemSender(
  walletClient: WalletClient<Transport, Chain, Account>,
  publicClient: Pick<PublicClient, "waitForTransactionReceipt">,
): Sender {
  return {
    send: (tx) =>
      walletClient.sendTransaction({
        account: walletClient.account,
        chain: walletClient.chain,
        to: tx.to,
        data: tx.data,
        value: tx.value,
      }),
    wait: async (hash) => {
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success")
        throw new BsktsError(`transaction ${hash} reverted`, "TX_FAILED", { detail: receipt });
      return receipt;
    },
  };
}

export interface ExecuteResult {
  /** the action's transaction */
  hash: Hex;
  /** the approval sent first, when the plan needed one */
  approvalHash?: Hex;
  /** the action's receipt, when `wait` was set */
  receipt?: TransactionReceipt;
}

/** Submit a plan: its approval (if any) first, waited on until mined, then its
 * tx. Refuses (SIMULATION_FAILED) a plan whose API dry run reverted, unless
 * `force`. `wait: true` also waits for the action (TX_FAILED if it reverted). */
export async function execute(
  plan: TxPlan,
  sender: Sender,
  opts: { wait?: boolean; force?: boolean } = {},
): Promise<ExecuteResult> {
  if (plan.simulation?.ok === false && !opts.force)
    throw new BsktsError(
      `the API's dry run of this transaction reverted (${plan.simulation.reason}); not sending it`,
      "SIMULATION_FAILED",
      { detail: plan.simulation },
    );
  const out: ExecuteResult = { hash: "0x" };
  if (plan.approval) {
    // The action must wait: sent before its approval is mined, it fails its gas estimate.
    out.approvalHash = await sender.send({ ...plan.approval, value: 0n });
    await sender.wait(out.approvalHash);
  }
  out.hash = await sender.send(plan.tx);
  if (opts.wait) {
    const receipt = await sender.wait(out.hash);
    if (receipt) out.receipt = receipt;
  }
  return out;
}
