#!/usr/bin/env node
// Refresh the vendored API contract in contract/: the bskts API's OpenAPI and
// one live response from each public read the SDK parses. The contract tests
// (packages/*/src/contract.test.ts) read these files, so CI stays offline.
//
// 2026-10-25: added after the 2026-10-24 limit-order release, where the SDK and
// the API disagreed three times (slippageBps optional in the SDK but required by
// the API, limitMinSlippageBps dropped by the SDK's zod objects, documented
// minimum arithmetic the API's check did not use) while each repo's own tests
// passed, because nothing compared them.
//
//   pnpm run contract:refresh   (node scripts/refresh-contract.mjs)
//
// Reads only public GET endpoints with no address in them: nothing personal is
// vendored. BSKTS_API_URL overrides the API (default https://api.bskts.xyz).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "oxfmt";

const base = (process.env.BSKTS_API_URL ?? "https://api.bskts.xyz").replace(/\/$/, "");
const out = fileURLToPath(new URL("../contract", import.meta.url));

async function get(path) {
  const res = await fetch(base + path, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}
// Through oxfmt itself, with the repo's settings, so a refresh leaves
// `pnpm run format:check` clean. 2026-10-27: plain JSON.stringify(v, null, 2)
// put every array on its own lines where oxfmt joins short ones, and
// format:check failed on openapi.json and nav-closes.json after a refresh.
// Fed indented, not compact: oxfmt keeps an object expanded only when its
// source breaks after the `{`, as `oxfmt` on the file would see it.
const {
  $schema: _,
  ignorePatterns: __,
  ...fmtOptions
} = JSON.parse(await readFile(fileURLToPath(new URL("../.oxfmtrc.json", import.meta.url)), "utf8"));
async function write(file, v) {
  const { code, errors } = await format(file, JSON.stringify(v, null, 2), fmtOptions);
  if (errors.length) throw new Error(`oxfmt could not format ${file}: ${errors[0].message}`);
  await writeFile(join(out, file), code);
}

await mkdir(join(out, "responses"), { recursive: true });
await write("openapi.json", await get("/openapi.json"));

// Full rows (no `fields`): the point is to see every key the API sends, so a
// new one the SDK's schemas would strip fails the test.
const baskets = await get("/v1/baskets");
const ticker = baskets.indexes?.[0]?.ticker;
if (!ticker) throw new Error("/v1/baskets listed no basket");
const responses = {
  baskets,
  markets: await get("/v1/markets"),
  basket: await get(`/v1/baskets/${ticker}`),
  stats: await get("/v1/stats"),
  "nav-history": await get(`/v1/nav/${ticker}/history?res=1d&days=3`),
  "nav-summary": await get(`/v1/nav/${ticker}/history?format=summary&days=7`),
  "nav-closes": await get(`/v1/nav/${ticker}/history?format=close&res=1d&days=7`),
  "cover-weeks": await get("/v1/cover/weeks"),
  "cover-book": await get(`/v1/cover/book/${ticker}`),
  // 2026-10-27: read by the skill's update check (packages/skill/src/update.mjs)
  "agent-skill": await get("/v1/agent/skill"),
  // 2026-10-27 (bskts agent audit F7): the API pages jobs and says whether a
  // list is complete; vendored so a field the SDK drops fails a test. Only
  // public jobs: order ids, vaults and calldata, nothing personal.
  jobs: await get("/v1/jobs"),
};
for (const [name, body] of Object.entries(responses)) await write(`responses/${name}.json`, body);
console.log(`contract refreshed from ${new URL(base).host} into ${out} (basket ${ticker})`);
