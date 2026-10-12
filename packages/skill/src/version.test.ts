import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 2026-10-12: skills.sh tracks an install by content hash, not a version, so
// the skill carries its own: SKILL.md's frontmatter (what people and ClawHub
// read) and SKILL_VERSION in the script (what `version` and `status` print).
// Read as text: importing the script would run its CLI.
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const source = read("./bskts.mjs");
const bundle = read("../../../skills/bskts/scripts/bskts.mjs");
const skill = read("../../../skills/bskts/SKILL.md");

const scriptVersion = (js: string) => /const SKILL_VERSION = "([^"]+)"/.exec(js)?.[1];
const frontmatter = skill.slice(0, skill.indexOf("\n---\n", 4));

describe("skill version", () => {
  it("is a semver in SKILL.md's frontmatter", () => {
    expect(frontmatter).toMatch(/^version: \d+\.\d+\.\d+$/m);
  });
  it("matches the script's SKILL_VERSION, in the source and the bundle", () => {
    const declared = /^version: (\S+)$/m.exec(frontmatter)?.[1];
    expect(scriptVersion(source)).toBe(declared);
    expect(scriptVersion(bundle)).toBe(declared);
  });
});
