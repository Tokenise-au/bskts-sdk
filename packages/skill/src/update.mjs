// 2026-10-27: an installed skill finds out a newer one is out. Fen, a live
// agent, ran 1.0.0 for two weeks after 1.1.0 added limit orders: nothing told
// its owner, and the skills CLI only updates when a person runs it. `status`
// and `version` now ask the bskts API for the latest release and, when this
// copy is behind, say so for the agent to pass on.
//
// Only the version number is taken from the API. The commands are fixed here,
// and no text from the response reaches the model: what the agent relays to
// its owner can't be steered by whatever the endpoint returns.

export const UPDATE_COMMAND = "npx skills update bskts -g";
export const REINSTALL_COMMAND = "npx skills add Tokenise-au/bskts-sdk --skill bskts -g";
export const WHATS_NEW = "https://bskts.xyz/account/agents";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** Below 0, 0 or above 0 as `a` is older than, equal to or newer than `b`. */
export function compareVersions(a, b) {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) throw new Error(`not a version: ${x ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return d;
  }
  return 0;
}

/** The `update` block for `status`, or undefined when this copy is current or
 *  the release can't be read: an update check never fails a command. */
export function updateView(current, release) {
  const latest = release && typeof release === "object" ? release.latest : undefined;
  if (typeof latest !== "string" || !SEMVER.test(latest)) return undefined;
  if (compareVersions(latest, current) <= 0) return undefined;
  return {
    current,
    latest,
    command: UPDATE_COMMAND,
    reinstall: REINSTALL_COMMAND,
    whatsNew: WHATS_NEW,
  };
}

/** GET /v1/agent/skill, or undefined if it doesn't answer within 3 s. */
export async function latestRelease(baseUrl, fetchFn = fetch) {
  try {
    const res = await fetchFn(`${baseUrl}/v1/agent/skill`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}
