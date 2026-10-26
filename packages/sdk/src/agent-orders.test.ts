import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbi, parseAbiParameters } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  BsktsClient,
  decodeAgentOrder,
  executeSession,
  executeSessionOnce,
  schemas,
  limitOrderId,
  exitOrderId,
  describePreview,
  type AgentTypedData,
} from "./index";
import { exitTermsAbi, limitTermsAbi, LIMIT_ESCROW, SELL_ESCROW } from "./agent-orders";
const agent = privateKeyToAccount(generatePrivateKey());
const owner = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const account = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const vault = "0xC02b7A59846B77d0b1d0cfE8943D32c279ED292a" as `0x${string}`;
const now = Math.floor(Date.now() / 1000);
const id = ("0x" + "ab".repeat(32)) as `0x${string}`;
const terms = {
  triggerNavE18: 98n * 10n ** 18n,
  triggerBelow: true,
  deadline: BigInt(now + 86400),
  maxSlippageBps: 50,
  fillerFeeBps: 100,
  startSlippageBps: 50,
};
// 2026-10-25: the API's preview, as it returns one for this limit
const BASIS = "Triggers are on NAV per share (the 10-minute pool average).";
const limitPreview = {
  kind: "limit",
  basis: BASIS,
  navNow: 100,
  triggerNav: 98,
  direction: "below",
  fromNowPct: -2,
  fillsNow: false,
  worstPricePerShare: 99.48,
  worstFromNowPct: -0.52,
  worstShares: 0.10052,
  costs: { mintFeeBps: 20, fillerFeeBps: 100, maxSlippageBps: 50 },
  notes: [],
};
const response = () => ({
  ticker: "INDEX2",
  status: {
    owner,
    account,
    key: agent.address,
    chainId: 4663,
    module: schemas.SESSION_MODULE,
    deployed: true,
    moduleEnabled: true,
    coverEnabled: false,
    active: true,
    paused: false,
    usdgWei: "20000000",
    dailyLimitUsdg: "10000000",
    remainingTodayUsdg: "10000000",
    maxSlippageBps: 50,
    validUntil: now + 604800,
    approvalUrl: "https://bskts.xyz/account/agents",
    relayerUrl: "https://bskts.xyz/relay/v1/account/execute",
    revokeEffect: "Cancel existing orders separately.",
  },
  action: {
    account,
    key: agent.address,
    kind: 2,
    vault,
    amount: "10000000",
    limit: "0",
    slippageBps: 50,
    data: encodeAbiParameters(limitTermsAbi, [terms]),
    nonce: "123",
    deadline: now + 300,
    fee: "0",
  },
  relayerUrl: "https://bskts.xyz/relay/v1/account/execute",
  simulation: { ok: null, skipped: "Unsigned" },
  preview: limitPreview as Record<string, unknown>,
});
const request = {
  kind: "limit" as const,
  owner,
  key: agent.address,
  ticker: "INDEX2",
  amountUsdg: 10,
  triggerNav: 98,
  expiryDays: 1,
  slippageBps: 50,
};
const receipt = { hash: id, blockNumber: 1, gasUsed: 100 };
const sender = () => ({
  key: agent.address,
  sign: vi.fn((data: AgentTypedData) => agent.signTypedData(data)),
  submit: vi.fn(async () => receipt),
});
const stringify = (x: unknown) =>
  JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));
function api(data = response(), policy = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(stringify(data)));
  return { client: new BsktsClient({ fetch, policy }), fetch };
}
describe("delegated limit SDK", () => {
  it("matches requested budget, trigger and expiry and retains the unsigned plan", async () => {
    const { client, fetch } = api();
    const plan = await client.buildAgentOrder(request);
    expect(decodeAgentOrder(plan)).toMatchObject({
      kind: "limit",
      triggerNavE18: terms.triggerNavE18,
    });
    expect(fetch.mock.calls[0]?.[0]).toContain("/v1/agent/order");
    expect(plan.simulation.ok).toBeNull();
  });
  it.each([
    "budget",
    "trigger",
    "direction",
    "expiry",
    "fee",
    "vault",
    "kind",
    "owner",
    "key",
    "account",
    "trailing",
  ])("refuses substituted %s", async (mode) => {
    const r = response();
    if (mode === "budget") r.action.amount = "11000000";
    if (mode === "trigger")
      r.action.data = encodeAbiParameters(limitTermsAbi, [
        { ...terms, triggerNavE18: 99n * 10n ** 18n },
      ]);
    if (mode === "direction")
      r.action.data = encodeAbiParameters(limitTermsAbi, [{ ...terms, triggerBelow: false }]);
    if (mode === "expiry")
      r.action.data = encodeAbiParameters(limitTermsAbi, [
        { ...terms, deadline: BigInt(now + 604801) },
      ]);
    if (mode === "fee") r.action.fee = "1";
    if (mode === "vault") r.action.vault = owner;
    if (mode === "kind") r.action.kind = 0;
    if (mode === "owner") r.status.owner = account;
    if (mode === "key") r.action.key = owner;
    if (mode === "account") r.action.account = owner;
    if (mode === "trailing") r.action.data = (r.action.data + "00") as typeof r.action.data;
    await expect(api(r).client.buildAgentOrder(request)).rejects.toMatchObject({
      code: "BAD_RESPONSE",
    });
  });
  it("checks host budget and slippage before fetching", async () => {
    for (const policy of [{ maxUsdPerTrade: 9 }, { maxSlippageBps: 25 }]) {
      const { client, fetch } = api(response(), policy);
      await expect(client.buildAgentOrder(request)).rejects.toMatchObject({ code: "POLICY" });
      expect(fetch).not.toHaveBeenCalled();
    }
  });
  // 2026-10-24: the API requires slippage; a missing or out-of-range value fails
  // here instead of as the API's 400
  it.each([undefined, 49, 1001, 50.5])("refuses slippageBps %s before fetching", async (slip) => {
    const { client, fetch } = api();
    await expect(
      client.buildAgentOrder({ ...request, slippageBps: slip as number }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses a plan whose slippage differs from the request", async () => {
    await expect(
      api().client.buildAgentOrder({ ...request, slippageBps: 300 }),
    ).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });
  it("decodes and signs cancellation with no budget or turnover", async () => {
    const r = response();
    r.action.kind = 4;
    r.action.amount = "0";
    r.action.slippageBps = 0;
    r.action.data = encodeAbiParameters([{ type: "bytes32" }], [id]);
    r.status.remainingTodayUsdg = "0";
    r.status.usdgWei = "0";
    r.preview = {
      kind: "cancel",
      basis: BASIS,
      navNow: 100,
      triggerNav: 98,
      direction: "below",
      fromNowPct: -2,
      refundUsdg: 10,
    };
    const p = await api(r).client.buildAgentOrder({
      kind: "cancel",
      owner,
      key: agent.address,
      orderId: id,
    });
    expect(decodeAgentOrder(p)).toEqual({ kind: "cancel", orderId: id });
    const s = sender();
    expect(await executeSession(p, s, { maxNetworkFeeUsdg: 0n, fees: false })).toEqual(receipt);
    expect(s.sign).toHaveBeenCalledOnce();
    await expect(
      api(r).client.buildAgentOrder({
        kind: "cancel",
        owner,
        key: agent.address,
        orderId: ("0x" + "cd".repeat(32)) as typeof id,
      }),
    ).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });
  it("revalidates changed encoded terms before the signer", async () => {
    const p = schemas.agentOrderPlan.parse(response());
    p.action.data = encodeAbiParameters(limitTermsAbi, [{ ...terms, maxSlippageBps: 1000 }]);
    const s = sender();
    await expect(executeSession(p, s, { maxNetworkFeeUsdg: 0n })).rejects.toMatchObject({
      code: "BAD_RESPONSE",
    });
    expect(s.sign).not.toHaveBeenCalled();
  });
  it("journals a limit and reconciles a lost receipt without a replacement", async () => {
    let record: unknown;
    let outcome: unknown;
    const store = {
      load: async () => record,
      loadOutcome: async () => outcome,
      reserve: async (r: unknown) => {
        record = r;
        return true;
      },
      complete: async (r: unknown) => {
        outcome = r;
      },
    };
    const s = sender();
    s.submit = vi.fn(async () => {
      throw new Error("Lost receipt");
    });
    const build = vi.fn(async () => schemas.agentOrderPlan.parse(response()));
    const reconcile = vi.fn(async () => "consumed" as const);
    await expect(
      executeSessionOnce({ store, build, sender: s, reconcile, maxNetworkFeeUsdg: 0n }),
    ).rejects.toMatchObject({ code: "UNCERTAIN" });
    expect(record).toBeDefined();
    expect(
      await executeSessionOnce({ store, build, sender: s, reconcile, maxNetworkFeeUsdg: 0n }),
    ).toEqual({ state: "consumed" });
    expect(build).toHaveBeenCalledOnce();
    expect(s.sign).toHaveBeenCalledOnce();
    expect(s.submit).toHaveBeenCalledOnce();
  });
  it("reads a placement ID only from the pinned escrow event", () => {
    const abi = parseAbi([
      "event OrderCreated(bytes32 indexed id,address indexed recipient,address vault,uint256 amount,uint256 triggerNavE18,bool triggerBelow,uint64 deadline,uint16 maxSlippageBps,uint16 fillerFeeBps)",
    ]);
    const topics = encodeEventTopics({
      abi,
      eventName: "OrderCreated",
      args: { id, recipient: account },
    });
    const data = encodeAbiParameters(
      parseAbiParameters("address,uint256,uint256,bool,uint64,uint16,uint16"),
      [vault, 10_000_000n, terms.triggerNavE18, true, terms.deadline, 50, 100],
    );
    expect(
      limitOrderId([{ address: owner, data, topics: topics as `0x${string}`[] }]),
    ).toBeUndefined();
    expect(limitOrderId([{ address: LIMIT_ESCROW, data, topics: topics as `0x${string}`[] }])).toBe(
      id,
    );
  });
});

// 2026-10-25: exits (Kind.Exit 3 / Kind.CancelExit 5), buy-above limits and previews
describe("delegated exits SDK", () => {
  const exitTerms = {
    stopNavE18: 90n * 10n ** 18n,
    tpNavE18: 110n * 10n ** 18n,
    deadline: BigInt(now + 86400),
    maxSlippageBps: 50,
    fillerFeeBps: 28,
    startSlippageBps: 50,
  };
  const exitPreview = {
    kind: "exit",
    basis: BASIS,
    navNow: 100,
    shares: 1,
    avgEntry: 80,
    breakEvenNav: 80.63,
    triggers: [
      {
        edge: "stop",
        nav: 90,
        fromNowPct: -10,
        priceReturnPct: 12.5,
        estNetReturnPct: 11.6,
        worstNetReturnPct: 11.6,
        estProceedsUsdg: 89.3,
        worstProceedsUsdg: 89.3,
      },
      {
        edge: "takeProfit",
        nav: 110,
        fromNowPct: 10,
        priceReturnPct: 37.5,
        estNetReturnPct: 36.4,
        worstNetReturnPct: 36.4,
        estProceedsUsdg: 109.1,
        worstProceedsUsdg: 109.1,
      },
    ],
    costs: { sellFeeBps: 20, routeCostBps: 30, fillerFeeBps: 28, maxSlippageBps: 50 },
    notes: [],
  };
  const exitResponse = (over: Partial<typeof exitTerms> = {}) => {
    const r = response();
    r.action.kind = 3;
    r.action.amount = (10n ** 18n).toString();
    r.action.data = encodeAbiParameters(exitTermsAbi, [{ ...exitTerms, ...over }]);
    r.preview = exitPreview;
    return r;
  };
  const exit = {
    kind: "exit" as const,
    owner,
    key: agent.address,
    ticker: "INDEX2",
    shares: 10n ** 18n,
    stopNav: 90,
    tpNav: 110,
    expiryDays: 1,
    slippageBps: 50,
  };
  it("matches shares, both edges and slippage, and keeps the preview", async () => {
    const { client, fetch } = api(exitResponse());
    const plan = await client.buildAgentOrder(exit);
    expect(decodeAgentOrder(plan)).toMatchObject({ kind: "exit", ...exitTerms });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      kind: "exit",
      shares: "1000000000000000000",
    });
    expect(plan.preview).toMatchObject({ kind: "exit", avgEntry: 80 });
    const lines = describePreview(plan.preview!);
    expect(lines[1]).toMatch(/^Stop-loss at NAV 90: -10\.00% from now; vs entry \+12\.50% price/);
    expect(lines.at(-1)).toBe(BASIS);
  });
  it.each(["stop", "tp", "shares", "slippage", "crossed", "neither", "preview", "fee"])(
    "refuses a substituted %s",
    async (mode) => {
      const r =
        mode === "stop"
          ? exitResponse({ stopNavE18: 80n * 10n ** 18n })
          : mode === "tp"
            ? exitResponse({ tpNavE18: 0n })
            : mode === "crossed"
              ? exitResponse({ stopNavE18: 120n * 10n ** 18n })
              : mode === "neither"
                ? exitResponse({ stopNavE18: 0n, tpNavE18: 0n })
                : exitResponse();
      if (mode === "shares") r.action.amount = (2n * 10n ** 18n).toString();
      if (mode === "slippage") r.action.slippageBps = 49;
      if (mode === "preview") r.preview = limitPreview;
      // an exit's fee is paid from idle USDG: shares never pay it
      if (mode === "fee") {
        r.status.usdgWei = "0";
        r.action.fee = "1";
      }
      await expect(
        api(r).client.buildAgentOrder({ ...exit, ...(mode === "fee" ? { feeUsdg: 1n } : {}) }),
      ).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    },
  );
  it('accepts the API\'s share count for "max" and applies the host cap to its value', async () => {
    const plan = await api(exitResponse()).client.buildAgentOrder({ ...exit, shares: "max" });
    expect(plan.action.amount).toBe(10n ** 18n);
    // 1 share at NAV 100 is over a 50-dollar cap: known only once the API counted "max"
    await expect(
      api(exitResponse(), { maxUsdPerTrade: 50 }).client.buildAgentOrder({
        ...exit,
        shares: "max",
      }),
    ).rejects.toMatchObject({ code: "POLICY" });
  });
  it("refuses a bad exit before fetching", async () => {
    for (const bad of [
      { stopNav: undefined, tpNav: undefined },
      { stopNav: 110, tpNav: 100 },
      { shares: 0n },
      { slippageBps: 40 },
      { stopNav: -1 },
    ]) {
      const { client, fetch } = api(exitResponse());
      await expect(client.buildAgentOrder({ ...exit, ...bad })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      expect(fetch).not.toHaveBeenCalled();
    }
  });
  it("builds a buy-above limit and refuses one the API turned into a dip buy", async () => {
    const r = response();
    r.action.data = encodeAbiParameters(limitTermsAbi, [{ ...terms, triggerBelow: false }]);
    r.preview = { ...limitPreview, direction: "above", fillsNow: true };
    const plan = await api(r).client.buildAgentOrder({ ...request, triggerBelow: false });
    expect(decodeAgentOrder(plan)).toMatchObject({ triggerBelow: false });
    expect(describePreview(plan.preview!)[0]).toMatch(/^Limit buy when NAV >= 98: -2\.00% from/);
    await expect(
      api(response()).client.buildAgentOrder({ ...request, triggerBelow: false }),
    ).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });
  it("decodes and signs an exit's cancellation, and reads a new exit's ID", async () => {
    const r = response();
    r.action.kind = 5;
    r.action.amount = "0";
    r.action.slippageBps = 0;
    r.action.data = encodeAbiParameters([{ type: "bytes32" }], [id]);
    r.status.remainingTodayUsdg = "0";
    r.preview = {
      kind: "cancel-exit",
      basis: BASIS,
      navNow: null,
      stop: { nav: 90, fromNowPct: null },
      takeProfit: null,
      returnsShares: 1,
      returnsSharesWei: "1000000000000000000",
    };
    const p = await api(r).client.buildAgentOrder({
      kind: "cancel-exit",
      owner,
      key: agent.address,
      orderId: id,
    });
    expect(decodeAgentOrder(p)).toEqual({ kind: "cancel-exit", orderId: id });
    expect(describePreview(p.preview!)[0]).toBe(
      "Cancel an exit (stop NAV 90); 1 shares return to the account.",
    );
    expect(await executeSession(p, sender(), { maxNetworkFeeUsdg: 0n, fees: false })).toEqual(
      receipt,
    );
    // a limit cancellation's plan is not an exit's
    await expect(
      api(r).client.buildAgentOrder({ kind: "cancel", owner, key: agent.address, orderId: id }),
    ).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    const abi = parseAbi([
      "event SellIntentCreated(bytes32 indexed id,address indexed recipient,address vault,uint256 shares,uint256 stopNavE18,uint256 tpNavE18,uint64 deadline,uint16 maxSlippageBps,uint16 fillerFeeBps)",
    ]);
    const topics = encodeEventTopics({
      abi,
      eventName: "SellIntentCreated",
      args: { id, recipient: account },
    }) as `0x${string}`[];
    const data = encodeAbiParameters(
      parseAbiParameters("address,uint256,uint256,uint256,uint64,uint16,uint16"),
      [vault, 10n ** 18n, 90n * 10n ** 18n, 0n, BigInt(now), 50, 28],
    );
    expect(exitOrderId([{ address: LIMIT_ESCROW, data, topics }])).toBeUndefined();
    expect(exitOrderId([{ address: SELL_ESCROW, data, topics }])).toBe(id);
  });
  it("still executes a plan journalled before previews existed", async () => {
    const { preview: _, ...old } = response();
    const p = schemas.agentOrderPlan.parse(old);
    expect(await executeSession(p, sender(), { maxNetworkFeeUsdg: 0n, fees: false })).toEqual(
      receipt,
    );
  });
});
