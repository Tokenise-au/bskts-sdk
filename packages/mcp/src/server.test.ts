import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BsktsClient, schemas, type Policy } from "@bskts/sdk";
import { describe, expect, it } from "vitest";
import { createBsktsMcpHandler, createBsktsServer, VERSION } from "./index";
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
  it("lists nine tools, with annotations, inside a token budget", async () => {
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
      "bskts_agent_trade",
      "bskts_guide",
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
    // loaded into every conversation that has the server
    expect(JSON.stringify(tools).length).toBeLessThan(9_000);
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
    expect((await list.json()).result.tools).toHaveLength(9);
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
