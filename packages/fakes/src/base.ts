// packages/fakes/src/base.ts — FakeBase (C0 TRD §5.4): seed, tenant keying, failNext, latency, calls.
import { LimsError } from "@lims/contracts/ports/common";
import type { ErrorCode } from "@lims/contracts/ports/common";
import type { EventSpy } from "./event-spy";

export { LimsError };
export type { ErrorCode };

/** Synthetic tenants A/B (same constants the C0 tests use). */
export const TENANT_A = "01900000-0000-7000-8000-00000000000a";
export const TENANT_B = "01900000-0000-7000-8000-00000000000b";
export const TENANTS = { A: TENANT_A, B: TENANT_B } as const;
export type TenantKey = keyof typeof TENANTS;
export const FIXED_NOW = "2026-11-05T04:15:00.000Z";

export interface FakeControls<M extends string = string> {
  failNext(method: M, code: ErrorCode, safeDetail?: string): void;
  latency(ms: number): void;
  calls(method: M): readonly { ctx: { tenantId: string; actorId: string }; input: unknown }[];
  reset(): void;
}

export interface FakeOpts<F> { seed: number; fixtures?: Partial<F>; events?: EventSpy }

/** Deterministic UUIDv7-shaped id: seed in the first group, `n` in the last (different seed ⇒ different ids). */
export function idFor(seed: number, n: number): string {
  const s = (0x01900000 + (seed & 0xffff) + 1).toString(16).padStart(8, "0");
  return `${s}-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
}
/** Deterministic id generator; `next()` continues after the fixed fixture ids. */
export function idGen(seed: number, start = 0x1000): () => string {
  let n = start;
  return () => idFor(seed, n++);
}

/** Actor id of a persona; harness ctxFor() and fake fixtures use the same function. */
export function actorIdFor(tenant: TenantKey, type: string, persona = "default"): string {
  let h = 0;
  for (const c of `${tenant}:${type}:${persona}`) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `01900000-0000-7000-9${h.toString(16).padStart(8, "0").slice(0, 3)}-${h.toString(16).padStart(12, "0")}`;
}

/** P-40 / A22.0 port idempotencyKey grammar. */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
export function checkIdempotencyKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || !IDEMPOTENCY_KEY_RE.test(key)) throw new LimsError("common.validation_failed", "idempotency_key_invalid");
}

export const err = (code: ErrorCode, safeDetail?: string): LimsError => new LimsError(code, safeDetail);
export const notFound = (): LimsError => new LimsError("common.not_found");
export const invalid = (detail?: string): LimsError => new LimsError("common.validation_failed", detail);
export const forbidden = (detail?: string): LimsError => new LimsError("auth.forbidden", detail);

export const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const deepFreeze = <T>(v: T): T => {
  if (v && typeof v === "object") { Object.freeze(v); for (const x of Object.values(v)) deepFreeze(x); }
  return v;
};

/** Seed-merge: arrays of `{id|...Id}` rows are upserted by `key`, other values replaced. */
export function mergeFixtures<F extends object>(base: F, over: Partial<F> | undefined, keyOf: (k: string, row: any) => string | undefined = defaultKey): F {
  if (!over) return base;
  const out: any = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (Array.isArray(v) && Array.isArray(out[k])) {
      const rows = [...out[k]];
      for (const r of v) {
        const key = keyOf(k, r);
        const i = key === undefined ? -1 : rows.findIndex((x) => keyOf(k, x) === key);
        if (i >= 0) rows[i] = clone(r); else rows.push(clone(r));
      }
      out[k] = rows;
    } else if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = { ...out[k], ...clone(v) };
    } else out[k] = clone(v);
  }
  return out;
}
function defaultKey(_k: string, row: any): string | undefined {
  if (!row || typeof row !== "object") return undefined;
  if (typeof row.id === "string") return row.id;
  // tenantId is the key only for per-tenant rows with no other *Id (e.g. settings)
  const ids = Object.keys(row).filter((x) => x.endsWith("Id") && typeof row[x] === "string");
  const idKey = ids.find((x) => x !== "tenantId") ?? ids[0];
  return idKey ? `${idKey}:${row[idKey]}` : undefined;
}

export interface FakeState<F> { fixtures: F; seed: number; events?: EventSpy; nextId: () => string }

/**
 * Builds a fake: wraps every method with call logging, failNext and latency. `build(state)` returns the methods and is
 * re-run on reset()/seed() so mutable state starts fresh. Any non-LimsError thrown by a method on malformed input is
 * surfaced as `common.validation_failed` [CONV: fakes never throw non-LimsErrors].
 */
export function makeFake<F extends object, P extends object>(
  defaults: (seed: number) => F,
  opts: FakeOpts<F>,
  build: (s: FakeState<F>) => P,
): P & FakeControls<Extract<keyof P, string>> & { readonly fixtures: F; __seed(f: Partial<F>): void; __rollback(tx: unknown): void } {
  let fixtures = deepFreeze(mergeFixtures(defaults(opts.seed), opts.fixtures));
  const failures = new Map<string, LimsError>();
  const log = new Map<string, { ctx: { tenantId: string; actorId: string }; input: unknown }[]>();
  let delay = 0;
  let methods: any;
  const rollbacks: ((tx: unknown) => void)[] = [];
  const init = () => {
    rollbacks.length = 0;
    methods = build({ fixtures: clone(fixtures), seed: opts.seed, events: opts.events, nextId: idGen(opts.seed) });
    if (typeof methods.__onRollback === "function") rollbacks.push(methods.__onRollback);
  };
  init();
  const fake: any = {
    get fixtures() { return fixtures; },
    failNext(method: string, code: ErrorCode, safeDetail?: string) { failures.set(method, new LimsError(code, safeDetail)); },
    latency(ms: number) { delay = Math.max(0, ms); },
    calls(method: string) { return log.get(method) ?? []; },
    reset() { failures.clear(); log.clear(); delay = 0; init(); },
    __seed(f: Partial<F>) { fixtures = deepFreeze(mergeFixtures(fixtures, f)); init(); },
    __rollback(tx: unknown) { for (const r of rollbacks) r(tx); },
  };
  for (const name of Object.keys(methods)) {
    if (name.startsWith("__")) continue;
    fake[name] = async (ctx: any, input?: any) => {
      const entry = { ctx: { tenantId: ctx?.tenantId, actorId: ctx?.actor?.id }, input: clone(input) };
      (log.get(name) ?? log.set(name, []).get(name)!).push(entry);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const f = failures.get(name);
      if (f) { failures.delete(name); throw f; }
      try { return await methods[name](ctx, input ?? {}); } catch (e) {
        if (e instanceof LimsError) throw e;
        throw new LimsError("common.validation_failed");
      }
    };
  }
  return fake;
}

// ---- small shared helpers used by the port fakes
export const tenantOf = (ctx: any): string => {
  const t = ctx?.tenantId;
  if (typeof t !== "string" || !t) throw new LimsError("auth.unauthenticated");
  return t;
};
export const actorType = (ctx: any): string => ctx?.actor?.type ?? "user";
export const nowOf = (ctx: any): string => (typeof ctx?.now === "function" ? ctx.now() : FIXED_NOW);
export const isStaffOrSystem = (ctx: any): boolean => ["user", "system"].includes(actorType(ctx));
export function requireStr(v: unknown, detail = "field_required"): string {
  if (typeof v !== "string" || v.length === 0) throw invalid(detail);
  return v;
}
export function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  return `{${Object.keys(v as object).sort().filter((k) => (v as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson((v as any)[k])}`).join(",")}}`;
}
export async function sha256Hex(s: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(s).digest("hex");
}
