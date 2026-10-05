import { describe, expect, it } from "vitest";
import { encodeAbiParameters, toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ACCOUNT_FACTORY,
  ACCOUNT_OF,
  GET_OWNERS,
  agentScript,
  newPrivateKey,
  ownerAddress,
  packageManager,
  parseArgs,
  starterFiles,
  walletOfAccount,
  type EthCall,
} from "./scaffold";

const owner = "0xaC0DD3d0E58FbC7Ba8B2d7d96DE595DBdc6a2fcf";
const account = "0x9f7024a8D7EC42E5aa2b098be79afF00Cf14C6ea";
const other = "0x1111111111111111111111111111111111111111";

describe("agent key", () => {
  it("is a valid secp256k1 private key, fresh each time", () => {
    const a = newPrivateKey();
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(() => privateKeyToAccount(a)).not.toThrow();
    expect(newPrivateKey()).not.toBe(a);
  });
  it("redraws a zero or out-of-range draw instead of writing it", () => {
    const draws = [new Uint8Array(32), new Uint8Array(32).fill(0xff), new Uint8Array(32).fill(1)];
    expect(newPrivateKey(() => draws.shift()!)).toBe(`0x${"01".repeat(32)}`);
  });
});

describe("owner address", () => {
  it("accepts a public address", () => expect(ownerAddress(` ${owner} `)).toBe(owner));
  it.each([`0x${"a".repeat(64)}`, "b".repeat(64), Array(12).fill("abandon").join(" ")])(
    "refuses a private key or recovery phrase %#",
    (v) => expect(() => ownerAddress(v)).toThrow("private key"),
  );
  it.each([undefined, "", "0x123", "vitalik.eth"])("refuses %s", (v) =>
    expect(() => ownerAddress(v)).toThrow("public address"),
  );
});

describe("a bskts account's address pasted for the wallet", () => {
  const owners = (list: string[]) =>
    encodeAbiParameters([{ type: "address[]" }], [list as `0x${string}`[]]);
  const accountOfIs = (a: string) =>
    encodeAbiParameters([{ type: "address" }], [a as `0x${string}`]);
  /** A chain where `account` is a 1-of-1 Safe of `safeOwners`, and the factory
   * maps its first owner to `factoryAccount`. */
  const chain =
    (safeOwners: string[] | null, factoryAccount: string): EthCall =>
    async (to, data) => {
      if (data === GET_OWNERS) {
        if (to.toLowerCase() !== account.toLowerCase() || !safeOwners) return "0x";
        return owners(safeOwners);
      }
      expect(to).toBe(ACCOUNT_FACTORY);
      expect(data.slice(0, 10)).toBe(ACCOUNT_OF);
      return accountOfIs(factoryAccount);
    };

  it("uses selectors that match the contracts' functions", () => {
    expect(GET_OWNERS).toBe(toFunctionSelector("getOwners()"));
    expect(ACCOUNT_OF).toBe(toFunctionSelector("accountOf(address)"));
  });
  it("finds the owner's wallet when the factory confirms the account is theirs", async () => {
    expect(await walletOfAccount(account, chain([owner], account))).toBe(owner.toLowerCase());
  });
  it.each([
    ["a wallet (no code)", null, account],
    ["a Safe with two owners", [owner, other], account],
    ["a 1-of-1 Safe the factory didn't make for that owner", [owner], other],
  ])("leaves %s alone", async (_, safeOwners, factoryAccount) => {
    expect(
      await walletOfAccount(account, chain(safeOwners as string[] | null, factoryAccount)),
    ).toBe(undefined);
  });
  it("never blocks setup when the chain can't be read", async () => {
    expect(
      await walletOfAccount(account, async () => {
        throw new Error("offline");
      }),
    ).toBe(undefined);
  });
});

describe("files", () => {
  const key = newPrivateKey();
  const files = starterFiles({ name: "my-agent", owner, key });
  it("keeps the key and the owner's address in .env only, out of git", () => {
    for (const [path, content] of Object.entries(files)) {
      expect(content.includes(key)).toBe(path === ".env");
      expect(content.includes(owner)).toBe(path === ".env");
    }
    expect(files[".env"]).toContain(`AGENT_KEY=${key}\n`);
    expect(files[".env"]).toContain(`BSKTS_OWNER=${owner}\n`);
    expect(files[".gitignore"]).toContain(".env");
  });
  it("starts with npm start, on the published SDK", () => {
    const pkg = JSON.parse(files["package.json"]);
    expect(pkg).toMatchObject({
      name: "my-agent",
      private: true,
      type: "module",
      scripts: { start: "node --env-file=.env agent.mjs" },
    });
    expect(pkg.dependencies["@bskts/sdk"]).toBe("^0.5.0");
    expect(pkg.engines.node).toBe(">=20.19");
    expect(files[".gitignore"]).toContain(".bskts-agent/");
  });
  it("reads the owner from .env, waits for approval and caps the network fee", () => {
    const script = agentScript();
    expect(script).toContain("const owner = process.env.BSKTS_OWNER;");
    expect(script).toContain("Waiting for your approval");
    expect(script).toContain("maxNetworkFeeUsdg: 250_000n");
    expect(script).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });
});

describe("arguments", () => {
  it("reads the folder, owner, --no-install and --no-start", () => {
    expect(parseArgs([])).toEqual({ dir: "bskts-agent", install: true, start: true });
    expect(parseArgs(["bot", "--owner", owner, "--no-install", "--no-start"])).toEqual({
      dir: "bot",
      owner,
      install: false,
      start: false,
    });
    expect(parseArgs([`--owner=${owner}`]).owner).toBe(owner);
    expect(() => parseArgs(["--key", "x"])).toThrow("Unknown option");
  });
  it("installs with the package manager it was run from", () => {
    expect(packageManager("pnpm/10.32.1 npm/? node/v24.21.0 win32 x64")).toBe("pnpm");
    expect(packageManager("npm/10.9.0 node/v22 darwin arm64")).toBe("npm");
    expect(packageManager(undefined)).toBe("npm");
  });
});
