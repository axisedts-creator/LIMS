// C11 T-18 — generator-driven probes that need NO database (07-SECURITY §5.1 path ids, §5.3 privilege, AB-5). The generator walks contracts/openapi/anatomic.yaml (probe-matrix.ts), builds a
// schema-valid request per operation and drives the REAL handlers (manifest.handlers) with a tenant-A context whose transaction is an EMPTY tenant: every query answers zero rows, which is exactly
// what RLS + the repositories' explicit tenant_id filter produce for ids that belong to tenant B (the live twin of this file, live.probes.test.ts, proves it on real PG17 rows).
// Contract under test (spec text, not implementation): a foreign id is indistinguishable from an unknown id -> 404 common.not_found (07-SECURITY §5.1, AB-1/AB-2, 02-CV §4 "never 403 for other tenants").
//   * "assertRole FIRST" for configuration/synoptic operations (service headers synoptic.service.ts / config.service.ts): a refusal from IdentityPort (auth.forbidden, auth.mfa_required — the aal2 check
//     lives behind it, 07-SECURITY §5.3) reaches the caller unchanged and before any query.
//   * AB-5: a body that sets tenant_id / status / accession_no / signed_by_membership_id is refused 400 common.validation_failed with a common.unknown_field entry, and no submitted value is echoed.
import { describe, expect, it } from 'vitest';
import { isLimsError, LimsError } from '../../../../core/errors.js';
import { manifest } from '../../index.js';
import { B_ID, buildRequest, FORBIDDEN_BODY_KEYS, hasIdPath, OP, ops, sampleBody, T_A, TRD, UPSERT_BY_KEY, type OpInfo } from './probe-matrix.js';

const USER = '01a1a98a-ac40-7000-8000-00000000a300', MEMB = '01a1a98a-ac40-7000-8000-00000000a500';
type Call = [unknown, { permission: string; centreId?: string }];
const SETTINGS_ROW = {
  tenant_id: T_A, auto_accession_on_receipt: true, require_gross_complete_for_processing: false, default_routine_stain_code: 'HE', max_images_per_case: 20, max_report_images: 6, version: 1, is_active: true,
  created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z', created_by: USER, updated_by: USER,
};
function makeCtx(opts: { assertRole?: (c: unknown, i: any) => Promise<unknown>; actorType?: string } = {}) {
  const statements: string[] = [], roleCalls: Call[] = [];
  const notFound = async () => { throw new LimsError('common.not_found'); };
  const ctx = {
    operationId: 'probe', clientIp: '203.0.113.7', log: { info() {}, warn() {}, error() {} }, tenantId: T_A, actor: { type: opts.actorType ?? 'user', id: USER, membershipId: MEMB },
    // empty tenant: every query answers zero rows, except the tenant's configuration row — the configuration operations create it lazily on first use (config.service ensureDefaults), which an
    // empty fake cannot emulate (the INSERT would "lose the race" -> common.internal), so the tenant is given its defaults.
    tx: { async query(text: string) { statements.push(String(text)); return /^\s*select[\s\S]*\banatomic\.settings\b/i.test(String(text)) ? { rows: [SETTINGS_ROW], rowCount: 1 } : { rows: [], rowCount: 0 }; } }, now: () => new Date('2026-11-14T00:00:00Z'),
    ports: {
      IdentityPort: { async assertRole(c: unknown, i: any) { roleCalls.push([c, i]); await opts.assertRole?.(c, i); }, async getTenantSettings() { return {}; } },
      CatalogPort: { getTest: notFound, listTests: async () => [] }, FrontdeskPort: { getOrderSummary: notFound, getPatientDemographicsBatch: async () => [] }, LabPort: {},
    },
    core: { user: async () => 'Synthetic User' }, audit: { access: async () => undefined, record: async () => undefined },
  } as any;
  return { ctx, statements, roleCalls };
}
const rejection = (p: Promise<unknown>): Promise<any> => p.then((v) => { throw new Error(`expected a rejection, got ${JSON.stringify(v)?.slice(0, 200)}`); }, (e: unknown) => e);
const run = (o: OpInfo, req: object, ctx: any) => Promise.resolve().then(() => (manifest.handlers as any)[o.operationId](req, { ...ctx, operationId: o.operationId }));
const label = (e: any) => `${e?.code ?? e?.name}: ${e?.message}`;

describe('C11-T18 generated: path ids of another tenant -> 404 common.not_found (07-SECURITY §5.1, AB-1, AB-2)', () => {
  const targets = ops().filter((o) => hasIdPath(o) && !UPSERT_BY_KEY.includes(o.operationId));
  it('the generator found the case-, part-, block-, slide-, stain-order-, addendum-, image-, batch-, template-, stain-, assay- and text-template-scoped operations (>= 40)', () => {
    expect(targets.length).toBeGreaterThanOrEqual(40);
  });

  it.each(targets.map((o) => [o.operationId, o] as const))('%s: every path id belonging to tenant B answers 404 common.not_found', async (_id, o) => {
    const { ctx } = makeCtx();
    const e = await rejection(run(o, buildRequest(o, () => B_ID), ctx));
    expect(isLimsError(e, 'common.not_found'), label(e)).toBe(true);
  });

  it.each(targets.map((o) => [o.operationId, o] as const))('%s: the 404 reveals nothing (no accession/label/text in message, same shape as an unknown id)', async (_id, o) => {
    const unknown = makeCtx(), foreign = makeCtx();
    const a = await rejection(run(o, buildRequest(o, () => '0190c418-0009-7000-8000-000000000999'), unknown.ctx));
    const b = await rejection(run(o, buildRequest(o, () => B_ID), foreign.ctx));
    expect({ code: a?.code, status: a?.statusCode ?? a?.status, errors: a?.errors }).toEqual({ code: b?.code, status: b?.statusCode ?? b?.status, errors: b?.errors });
    expect(String(b?.message)).not.toMatch(/S\d{2}-\d+|PHI|accession/i);
  });

  it('key-addressed upserts (PUT test-profiles/{test_id}, PUT coded-sets/{set}/values/{code}) never answer 5xx for tenant B keys: they create the caller\'s own row or refuse with 4xx', async () => {
    for (const id of UPSERT_BY_KEY) {
      const o = OP[id]!;
      const { ctx } = makeCtx();
      const r = await run(o, buildRequest(o, () => B_ID), ctx).then(() => ({ ok: true as const }), (e: any) => ({ ok: false as const, e }));
      if (!r.ok) expect(isLimsError(r.e) && (r.e.statusCode ?? 400) < 500, label(r.e)).toBe(true);
    }
  });
});

describe('C11-T18 generated: configuration operations — IdentityPort refusal first and unchanged (07-SECURITY §5.3 "All K-ops except reads: anatomic.config.manage required; aal2")', () => {
  const kOps = Object.keys(TRD).filter((c) => /^K\d+$/.test(c)).map((c) => OP[TRD[c]!]!);
  it('the generator selects all 22 K-operations', () => { expect(kOps).toHaveLength(22); });

  it.each(kOps.map((o) => [o.operationId, o] as const))('%s asks IdentityPort for exactly its spec permission before any query, and passes auth.forbidden / auth.mfa_required through unchanged', async (_id, o) => {
    for (const code of ['auth.forbidden', 'auth.mfa_required'] as const) {
      const { ctx, statements, roleCalls } = makeCtx({ assertRole: async () => { throw new LimsError(code); } });
      const e = await rejection(run(o, buildRequest(o, () => B_ID), ctx));
      expect(isLimsError(e, code), `${code} -> ${label(e)}`).toBe(true);
      expect(roleCalls.length, 'assertRole must be called').toBeGreaterThanOrEqual(1);
      expect(roleCalls[0]![1].permission).toBe(o.permission);
      expect(statements, 'nothing may be read or written before the permission check').toEqual([]);
    }
  });

  it('exactly the 14 write operations require anatomic.config.manage and none of them is satisfied by a weaker permission', () => {
    const writes = kOps.filter((o) => o.permission === 'anatomic.config.manage');
    expect(writes).toHaveLength(14);
    expect(kOps.filter((o) => o.permission !== 'anatomic.config.manage').every((o) => o.method === 'GET' && o.permission === 'anatomic.case.read')).toBe(true);
  });
});

describe('C11-T18 generated: AB-5 — a body cannot set tenant_id / status / accession_no / signed_by_membership_id', () => {
  const targets = ops().filter((o) => o.bodySchema && !o.isMultipart && !hasIdPath(o));
  it('the generator found the body operations without a path id (lookup, bulk, movements, create settings/stain/assay/template/batch …)', () => { expect(targets.length).toBeGreaterThanOrEqual(8); });

  it.each(targets.map((o) => [o.operationId, o] as const))('%s refuses every forbidden key with 400 common.validation_failed + common.unknown_field and never echoes the value', async (_id, o) => {
    const props = Object.keys((o.bodySchema?.properties ?? {}) as object);
    for (const key of FORBIDDEN_BODY_KEYS.filter((k) => !props.includes(k))) {
      const { ctx } = makeCtx();
      const body = { ...sampleBody(o), [key]: 'PLANTED-9f3a-never-echo' };
      const e = await rejection(run(o, { ...buildRequest(o, () => B_ID), body }, ctx));
      expect(isLimsError(e, 'common.validation_failed'), `${key}: ${label(e)}`).toBe(true);
      expect(e.errors?.some((f: any) => f.code === 'common.unknown_field' && String(f.path).endsWith(`/${key}`)), `${key}: ${JSON.stringify(e.errors)}`).toBe(true);
      expect(JSON.stringify({ m: e.message, d: e.detail, errors: e.errors })).not.toContain('PLANTED-9f3a');
    }
  });
});
