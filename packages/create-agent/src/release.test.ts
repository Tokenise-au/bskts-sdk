import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 2026-10-04: the release script's package list is written by hand, and
// create-agent's 0.2.0 was never staged because it wasn't on it.
const root = join(__dirname, "../../..");

describe("release", () => {
  it("stages every package that is published", () => {
    const script = readFileSync(join(root, "scripts/stage-publish.mjs"), "utf8");
    const listed = [...script.matchAll(/"(packages\/[a-z-]+)"/g)].map((m) => m[1]);
    const published = readdirSync(join(root, "packages"))
      .map((dir) => `packages/${dir}`)
      .filter((dir) => {
        const pkg = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
        return !pkg.private;
      });
    expect(listed.sort()).toEqual(published.sort());
  });
});
