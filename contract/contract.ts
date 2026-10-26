// Shared by the contract tests (packages/sdk/src/contract.test.ts and
// packages/mcp/src/contract.test.ts): the vendored bskts API contract, a JSON
// Schema check for the request bodies the SDK sends, and the boundary cases a
// request schema implies. Refresh the files with `node scripts/refresh-contract.mjs`.
//
// 2026-10-25: each repo's own tests passed through three SDK/API mismatches in
// the 2026-10-24 release (an optional slippageBps the API required, a response
// field the SDK stripped, minimum arithmetic). These tests compare the two.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACT_DIR = fileURLToPath(new URL(".", import.meta.url));

export type Schema = { [k: string]: unknown };
export const readContract = (file: string): unknown =>
  JSON.parse(readFileSync(join(CONTRACT_DIR, file), "utf8"));
export const openapi = () =>
  readContract("openapi.json") as { components: { schemas: Record<string, Schema> } };
export const requestSchema = (name: string): Schema => {
  const s = openapi().components.schemas[name];
  if (!s) throw new Error(`the API's OpenAPI has no components.schemas.${name}`);
  return s;
};

// Keywords the checker below enforces, and ones that only annotate. Anything
// else throws: a constraint the API adds must not be silently passed.
const ANNOTATIONS = new Set(["description", "default", "title", "examples", "$schema"]);
const ENFORCED = new Set([
  "type",
  "const",
  "enum",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "properties",
  "required",
  "additionalProperties",
  "oneOf",
  "anyOf",
  "not",
]);

const typeOf = (v: unknown) =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? "number" : typeof v;

/** Problems with `value` under `schema` (the JSON Schema subset the API's
 * OpenAPI uses); [] when it is valid. */
export function check(schema: Schema, value: unknown, path = "body"): string[] {
  for (const k of Object.keys(schema))
    if (!ANNOTATIONS.has(k) && !ENFORCED.has(k))
      throw new Error(
        `contract checker does not know "${k}" (at ${path}): teach it in contract/contract.ts`,
      );
  const errs: string[] = [];
  const at = (msg: string) => errs.push(`${path}: ${msg}`);
  if (schema.type !== undefined) {
    const types = ([] as unknown[]).concat(schema.type);
    const t = typeOf(value);
    const ok = types.some((x) => x === t || (x === "integer" && Number.isInteger(value)));
    if (!ok) return [`${path}: expected ${types.join("|")}, got ${t}`];
  }
  if ("const" in schema && value !== schema.const) at(`expected ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    at(`not one of ${schema.enum.join(", ")}`);
  if (typeof value === "string") {
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value))
      at(`does not match ${schema.pattern}`);
    if (typeof schema.minLength === "number" && value.length < schema.minLength) at("too short");
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) at("too long");
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) at(`under ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) at(`over ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum)
      at(`not above ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum)
      at(`not below ${schema.exclusiveMaximum}`);
  }
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const r of (schema.required ?? []) as string[])
      if (!(r in obj)) at(`missing required "${r}"`);
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) errs.push(...check(props[k], v, `${path}.${k}`));
      else if (schema.additionalProperties === false)
        at(`"${k}" is not a property the API accepts`);
    }
  }
  for (const key of ["oneOf", "anyOf"] as const) {
    const branches = schema[key] as Schema[] | undefined;
    if (!branches) continue;
    const results = branches.map((b) => check(b, value, path));
    const passing = results.filter((r) => r.length === 0).length;
    if (key === "oneOf" ? passing !== 1 : passing === 0)
      at(
        `matches ${passing} of its ${key} branches: ${results.map((r) => r.join("; ")).join(" | ")}`,
      );
  }
  if (schema.not && check(schema.not as Schema, value, path).length === 0) at("matches its `not`");
  return errs;
}

/** One object branch of a request schema, keyed by its `kind` const. */
export function branches(schema: Schema, discriminator = "kind") {
  const out = new Map<string, Schema>();
  for (const b of (schema.oneOf ?? []) as Schema[]) {
    const props = b.properties as Record<string, Schema>;
    const k = props?.[discriminator]?.const;
    if (typeof k !== "string") throw new Error(`a ${discriminator} branch without a const`);
    out.set(k, b);
  }
  return out;
}

export type Case = {
  /** what the case does, for the test name */
  name: string;
  /** the field it changes */
  field: string;
  /** the base request with this change made */
  args: Record<string, unknown>;
  /** the API accepts it (so the client must too), or refuses it (so must the client) */
  accept: boolean;
};

/** The cases one branch implies, from a valid base request: each required field
 * left out (unless `required: false`, where types own that); each numeric bound just inside and just outside; a fraction where
 * an integer is required; and, with `patterns`, a string its pattern refuses
 * (for untyped callers like MCP; the SDK's Address/Hex types cover these). */
export function cases(
  branch: Schema,
  base: Record<string, unknown>,
  /** skip: case name -> why the client is deliberately stricter than the API */
  opts: { patterns?: boolean; required?: boolean; skip?: Record<string, string> } = {},
): Case[] {
  const out: Case[] = [];
  const skipped = new Set<string>();
  const props = branch.properties as Record<string, Schema>;
  const add = (name: string, field: string, value: unknown, accept: boolean) => {
    if (opts.skip?.[`${field} ${name}`]) return void skipped.add(`${field} ${name}`);
    const args = { ...base };
    if (value === undefined) delete args[field];
    else args[field] = value;
    out.push({ name: `${field} ${name}`, field, args, accept });
  };
  if (opts.required !== false)
    for (const r of (branch.required ?? []) as string[])
      if (props[r]?.const === undefined) add("left out", r, undefined, false);
  for (const [field, p] of Object.entries(props)) {
    const int = p.type === "integer";
    const step = int ? 1 : 0.01;
    if (typeof p.minimum === "number") {
      add(`at its minimum ${p.minimum}`, field, p.minimum, true);
      add(`under its minimum ${p.minimum}`, field, p.minimum - step, false);
    }
    if (typeof p.maximum === "number") {
      add(`at its maximum ${p.maximum}`, field, p.maximum, true);
      add(`over its maximum ${p.maximum}`, field, p.maximum + step, false);
    }
    if (typeof p.exclusiveMinimum === "number") {
      add(`at its exclusive minimum ${p.exclusiveMinimum}`, field, p.exclusiveMinimum, false);
      add(`just above ${p.exclusiveMinimum}`, field, p.exclusiveMinimum + step, true);
    }
    if (typeof p.exclusiveMaximum === "number") {
      add(`at its exclusive maximum ${p.exclusiveMaximum}`, field, p.exclusiveMaximum, false);
      add(`just under ${p.exclusiveMaximum}`, field, p.exclusiveMaximum - step, true);
    }
    if (int) {
      const n =
        typeof base[field] === "number" ? (base[field] as number) : ((p.minimum as number) ?? 1);
      add("as a fraction", field, n + 0.5, false);
    }
    if (opts.patterns && typeof p.pattern === "string")
      add("off its pattern", field, "nope", false);
  }
  // an allowance whose case no longer exists is stale: drop it
  for (const k of Object.keys(opts.skip ?? {}))
    if (!skipped.has(k)) throw new Error(`allowance "${k}" matches no case`);
  for (const c of out) {
    const valid = check(branch, c.args).length === 0;
    if (valid !== c.accept)
      throw new Error(
        `case "${c.name}" was meant to be ${c.accept ? "valid" : "invalid"} for the API`,
      );
  }
  return out;
}

/** Paths of keys in the raw JSON that the parsed result no longer has: what a
 * zod object strips. Bigint and other transforms keep their keys. */
export function strippedKeys(raw: unknown, parsed: unknown, path = "$"): string[] {
  if (Array.isArray(raw) && Array.isArray(parsed))
    return raw.flatMap((r, i) => strippedKeys(r, parsed[i], `${path}[${i}]`));
  if (typeOf(raw) !== "object" || typeOf(parsed) !== "object") return [];
  const p = parsed as Record<string, unknown>;
  return Object.entries(raw as Record<string, unknown>).flatMap(([k, v]) =>
    k in p ? strippedKeys(v, p[k], `${path}.${k}`) : [`${path}.${k}`],
  );
}
