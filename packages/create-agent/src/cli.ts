#!/usr/bin/env node
// npm create @bskts/agent [dir] [-- --owner 0x… --no-install --no-start]
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  newPrivateKey,
  ownerAddress,
  packageManager,
  parseArgs,
  starterFiles,
  walletOfAccount,
} from "./scaffold";

/** Runs `pm <script>` in `cwd`. Windows needs a shell to find npm.cmd; one fixed
 * string, so nothing is concatenated into it (Node 24 warns on args plus shell). */
const run = (pm: string, script: string, cwd: string): SpawnSyncReturns<Buffer> =>
  process.platform === "win32"
    ? spawnSync(`${pm} ${script}`, { cwd, stdio: "inherit", shell: true })
    : spawnSync(pm, [script], { cwd, stdio: "inherit" });

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = resolve(opts.dir);
  if (existsSync(dir) && readdirSync(dir).length > 0)
    throw new Error(`${opts.dir} already exists and isn't empty. Pick another folder name.`);
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;

  let owner = opts.owner;
  if (!owner) {
    if (!interactive)
      throw new Error("Pass your wallet address: npm create @bskts/agent -- --owner 0x…");
    console.log(
      "\nTip: bskts → Portfolio → Agents gives you this command with your wallet already filled in.",
    );
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    owner = await rl.question("Your wallet address (the one you log in to bskts with, 0x…): ");
    rl.close();
  }
  let address = ownerAddress(owner);
  // the bskts account's address in place of its owner's wallet: certain to be
  // wrong, and certain what was meant, so correct it and say so
  const wallet = await walletOfAccount(address);
  if (wallet) {
    console.log(`\n${address} is your bskts account. Using its owner wallet, ${wallet}.`);
    address = wallet;
  }

  mkdirSync(dir, { recursive: true });
  const files = starterFiles({ name: basename(dir), owner: address, key: newPrivateKey() });
  for (const [path, content] of Object.entries(files))
    // 0o600 for .env: the key is readable by its owner only (ignored on Windows)
    writeFileSync(join(dir, path), content, path === ".env" ? { mode: 0o600 } : {});
  console.log(
    `\nCreated ${opts.dir}. The agent's new key is in .env (not shown; keep it private).`,
  );

  const pm = packageManager(process.env["npm_config_user_agent"]);
  let installed = !opts.install;
  if (opts.install) {
    console.log(`Installing with ${pm}...`);
    installed = run(pm, "install", dir).status === 0;
    if (!installed) console.log(`Install failed: run "${pm} install" in ${opts.dir}.`);
  }
  const start = pm === "npm" ? "npm start" : `${pm} start`;

  // 2026-10-04: start it here, so one command takes the owner to the approval.
  // Not when piped or scripted: nobody would see the link it prints.
  if (opts.start && opts.install && installed && interactive) {
    console.log(`
Starting your agent (the first start can take a minute). It prints a link to
approve it in bskts, waits while you do, then DRY RUNS a $6 buy of INDEX2:
nothing is sent. Ctrl+C stops it; later, run "${start}" in ${opts.dir}, and
"${pm} run live" to send the buy for real.
`);
    process.exitCode = run(pm, "start", dir).status ?? 1;
    return;
  }
  console.log(`
Next:
  cd ${opts.dir}
  ${start}

It prints the agent's address and a link to approve it in bskts, waits while
you approve, then dry runs a $6 buy of INDEX2: nothing is sent until you run
"${pm} run live". Guide: https://bskts.xyz/docs#agents
`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
