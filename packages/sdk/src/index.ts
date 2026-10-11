/**
 * @bskts/sdk: typed, non-custodial client for the bskts API
 * (https://api.bskts.xyz), tokenized index baskets on Robinhood Chain.
 *
 * Reads return data validated against Zod schemas; build* methods return
 * UNSIGNED wallet plans ({ approval, tx, simulation }) that your wallet signs, through
 * execute() and a viem Sender. Agent plans use a host SessionSender and relayer.
 * The SDK never holds private keys or funds.
 */
export { robinhood } from "viem/chains";
export { BsktsClient, DEFAULT_API_URL } from "./client";
export type { BsktsClientOptions, OrderArgs, SharesArg } from "./client";
export { execute, viemSender } from "./execute";
export type { ExecuteResult, Sender } from "./execute";
export { BsktsError, isBsktsError } from "./errors";
export type { ErrorCode } from "./errors";
export { checkPolicy, policyFromEnv } from "./policy";
export type { Policy } from "./policy";
export * as schemas from "./schemas";
export type * from "./schemas";

/** USDG, the dollar token baskets are bought and sold for (6 decimals). */
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
export {
  agentTypedData,
  executeSession,
  feeKey,
  feeMemory,
  sessionRelayer,
  SESSION_ACTION_TYPES,
} from "./agent";
export type { AgentTypedData, FeeMemory, SessionSender } from "./agent";
export { executeSessionOnce, sessionActionState } from "./session-once";
export type { SessionStore, SessionPending, SessionOutcome } from "./session-once";
export {
  COVER_ACTION_TYPES,
  checkCoverPlan,
  coverActionState,
  coverCommits,
  coverFeeKey,
  coverRelayer,
  coverTypedData,
  decodeCoverAction,
  executeCover,
  executeCoverOnce,
} from "./cover";
export type { CoverPending, CoverSender, CoverStore, CoverTypedData } from "./cover";
export type { JournalStore } from "./session-once";
export type { RelayerOptions } from "./agent";
