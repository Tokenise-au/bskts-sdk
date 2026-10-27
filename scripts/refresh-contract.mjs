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
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const base = (process.env.BSKTS_API_URL ?? "https://api.bskts.xyz").replace(/\/$/, "");
const out = fileURLToPath(new URL("../contract", import.meta.url));

async function get(path) {
  const res = await fetch(base + path, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}
// oxfmt's JSON style, so a refresh leaves `pnpm run format:check` clean
const write = (file, v) => writeFile(join(out, file), JSON.stringify(v, null, 2) + "\n");

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
};
for (const [name, body] of Object.entries(responses)) await write(`responses/${name}.json`, body);
console.log(`contract refreshed from ${new URL(base).host} into ${out} (basket ${ticker})`);
