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
  type AgentTypedData,
} from "./index";
import { limitTermsAbi, LIMIT_ESCROW } from "./agent-orders";
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
});
const request = {
  kind: "limit" as const,
  owner,
  key: agent.address,
  ticker: "INDEX2",
  amountUsdg: 10,
  triggerNav: 98,
  expiryDays: 1,
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
  it("checks host budget before fetching and resolved slippage afterwards", async () => {
    const { client, fetch } = api(response(), { maxUsdPerTrade: 9 });
    await expect(client.buildAgentOrder(request)).rejects.toMatchObject({ code: "POLICY" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      api(response(), { maxSlippageBps: 25 }).client.buildAgentOrder(request),
    ).rejects.toMatchObject({ code: "POLICY" });
  });
  it("decodes and signs cancellation with no budget or turnover", async () => {
    const r = response();
    r.action.kind = 4;
    r.action.amount = "0";
    r.action.slippageBps = 0;
    r.action.data = encodeAbiParameters([{ type: "bytes32" }], [id]);
    r.status.remainingTodayUsdg = "0";
    r.status.usdgWei = "0";
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
