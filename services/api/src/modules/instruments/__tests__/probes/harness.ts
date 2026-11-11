// C7 INT-T03 probe harness (helper, not a test file). Synthetic data only.
//
// WHAT THE PROBES PIN. Every one of the 41 operations E01-E42 (no E09) is called THROUGH ITS REAL HANDLER (`manifest.handlers[operationId]`, the map the core serves), with the
// repositories replaced by the stateful in-memory worlds the earlier API tasks built (agents/instruments/device/ingest/messages/reprocess/attachments helpers). The DB is faithful in
// the two ways the spec relies on (07-SECURITY REQ-SEC-011/017/023):
//   - tenant predicate: every fake repo returns only rows of the tenant argument it was called with (explicit predicate; RLS is the backstop);
//   - centre RLS: `centreRls()` wraps a repo so rows whose `centre_id` is not one of the caller's centres are invisible (what `app.current_centre_ids()` does to a staff session).
// The core pipeline (schema, auth scheme, x-permission, aal2) is NOT re-run here: probes pin what the HANDLER + SERVICE + REPO promise when the DB shows them nothing of the other
// tenant / centre. Real RLS, FORCE RLS and column privileges are the SQL probes of db/tests/instruments (S-03/S-14/S-15).
//
// HOW THE HANDLERS GET THE FAKES. Handlers build their service at import (`createXService()` -> `createXRepo()`), so probes.test.ts `vi.mock`s the seven repo factories to return a
// late-bound delegate; each probe installs its world with `useRepos()` before calling. Handler request shape = the convention of the existing handlers: `{ params, query, headers, body }`
// with snake_case names exactly as in contracts/openapi/instruments.yaml, `If-Match: "<n>"` as a header, hctx = the service ctx.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../../core/module.js';

/** every operation of contracts/openapi/instruments.yaml (the source of truth for "100 % operation coverage", 07-SECURITY §6). */
export interface OpenApiOp { readonly id: string; readonly method: string; readonly path: string; readonly security: string[]; readonly permission: string }
export const OPENAPI_OPS: readonly OpenApiOp[] = (() => {
  const doc: any = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'instruments.yaml'), 'utf8'));
  return Object.entries<any>(doc.paths).flatMap(([path, item]) => Object.entries<any>(item).filter(([, o]) => o?.operationId).map(([method, o]) => (
    { id: o.operationId as string, method: method.toUpperCase(), path, security: (o.security ?? doc.security ?? []).flatMap((s: object) => Object.keys(s)), permission: String(o['x-permission'] ?? '') })));
})();
export const isDeviceOp = (o: OpenApiOp) => o.security.includes('deviceToken');

export type Mode = 'tenant' | 'centre';
export type RepoName = 'agents' | 'device' | 'instruments' | 'ingest' | 'messages' | 'reprocess' | 'attachments';
const current: { repos: Partial<Record<RepoName, any>> } = { repos: {} };
export const useRepos = (r: Partial<Record<RepoName, any>>) => { current.repos = r; };
/** what the `vi.mock`ed `createXRepo()` returns: forwards every call to the repo the running probe installed. */
export function delegate(name: RepoName): any {
  return new Proxy({}, {
    get: (_t, p) => (p === 'then' ? undefined : (...a: unknown[]) => {
      const r = current.repos[name];
      if (!r) throw new Error(`probe harness: no "${name}" repo installed (useRepos) for this probe`);
      return (r as any)[p](...a);
    }),
  });
}

// ---------------------------------------------------------------------------------------------------- centre RLS emulation
type Row = Record<string, any>;
/** staff-session RLS: a row (or list member) whose centre_id is not in `centres` does not exist for the caller. Rows without a centre_id (global / tenant-level) pass. */
export function centreRls<T extends object>(repo: T, centres: readonly string[]): T {
  const visible = (v: any) => !(v && typeof v === 'object' && typeof v.centre_id === 'string' && !centres.includes(v.centre_id));
  const filter = (out: any): any => {
    if (Array.isArray(out)) return out.filter(visible);
    if (out && typeof out === 'object' && Array.isArray(out.rows)) return { ...out, rows: out.rows.filter(visible) };
    return visible(out) ? out : undefined;
  };
  return new Proxy(repo, {
    get(t, p, r) {
      const f = Reflect.get(t, p, r);
      return typeof f === 'function' ? async (...a: unknown[]) => filter(await f.apply(t, a)) : f;
    },
  });
}

// ---------------------------------------------------------------------------------------------------- roles (IdentityPort.assertRole stand-ins)
export type Role = (r: { permission: string; centreId?: string }) => void;
const deny = () => Object.assign(new Error('auth.forbidden'), { code: 'auth.forbidden' });
export const allCentres: Role = () => undefined;
export const onlyCentre = (c: string): Role => (r) => { if (r.centreId !== undefined && r.centreId !== c) throw deny(); };
/** a user whose grants are all centre-scoped: tenant-level permission checks (no centreId) are refused. */
export const centreGrantsOnly: Role = (r) => { if (r.centreId === undefined) throw deny(); };

// ---------------------------------------------------------------------------------------------------- calling a handler
export const request = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
export const ifMatch = (v = 1) => ({ 'if-match': `"${v}"` });
/** empty in the committed suite; lets a scratch run substitute a handler to validate a probe against the service before the real handler exists. */
export const overrides: Record<string, (r: unknown, c: unknown) => Promise<any>> = {};
export async function call(operationId: string, req: ReturnType<typeof request>, ctx: object): Promise<any> {
  const { manifest } = await import('../../index.js');
  const h = overrides[operationId] ?? (manifest.handlers as Record<string, (r: unknown, c: unknown) => Promise<any>>)[operationId];
  if (typeof h !== 'function') throw new Error(`no handler for ${operationId}`);
  return h(req, { operationId, clientIp: '203.0.113.9', ...ctx });
}
export async function fails(p: Promise<unknown>): Promise<any> {
  try { await p; } catch (e) { return e; }
  throw new Error('expected the operation to be refused, but it answered');
}
export const dump = (v: unknown): string => JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? `bytes:${x.length}` : typeof x === 'bigint' ? String(x) : x instanceof Error ? { code: (x as any).code, message: x.message, errors: (x as any).errors, detail: (x as any).detail } : x));
/** the answer (or the error) names none of the foreign ids. */
export const leakFree = (answer: unknown, foreign: readonly string[]) => { const s = dump(answer); for (const f of foreign) expect(s, `answer leaks ${f}`).not.toContain(f); };

export interface Spy {
  /** every repo call with the tenant it carried (undefined = global reference data). */
  calls: Array<{ op: string; tenantId?: string }>;
  /** repo calls that write. */
  mutations: () => unknown[];
}
/** every repo call carried the caller's tenant (or none: global tables); not one carried another tenant. */
export const onlyTenant = (spy: Pick<Spy, 'calls'>, tenant: string) => { for (const c of spy.calls) expect(c.tenantId === undefined || c.tenantId === tenant, `repo call ${c.op} carried tenant ${c.tenantId}`).toBe(true); };

/** Staff object probe: the object is invisible -> 404 BEFORE any permission check, nothing written, nothing audited, nothing leaked (S-01/S-02). */
export async function expectInvisible(o: { op: string; req: ReturnType<typeof request>; ctx: object; spy: Spy; asserted: () => unknown[]; access: () => unknown[]; foreign: string[]; tenant: string }) {
  const e = await fails(call(o.op, o.req, o.ctx));
  expect(e.code, `${o.op}: invisible object must answer common.not_found, got ${e.code}`).toBe('common.not_found');
  expect(o.spy.mutations(), `${o.op}: nothing may be written`).toEqual([]);
  expect(o.asserted(), `${o.op}: 404 comes before assertRole (no existence oracle)`).toEqual([]);
  expect(o.access(), `${o.op}: no access_log row for an object the caller cannot see`).toEqual([]);
  leakFree(e, o.foreign);
  onlyTenant(o.spy, o.tenant);
}
/** Staff list probe: own rows present, foreign rows absent; the answer names no foreign id. */
export function expectRows(body: any, own: readonly string[], foreign: readonly string[], key = 'data') {
  const ids = (body?.[key] ?? []).map((r: Row) => r['id'] ?? r['instrument_message_id'] ?? r['agent_id']);
  for (const id of own) expect(ids, `own row ${id} missing`).toContain(id);
  for (const id of foreign) expect(ids).not.toContain(id);
  leakFree(body, foreign);
}
