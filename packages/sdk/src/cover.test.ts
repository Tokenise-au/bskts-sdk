import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  BsktsClient,
  BsktsError,
  coverActionState,
  coverTypedData,
  executeCover,
  executeCoverOnce,
  feeMemory,
  schemas,
  type CoverSender,
  type CoverStore,
} from "./index";

const agent = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
const owner = "0x1111111111111111111111111111111111111111" as const;
const account = "0x2222222222222222222222222222222222222222" as const;
const digi64 = "0x63e5dFBEC475b3afA031be9031e73aCdb6F1d559" as const;
const receipt = { hash: `0x${"11".repeat(32)}` as const, blockNumber: 1, gasUsed: 100 };
const opts = () => ({ maxNetworkFeeUsdg: 250_000n, fees: feeMemory() });

const take = (ids: bigint[], cover: bigint[], minCoverUsd: bigint, limit: bigint) =>
  encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "ids", type: "uint256[]" },
          { name: "coverUsd", type: "uint64[]" },
          { name: "minCoverUsd", type: "uint256" },
          { name: "limit", type: "uint256" },
        ],
      },
    ],
    [{ ids, coverUsd: cover, minCoverUsd, limit }],
  );
const request = (vault: `0x${string}`, pricePer1k: bigint, coverUsd = 1000n, week = 2) =>
  encodeAbiParameters(
    [
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
    ],
    [{ week, vault, fromBps: 300, toBps: 1000, coverUsd, pricePer1k }],
  );
const cancelData = encodeAbiParameters([{ type: "uint256" }], [42n]);

const status = {
  owner,
  account,
  key: agent.address,
  chainId: 4663,
  module: schemas.SESSION_MODULE,
  deployed: true,
  moduleEnabled: true,
  coverEnabled: true,
  active: true,
  paused: false,
  usdgWei: "100000000",
  dailyLimitUsdg: "10000000",
  remainingTodayUsdg: "10000000",
  maxSlippageBps: 50,
  validUntil: Math.floor(Date.now() / 1000) + 604800,
  approvalUrl: "https://bskts.xyz/portfolio?tab=agents",
  relayerUrl: "https://bskts.xyz/relay/v1/account/execute",
  revokeEffect: "Cancel existing listings separately.",
};
// $1,000 of -3% to -10% cover from two offers, $8.03 all in (premium + 1% fee)
const takeResponse = {
  intent: "take",
  ticker: "DIGI64",
  week: 2,
  fromBps: 300,
  toBps: 1000,
  summary: { coverUsd: 1000, cost: 8.0295 },
  status,
  coverRemainingTodayUsdg: "10000000",
  module: schemas.COVER_MODULE,
  action: {
    account,
    key: agent.address,
    kind: 0,
    data: take([3n, 2n], [600n, 400n], 1000n, 8_029_500n),
    nonce: "123",
    deadline: Math.floor(Date.now() / 1000) + 300,
    fee: "0",
  },
  typedData: { ignored: true },
  relayerUrl: schemas.COVER_RELAYER_URL,
  simulation: { ok: null, skipped: "Unsigned" },
};
const plan = (over: Record<string, unknown> = {}, action: Record<string, unknown> = {}) =>
  schemas.agentCoverPlan.parse({
    ...takeResponse,
    ...over,
    action: { ...takeResponse.action, ...action },
  });
const sender = (submit: CoverSender["submit"] = async () => receipt): CoverSender => ({
  key: agent.address,
  sign: vi.fn((data) => agent.signTypedData(data)),
  submit: vi.fn(submit),
});
const quote = (fee: string) =>
  new BsktsError("Relayer quoted a network fee", "FEE_REQUIRED", {
    status: 402,
    detail: { ok: false, requiredFee: fee },
  });

describe("cover plans", () => {
  it("parses a take and drops the response's own typed data", () => {
    const p = plan();
    expect(p.action.nonce).toBe(123n);
    expect(p).not.toHaveProperty("typedData");
  });
  it.each([
    [{ intent: "request" }, {}],
    [{}, { kind: 2 }], // an offer: underwriting is not an agent action
    [{}, { kind: 3 }], // a fill
    [
      { intent: "cancel", ticker: undefined },
      { kind: 4, data: cancelData, fee: "1" },
    ],
    [{ module: "0x66a0ba9be3f6779b4f24CE6135Cc93B5559888Da" }, {}],
    [{ relayerUrl: "https://bskts.xyz/relay/v1/account/execute" }, {}],
  ])("refuses %o %o", (over, action) => expect(() => plan(over, action)).toThrow());
  it("pins the cover module's own domain, never the trading module's", () => {
    const t = coverTypedData(plan().action);
    expect(t.domain).toEqual({
      name: "bskts cover",
      version: "1",
      chainId: 4663,
      verifyingContract: schemas.COVER_MODULE,
    });
    expect(t.primaryType).toBe("CoverAction");
  });
});

describe("executeCover", () => {
  it("signs with the host's key and submits once", async () => {
    const s = sender();
    expect(await executeCover(plan(), s, opts())).toEqual(receipt);
    expect(s.sign).toHaveBeenCalledOnce();
    expect(vi.mocked(s.submit).mock.calls[0]![0].action.nonce).toBe(123n);
  });
  it.each([
    ["Cover off", { status: { ...status, coverEnabled: false } }, "SESSION_INACTIVE"],
    ["inactive", { status: { ...status, active: false } }, "SESSION_INACTIVE"],
    ["paused", { status: { ...status, paused: true } }, "SESSION_INACTIVE"],
    ["failed simulation", { simulation: { ok: false, reason: "x" } }, "SIMULATION_FAILED"],
  ])("refuses a plan with %s before signing", async (_, over, code) => {
    const s = sender();
    await expect(executeCover(plan(over), s, opts())).rejects.toMatchObject({ code });
    expect(s.sign).not.toHaveBeenCalled();
  });
  it("refuses a key that isn't the plan's", async () => {
    const s = { ...sender(), key: other.address };
    await expect(executeCover(plan(), s, opts())).rejects.toMatchObject({
      code: "SESSION_INACTIVE",
    });
  });
  it("refuses a take that may cost over 3% of its cover, or buy less than it lists", async () => {
    const dear = plan({}, { data: take([3n], [1000n], 1000n, 30_000_001n) });
    await expect(executeCover(dear, sender(), opts())).rejects.toMatchObject({ code: "POLICY" });
    const exact = plan({}, { data: take([3n], [1000n], 1000n, 30_000_000n) });
    await expect(executeCover(exact, sender(), opts())).resolves.toEqual(receipt);
    const short = plan({}, { data: take([3n], [1000n], 10n, 8_000_000n) });
    await expect(executeCover(short, sender(), opts())).rejects.toMatchObject({
      code: "BAD_RESPONSE",
    });
  });
  it("refuses a request on another basket's vault or over $30 per $1,000", async () => {
    const req = (vault: `0x${string}`, price: bigint) =>
      plan({ intent: "request" }, { kind: 1, data: request(vault, price) });
    await expect(executeCover(req(digi64, 30_000_000n), sender(), opts())).resolves.toEqual(
      receipt,
    );
    await expect(
      executeCover(req("0xC02b7A59846B77d0b1d0cfE8943D32c279ED292a", 5_000_000n), sender(), opts()),
    ).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    await expect(executeCover(req(digi64, 30_010_000n), sender(), opts())).rejects.toMatchObject({
      code: "POLICY",
    });
  });
  it("re-signs only the fee on a 402, same nonce, within the host's cap", async () => {
    const submit = vi
      .fn<CoverSender["submit"]>()
      .mockRejectedValueOnce(quote("40000"))
      .mockResolvedValueOnce(receipt);
    const s = sender(submit);
    await executeCover(plan(), s, opts());
    const [a, b] = submit.mock.calls.map((c) => c[0].action);
    expect(a!.fee).toBe(0n);
    expect(b).toEqual({ ...a, fee: 40_000n });
  });
  it("stops at the host's fee cap", async () => {
    const s = sender(async () => {
      throw quote("300000");
    });
    await expect(executeCover(plan(), s, opts())).rejects.toMatchObject({ code: "POLICY" });
    expect(s.sign).toHaveBeenCalledOnce();
  });
  it("cancels free, even while cover is paused, and never retries a fee", async () => {
    const c = plan(
      { intent: "cancel", ticker: undefined, status: { ...status, paused: true } },
      { kind: 4, data: cancelData },
    );
    const fees = feeMemory();
    fees.set("cover:4", 50_000n);
    const s = sender(async () => {
      throw quote("10000");
    });
    await expect(executeCover(c, s, { maxNetworkFeeUsdg: 250_000n, fees })).rejects.toMatchObject({
      code: "FEE_REQUIRED",
    });
    expect(vi.mocked(s.submit).mock.calls).toHaveLength(1);
    expect(vi.mocked(s.submit).mock.calls[0]![0].action.fee).toBe(0n);
  });
});

describe("client cover", () => {
  const client = (body: unknown, policy = {}) =>
    new BsktsClient({ policy, fetch: async () => new Response(JSON.stringify(body)) });
  const ask = {
    owner,
    key: agent.address,
    action: "take" as const,
    ticker: "DIGI64",
    fromBps: 300,
    toBps: 1000,
    coverUsd: 1000,
  };
  it("returns a plan that matches the request", async () =>
    expect((await client(takeResponse).buildAgentCover(ask)).intent).toBe("take"));
  it.each([
    ["another basket", { ...takeResponse, ticker: "INDEX2" }],
    ["another range", { ...takeResponse, toBps: 1500 }],
    [
      "a partial take nobody allowed",
      {
        ...takeResponse,
        action: { ...takeResponse.action, data: take([3n], [600n], 600n, 4_000_000n) },
      },
    ],
    ["another key", { ...takeResponse, status: { ...status, key: other.address } }],
  ])("refuses %s", async (_, body) =>
    expect(client(body).buildAgentCover(ask)).rejects.toMatchObject({ code: "BAD_RESPONSE" }),
  );
  it("accepts a partial take only when asked for one", async () => {
    const body = {
      ...takeResponse,
      action: { ...takeResponse.action, data: take([3n], [600n], 600n, 4_000_000n) },
    };
    await expect(
      client(body).buildAgentCover({ ...ask, allowPartial: true }),
    ).resolves.toBeDefined();
  });
  it("holds the cost to the policy's maxUsdPerTrade and tickers", async () => {
    await expect(
      client(takeResponse, { maxUsdPerTrade: 5 }).buildAgentCover(ask),
    ).rejects.toMatchObject({ code: "POLICY" });
    await expect(
      client(takeResponse, { allowedTickers: ["INDEX2"] }).buildAgentCover(ask),
    ).rejects.toMatchObject({ code: "POLICY" });
  });
  it("refuses a fee on a cancel before asking the API", async () => {
    const fetch = vi.fn();
    const c = new BsktsClient({ fetch });
    await expect(
      c.buildAgentCover({
        owner,
        key: agent.address,
        action: "cancel",
        listingId: 1n,
        feeUsdg: 1n,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("once-only cover", () => {
  function memory() {
    let record: unknown;
    let result: unknown;
    const json = (v: unknown) =>
      JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
    const store: CoverStore = {
      load: vi.fn(async () => record),
      loadOutcome: vi.fn(async () => result),
      reserve: vi.fn(async (v) => {
        if (record !== undefined) return false;
        record = json(v);
        return true;
      }),
      complete: vi.fn(async (v) => {
        result = json(v);
      }),
    };
    return store;
  }
  it("journals before signing, and a restart reconciles instead of buying again", async () => {
    const store = memory();
    const s = sender(async () => {
      throw new BsktsError("Response lost", "NETWORK");
    });
    const run = {
      store,
      sender: s,
      build: vi.fn(async () => plan()),
      maxNetworkFeeUsdg: 250_000n,
      reconcile: vi.fn(async () => "consumed" as const),
    };
    await expect(executeCoverOnce(run)).rejects.toMatchObject({ code: "NETWORK" });
    const again = { ...run, sender: sender(), build: vi.fn(async () => plan()) };
    expect(await executeCoverOnce(again)).toEqual({ state: "consumed" });
    expect(again.build).not.toHaveBeenCalled();
    expect(again.sender.sign).not.toHaveBeenCalled();
  });
  it("does not run a trade's journal as cover", async () => {
    const store = memory();
    await store.reserve({ version: 1, plan: { ticker: "INDEX2" }, maxNetworkFeeUsdg: 0n } as never);
    await expect(
      executeCoverOnce({
        store,
        sender: sender(),
        build: async () => plan(),
        maxNetworkFeeUsdg: 0n,
        reconcile: async () => "pending",
      }),
    ).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });
});

describe("coverActionState", () => {
  it("reads the cover module's nonces at one block", async () => {
    const readContract = vi.fn(async (_call: unknown) => false);
    const client = {
      getChainId: async () => 4663,
      getBlock: async () => ({ number: 9n, timestamp: 100n }),
      readContract,
    } as unknown as PublicClient;
    expect(await coverActionState(client, { account, nonce: 1n, deadline: 200 })).toBe("pending");
    expect(await coverActionState(client, { account, nonce: 1n, deadline: 50 })).toBe("expired");
    expect(readContract.mock.calls[0]![0]).toMatchObject({
      address: schemas.COVER_MODULE,
      blockNumber: 9n,
    });
  });
});
