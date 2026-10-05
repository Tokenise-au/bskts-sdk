import vaults from "./agent-vaults.json";

// 2026-10-05: trusting the plan's ticker let an INDEX2 allowlist sign another
// basket's vault. These API addresses were reviewed against the app's canonical
// contracts.ts; a new or redeployed basket needs reviewed pins and an SDK release.
const pins: Readonly<Record<string, string>> = Object.freeze(vaults);

export function isAgentVault(ticker: string, vault: string): boolean {
  const name = ticker.toUpperCase();
  return Object.hasOwn(pins, name) && pins[name]!.toLowerCase() === vault.toLowerCase();
}
