// Stage every package version that is not on npm yet (the release workflow's
// publish step). Staged, not published: the trusted publisher for each package
// is stage-only, so a version goes live only when a maintainer approves it with
// 2FA (npmjs.com, or `npm stage approve <stage-id>`). A compromised repo or
// workflow can stage a version; it cannot ship one.
//
// Each package is packed with pnpm first, which turns `workspace:*` (the MCP
// server's dependency on the SDK) into the real version; npm then stages the
// tarball. Order matters for approval, not for staging: approve @bskts/sdk
// before @bskts/mcp, whose dependency on it resolves only once it is live.
//
//   node scripts/stage-publish.mjs            # stage what is new
//   node scripts/stage-publish.mjs --dry-run  # say what it would stage
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DRY = process.argv.includes("--dry-run");
// dependencies first: the SDK before the MCP server
const PACKAGES = ["packages/sdk", "packages/mcp"];

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

/** true when `name@version` is live on the registry */
function isPublished(name, version) {
  try {
    return run("npm", ["view", `${name}@${version}`, "version"]).trim() === version;
  } catch {
    return false; // E404: no such package or version
  }
}

/** true when `name@version` is already staged and waiting for approval */
function isStaged(name, version) {
  try {
    const staged = JSON.parse(run("npm", ["stage", "list", name, "--json"]) || "[]");
    return staged.some((s) => JSON.stringify(s).includes(`"${version}"`));
  } catch {
    return false;
  }
}

const out = mkdtempSync(join(tmpdir(), "bskts-stage-"));
let staged = 0;
for (const dir of PACKAGES) {
  const {
    name,
    version,
    private: isPrivate,
  } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  if (isPrivate) continue;
  if (isPublished(name, version)) {
    console.log(`${name}@${version}: already on npm`);
    continue;
  }
  if (isStaged(name, version)) {
    console.log(`${name}@${version}: already staged, waiting for approval`);
    continue;
  }
  const before = new Set(readdirSync(out));
  run("pnpm", ["pack", "--pack-destination", out], { cwd: dir });
  const tarball = readdirSync(out).find((f) => !before.has(f));
  if (!tarball) throw new Error(`pnpm pack wrote no tarball for ${name}`);
  if (DRY) {
    console.log(`${name}@${version}: would stage ${tarball}`);
    continue;
  }
  run("npm", ["stage", "publish", join(out, tarball), "--access", "public"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  console.log(`${name}@${version}: staged. Approve it on npmjs.com to publish.`);
  staged++;
}
if (staged)
  console.log(
    `\n${staged} version(s) staged. Approve @bskts/sdk before @bskts/mcp (the server depends on it).`,
  );
