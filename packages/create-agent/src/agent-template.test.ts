import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { existsSync, mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BsktsError, executeSessionOnce, sessionActionState, schemas } from "../../sdk/src/index";
import { fileSessionStore } from "../../sdk/src/node";
import { agentTemplate } from "./agent-template";

// 2026-10-05: execute the generated source twice against a fake chain and
// relayer, retaining real journal files. A text assertion missed repeat buys.
describe("generated agent restarts", () => {
  // 2026-10-11: npm start is a dry run; only --live (npm run live) sends.
  it.each([
    { live: true, lost: false },
    { live: true, lost: true },
    { live: false, lost: false },
  ])("live=$live lost=$lost: at most one buy, and none without --live", async ({ live, lost }) => {
    const directory = mkdtempSync(join(tmpdir(), "bskts-starter-restart-"));
    const path = join(directory, "trade.json");
    const agent = privateKeyToAccount(generatePrivateKey());
    const owner = "0x1111111111111111111111111111111111111111";
    const account = "0x2222222222222222222222222222222222222222";
    const relayerUrl = "https://bskts.xyz/relay/v1/account/execute";
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
      relayerUrl,
      revokeEffect: "Cancel existing orders separately.",
    };
    const plan = schemas.agentTradePlan.parse({
      ticker: "INDEX2",
      status,
      action: {
        account,
        key: agent.address,
        kind: 0,
        vault: "0xC02b7A59846B77d0b1d0cfE8943D32c279ED292a",
        amount: "100000000000000",
        limit: "5000000",
        slippageBps: 50,
        data: "0x",
        nonce: "321",
        deadline: Math.floor(Date.now() / 1000) + 300,
        fee: "0",
      },
      relayerUrl,
      simulation: { ok: null, skipped: "Unsigned" },
    });
    const build = vi.fn(async () => plan);
    const permission = vi.fn(async () => status);
    let used = false;
    const submit = vi.fn(async () => {
      used = true;
      if (lost) throw new BsktsError("Response lost after broadcasting", "NETWORK");
      return { hash: `0x${"11".repeat(32)}` as const, blockNumber: 1, gasUsed: 100 };
    });
    const messages: unknown[][] = [];
    const source = agentTemplate().replace(/^import .*;\r?\n/gm, "");
    const run = () =>
      runInNewContext(`(async () => {${source}})()`, {
        process: {
          env: { BSKTS_OWNER: owner, AGENT_KEY: "test-marker" },
          argv: ["node", "agent.mjs", ...(live ? ["--live"] : [])],
        },
        privateKeyToAccount: () => agent,
        BsktsClient: class {
          agentSession = permission;
          buildAgentTrade = build;
        },
        executeSessionOnce,
        sessionActionState,
        fileSessionStore: () => fileSessionStore(path),
        sessionRelayer: () => submit,
        createPublicClient: () => ({
          getChainId: async () => 4663,
          getBlock: async () => ({
            number: 123n,
            timestamp: BigInt(Math.floor(Date.now() / 1000)),
          }),
          readContract: async () => used,
        }),
        robinhood: {},
        http: () => undefined,
        console: { log: (...args: unknown[]) => messages.push(args) },
      });
    try {
      if (lost) await expect(run()).rejects.toMatchObject({ code: "NETWORK" });
      else await run();
      await run();
      if (live) {
        expect(submit).toHaveBeenCalledTimes(1);
        expect(build).toHaveBeenCalledTimes(1);
        expect(permission).toHaveBeenCalledTimes(1);
        if (lost) expect(messages.flat().join(" ")).toContain("no additional trade");
      } else {
        // each dry run builds and simulates; nothing is signed, sent or journalled
        expect(submit).not.toHaveBeenCalled();
        expect(build).toHaveBeenCalledTimes(2);
        expect(existsSync(path)).toBe(false);
        expect(messages.flat().join(" ")).toContain("Nothing was sent");
      }
    } finally {
      for (const file of [path, `${path}.result`]) if (existsSync(file)) unlinkSync(file);
      rmdirSync(directory);
    }
  });
});
