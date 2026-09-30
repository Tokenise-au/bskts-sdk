import type { Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { BsktsClient, BsktsError, execute, policyFromEnv, type Sender, type TxPlan } from "./index";

const ADDR = "0x000000000000000000000000000000000000dEaD" as const;
const reply = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));
const client = (body: unknown, status = 200, policy = {}) =>
  new BsktsClient({ fetch: () => reply(body, status), policy });
const never = () => Promise.reject(new Error("no request expected"));

const plan = (over: Partial<TxPlan> = {}): TxPlan => ({
  approval: null,
  tx: { to: ADDR, data: "0x1234", value: 0n },
  ...over,
});
const sender = () => {
  const sent: string[] = [];
  const s: Sender = {
    send: async (tx) => {
      sent.push(tx.to);
      return `0x${sent.length}` as Hex;
    },
    wait: vi.fn(async () => undefined),
  };
  return { s, sent };
};

describe("responses", () => {
  it("parses on-chain amounts into bigints and keeps dollars as numbers", async () => {
    const w = await client({
      address: ADDR,
      chainId: 4663,
      eth: 0.01,
      ethWei: "10000000000000000",
      usdg: 12.5,
      usdgWei: "12500000",
      holdings: [{ ticker: "DIGI64", sharesWei: "236670514877425866" }],
      tradeGasEth: 0.0001,
      gasOk: true,
    }).wallet(ADDR);
    expect(w.usdgWei).toBe(12_500_000n);
    expect(w.holdings[0]!.sharesWei).toBe(236670514877425866n);
    expect(w.usdg).toBe(12.5);
  });
  it("turns an unexpected shape into BAD_RESPONSE, not undefined", async () => {
    const e = await client({ address: ADDR, positions: [{ ticker: "X" }] })
      .positions(ADDR)
      .catch((x) => x);
    expect(e).toBeInstanceOf(BsktsError);
    expect(e.code).toBe("BAD_RESPONSE");
  });
  it("carries the API's error code and retryable flag", async () => {
    const e = await client({ error: "no route", code: "NO_ROUTE", retryable: false }, 422)
      .basket("X")
      .catch((x) => x);
    expect([e.code, e.status, e.retryable]).toEqual(["NO_ROUTE", 422, false]);
  });
  it("treats an uncoded 5xx as retryable and a network failure as NETWORK", async () => {
    expect(
      (
        await client({ error: "boom" }, 502)
          .stats()
          .catch((x) => x)
      ).retryable,
    ).toBe(true);
    const e = await new BsktsClient({ fetch: never }).stats().catch((x) => x);
    expect([e.code, e.retryable]).toEqual(["NETWORK", true]);
  });
});

describe("requests", () => {
  it("asks for compact markets by default and serialises bigints", async () => {
    const calls: { url: string; body?: string }[] = [];
    const c = new BsktsClient({
      baseUrl: "https://x.test/",
      fetch: (u, init) => {
        calls.push({ url: String(u), body: init?.body as string | undefined });
        return reply({});
      },
    });
    await c.markets().catch(() => undefined);
    await c.buildSell({ ticker: "DIGI64", address: ADDR, shares: 5n }).catch(() => undefined);
    await c.buildSell({ ticker: "DIGI64", address: ADDR, fraction: 0.5 }).catch(() => undefined);
    expect(calls[0]!.url).toBe(
      "https://x.test/v1/markets?fields=ticker%2Cnav%2Cchange24h%2CbuyCostBps&prices=0",
    );
    expect(JSON.parse(calls[1]!.body!)).toMatchObject({ shares: "5" });
    expect(JSON.parse(calls[2]!.body!)).toMatchObject({ shares: "max", fraction: 0.5 });
  });
});

describe("policy", () => {
  const strict = new BsktsClient({
    fetch: never,
    policy: { maxUsdPerTrade: 100, allowedTickers: ["digi64"], maxSlippageBps: 100 },
  });
  it("refuses before any request", async () => {
    for (const p of [
      strict.buildBuy({ ticker: "DIGI64", amountUsdg: 101, address: ADDR }),
      strict.buildBuy({ ticker: "MAG6", amountUsdg: 5, address: ADDR }),
      strict.buildBuy({ ticker: "DIGI64", amountUsdg: 5, address: ADDR, slippageBps: 200 }),
      strict.buildOrder({ kind: "limit", ticker: "DIGI64", amountUsdg: 500, address: ADDR }),
      strict.buildSell({ ticker: "MAG6", address: ADDR }),
    ])
      expect((await p.catch((x) => x)).code).toBe("POLICY");
  });
  it("checks a sale's expected proceeds against the cap", async () => {
    const c = client(
      {
        ...plan(),
        tx: { to: ADDR, data: "0x", value: "0" },
        sharesWei: "1",
        expectedUsdg: "250000000",
        minOutUsdg: "1",
        legs: 1,
      },
      200,
      { maxUsdPerTrade: 100 },
    );
    expect((await c.buildSell({ ticker: "DIGI64", address: ADDR }).catch((x) => x)).code).toBe(
      "POLICY",
    );
  });
  it("refuses a buy whose live cost is over maxBuyCostBps", async () => {
    const c = client(
      {
        ticker: "FABLE",
        name: "",
        thesis: "",
        vault: ADDR,
        rebalance: "",
        mgmtFeeBps: 50,
        targetWeights: {},
        nav: 1,
        change24h: 0,
        buyCostBps: 73,
        group: "",
        risk: null,
        constituents: [],
      },
      200,
      { maxBuyCostBps: 50 },
    );
    expect(
      (await c.buildBuy({ ticker: "FABLE", amountUsdg: 5, address: ADDR }).catch((x) => x)).code,
    ).toBe("POLICY");
  });
  it("reads limits from the environment", () => {
    expect(
      policyFromEnv({ BSKTS_MAX_USD_PER_TRADE: "20", BSKTS_ALLOWED_TICKERS: "DIGI64, MAG6" }),
    ).toEqual({
      maxUsdPerTrade: 20,
      allowedTickers: ["DIGI64", "MAG6"],
    });
    expect(() => policyFromEnv({ BSKTS_MAX_USD_PER_TRADE: "lots" })).toThrow();
  });
});

describe("execute", () => {
  it("sends the approval, waits for it, then the action", async () => {
    const { s, sent } = sender();
    const r = await execute(
      plan({ approval: { to: "0x0000000000000000000000000000000000000001", data: "0x" } }),
      s,
    );
    expect(sent).toEqual(["0x0000000000000000000000000000000000000001", ADDR]);
    expect(s.wait).toHaveBeenCalledWith("0x1");
    expect(r).toEqual({ approvalHash: "0x1", hash: "0x2" });
  });
  it("refuses a plan whose dry run reverted, unless forced", async () => {
    const { s, sent } = sender();
    const bad = plan({ simulation: { ok: false, reason: "SlippageExceeded(1, 2)" } });
    expect((await execute(bad, s).catch((x) => x)).code).toBe("SIMULATION_FAILED");
    expect(sent).toEqual([]);
    await execute(bad, s, { force: true });
    expect(sent).toEqual([ADDR]);
  });
  it("waits for the action when asked", async () => {
    const { s } = sender();
    await execute(plan(), s, { wait: true });
    expect(s.wait).toHaveBeenCalledWith("0x1");
  });
});
