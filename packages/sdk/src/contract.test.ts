// The SDK against the bskts API's own contract (contract/, vendored by
// `node scripts/refresh-contract.mjs`). 2026-10-25: on 2026-10-24 the SDK took
// slippageBps as optional while the API required it, and its zod objects
// stripped the new limitMinSlippageBps; the SDK's own tests passed both times.
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  branches,
  cases,
  check,
  readContract,
  requestSchema,
  strippedKeys,
} from "../../../contract/contract";
import { BsktsClient } from "./client";
import * as s from "./schemas";

/** The fields a BsktsClient method's argument type takes, per `kind`, and
 * which are optional, read with the TypeScript compiler: the SDK states
 * required-ness in its types (it range-checks numbers at runtime, not presence). */
function argFields(method: keyof BsktsClient) {
  const file = fileURLToPath(new URL("./client.ts", import.meta.url));
  const program = ts.createProgram([file], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(file)!;
  let param: ts.ParameterDeclaration | undefined;
  const visit = (n: ts.Node) => {
    if (ts.isMethodDeclaration(n) && n.name.getText(sf) === method) param = n.parameters[0];
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!param) throw new Error(`BsktsClient.${method} not found`);
  const t = checker.getTypeAtLocation(param);
  const out = new Map<string, { required: string[]; optional: string[] }>();
  for (const member of t.isUnion() ? t.types : [t]) {
    const props = checker.getPropertiesOfType(member);
    const kind = props.find((p) => p.name === "kind");
    const kt = kind && checker.getTypeOfSymbol(kind);
    if (!kt?.isStringLiteral()) throw new Error(`a ${method} argument without a literal kind`);
    const opt = (p: ts.Symbol) => (p.flags & ts.SymbolFlags.Optional) !== 0;
    out.set(kt.value, {
      required: props
        .filter((p) => !opt(p))
        .map((p) => p.name)
        .sort(),
      optional: props
        .filter(opt)
        .map((p) => p.name)
        .sort(),
    });
  }
  return out;
}

const ADDR = "0x000000000000000000000000000000000000dEaD";
const ORDER_ID = `0x${"ab".repeat(32)}`;

/** A client whose API refuses everything, recording what reached it. Whether a
 * request was sent is the point; the plan it would get back is not. */
function stub() {
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
  return { client, sent };
}

describe("POST /v1/agent/order: buildAgentOrder against AgentOrderRequest", () => {
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
    // 2026-10-27: exits and their cancellation (API PR 236, SDK 0.8.0). The
    // vendored contract predated them, so main's CI went red on the release.
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
  // where the SDK is deliberately stricter than the API, and why
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

  it("covers every kind the API takes, and only those", () => {
    expect([...byKind.keys()].sort()).toEqual(Object.keys(base).sort());
  });

  // 2026-10-24 drift: the SDK's limit type had `slippageBps?` while the API required it
  it("types each kind's fields as the API requires them", { timeout: 60_000 }, () => {
    const sdk = argFields("buildAgentOrder");
    const api = new Map(
      [...byKind].map(([kind, b]) => {
        const req = new Set(b.required as string[]);
        const names = Object.keys(b.properties as object);
        return [
          kind,
          {
            required: names.filter((n) => req.has(n)).sort(),
            optional: names.filter((n) => !req.has(n)).sort(),
          },
        ];
      }),
    );
    expect(Object.fromEntries(sdk)).toEqual(Object.fromEntries(api));
  });

  for (const [kind, branch] of byKind) {
    const b = base[kind]!;
    const send = async (args: Record<string, unknown>) => {
      const { client, sent } = stub();
      await client
        .buildAgentOrder(args as Parameters<BsktsClient["buildAgentOrder"]>[0])
        .catch(() => {});
      return sent.filter((r) => r.path === "/v1/agent/order");
    };

    it(`${kind}: sends a body the API accepts`, async () => {
      const [req] = await send(b);
      expect(req, "the SDK refused a valid request").toBeDefined();
      expect(check(schema, req!.body)).toEqual([]);
      // with the optional fee too (a bigint, sent as its digits)
      const [fee] = await send({ ...b, feeUsdg: 1_000n });
      expect(check(schema, fee!.body)).toEqual([]);
    });

    for (const c of cases(branch, b, { required: false, skip: stricter[kind] }))
      it(`${kind}: ${c.name} is ${c.accept ? "sent" : "refused before sending"}`, async () => {
        const reqs = await send(c.args);
        if (!c.accept) expect(reqs, "the SDK sent a request the API refuses").toEqual([]);
        else {
          expect(reqs, "the SDK refused a request the API accepts").toHaveLength(1);
          expect(check(schema, reqs[0]!.body)).toEqual([]);
        }
      });
  }

  it("refuses a kind the API does not take", async () => {
    const { client, sent } = stub();
    await client.buildAgentOrder({ ...base.limit, kind: "market" } as never).catch(() => {});
    expect(sent).toEqual([]);
  });
});

describe("responses: the SDK's schemas keep every field the API sends", () => {
  const responses: [
    string,
    string,
    { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: unknown } },
  ][] = [
    ["GET /v1/baskets", "baskets", s.basketsResponse],
    ["GET /v1/markets", "markets", s.marketsResponse],
    ["GET /v1/baskets/{ticker}", "basket", s.basketDetail],
    ["GET /v1/stats", "stats", s.stats],
    ["GET /v1/nav/{ticker}/history", "nav-history", s.candlesResponse],
    ["GET /v1/nav/{ticker}/history?format=summary", "nav-summary", s.navSummaryResponse],
    ["GET /v1/nav/{ticker}/history?format=close", "nav-closes", s.closesResponse],
    ["GET /v1/cover/weeks", "cover-weeks", s.coverWeeksResponse],
    ["GET /v1/cover/book/{ticker}", "cover-book", s.coverBookResponse],
  ];
  for (const [route, file, schema] of responses)
    it(route, () => {
      const raw = readContract(`responses/${file}.json`);
      const parsed = schema.safeParse(raw);
      expect(parsed.error).toBeUndefined();
      // a field here is one the API sends and SDK users never see: add it to schemas.ts
      expect(strippedKeys(raw, parsed.data)).toEqual([]);
    });
});
