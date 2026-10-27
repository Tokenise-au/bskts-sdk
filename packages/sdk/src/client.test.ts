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

// 2026-10-27 (bskts agent audit F7): /v1/jobs pages each kind; the client passes
// the cursor and keeps the completeness fields zod would otherwise drop.
describe("jobs", () => {
  it("passes the cursor and keeps complete, next and scan", async () => {
    const urls: string[] = [];
    const scan = { index: "ok", offset: 25, scanned: 5, more: false };
    const c = new BsktsClient({
      baseUrl: "https://x.test",
      fetch: (u) => {
        urls.push(String(u));
        return reply({
          asOf: "t",
          jobs: [],
          skipped: [],
          complete: true,
          next: null,
          scan: { sell: scan, limit: scan, schedule: scan },
          note: "",
        });
      },
    });
    const r = await c.jobs({ cursor: "sell:25,limit:0,schedule:0" });
    expect(urls[0]).toBe("https://x.test/v1/jobs?cursor=sell%3A25%2Climit%3A0%2Cschedule%3A0");
    expect([r.complete, r.next, r.scan?.sell.scanned]).toEqual([true, null, 5]);
    await c.jobs();
    expect(urls[1]).toBe("https://x.test/v1/jobs");
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
  // 2026-10-27 (bskts agent audit F5): each of these passed the policy before.
  describe("checks effective terms, not only the caller's", () => {
    const basketBody = (nav: number | null) => ({
      ticker: "DIGI64",
      name: "",
      thesis: "",
      vault: ADDR,
      rebalance: "",
      mgmtFeeBps: 50,
      targetWeights: {},
      nav,
      change24h: 0,
      buyCostBps: 30,
      group: "",
      risk: null,
      constituents: [],
    });
    it("holds an omitted slippage to the cap at the API's default of 50", async () => {
      const tight = new BsktsClient({ fetch: never, policy: { maxSlippageBps: 1 } });
      for (const p of [
        tight.buildBuy({ ticker: "DIGI64", amountUsdg: 5, address: ADDR }),
        tight.buildSell({ ticker: "DIGI64", address: ADDR }),
      ])
        expect((await p.catch((x) => x)).code).toBe("POLICY");
    });
    it("sends the slippage it checked", async () => {
      const bodies: Record<string, unknown>[] = [];
      const c = new BsktsClient({
        fetch: (_u, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return reply({});
        },
      });
      await c.buildBuy({ ticker: "DIGI64", amountUsdg: 5, address: ADDR }).catch(() => undefined);
      await c.buildSell({ ticker: "DIGI64", address: ADDR }).catch(() => undefined);
      expect(bodies.map((b) => b["slippageBps"])).toEqual([50, 50]);
    });
    it("holds wallet orders to the cap at their 3% widest floor", async () => {
      const c = new BsktsClient({ fetch: never, policy: { maxSlippageBps: 100 } });
      for (const p of [
        c.buildOrder({ kind: "limit", ticker: "DIGI64", amountUsdg: 5, address: ADDR }),
        c.buildOrder({ kind: "exit", ticker: "DIGI64", address: ADDR, shares: 1n, stopNav: 1 }),
      ])
        expect((await p.catch((x) => x)).code).toBe("POLICY");
    });
    it("sizes a wallet exit's shares against maxUsdPerTrade", async () => {
      const c = client(basketBody(1), 200, { maxUsdPerTrade: 1 });
      const e = await c
        .buildOrder({
          kind: "exit",
          ticker: "DIGI64",
          address: ADDR,
          shares: 1000n * 10n ** 18n,
          stopNav: 0.9,
        })
        .catch((x) => x);
      expect([e.code, e.message]).toEqual(["POLICY", expect.stringContaining("$1000.00")]);
    });
    it("refuses a size cap it cannot value, rather than valuing at $0", async () => {
      const c = client(basketBody(null), 200, { maxUsdPerTrade: 1_000_000 });
      const e = await c
        .buildOrder({ kind: "exit", ticker: "DIGI64", address: ADDR, shares: 1n, stopNav: 1 })
        .catch((x) => x);
      expect([e.code, e.message]).toEqual(["POLICY", expect.stringContaining("no NAV")]);
    });
  });
});

// 2026-10-24: zod objects drop unknown keys, so a field the API adds is
// invisible until the schema names it; optional while older deployments lack it.
describe("limitMinSlippageBps", () => {
  const basket = {
    ticker: "WAFER",
    name: "",
    thesis: "",
    vault: ADDR,
    rebalance: "",
    mgmtFeeBps: 50,
    targetWeights: {},
    nav: 1,
    change24h: 0,
    buyCostBps: 30,
    group: "",
    risk: null,
    constituents: [],
  };
  it("keeps the basket's limit minimum, and parses an API that has none", async () => {
    expect(
      (await client({ ...basket, limitMinSlippageBps: 170 }).basket("WAFER")).limitMinSlippageBps,
    ).toBe(170);
    expect((await client(basket).basket("WAFER")).limitMinSlippageBps).toBeUndefined();
  });
  it("keeps it on markets too", async () => {
    const r = await client({
      markets: [{ ticker: "WAFER", limitMinSlippageBps: 170 }],
      asOfMs: 0,
      live: true,
    }).markets({ fields: ["ticker", "limitMinSlippageBps"] });
    expect(r.markets[0]).toEqual({ ticker: "WAFER", limitMinSlippageBps: 170 });
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
