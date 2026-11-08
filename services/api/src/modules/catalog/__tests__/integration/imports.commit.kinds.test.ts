// T-25 (C3) — commitImport API (#102) for the kinds catalog_master, referrers, credit_parties: per-kind permission, the extra privileged permission for clinical changes,
// no stale-base rule, enqueue. Spec: PRD AC-17.5 (catalog_master commit that creates/publishes analyte versions, reference-range sets or critical-limit sets also needs
// catalog.reference_range.publish, privileged, on top of catalog.test.manage — 08 A13 D-18), AC-17.6 (referrers: catalog.referrer.manage), 02-TRD §8.5 (API half: "asserts
// catalog.reference_range.publish when the validation summary shows analyte-version, range-set or critical-set changes"; job_key = import id), §8.2 (credit_parties:
// catalog.price_list.manage), 07-SECURITY S-4/P-10, AB-5.
// SEAM / SPEC GAP (the spec names no summary key for "analyte-version, range-set or critical-set changes"): ASSUMED stored in imports.summary by the validation job as integer counts
//   CLINICAL_KEYS = analyte_versions, range_sets, critical_sets (any > 0 => the extra permission is required). Change the constant if the arbiter fixes other names.
// Also ASSUMED: non-price_list kinds have no stale-base rule (base_version_no is a price_list notion) and no target_price_list_id.
import { describe, expect, it } from 'vitest';
import { createImportsService } from '../../service/imports.service.js';
import { makeIdentity } from '../helpers/identity.js';
import { makeImportsDb, NOW, TENANT_A, TENANT_B, USER } from '../helpers/importsDb.js';

const T = 20_000;
const CLINICAL_KEYS = ['analyte_versions', 'range_sets', 'critical_sets'] as const;
const PUBLISH = 'catalog.reference_range.publish';
const REASON = 'Catalog swap (synthetic)';
const BASE_SUMMARY = { rows: 40, added: 40, changed: 0, removed: 0, unchanged: 0, errors: 0, warnings: 0 };

interface Svc { commitImport(ctx: unknown, id: string, expectedVersion: number | undefined, body: unknown): Promise<any> }
function setup(grants: readonly string[], aal: 1 | 2 = 2) {
  const db = makeImportsDb();
  const identity = makeIdentity(grants, aal);
  const svc = createImportsService({ identity } as never) as unknown as Svc;
  const seed = (kind: string, summary: Record<string, unknown> = BASE_SUMMARY, over: Record<string, unknown> = {}) =>
    db.seed.import(TENANT_A, { kind, status: 'validated', target_price_list_id: null, base_version_no: null, summary, ...over });
  const commit = (imp: { id: string; version: number }, b: unknown = { change_reason: REASON }, tenantId = TENANT_A) => db.run((ctx) => svc.commitImport(ctx, imp.id, imp.version, b), { tenantId, actorId: USER });
  const row = (id: string) => db.rows('imports').find((r) => r.id === id)!;
  return { db, identity, seed, commit, row };
}
const errOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } return undefined; };

describe.each([
  ['referrers', 'catalog.referrer.manage'],
  ['credit_parties', 'catalog.price_list.manage'],
  ['catalog_master', 'catalog.test.manage'],
] as const)('commitImport kind %s — validated -> committing (AC-17.1/17.6, 02-TRD §8.5)', (kind, perm) => {
  it(`with ${perm}: returns the Import (committing), stores the commit params, enqueues catalog.import_commit keyed by the import id`, async () => {
    const s = setup([perm]);
    const imp = s.seed(kind);
    const v0 = imp.version;                                                // seed returns the live row the commit mutates (T-25 ruling #5)
    const out = await s.commit(imp, { change_reason: REASON, effective_from: '2026-12-01T00:00:00.000Z' });
    expect(out).toMatchObject({ id: imp.id, kind, status: 'committing', version: v0 + 1 });
    expect(s.row(imp.id)).toMatchObject({ status: 'committing', commit_change_reason: REASON, committed_by: USER });
    expect(s.db.jobs).toHaveLength(1);
    expect(s.db.jobs[0]).toMatchObject({ identifier: 'catalog.import_commit', jobKey: imp.id });
    expect(s.db.jobs[0]!.payload).toMatchObject({ tenant_id: TENANT_A, import_id: imp.id });
  }, T);

  it('replace_draft:true travels in the job payload', async () => {
    const s = setup([perm]);
    const imp = s.seed(kind);
    await s.commit(imp, { change_reason: REASON, replace_draft: true });
    expect(s.db.jobs[0]!.payload.replace_draft).toBe(true);
  }, T);

  it(`without ${perm} -> 403 auth.forbidden, import untouched, no job; the asserted permission is ${perm}`, async () => {
    const s = setup(['catalog.price_list.read', 'catalog.referrer.read', 'catalog.test.read'].filter((p) => p !== perm));
    const imp = s.seed(kind);
    expect((await errOf(s.commit(imp)))?.code).toBe('auth.forbidden');
    expect(s.identity.calls.at(-1)?.permission).toBe(perm);
    expect(s.row(imp.id)).toMatchObject({ status: 'validated', version: imp.version });
    expect(s.db.jobs).toHaveLength(0);
  }, T);

  it('no stale-base rule outside price_list: a base_version_no that would not match anything cannot block the commit', async () => {
    const s = setup([perm]);
    const imp = s.seed(kind, BASE_SUMMARY, { base_version_no: null });
    expect((await errOf(s.commit(imp)))).toBeUndefined();
  }, T);

  it('a tenant-B caller with tenant-A\'s import id -> 404 common.not_found (AB-5), row untouched', async () => {
    const s = setup([perm]);
    const imp = s.seed(kind);
    expect((await errOf(s.commit(imp, { change_reason: REASON }, TENANT_B)))?.code).toBe('common.not_found');
    expect(s.row(imp.id).status).toBe('validated');
    expect(s.db.jobs).toHaveLength(0);
  }, T);

  it.each(['invalid', 'uploaded', 'committed', 'discarded', 'expired'])('status %s -> 409 catalog.import_not_committable, no job', async (status) => {
    const s = setup([perm, PUBLISH]);
    const imp = s.seed(kind, BASE_SUMMARY, { status });
    expect((await errOf(s.commit(imp)))?.code).toBe('catalog.import_not_committable');
    expect(s.db.jobs).toHaveLength(0);
  }, T);

  it('an expired validated import -> 409 catalog.import_not_committable', async () => {
    const s = setup([perm, PUBLISH]);
    const imp = s.seed(kind, BASE_SUMMARY, { expires_at: new Date(Date.parse(NOW) - 1000) });
    expect((await errOf(s.commit(imp)))?.code).toBe('catalog.import_not_committable');
    expect(s.db.jobs).toHaveLength(0);
  }, T);
});

describe('AC-17.5 — catalog_master with analyte-version / range-set / critical-set changes needs catalog.reference_range.publish (privileged) too', () => {
  it.each(CLINICAL_KEYS)('summary.%s > 0 with catalog.test.manage only -> 403 auth.forbidden (asserts catalog.reference_range.publish), import untouched, no job', async (key) => {
    const s = setup(['catalog.test.manage']);
    const imp = s.seed('catalog_master', { ...BASE_SUMMARY, [key]: 3 });
    expect((await errOf(s.commit(imp)))?.code).toBe('auth.forbidden');
    expect(s.identity.calls.map((c) => c.permission)).toContain(PUBLISH);
    expect(s.row(imp.id)).toMatchObject({ status: 'validated', version: imp.version });
    expect(s.db.jobs).toHaveLength(0);
  }, T);

  it.each(CLINICAL_KEYS)('summary.%s > 0 with both permissions -> committing + job', async (key) => {
    const s = setup(['catalog.test.manage', PUBLISH]);
    const imp = s.seed('catalog_master', { ...BASE_SUMMARY, [key]: 3 });
    expect((await s.commit(imp)).status).toBe('committing');
    expect(s.db.jobs).toHaveLength(1);
  }, T);

  it('catalog.reference_range.publish is privileged: aal1 -> auth.mfa_required, nothing changes', async () => {
    const s = setup(['catalog.test.manage', PUBLISH], 1);
    const imp = s.seed('catalog_master', { ...BASE_SUMMARY, analyte_versions: 1 });
    expect((await errOf(s.commit(imp)))?.code).toBe('auth.mfa_required');
    expect(s.row(imp.id).status).toBe('validated');
    expect(s.db.jobs).toHaveLength(0);
  }, T);

  it('a catalog_master import with NO clinical changes (all counters 0 / absent) commits with catalog.test.manage alone (no privileged call needed)', async () => {
    const s = setup(['catalog.test.manage'], 1);
    const imp = s.seed('catalog_master', { ...BASE_SUMMARY, analyte_versions: 0, range_sets: 0, critical_sets: 0 });
    expect((await s.commit(imp)).status).toBe('committing');
    expect(s.identity.calls.map((c) => c.permission)).not.toContain(PUBLISH);
  }, T);

  it('the extra permission is NOT asked for referrers / credit_parties even if their summary carries those keys (kind decides)', async () => {
    const s = setup(['catalog.referrer.manage']);
    const imp = s.seed('referrers', { ...BASE_SUMMARY, analyte_versions: 9 });
    expect((await s.commit(imp)).status).toBe('committing');
    expect(s.identity.calls.map((c) => c.permission)).not.toContain(PUBLISH);
  }, T);

  it('holding catalog.reference_range.publish alone (without catalog.test.manage) is not enough', async () => {
    const s = setup([PUBLISH]);
    const imp = s.seed('catalog_master', { ...BASE_SUMMARY, analyte_versions: 1 });
    expect((await errOf(s.commit(imp)))?.code).toBe('auth.forbidden');
    expect(s.db.jobs).toHaveLength(0);
  }, T);
});
