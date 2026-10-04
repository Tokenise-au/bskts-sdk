#!/usr/bin/env node
// npm create @bskts/agent [dir] [--owner 0x…] [--no-install]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { newPrivateKey, ownerAddress, packageManager, parseArgs, starterFiles } from "./scaffold";

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = resolve(opts.dir);
  if (existsSync(dir) && readdirSync(dir).length > 0)
    throw new Error(`${opts.dir} already exists and isn't empty. Pick another folder name.`);

  let owner = opts.owner;
  if (!owner) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    owner = await rl.question("Your wallet address (the bskts account owner, 0x…): ");
    rl.close();
  }
  const address = ownerAddress(owner);

  mkdirSync(dir, { recursive: true });
  const files = starterFiles({ name: basename(dir), owner: address, key: newPrivateKey() });
  for (const [path, content] of Object.entries(files))
    // 0o600 for .env: the key is readable by its owner only (ignored on Windows)
    writeFileSync(join(dir, path), content, path === ".env" ? { mode: 0o600 } : {});
  console.log(`\nCreated ${opts.dir} with a new agent key in .env (not shown; keep it private).`);

  const pm = packageManager(process.env["npm_config_user_agent"]);
  if (opts.install) {
    console.log(`Installing with ${pm}...`);
    // Windows needs a shell to find npm.cmd; one fixed string, so nothing is
    // concatenated into it (Node 24 warns on args plus shell: DEP0190)
    const r =
      process.platform === "win32"
        ? spawnSync(`${pm} install`, { cwd: dir, stdio: "inherit", shell: true })
        : spawnSync(pm, ["install"], { cwd: dir, stdio: "inherit" });
    if (r.status !== 0) console.log(`Install failed: run "${pm} install" in ${opts.dir}.`);
  }
  console.log(`
Next:
  cd ${opts.dir}
  ${pm === "npm" ? "npm start" : `${pm} start`}

It prints the agent's address and a link to approve it in bskts, waits while
you approve, then buys $6 of INDEX2 once. Guide: https://bskts.xyz/docs#agents
`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
