import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  BsktsClient,
  BsktsError,
  executeSession,
  feeKey,
  feeMemory,
  sessionRelayer,
  schemas,
  type SessionSender,
} from "./index";
// a fresh fee memory per call, so no test signs with a fee another one left behind
const opts = () => ({ maxNetworkFeeUsdg: 250_000n, fees: feeMemory() });
const agent = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
const owner = "0x1111111111111111111111111111111111111111" as const;
const account = "0x2222222222222222222222222222222222222222" as const;
const vault = "0xC02b7A59846B77d0b1d0cfE8943D32c279ED292a" as const;
const receipt = { hash: `0x${"11".repeat(32)}` as const, blockNumber: 1, gasUsed: 100 };
const status = {
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
  usdgWei: "100000000",
  dailyLimitUsdg: "10000000",
  remainingTodayUsdg: "10000000",
  maxSlippageBps: 50,
  validUntil: Math.floor(Date.now() / 1000) + 604800,
  approvalUrl: "https://bskts.xyz/portfolio?p=agents",
  relayerUrl: "https://bskts.xyz/relay/v1/account/execute",
  revokeEffect: "Cancel existing orders separately.",
};
const response = {
  ticker: "INDEX2",
  status,
  action: {
    account,
    key: agent.address,
    kind: 0,
    vault,
    amount: "100000000000000",
    limit: "5000000",
    slippageBps: 50,
    data: "0x",
    nonce: "123",
    deadline: Math.floor(Date.now() / 1000) + 300,
    fee: "0",
  },
  relayerUrl: status.relayerUrl,
  simulation: { ok: null, skipped: "Unsigned" },
};
const plan = () => schemas.agentTradePlan.parse(response);
const sender = (submit: SessionSender["submit"] = async () => receipt): SessionSender => ({
  key: agent.address,
  sign: vi.fn((data) => agent.signTypedData(data)),
  submit: vi.fn(submit),
});
describe("agent execution", () => {
  it.each(["otherVault", "unknownTicker", "prototypeTicker"])(
    "refuses %s before invoking the signer or submitting",
    async (mode) => {
      const p = plan();
      const s = sender();
      if (mode === "otherVault") p.action.vault = "0x63e5dFBEC475b3afA031be9031e73aCdb6F1d559";
      else p.ticker = mode === "unknownTicker" ? "NEW" : "constructor";
      await expect(executeSession(p, s, opts())).rejects.toMatchObject({ code: "BAD_RESPONSE" });
      expect(s.sign).not.toHaveBeenCalled();
      expect(s.submit).not.toHaveBeenCalled();
    },
  );
  it("only the caller's matching signer signs, with the pinned chain/domain", async () => {
    const s = sender();
    expect(await executeSession(plan(), s, opts())).toEqual(receipt);
    expect(s.sign).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: expect.objectContaining({
          chainId: 4663,
          verifyingContract: schemas.SESSION_MODULE,
        }),
        primaryType: "Action",
      }),
    );
  });
  it("re-signs only a bounded 402 fee; nonce and all trade terms stay fixed", async () => {
    const submitted: unknown[] = [];
    const s = sender(async (body) => {
      submitted.push(body.action);
      if (submitted.length === 1)
        throw new BsktsError("quote", "FEE_REQUIRED", {
          status: 402,
          detail: { requiredFee: "10000" },
        });
      return receipt;
    });
    const p = plan();
    await executeSession(p, s, opts());
    expect(submitted).toEqual([p.action, { ...p.action, fee: 10_000n }]);
  });
  it.each(["250001", "-1", "1e6", "1000000000000000000000"])(
    "rejects a bad or excessive fee quote %s before re-signing",
    async (requiredFee) => {
      const s = sender(async () => {
        throw new BsktsError("quote", "FEE_REQUIRED", { status: 402, detail: { requiredFee } });
      });
      await expect(executeSession(plan(), s, opts())).rejects.toBeInstanceOf(BsktsError);
      expect(s.sign).toHaveBeenCalledTimes(1);
    },
  );
  it("never retries uncertain network submissions", async () => {
    const s = sender(async () => {
      throw new BsktsError("uncertain", "NETWORK");
    });
    await expect(executeSession(plan(), s, opts())).rejects.toMatchObject({
      code: "NETWORK",
    });
    expect(s.submit).toHaveBeenCalledTimes(1);
  });
  it("bounds fee retries at four signed requests", async () => {
    let fee = 0;
    const s = sender(async () => {
      throw new BsktsError("quote", "FEE_REQUIRED", {
        status: 402,
        detail: { requiredFee: String(++fee) },
      });
    });
    await expect(executeSession(plan(), s, opts())).rejects.toMatchObject({
      code: "FEE_REQUIRED",
    });
    expect(s.sign).toHaveBeenCalledTimes(4);
  });
  it.each(["inactive", "paused", "expired", "slippage", "wrongKey", "simulation"])(
    "refuses %s before signing",
    async (mode) => {
      const p = plan();
      const s = sender();
      if (mode === "inactive") p.status.active = false;
      if (mode === "paused") p.status.paused = true;
      if (mode === "expired") p.action.deadline = 1;
      if (mode === "slippage") p.action.slippageBps = 51;
      if (mode === "wrongKey") s.key = other.address;
      if (mode === "simulation") p.simulation = { ok: false, reason: "bad route" };
      await expect(executeSession(p, s, opts())).rejects.toBeInstanceOf(BsktsError);
      expect(s.sign).not.toHaveBeenCalled();
      expect(s.submit).not.toHaveBeenCalled();
    },
  );
  it("rejects a signature from a different private signer without submitting", async () => {
    const s = sender();
    s.sign = async (data) => other.signTypedData(data);
    await expect(executeSession(plan(), s, opts())).rejects.toMatchObject({
      code: "BAD_RESPONSE",
    });
    expect(s.submit).not.toHaveBeenCalled();
  });
});
describe("remembered network fee", () => {
  const quoteOnce = (fee = "10000") => {
    let n = 0;
    return async () => {
      if (n++ === 0)
        throw new BsktsError("quote", "FEE_REQUIRED", {
          status: 402,
          detail: { requiredFee: fee },
        });
      return receipt;
    };
  };
  it("a repeat trade signs once, with the fee the last one needed", async () => {
    const fees = feeMemory();
    const first = sender(quoteOnce());
    await executeSession(plan(), first, { maxNetworkFeeUsdg: 250_000n, fees });
    expect(first.sign).toHaveBeenCalledTimes(2);
    const next = sender();
    await executeSession(plan(), next, { maxNetworkFeeUsdg: 250_000n, fees });
    expect(next.sign).toHaveBeenCalledTimes(1);
    expect(next.submit).toHaveBeenCalledWith(
      expect.objectContaining({ action: expect.objectContaining({ fee: 10_000n, nonce: 123n }) }),
    );
  });
  it("follows the relayer's quote on success, down as well as up", async () => {
    const fees = feeMemory();
    fees.set(feeKey(plan().action), 10_000n);
    await executeSession(
      plan(),
      sender(async () => ({ ...receipt, requiredFee: 8_000n })),
      {
        maxNetworkFeeUsdg: 250_000n,
        fees,
      },
    );
    expect(fees.get(feeKey(plan().action))).toBe(8_000n);
  });
  it("keeps fees per kind of trade and basket", async () => {
    const fees = feeMemory();
    fees.set(feeKey({ kind: 1, vault: response.action.vault }), 10_000n);
    const s = sender();
    await executeSession(plan(), s, { maxNetworkFeeUsdg: 250_000n, fees });
    expect(s.submit).toHaveBeenCalledWith(
      expect.objectContaining({ action: expect.objectContaining({ fee: 0n }) }),
    );
  });
  it.each(["aboveCap", "planFee", "disabled", "expired"])(
    "does not use a remembered fee when %s",
    async (mode) => {
      const p = plan();
      const fees = feeMemory(mode === "expired" ? -1 : undefined);
      fees.set(feeKey(p.action), mode === "aboveCap" ? 250_001n : 10_000n);
      if (mode === "planFee") p.action.fee = 5n;
      const s = sender();
      await executeSession(p, s, {
        maxNetworkFeeUsdg: 250_000n,
        fees: mode === "disabled" ? false : fees,
      });
      expect(s.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.objectContaining({ fee: mode === "planFee" ? 5n : 0n }),
        }),
      );
    },
  );
  it("parses the relayer's success quote into the receipt", async () => {
    const submit = sessionRelayer({
      fetch: async () =>
        new Response(JSON.stringify({ ok: true, ...receipt, requiredFee: "9000" })),
    });
    expect(await submit({ action: plan().action, signature: "0x" })).toMatchObject({
      requiredFee: 9_000n,
    });
  });
});
describe("session transport and responses", () => {
  it("rejects permission discovery that swaps the requested owner/key", async () => {
    const client = new BsktsClient({
      fetch: async () => new Response(JSON.stringify({ ...status, key: other.address })),
    });
    await expect(client.agentSession({ owner, key: agent.address })).rejects.toMatchObject({
      code: "BAD_RESPONSE",
    });
  });

  it("POSTs only a signed Action and decimal base units, without private keys", async () => {
    const calls: unknown[] = [];
    const submit = sessionRelayer({
      fetch: async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(receipt));
      },
    });
    await executeSession(plan(), sender(submit), opts());
    expect(calls[0]).toMatchObject({
      action: { nonce: "123", fee: "0" },
      signature: expect.any(String),
    });
    expect(Object.keys(calls[0] as object)).toEqual(["action", "signature"]);
  });
  it("fails closed on HTTP destinations and ambiguous transport failures", async () => {
    expect(() => sessionRelayer({ url: "http://example.com/execute" })).toThrow("HTTPS");
    const submit = sessionRelayer({
      fetch: async () => {
        throw new Error("timeout");
      },
    });
    await expect(executeSession(plan(), sender(submit), opts())).rejects.toMatchObject({
      code: "NETWORK",
      retryable: false,
    });
  });
  it.each([
    [402, { ok: false, error: "network fee too low", requiredFee: "10000" }, "FEE_REQUIRED", false],
    [429, { ok: false, error: "rate limited (account)" }, "RATE_LIMITED", true],
    [400, { ok: false, error: "execution reverted: SlippageExceeded" }, "REFUSED", false],
    [503, { ok: false, error: "relayer daily budget reached" }, "REFUSED", true],
    [500, { ok: false, error: "replacement transaction underpriced" }, "UNCERTAIN", false],
    [504, undefined, "UNCERTAIN", false],
  ] as const)(
    "maps relayer HTTP %i to its code with the reason",
    async (status, body, code, retryable) => {
      const submit = sessionRelayer({
        fetch: async () => new Response(body ? JSON.stringify(body) : "gateway", { status }),
      });
      const e = await submit({ action: plan().action, signature: "0x" }).catch((x: unknown) => x);
      expect(e).toMatchObject({ code, retryable, status });
      expect((e as Error).message).toContain(body?.error ?? `HTTP ${status}`);
      if (code === "UNCERTAIN") expect((e as Error).message).toContain("nonce");
    },
  );
  it("accepts any bskts.xyz approval page and refuses other origins", () => {
    for (const approvalUrl of [
      "https://bskts.xyz/portfolio?p=agents",
      "https://bskts.xyz/portfolio#agents",
    ])
      expect(schemas.agentSession.parse({ ...status, approvalUrl }).approvalUrl).toBe(approvalUrl);
    for (const approvalUrl of ["https://bskts.xyz.evil.com/x", "http://bskts.xyz/portfolio", "x"])
      expect(() => schemas.agentSession.parse({ ...status, approvalUrl })).toThrow();
  });
  it("rejects a response that swaps requested terms", async () => {
    const c = new BsktsClient({
      fetch: async () =>
        new Response(
          JSON.stringify({ ...response, action: { ...response.action, limit: "6000000" } }),
        ),
    });
    await expect(
      c.buildAgentTrade({
        owner,
        key: agent.address,
        ticker: "INDEX2",
        side: "buy",
        amountUsdg: 5,
      }),
    ).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });
  it.each(["0x63e5dFBEC475b3afA031be9031e73aCdb6F1d559", owner])(
    "refuses an INDEX2 response with substituted vault %s even under an allowlist",
    async (swapped) => {
      const c = new BsktsClient({
        policy: { allowedTickers: ["INDEX2"] },
        fetch: async () =>
          new Response(
            JSON.stringify({
              ...response,
              action: { ...response.action, vault: swapped },
            }),
          ),
      });
      await expect(
        c.buildAgentTrade({
          owner,
          key: agent.address,
          ticker: "INDEX2",
          side: "buy",
          amountUsdg: 6,
        }),
      ).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    },
  );
  it("accepts case-insensitive pinned addresses and rejects unknown baskets", () => {
    expect(
      schemas.agentTradePlan.parse({
        ...response,
        ticker: "index2",
        action: { ...response.action, vault: vault.toLowerCase() },
      }).ticker,
    ).toBe("index2");
    for (const ticker of ["NEW", "constructor", "__proto__"])
      expect(() => schemas.agentTradePlan.parse({ ...response, ticker })).toThrow(
        /reviewed basket/,
      );
  });
  it("accepts the grant's tighter slippage when the agent leaves it out", async () => {
    const tight = {
      ...response,
      status: { ...status, maxSlippageBps: 30 },
      action: { ...response.action, slippageBps: 30 },
    };
    const c = new BsktsClient({ fetch: async () => new Response(JSON.stringify(tight)) });
    const p = { owner, key: agent.address, ticker: "INDEX2", side: "buy", amountUsdg: 5 } as const;
    expect((await c.buildAgentTrade(p)).action.slippageBps).toBe(30);
    await expect(c.buildAgentTrade({ ...p, slippageBps: 20 })).rejects.toMatchObject({
      code: "BAD_RESPONSE",
    });
  });
  it("validates the pinned domain and parses action amounts as bigints", () => {
    expect(plan().action.nonce).toBe(123n);
    expect(() =>
      schemas.agentTradePlan.parse({ ...response, status: { ...status, chainId: 1 } }),
    ).toThrow();
    expect(() =>
      schemas.agentTradePlan.parse({ ...response, status: { ...status, module: owner } }),
    ).toThrow();
  });
});
