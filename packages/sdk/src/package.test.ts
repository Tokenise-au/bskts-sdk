// The published manifests' dependency ranges (2026-09-30). @bskts/sdk@0.3.0
// shipped with its viem peer pinned to exactly "2.30.0": a `node -e` edit run
// through Volta's shim on Windows went via cmd, which ate the `^` as an escape
// character. No install could satisfy it next to any other viem. A peer must be
// a range, and the MCP server must accept SDK patch releases.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = (pkg: string) =>
  JSON.parse(readFileSync(new URL(`../../${pkg}/package.json`, import.meta.url), "utf8")) as {
    peerDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  };

describe("published dependency ranges", () => {
  it("keeps every SDK peer dependency a caret range", () => {
    const peers = manifest("sdk").peerDependencies ?? {};
    expect(Object.keys(peers)).toContain("viem");
    for (const [name, range] of Object.entries(peers))
      expect(range, `peer ${name}`).toMatch(/^\^\d+\.\d+\.\d+$/);
  });
  it("asks for viem no newer than it needs", () => {
    // 2.55.0 is the first viem with the `robinhood` chain the SDK re-exports.
    // 0.3.1 asked for ^2.57.0, which the bskts app (pinned to 2.55.19) could
    // not satisfy without a viem upgrade it had no reason for.
    expect(manifest("sdk").peerDependencies?.["viem"]).toBe("^2.55.0");
    expect(manifest("mcp").dependencies?.["viem"]).toBe("^2.55.0");
  });
  it("lets the MCP server take SDK patch releases", () => {
    expect(manifest("mcp").dependencies?.["@bskts/sdk"]).toBe("workspace:^");
  });
});
