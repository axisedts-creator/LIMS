// C11.T-07 LIVE integration (GATED exactly like T-04/T-06: skipped unless LIMS_TEST_DATABASE_URL + LIMS_TEST_APP_DATABASE_URL point at a migrated DB incl. the anatomic DDL).
// Proves what the in-memory unit tests (../case.reads.test.ts) cannot: the SQL of the queue definitions (03-APP-FLOW §4.1) on seeded rows — in particular
// awaiting_lab = signed_out cases with an active PRIMARY case item whose latest item_submissions.item_version_no > case_items.lab_approved_version_no (CR-C11-011) —
// plus default order "urgent first, oldest first" and sort=accessioned_at (AC-13.1), centre scoping by RLS (AC-13.2) and the real unique-label lookup (AC-13.4).
// Real handlers + real repositories + real requestTx. Fixture ids 0190c411-… (cleanup() removes them); seeds supply every NOT NULL column explicitly
// (the harness seeds with jsonb_populate_record, i.e. no column defaults). Not run here: no PG and no anatomic DDL in db/migrations yet (see T-04 notes).
// Same ctx assumption as ../case.reads.test.ts (IdentityPort.assertRole open, FrontdeskPort/LabPort stubs; the list must not call them per row).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { manifest } from '../../index.js';
import { caseRow, CENTRE_A1, CENTRE_A2, CLAIMS, LIVE, openHarness, partRow, SYS, TENANT_A, uid, type Harness } from './setup.js';

const TS = '2026-11-01T00:00:00.000Z';
const base = { created_at: TS, updated_at: TS, created_by: SYS, updated_by: SYS, version: 1 };
let labCalls = 0;
const ctxFor = (tx: unknown, claims: { sub: string }) => ({
  operationId: 'live', clientIp: '203.0.113.7', requestId: uid(9990), log: { info() {}, warn() {}, error() {} },
  tenantId: TENANT_A, actor: { type: 'user', id: claims.sub }, tx, now: () => new Date('2026-11-12T01:30:00Z'),
  audit: { async access() {} },
  core: { async user() { return { id: claims.sub, displayName: 'Synthetic Tech', isActive: true }; }, memberships: { async list() { return []; } }, async branch() { throw new Error('unused'); } },
  ports: {
    IdentityPort: { async assertRole() {}, async getTenantSettings() { return { timezone: 'Asia/Kathmandu', numbering: {} }; } },
    CatalogPort: { async getTest(_c: unknown, i: { testId: string }) { return { name: `T ${i.testId.slice(-4)}` }; } },
    FrontdeskPort: { async getPatientDemographicsBatch() { return []; } },
    LabPort: { async getOrderResults(_c: unknown, i: { orderId: string }) { labCalls++; return { orderId: i.orderId, specimens: [], items: [], approvedSetHash: 'h' }; } },
  },
}) as any;

describe.skipIf(!LIVE)('C11-T07 case reads over a real DB', () => {
  let h: Harness;
  beforeAll(async () => { h = await openHarness(); await h.cleanup(); });
  afterAll(async () => { if (h) { await h.cleanup().catch(() => undefined); await h.close(); } });

  const seedCase = async (n: number, over: Record<string, unknown> = {}, centre = CENTRE_A1) => {
    const c = caseRow(uid(2100 + n), TENANT_A, centre, { created_at: TS, updated_at: TS, version: 1, current_version_no: 0, molecular_rev: 0, profile_missing: false, ...over });
    await h.seed('anatomic.cases', c);
    await h.seed('anatomic.parts', { ...partRow(uid(2200 + n), c['id'] as string, TENANT_A, centre), site_text: 'Left breast', ...base });
    return c['id'] as string;
  };
  /** case item + its submissions (item_version_no list) */
  const seedItem = async (n: number, caseId: string, o: { approved: number; submitted: number[]; role?: string; active?: boolean }, centre = CENTRE_A1) => {
    const itemId = uid(2300 + n);
    await h.seed('anatomic.case_items', { id: itemId, tenant_id: TENANT_A, centre_id: centre, case_id: caseId, order_item_id: uid(2400 + n), test_id: uid(2500 + n), role: o.role ?? 'primary',
      lab_approved_version_no: o.approved, lab_approved_at: null, is_active: o.active ?? true, ...base });
    for (const v of o.submitted) {
      await h.seed('anatomic.item_submissions', { id: uid(2600 + n * 10 + v), tenant_id: TENANT_A, centre_id: centre, case_id: caseId, case_item_id: itemId, item_version_no: v, report_version_id: uid(2700 + n),
        idempotency_key: `anatomic:${itemId}:${v}`, lab_result_id: uid(2800 + n), lab_version_no: v, lab_status: 'resulted', replayed: false, submitted_at: TS, created_at: TS, created_by: SYS });
    }
  };
  const list = async (claims: { sub: string }, query: Record<string, unknown>) => {
    const r: any = await h.asApp(claims as never, (tx) => (manifest.handlers as any)['listAnatomicCases']({ params: {}, query, headers: {}, body: {} }, ctxFor(tx, claims)));
    return r.body as { data: { id: string; status: string; priority: string }[]; page: { next_cursor: string | null; limit: number } };
  };
  const ids = (b: { data: { id: string }[] }) => b.data.map((c) => c.id);

  it('AC-13.1: to_accession lists ONLY received cases, urgent first then oldest first', async () => {
    const a = await seedCase(1, { status: 'received', priority: 'routine', received_at: '2026-11-02T04:00:00Z' });
    const b = await seedCase(2, { status: 'received', priority: 'routine', received_at: '2026-11-01T04:00:00Z' });
    const u = await seedCase(3, { status: 'received', priority: 'urgent', received_at: '2026-11-03T04:00:00Z' });
    await seedCase(4, { status: 'accessioned', accession_no: 'S99-9004', accessioned_at: TS });
    await seedCase(5, { status: 'signed_out', accession_no: 'S99-9005', accessioned_at: TS });
    await seedCase(6, { status: 'cancelled' });
    const r = await list(CLAIMS.allA, { queue: 'to_accession', limit: 200 });
    const mine = ids(r).filter((id) => [a, b, u].includes(id));
    expect(mine).toEqual([u, b, a]);
    expect(r.data.every((c) => c.status === 'received')).toBe(true);
  });

  it('awaiting_lab (seeded item_submissions / lab_approved_version_no): signed_out + active primary item with latest submission > lab_approved_version_no; never calls C5 per row', async () => {
    const pending = await seedCase(10, { status: 'signed_out', accession_no: 'S99-9010', accessioned_at: TS, signed_out_at: TS, current_version_no: 1 });
    await seedItem(10, pending, { approved: 0, submitted: [1] });                        // submitted v1, approved 0  → awaiting
    const amended = await seedCase(11, { status: 'signed_out', accession_no: 'S99-9011', accessioned_at: TS, signed_out_at: TS, current_version_no: 2 });
    await seedItem(11, amended, { approved: 1, submitted: [1, 2] });                     // approved v1, latest v2   → awaiting (amendment pending)
    const done = await seedCase(12, { status: 'signed_out', accession_no: 'S99-9012', accessioned_at: TS, signed_out_at: TS, current_version_no: 2 });
    await seedItem(12, done, { approved: 2, submitted: [1, 2] });                        // approved == latest       → NOT awaiting
    const addonOnly = await seedCase(13, { status: 'signed_out', accession_no: 'S99-9013', accessioned_at: TS, signed_out_at: TS, current_version_no: 1 });
    await seedItem(13, addonOnly, { approved: 1, submitted: [1, 2], role: 'addon' });    // only an add-on is behind    → NOT awaiting (primary items only)
    const inactive = await seedCase(14, { status: 'signed_out', accession_no: 'S99-9014', accessioned_at: TS, signed_out_at: TS, current_version_no: 1 });
    await seedItem(14, inactive, { approved: 0, submitted: [1], active: false });        // inactive item              → NOT awaiting
    const notSigned = await seedCase(15, { status: 'accessioned', accession_no: 'S99-9015', accessioned_at: TS });
    await seedItem(15, notSigned, { approved: 0, submitted: [1] });                      // not signed out             → NOT awaiting
    const never = await seedCase(16, { status: 'signed_out', accession_no: 'S99-9016', accessioned_at: TS, signed_out_at: TS, current_version_no: 1 });
    await seedItem(16, never, { approved: 0, submitted: [] });                           // no submission at all       → NOT awaiting
    labCalls = 0;
    const r = await list(CLAIMS.allA, { queue: 'awaiting_lab', limit: 200 });
    const mine = ids(r).filter((id) => [pending, amended, done, addonOnly, inactive, notSigned, never].includes(id)).sort();
    expect(mine).toEqual([pending, amended].sort());
    expect(labCalls).toBe(0);
  });

  it('sort=accessioned_at ascending and -accessioned_at descending (AC-13.1 sort contract)', async () => {
    const x = await seedCase(20, { status: 'accessioned', accession_no: 'S99-9020', accessioned_at: '2026-11-05T01:00:00Z' });
    const y = await seedCase(21, { status: 'accessioned', accession_no: 'S99-9021', accessioned_at: '2026-11-04T01:00:00Z' });
    const z = await seedCase(22, { status: 'accessioned', accession_no: 'S99-9022', accessioned_at: '2026-11-06T01:00:00Z' });
    const pick = (b: { data: { id: string }[] }) => ids(b).filter((id) => [x, y, z].includes(id));
    expect(pick(await list(CLAIMS.allA, { queue: 'all', sort: 'accessioned_at', limit: 200 }))).toEqual([y, x, z]);
    expect(pick(await list(CLAIMS.allA, { queue: 'all', sort: '-accessioned_at', limit: 200 }))).toEqual([z, x, y]);
  });

  it('cursor paging walks the whole queue exactly once (no duplicate, no gap) with limit 2', async () => {
    const mk = []; for (let i = 0; i < 5; i++) mk.push(await seedCase(30 + i, { status: 'received', priority: 'routine', received_at: `2026-10-0${i + 1}T04:00:00Z` }));
    const seen: string[] = []; let cursor: string | null = null;
    for (let guard = 0; guard < 100; guard++) {
      const p = await list(CLAIMS.allA, { queue: 'to_accession', limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...ids(p)); cursor = p.page.next_cursor; if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(mk.every((id) => seen.includes(id))).toBe(true);
  }, 60_000);

  it('AC-13.2: a centre-scoped user of A1 never sees a centre A2 case (list or detail → 404); an all-centres user sees both', async () => {
    const a1 = await seedCase(40, { status: 'received' }, CENTRE_A1);
    const a2 = await seedCase(41, { status: 'received' }, CENTRE_A2);
    const scoped = ids(await list(CLAIMS.a1Only, { queue: 'to_accession', limit: 200 }));
    expect(scoped).toContain(a1); expect(scoped).not.toContain(a2);
    const all = ids(await list(CLAIMS.allA, { queue: 'to_accession', limit: 200 }));
    expect(all).toContain(a1); expect(all).toContain(a2);
    const viaFilter = ids(await list(CLAIMS.a1Only, { queue: 'to_accession', centre_id: CENTRE_A2, limit: 200 }));
    expect(viaFilter).not.toContain(a2);
    const e = await h.asApp(CLAIMS.a1Only as never, (tx) => (manifest.handlers as any)['getAnatomicCase']({ params: { case_id: a2 }, query: {}, headers: {}, body: {} }, ctxFor(tx, CLAIMS.a1Only))).then(() => undefined, (x: unknown) => x);
    expect(isLimsError(e) && e.code).toBe('common.not_found');
  });

  it('AC-13.4: lookup by accession number opens the case; unknown label and another centre\'s label → 404', async () => {
    const a1 = await seedCase(50, { status: 'accessioned', accession_no: 'S99-9050', accessioned_at: TS }, CENTRE_A1);
    const a2 = await seedCase(51, { status: 'accessioned', accession_no: 'S99-9051', accessioned_at: TS }, CENTRE_A2);
    const look = (claims: { sub: string }, label: string) => h.asApp(claims as never, (tx) => (manifest.handlers as any)['lookupAnatomicObject']({ params: {}, query: {}, headers: {}, body: { label } }, ctxFor(tx, claims)));
    expect((await look(CLAIMS.a1Only, 'S99-9050') as any).body).toEqual({ object_kind: 'case', case_id: a1 });
    for (const label of ['S99-9051', 'S99-0000']) {
      const e = await look(CLAIMS.a1Only, label).then(() => undefined, (x: unknown) => x);
      expect(isLimsError(e) && e.code).toBe('common.not_found');
    }
    expect((await look(CLAIMS.allA, 'S99-9051') as any).body.case_id).toBe(a2);
  });
});
