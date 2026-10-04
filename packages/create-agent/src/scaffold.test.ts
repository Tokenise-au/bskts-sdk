import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  agentScript,
  newPrivateKey,
  ownerAddress,
  packageManager,
  parseArgs,
  starterFiles,
} from "./scaffold";

const owner = "0xaC0DD3d0E58FbC7Ba8B2d7d96DE595DBdc6a2fcf";

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

describe("files", () => {
  const key = newPrivateKey();
  const files = starterFiles({ name: "my-agent", owner, key });
  it("puts the key in .env only, and ignores .env in git", () => {
    for (const [path, content] of Object.entries(files))
      expect(content.includes(key)).toBe(path === ".env");
    expect(files[".env"]).toContain(`AGENT_KEY=${key}\n`);
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
    expect(pkg.dependencies["@bskts/sdk"]).toMatch(/^\^0\.4\./);
  });
  it("fills in the owner, waits for approval and caps the network fee", () => {
    const script = agentScript(owner);
    expect(script).toContain(`const owner = "${owner}";`);
    expect(script).toContain("Waiting for your approval");
    expect(script).toContain("maxNetworkFeeUsdg: 250_000n");
    expect(script).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });
});

describe("arguments", () => {
  it("reads the folder, owner and --no-install", () => {
    expect(parseArgs([])).toEqual({ dir: "bskts-agent", install: true });
    expect(parseArgs(["bot", "--owner", owner, "--no-install"])).toEqual({
      dir: "bot",
      owner,
      install: false,
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
