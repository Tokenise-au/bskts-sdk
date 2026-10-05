import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { type PublicClient } from "viem";
import { BsktsError, schemas, type SessionSender } from "./index";
import { executeSessionOnce, sessionActionState, type SessionStore } from "./session-once";
import { fileSessionStore } from "./node";
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agent = privateKeyToAccount(generatePrivateKey());
const owner = "0x1111111111111111111111111111111111111111" as const;
const account = "0x2222222222222222222222222222222222222222" as const;
const relayerUrl = "https://bskts.xyz/relay/v1/account/execute";
const plan = () =>
  schemas.agentTradePlan.parse({
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
      usdgWei: "100000000",
      dailyLimitUsdg: "10000000",
      remainingTodayUsdg: "10000000",
      maxSlippageBps: 50,
      validUntil: Math.floor(Date.now() / 1000) + 604800,
      approvalUrl: "https://bskts.xyz/portfolio?p=agents",
      relayerUrl,
      revokeEffect: "Cancel existing orders separately.",
    },
    action: {
      account,
      key: agent.address,
      kind: 0,
      vault: "0xC02b7A59846B77d0b1d0cfE8943D32c279ED292a",
      amount: "100000000000000",
      limit: "5000000",
      slippageBps: 50,
      data: "0x",
      nonce: "123",
      deadline: Math.floor(Date.now() / 1000) + 300,
      fee: "0",
    },
    relayerUrl,
    simulation: { ok: null, skipped: "Unsigned" },
  });
const receipt = { hash: `0x${"11".repeat(32)}` as const, blockNumber: 1, gasUsed: 100 };
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
function memory() {
  let record: unknown;
  let result: unknown;
  const store: SessionStore = {
    load: vi.fn(async () => record),
    loadOutcome: vi.fn(async () => result),
    reserve: vi.fn(async (value) => {
      if (record !== undefined) return false;
      record = json(value);
      return true;
    }),
    complete: vi.fn(async (value) => {
      result = json(value);
    }),
  };
  return store;
}
function host(submit: SessionSender["submit"] = async () => receipt): SessionSender {
  return {
    key: agent.address,
    sign: vi.fn((data) => agent.signTypedData(data)),
    submit: vi.fn(submit),
  };
}
const args = (store: SessionStore, sender = host()) => ({
  store,
  sender,
  build: vi.fn(async () => plan()),
  maxNetworkFeeUsdg: 250_000n,
  reconcile: vi.fn(async () => "pending" as const),
});

describe("durable delegated execution", () => {
  it("saves before signing and remembers a completed first trade across starts", async () => {
    const store = memory();
    const sender = host();
    sender.sign = vi.fn(async (data) => {
      expect(await store.load()).toBeDefined();
      return agent.signTypedData(data);
    });
    const a = args(store, sender);
    expect(await executeSessionOnce(a)).toEqual({ state: "confirmed", receipt });
    const restarted = args(store);
    expect(await executeSessionOnce(restarted)).toEqual({ state: "confirmed", receipt });
    expect(restarted.build).not.toHaveBeenCalled();
    expect(restarted.sender.sign).not.toHaveBeenCalled();
    expect(restarted.sender.submit).not.toHaveBeenCalled();
  });
  it("retains an uncertain nonce across a restart, then reconciles consumption without another buy", async () => {
    const store = memory();
    const a = args(
      store,
      host(async () => {
        throw new BsktsError("Response lost", "NETWORK");
      }),
    );
    await expect(executeSessionOnce(a)).rejects.toMatchObject({
      code: "NETWORK",
      message: expect.stringContaining("nonce 123"),
    });
    const restarted = args(store);
    await expect(executeSessionOnce(restarted)).rejects.toMatchObject({ code: "UNCERTAIN" });
    expect(restarted.build).not.toHaveBeenCalled();
    expect(restarted.sender.sign).not.toHaveBeenCalled();
    expect(restarted.sender.submit).not.toHaveBeenCalled();
    const resolved = { ...restarted, reconcile: vi.fn(async () => "consumed" as const) };
    expect(await executeSessionOnce(resolved)).toEqual({ state: "consumed" });
    expect(await executeSessionOnce(restarted)).toEqual({ state: "consumed" });
  });
  it("retains expiry as a terminal result instead of rebuilding", async () => {
    const store = memory();
    await store.reserve({ version: 1, plan: plan(), maxNetworkFeeUsdg: 250000n });
    const a = { ...args(store), reconcile: vi.fn(async () => "expired" as const) };
    expect(await executeSessionOnce(a)).toEqual({ state: "expired" });
    expect(a.build).not.toHaveBeenCalled();
    expect(a.sender.sign).not.toHaveBeenCalled();
  });
  it("never signs if durable reservation fails", async () => {
    const a = args(memory());
    a.store.reserve = async () => {
      throw new Error("Disk full");
    };
    await expect(executeSessionOnce(a)).rejects.toThrow("Disk full");
    expect(a.sender.sign).not.toHaveBeenCalled();
    expect(a.sender.submit).not.toHaveBeenCalled();
  });
  it("arbitrates concurrent starts with only one submitter", async () => {
    const store = memory();
    const sender = host();
    const a = args(store, sender);
    const results = await Promise.allSettled([
      executeSessionOnce(a),
      executeSessionOnce(args(store, sender)),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(sender.submit).toHaveBeenCalledTimes(1);
  });
  it("does not rebuild when reconciliation is offline or the journal is corrupt", async () => {
    const store = memory();
    await store.reserve({ version: 1, plan: plan(), maxNetworkFeeUsdg: 250000n });
    const a = {
      ...args(store),
      reconcile: async () => {
        throw new Error("offline");
      },
    };
    await expect(executeSessionOnce(a)).rejects.toThrow("offline");
    expect(a.build).not.toHaveBeenCalled();
    const bad = args({ ...store, load: async () => ({ invalid: true }) });
    await expect(executeSessionOnce(bad)).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    expect(bad.build).not.toHaveBeenCalled();
  });
  it("does not accept another key's journal", async () => {
    const store = memory();
    await store.reserve({ version: 1, plan: plan(), maxNetworkFeeUsdg: 250000n });
    const sender = { ...host(), key: owner };
    await expect(executeSessionOnce(args(store, sender))).rejects.toMatchObject({
      code: "BAD_RESPONSE",
    });
    expect(sender.sign).not.toHaveBeenCalled();
  });
  it("recovers a lost success receipt when completing the journal fails", async () => {
    const store = memory();
    const complete = store.complete;
    store.complete = async () => {
      throw new Error("Disk full");
    };
    await expect(executeSessionOnce(args(store))).rejects.toMatchObject({ code: "UNCERTAIN" });
    store.complete = complete;
    const a = { ...args(store), reconcile: async () => "consumed" as const };
    expect(await executeSessionOnce(a)).toEqual({ state: "consumed" });
    expect(a.sender.submit).not.toHaveBeenCalled();
  });
});

describe("nonce reconciliation", () => {
  const action = () => ({ ...plan().action, deadline: 100 });
  function rpc(used: boolean, timestamp: bigint) {
    return {
      getChainId: vi.fn(async () => 4663),
      getBlock: vi.fn(async () => ({ number: 123456n, timestamp })),
      readContract: vi.fn(async () => used),
    };
  }
  it.each([
    [true, 99n, "consumed"],
    [false, 100n, "pending"],
    [false, 101n, "expired"],
  ] as const)("reads used=%s at timestamp %s as %s", async (used, timestamp, state) => {
    const client = rpc(used, timestamp);
    expect(await sessionActionState(client as unknown as PublicClient, action())).toBe(state);
    expect(client.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: schemas.SESSION_MODULE,
        blockNumber: 123456n,
        args: [account, 123n],
      }),
    );
  });
  it("refuses another chain before reading nonce state", async () => {
    const client = rpc(true, 99n);
    client.getChainId = vi.fn(async () => 1);
    await expect(
      sessionActionState(client as unknown as PublicClient, action()),
    ).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    expect(client.readContract).not.toHaveBeenCalled();
  });
});

describe("file session store", () => {
  it("exclusively reserves on disk, survives a new adapter and retains completed records", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bskts-journal-"));
    const path = join(dir, "trade.json");
    try {
      const store = fileSessionStore(path);
      const record = { version: 1 as const, plan: plan(), maxNetworkFeeUsdg: 250000n };
      expect(await store.reserve(record)).toBe(true);
      expect(await fileSessionStore(path).reserve(record)).toBe(false);
      expect((await fileSessionStore(path).load()) as object).toMatchObject({
        plan: { action: { nonce: "123" } },
      });
      const text = readFileSync(path, "utf8");
      expect(text).not.toContain("signature");
      expect(text).not.toContain("privateKey");
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
      await store.complete({ state: "confirmed", receipt });
      await fileSessionStore(path).complete({ state: "expired" });
      expect(await fileSessionStore(path).loadOutcome()).toEqual({ state: "confirmed", receipt });
      expect(readFileSync(path, "utf8")).toBe(text);
      writeFileSync(path, "partial");
      await expect(fileSessionStore(path).load()).rejects.toThrow("retain it");
    } finally {
      unlinkSync(path);
      unlinkSync(`${path}.result`);
      rmdirSync(dir);
    }
  });
});
