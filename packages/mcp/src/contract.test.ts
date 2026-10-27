// bskts_agent_order against the bskts API's AgentOrderRequest (contract/,
// vendored by `node scripts/refresh-contract.mjs`). 2026-10-25: MCP callers are
// untyped, so every rule is checked by calling the tool: what the API refuses
// must never reach it, and what it accepts must.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BsktsClient } from "@bskts/sdk";
import { describe, expect, it } from "vitest";
import { branches, cases, check, requestSchema } from "../../../contract/contract";
import { createBsktsServer } from "./index";

const ADDR = "0x000000000000000000000000000000000000dEaD";
const ORDER_ID = `0x${"ab".repeat(32)}`;

/** The MCP server over an API that refuses everything, recording what reached it. */
async function connect() {
  const sent: { path: string; body: unknown }[] = [];
  const client = new BsktsClient({
    baseUrl: "https://x.test",
    fetch: async (u, init) => {
      sent.push({
        path: new URL(String(u)).pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json({ error: "stub", code: "BAD_REQUEST" }, { status: 400 });
    },
  });
  const server = createBsktsServer({ client });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "contract", version: "0" });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  return { mcp, sent };
}

describe("bskts_agent_order against AgentOrderRequest", () => {
  const schema = requestSchema("AgentOrderRequest");
  const byKind = branches(schema);
  const base: Record<string, Record<string, unknown>> = {
    limit: {
      kind: "limit",
      owner: ADDR,
      key: ADDR,
      ticker: "DIGI64",
      amountUsdg: 25,
      triggerNav: 90,
      slippageBps: 300,
    },
    cancel: { kind: "cancel", owner: ADDR, key: ADDR, orderId: ORDER_ID },
    // 2026-10-27: exits and their cancellation (API PR 236, MCP 0.5.0), which
    // the vendored contract predated
    exit: {
      kind: "exit",
      owner: ADDR,
      key: ADDR,
      ticker: "DIGI64",
      shares: "max",
      stopNav: 90,
      tpNav: 110,
      slippageBps: 300,
    },
    "cancel-exit": { kind: "cancel-exit", owner: ADDR, key: ADDR, orderId: ORDER_ID },
  };
  // where the tool (through the SDK) is deliberately stricter than the API, and why
  const stricter: Record<string, Record<string, string>> = {
    limit: {
      "amountUsdg at its maximum 9007199300":
        "the SDK caps at Number.MAX_SAFE_INTEGER / 1e6 (9007199254.74) so the base-unit amount is exact",
    },
    exit: {
      "tpNav just above 0":
        "under the base's stopNav 90: stop must be below take-profit, which the API also refuses (400) but its schema can't say across two fields",
    },
  };
  // API fields the tool does not take, and why
  const notInputs: Record<string, string> = {
    feeUsdg: "plans are built at fee 0; the relayer quotes the fee (402) and the host re-signs",
  };
  const call = async (args: Record<string, unknown>) => {
    const { mcp, sent } = await connect();
    await mcp.callTool({ name: "bskts_agent_order", arguments: args }).catch(() => {});
    return sent.filter((r) => r.path === "/v1/agent/order");
  };

  it("advertises exactly the kinds the API takes", async () => {
    const { mcp } = await connect();
    const tool = (await mcp.listTools()).tools.find((t) => t.name === "bskts_agent_order")!;
    const kind = (tool.inputSchema.properties as Record<string, { enum?: string[] }>).kind;
    expect(kind?.enum?.slice().sort()).toEqual([...byKind.keys()].sort());
    expect(Object.keys(base).sort()).toEqual([...byKind.keys()].sort());
    // one flat object for every kind (tools/list shows a union as {}): the union of
    // the API's fields, less the ones the tool leaves to the SDK
    const api = new Set([...byKind.values()].flatMap((b) => Object.keys(b.properties as object)));
    for (const k of Object.keys(notInputs)) expect(api, `stale notInputs.${k}`).toContain(k);
    expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(
      [...api].filter((k) => !(k in notInputs)).sort(),
    );
  });

  for (const [kind, branch] of byKind) {
    const b = base[kind]!;
    it(`${kind}: sends a body the API accepts`, async () => {
      const [req] = await call(b);
      expect(req, "the tool refused a valid request").toBeDefined();
      expect(check(schema, req!.body)).toEqual([]);
    });
    // 2026-10-24 drift: the tool took slippageBps as optional while the API required it
    for (const c of cases(branch, b, { patterns: true, skip: stricter[kind] }))
      if (!(c.field in notInputs))
        it(`${kind}: ${c.name} is ${c.accept ? "sent" : "refused before sending"}`, async () => {
          const reqs = await call(c.args);
          if (!c.accept) expect(reqs, "the tool sent a request the API refuses").toEqual([]);
          else {
            expect(reqs, "the tool refused a request the API accepts").toHaveLength(1);
            expect(check(schema, reqs[0]!.body)).toEqual([]);
          }
        });
  }
});
