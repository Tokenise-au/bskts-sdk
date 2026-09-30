/** Stable error codes: the API's (listed in https://api.bskts.xyz/llms.txt)
 * plus the SDK's own. Branch on these, never on the message. */
export type ErrorCode =
  // from the API
  | "BAD_REQUEST"
  | "UNKNOWN_BASKET"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "NO_ROUTE"
  | "NO_REFERENCE"
  | "ORDER_NOT_OPEN"
  | "INSUFFICIENT_SHARES"
  | "PAUSED"
  | "NOT_IMPLEMENTED"
  | "UPSTREAM"
  | "SERVER"
  // from the SDK
  | "POLICY" // the client's policy refused it; nothing was requested or sent
  | "SIMULATION_FAILED" // the API's dry run reverted; execute() did not send
  | "TX_FAILED" // mined and reverted
  | "BAD_RESPONSE" // the API answered with something the SDK does not understand
  | "NETWORK"; // the request never got an answer

export class BsktsError extends Error {
  override readonly name = "BsktsError";
  constructor(
    message: string,
    readonly code: ErrorCode,
    readonly options: {
      status?: number;
      retryable?: boolean;
      /** the API's body, the failed simulation, or the reverted receipt */
      detail?: unknown;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
  }
  get status() {
    return this.options.status;
  }
  /** true when the same call may succeed later */
  get retryable() {
    return this.options.retryable ?? false;
  }
  get detail() {
    return this.options.detail;
  }
}

export const isBsktsError = (e: unknown): e is BsktsError => e instanceof BsktsError;
