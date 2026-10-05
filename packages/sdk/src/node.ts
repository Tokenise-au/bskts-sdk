// 2026-10-05: keep fs out of the neutral SDK entry used by Cloudflare/MCP.
// This adapter writes only public plans and outcomes, never signing material.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SessionStore } from "./session-once";

const code = (e: unknown) => (e as NodeJS.ErrnoException).code;
function read(path: string): unknown | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if (code(e) === "ENOENT") return undefined;
    throw new Error("Cannot read the session journal; retain it and reconcile before a new trade.");
  }
}
function create(path: string, record: unknown): boolean {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (e) {
    if (code(e) === "EEXIST") return false;
    throw e;
  }
  try {
    writeFileSync(
      fd,
      JSON.stringify(record, (_, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n",
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // POSIX needs the directory entry flushed too. Windows does not allow
  // opening directories this way; fsync still flushes the file's contents.
  if (process.platform !== "win32") {
    // Flush ancestor entries too: mkdir may have created the journal folder,
    // and a competing process can win reserve after that creation.
    let parent = dirname(path);
    for (;;) {
      const directory = openSync(parent, "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }
  return true;
}
/** Retain both files, even after success. Exclusive creation arbitrates
 * concurrent starts without a stale PID lock after an abrupt process exit.
 * A partial/corrupt journal fails closed and is never overwritten. */
export function fileSessionStore(path: string): SessionStore {
  const record = resolve(path);
  const result = `${record}.result`;
  return {
    load: async () => read(record),
    loadOutcome: async () => read(result),
    reserve: async (pending) => create(record, pending),
    complete: async (outcome) => {
      create(result, outcome);
    },
  };
}
