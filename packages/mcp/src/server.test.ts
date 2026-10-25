import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BsktsClient, schemas, type Policy } from "@bskts/sdk";
import { describe, expect, it } from "vitest";
import { createBsktsMcpHandler, createBsktsServer, VERSION } from "./index";
import { encodeAbiParameters, parseAbiParameters } from "viem";
import pkg from "../package.json" with { type: "json" };

const ADDR = "0x000000000000000000000000000000000000dEaD";

/** A bskts API stub: path -> body (or [status, body]). */
function api(routes: Record<string, unknown>, policy: Policy = {}) {
  const calls: { path: string; body?: unknown }[] = [];
  const client = new BsktsClient({
    baseUrl: "https://x.test",
    policy,
    fetch: async (u, init) => {
      const path = new URL(String(u)).pathname;
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const hit = routes[path];
      const [status, body] = Array.isArray(hit)
        ? hit
        : [hit ? 200 : 404, hit ?? { error: "not found", code: "NOT_FOUND" }];
      return new Response(JSON.stringify(body), { status });
    },
  });
  return { client, calls };
}

async function connect(client: BsktsClient) {
  const server = createBsktsServer({ client });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  return mcp;
}
const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);

const PLAN = { approval: null, tx: { to: ADDR, data: "0x", value: "0" } };

describe("bskts MCP server", () => {
  it("lists twelve tools, with annotations, inside a token budget", async () => {
    const mcp = await connect(api({}).client);
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "bskts_markets",
      "bskts_basket",
      "bskts_account",
      "bskts_buy",
      "bskts_sell",
      "bskts_order",
      "bskts_agent_session",
      "bskts_agent_order",
      "bskts_agent_trade",
      "bskts_cover",
      "bskts_agent_cover",
      "bskts_guide",
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
    // loaded into every conversation that has the server
    // 2026-10-11: 9,000 -> 12,000 for the two Weekend Cover tools (~2.5k with
    // their input schemas, trimmed to the rules a buyer needs)
    expect(JSON.stringify(tools).length).toBeLessThan(14_000);
    expect(mcp.getInstructions()).toMatch(/UNSIGNED/);
  });

  it("merges wallet, positions and orders into one account read", async () => {
    const { client } = api({
      [`/v1/wallet/${ADDR}`]: {
        address: ADDR,
        chainId: 4663,
        eth: 1,
        ethWei: "1000000000000000000",
        usdg: 10,
        usdgWei: "10000000",
        holdings: [],
        tradeGasEth: 0.0001,
        gasOk: true,
      },
      [`/v1/positions/${ADDR}`]: { address: ADDR, positions: [] },
      [`/v1/orders/${ADDR}`]: { address: ADDR, orders: [] },
    });
    const out = text(
      await (
        await connect(client)
      ).callTool({ name: "bskts_account", arguments: { address: ADDR } }),
    );
    expect(out).toMatchObject({
      usdg: 10,
      ethWei: "1000000000000000000",
      gasOk: true,
      positions: [],
      orders: [],
    });
    expect(out.holdings).toBeUndefined();
  });

  it("sells the whole balance by default and passes exact shares through", async () => {
    const sale = { ...PLAN, sharesWei: "5", expectedUsdg: "1", minOutUsdg: "1", legs: 1 };
    const { client, calls } = api({ "/v1/tx/sell": sale });
    const mcp = await connect(client);
    await mcp.callTool({
      name: "bskts_sell",
      arguments: { ticker: "DIGI64", address: ADDR, fraction: 0.5 },
    });
    await mcp.callTool({
      name: "bskts_sell",
      arguments: { ticker: "DIGI64", address: ADDR, shares: "5" },
    });
    expect(calls.map((c) => c.body)).toMatchObject([
      { shares: "max", fraction: 0.5 },
      { shares: "5" },
    ]);
  });

  it("returns API refusals as readable tool errors with their code", async () => {
    const { client } = api({
      "/v1/tx/buy": [422, { error: "no route for X", code: "NO_ROUTE", retryable: false }],
    });
    const r = await (
      await connect(client)
    ).callTool({
      name: "bskts_buy",
      arguments: { ticker: "X", amountUsdg: 5, address: ADDR },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatchObject({ code: "NO_ROUTE", retryable: false });
  });

  it("enforces the user's policy before building", async () => {
    const { client, calls } = api({}, { maxUsdPerTrade: 20, allowedTickers: ["DIGI64"] });
    const mcp = await connect(client);
    const big = await mcp.callTool({
      name: "bskts_buy",
      arguments: { ticker: "DIGI64", amountUsdg: 50, address: ADDR },
    });
    const other = await mcp.callTool({
      name: "bskts_order",
      arguments: { kind: "limit", ticker: "FABLE", amountUsdg: 5, address: ADDR },
    });
    expect([text(big).code, text(other).code]).toEqual(["POLICY", "POLICY"]);
    expect(calls).toEqual([]);
  });

  it("rejects bad arguments before calling the API", async () => {
    const { client, calls } = api({});
    const r = await (
      await connect(client)
    ).callTool({
      name: "bskts_buy",
      arguments: { ticker: "DIGI64", amountUsdg: -5, address: "not-an-address" },
    });
    expect(r.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("answers Streamable HTTP, statelessly", async () => {
    const handler = createBsktsMcpHandler({ client: api({}).client });
    const post = (body: unknown) =>
      handler(
        new Request("https://x.test/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify(body),
        }),
      );
    const init = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    expect(init.status).toBe(200);
    const { serverInfo } = (await init.json()).result;
    expect(serverInfo.name).toBe("bskts");
    // the published version, not a hand-typed copy (0.1.1 reported "0.1.0")
    expect(serverInfo.version).toBe(pkg.version);
    expect(VERSION).toBe(pkg.version);
    const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((await list.json()).result.tools).toHaveLength(12);
  });
});

describe("delegated agent MCP", () => {
  it.each([25, 50])("checks resolved slippage %s against a 25 bps host policy", async (slip) => {
    const relayerUrl = "https://bskts.xyz/relay/v1/account/execute";
    const response = {
      ticker: "INDEX2",
      status: {
        owner: ADDR,
        account: ADDR,
        key: ADDR,
        chainId: 4663,
        module: schemas.SESSION_MODULE,
        deployed: true,
        moduleEnabled: true,
        coverEnabled: false,
        active: true,
        paused: false,
        usdgWei: "100000000",
        dailyLimitUsdg: "10000000",
        remainingTodayUsdg: "10000000",
        maxSlippageBps: slip,
        validUntil: 2000000000,
        approvalUrl: "https://bskts.xyz/portfolio?p=agents",
        relayerUrl,
        revokeEffect: "Cancel existing orders separately.",
      },
      action: {
        account: ADDR,
        key: ADDR,
        kind: 0,
        vault: "0xC02b7A59846B77d0b1d0cfE8943D32c279ED292a",
        amount: "100000000000000",
        limit: "5000000",
        slippageBps: slip,
        data: "0x",
        nonce: "123",
        deadline: 1900000000,
        fee: "0",
      },
      relayerUrl,
      simulation: { ok: null, skipped: "Unsigned" },
    };
    const { client, calls } = api({ "/v1/agent/trade": response }, { maxSlippageBps: 25 });
    const result = await (
      await connect(client)
    ).callTool({
      name: "bskts_agent_trade",
      arguments: { owner: ADDR, key: ADDR, ticker: "INDEX2", side: "buy", amountUsdg: 5 },
    });
    expect(calls).toHaveLength(1);
    if (slip === 25) {
      expect(result.isError).not.toBe(true);
      expect(text(result).action.slippageBps).toBe(25);
    } else expect(result.isError).toBe(true);
  });
  it("reads live permissions and exposes no signing, grant or execution tools", async () => {
    const { client } = api({});
    const mcp = await connect(client);
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name)).toContain("bskts_agent_session");
    expect(tools.map((t) => t.name)).toContain("bskts_agent_trade");
    expect(tools.some((t) => /sign|execute|grant|withdraw/.test(t.name))).toBe(false);
    expect(mcp.getInstructions()).toContain("Owner signature required");
  });
  it("rejects mixed buy/sell inputs before calling the API", async () => {
    const { client, calls } = api({});
    const result = await (
      await connect(client)
    ).callTool({
      name: "bskts_agent_trade",
      arguments: {
        owner: ADDR,
        key: ADDR,
        ticker: "INDEX2",
        side: "sell",
        amountUsdg: 5,
        shares: "1",
      },
    });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("delegated limit MCP", () => {
  it("returns locally reconstructed typed data and rejects mixed parameters", async () => {
    const owner = "0x1111111111111111111111111111111111111111";
    const key = "0x3333333333333333333333333333333333333333";
    const account = "0x2222222222222222222222222222222222222222";
    const now = Math.floor(Date.now() / 1000);
    const orderId = "0x" + "ab".repeat(32);
    const fixture = {
      ticker: "INDEX2",
      status: {
        owner,
        key,
        account,
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
        revokeEffect: "Cancel separately.",
      },
      action: {
        account,
        key,
        kind: 2,
        vault: "0xC02b7A59846B77d0b1d0cfE8943D32c279ED292a",
        amount: "10000000",
        limit: "0",
        slippageBps: 50,
        data: encodeAbiParameters(
          parseAbiParameters("(uint256,bool,uint64,uint16,uint16,uint16)"),
          [[98n * 10n ** 18n, true, BigInt(now + 86400), 50, 100, 50]],
        ),
        nonce: "123",
        deadline: now + 300,
        fee: "0",
      },
      relayerUrl: "https://bskts.xyz/relay/v1/account/execute",
      simulation: { ok: null, skipped: "Unsigned" },
      typedData: { domain: { chainId: 1 } },
      preview: {
        kind: "limit",
        basis: "Triggers are on NAV per share.",
        navNow: 100,
        triggerNav: 98,
        direction: "below",
        fromNowPct: -2,
        fillsNow: false,
        worstPricePerShare: 99.5,
        worstFromNowPct: -0.5,
        worstShares: 0.1005,
        costs: { mintFeeBps: 20, fillerFeeBps: 100, maxSlippageBps: 50 },
        notes: [],
      } as Record<string, unknown>,
    };
    const { client, calls } = api({ "/v1/agent/order": fixture });
    const mcp = await connect(client);
    try {
      const result = text(
        await mcp.callTool({
          name: "bskts_agent_order",
          arguments: {
            kind: "limit",
            owner,
            key,
            ticker: "INDEX2",
            amountUsdg: 10,
            triggerNav: 98,
            slippageBps: 50,
          },
        }),
      );
      expect(result.action.kind).toBe(2);
      // 2026-10-25: the preview leads, as text the model shows before signing
      expect(Object.keys(result)[0]).toBe("previewText");
      expect(result.previewText[0]).toMatch(/^Limit buy when NAV <= 98: -2\.00% from NAV 100 now/);
      expect(result.typedData.domain.chainId).toBe(4663);
      expect(result.terms.triggerNavE18).toBe("98000000000000000000");
      expect(calls).toHaveLength(1);
      const invalid = await mcp.callTool({
        name: "bskts_agent_order",
        arguments: { kind: "cancel", owner, key, orderId, ticker: "INDEX2" },
      });
      expect(invalid.isError).toBe(true);
      // 2026-10-24: a limit without slippage is refused before the API is called
      const unslipped = await mcp.callTool({
        name: "bskts_agent_order",
        arguments: { kind: "limit", owner, key, ticker: "INDEX2", amountUsdg: 10, triggerNav: 98 },
      });
      expect(unslipped.isError).toBe(true);
      expect(text(unslipped).error).toMatch(/slippageBps/);
      expect(calls).toHaveLength(1);
      // an exit: shares "max", a bracket, its preview against the entry
      fixture.action.kind = 3;
      fixture.action.amount = (10n ** 18n).toString();
      fixture.action.data = encodeAbiParameters(
        parseAbiParameters("(uint256,uint256,uint64,uint16,uint16,uint16)"),
        [[90n * 10n ** 18n, 110n * 10n ** 18n, BigInt(now + 86400), 50, 28, 50]],
      );
      fixture.preview = {
        kind: "exit",
        basis: "Triggers are on NAV per share.",
        navNow: 100,
        shares: 1,
        avgEntry: null,
        breakEvenNav: null,
        triggers: [
          {
            edge: "takeProfit",
            nav: 110,
            fromNowPct: 10,
            priceReturnPct: null,
            estNetReturnPct: null,
            worstNetReturnPct: null,
            estProceedsUsdg: 109.2,
            worstProceedsUsdg: 109.1,
          },
        ],
        costs: { sellFeeBps: 20, routeCostBps: 30, fillerFeeBps: 28, maxSlippageBps: 50 },
        notes: [],
      };
      const exitArgs = { kind: "exit", owner, key, ticker: "INDEX2", shares: "max" };
      const noEdge = await mcp.callTool({
        name: "bskts_agent_order",
        arguments: { ...exitArgs, slippageBps: 50 },
      });
      expect(noEdge.isError).toBe(true);
      const mixed = await mcp.callTool({
        name: "bskts_agent_order",
        arguments: { ...exitArgs, tpNav: 110, slippageBps: 50, amountUsdg: 10 },
      });
      expect(mixed.isError).toBe(true);
      expect(calls).toHaveLength(1);
      const placed = text(
        await mcp.callTool({
          name: "bskts_agent_order",
          arguments: { ...exitArgs, stopNav: 90, tpNav: 110, slippageBps: 50 },
        }),
      );
      expect(placed.action.kind).toBe(3);
      expect(placed.terms).toMatchObject({ kind: "exit", tpNavE18: "110000000000000000000" });
      expect(placed.previewText[1]).toBe(
        "Take-profit at NAV 110: +10.00% from now; worst proceeds 109.1 USDG.",
      );
      expect(calls).toHaveLength(2);
      fixture.action.kind = 4;
      fixture.action.amount = "0";
      fixture.action.slippageBps = 0;
      fixture.action.data = encodeAbiParameters([{ type: "bytes32" }], [orderId as `0x${string}`]);
      fixture.preview = {
        kind: "cancel",
        basis: "Triggers are on NAV per share.",
        navNow: 100,
        triggerNav: 98,
        direction: "below",
        fromNowPct: -2,
        refundUsdg: 10,
      };
      const cancelled = text(
        await mcp.callTool({
          name: "bskts_agent_order",
          arguments: { kind: "cancel", owner, key, orderId },
        }),
      );
      expect(cancelled.action.kind).toBe(4);
      expect(cancelled.terms.orderId).toBe(orderId);
      expect(calls).toHaveLength(3);
    } finally {
      await mcp.close();
    }
  });
});
