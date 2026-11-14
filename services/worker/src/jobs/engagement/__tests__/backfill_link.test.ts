// C16.T-L2 — task engagement.backfill_link + projection service skeleton + views repo (06-PLAN row T-L2; 02-TRD §4.4 read models + backfill paragraph + timeline-view paragraph (CR-C16-022), §4.5 stage, §4.3.5 (merged / anonymised
// at backfill), §8.1 max 10, job key backfill:<link_id>; 05-SCHEMA patient_orders / patient_order_specimens / patient_reports; 02-CV §5.13 (only repository/views.repo.ts reads other schemas' v_pub_* views); 03-IC §6.3.)
// done_when: backfill from views + getReleasedReports. tests: backfill idempotent (run twice); backfill status_seq = specimen_version (the view already has `specimen_version` and `replaces_specimen_id`, db/migrations lab 1265-1272).
// Fails now: manifest task 'engagement.backfill_link' is the T-01 fail-closed stub; tasks/backfill_link.ts, service/projection.service.ts and repository/views.repo.ts do not exist.
//
// SEAMS (spec fixes behaviour, not names; same convention as send_login_otp.test.ts):
//   tasks/backfill_link.ts exports createBackfillLink() -> TaskHandler; payload {tenant_id, link_id} (what the redeem handler enqueued); ctx = worker JobContext (system actor, tx, now(), ports{FrontdeskPort, ReportingPort}, log).
//   Views are read ONLY through tx.query: `frontdesk.v_pub_order_status`, `lab.v_pub_specimen_timeline`, `billing.v_pub_order_balance`, always with `tenant_id = $n`; orders by `tenant_id = $1 AND patient_id = $2 ORDER BY registered_at DESC, order_id
//   LIMIT n OFFSET m`, timeline / balance batched with `order_id = ANY($n)`. The world (api __tests__/link.world.ts) supports LIMIT / OFFSET paging only (no keyset tuple compare, no JOIN / sub-select).
//   Reports: ReportingPort.getReleasedReports(ctx, {filter:{patientId, includeSuperseded:true}, limit, cursor} (03-IC §4.7: includeSuperseded is a ReportsFilter field, not an input field)) - the REAL C6 fake (packages/fakes ReportingPort.fake.ts). NOTE: that fake rejects limit > 100 (the TRD says pages of 200);
//   this test only requires limit <= 200 and that every page is followed via nextCursor.
//   Writes: plain INSERT .. ON CONFLICT (pk) DO UPDATE SET c = EXCLUDED.c .. (the world evaluates EXCLUDED and `col + 1`); the seq guard of 02-CV §7.4 for specimens may be a DO UPDATE .. WHERE; the world does not evaluate that WHERE
//   (always applies, like fakeSql.ts) so the guard test below ALSO accepts a pre-read + skip; either way the higher status_seq must survive.
import '../../../../../api/src/__tests__/setup-env.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';
import { manifest } from '../index.js';
import { createFakeReportingPort } from '../../../../../../packages/fakes/src/ReportingPort.fake';
import { REPO_ROOT } from '../../../../../api/src/core/module.js';
import { ID, T0, TENANT_A, TENANT_B, makeLinkWorld, type LinkWorld } from '../../../../../api/src/modules/engagement/__tests__/link.world.js';

const PHONE = '+99001000001';
const PAT = ID(0x700), OTHER_PAT = ID(0x701);
const CENTRE = ID(0xc01), BRANCH = ID(0xb01);
const task = async () => (await import('../tasks/backfill_link.js')).createBackfillLink() as (p: any, c: any) => Promise<void>;
const rejection = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } return undefined; };
const minus = (min: number) => new Date(Date.parse(T0) - min * 60_000).toISOString();

// ---------------------------------------------------------------- published-view fixtures (columns of the real views, db/migrations frontdesk 638-641, lab 1265-1272, billing 1050-1052)
const oid = (n: number) => ID(0x1000 + n), sid = (n: number, k = 0) => ID(0x2000 + n * 16 + k), rid = (n: number) => ID(0x3000 + n);
const orderRow = (n: number, o: Record<string, any> = {}) => ({ tenant_id: TENANT_A, order_id: oid(n), patient_id: PAT, centre_id: CENTRE, branch_id: BRANCH, source: 'front_desk', source_ref_id: null, partner_id: null, status: 'registered', registered_at: minus(n), updated_at: T0, ...o });
const specRow = (n: number, k: number, status: string, o: Record<string, any> = {}) => ({ tenant_id: TENANT_A, specimen_id: sid(n, k), order_id: oid(n), centre_id: CENTRE, processing_branch_id: BRANCH, specimen_type_code: 'SER', priority: 'routine', status, ordered_at: minus(n + k), collected_at: null,
  in_transit_at: null, received_at: null, first_resulted_at: null, first_verified_at: null, all_approved_at: null, reported_at: null, rejected_at: null, rejection_reason_code: null, parent_specimen_id: null, replaces_specimen_id: null, specimen_version: 3 + k, ...o });
const balRow = (n: number, o: Record<string, any> = {}) => ({ tenant_id: TENANT_A, order_id: oid(n), invoiced_paisa: 100000, paid_paisa: 100000, credited_paisa: 0, balance_due_paisa: 0, balance_version: 4, release_basis: 'paid_in_full', ...o });
const report = (n: number, o: Record<string, any> = {}) => ({ id: rid(n), tenantId: TENANT_A, reportId: ID(0x4000 + n), versionNo: 1, orderId: oid(n), patientId: PAT, kind: 'final', status: 'valid', released: true, releasedAt: minus(n), panelNames: ['Synthetic Panel', 'Lipid Profile'], ...o });

interface Fx { w: LinkWorld; link: Record<string, any>; acct: Record<string, any>; rp: any; run: (payload?: any, over?: Record<string, any>) => Promise<void>; projected: () => Record<string, any[]> }
async function setup(o: { reports?: any[]; method?: string; link?: Record<string, any>; showPartner?: boolean } = {}): Promise<Fx> {
  const w = makeLinkWorld({ showPartnerOrders: o.showPartner }); const t = await task();
  const acct = w.seedAccount(PHONE); w.setDemographics(PAT, { fullName: 'Synthetic Patient', sex: 'female', phoneE164: PHONE }); w.setDemographics(OTHER_PAT, {});
  const link = w.seedLink(acct['id'], PAT, { method: o.method ?? 'link_code', ...(o.link ?? {}) });
  const rp: any = createFakeReportingPort({ seed: 7, fixtures: { reports: o.reports ?? [] } as any });
  const run = (payload: any = { tenant_id: w.tenantId, link_id: link['id'] }, over: Record<string, any> = {}) => w.inTx(() => t(payload, w.jobCtx({ ports: { ...w.ports, ReportingPort: rp }, ...over })));
  const projected = () => ({ orders: w.t['patient_orders']!, specimens: w.t['patient_order_specimens']!, reports: w.t['patient_reports']! });
  return { w, link, acct, rp, run, projected };
}
const VOLATILE = ['created_at', 'updated_at', 'synced_at', 'status_version', 'created_by', 'updated_by'];
const stable = (rows: any[], key: string[]) => JSON.stringify([...rows].map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !VOLATILE.includes(k)))).sort((a, b) => key.map((k) => String(a[k])).join().localeCompare(key.map((k) => String(b[k])).join())));
const ordersOf = (f: Fx) => f.w.t['patient_orders']!; const orderOf = (f: Fx, n: number) => ordersOf(f).find((r) => r['order_id'] === oid(n))!;
const specOf = (f: Fx, n: number, k = 0) => f.w.t['patient_order_specimens']!.find((r) => r['specimen_id'] === sid(n, k))!;

describe('manifest (TRD §8.1)', () => {
  it('engagement.backfill_link is implemented (no longer the fail-closed stub), max_attempts 10, manifest still validates', async () => {
    expect(() => validateManifests([manifest])).not.toThrow();
    expect(manifest.maxAttempts?.['engagement.backfill_link']).toBe(10);
    const f = await setup(); const e = await rejection(manifest.tasks!['engagement.backfill_link']!({ tenant_id: f.w.tenantId, link_id: f.link['id'] } as any, f.w.jobCtx({ ports: { ...f.w.ports, ReportingPort: f.rp } }) as any));
    expect(String(e?.message ?? '')).not.toMatch(/not implemented/);
  });
});

describe('backfill from the published views (TRD §4.4)', () => {
  const seedViews = (f: Fx) => {
    const v = f.w.t;
    v['orders']!.push(orderRow(1), orderRow(2, { status: 'in_progress' }), orderRow(3, { source: 'home_collection', source_ref_id: ID(0x9001) }), orderRow(99, { patient_id: OTHER_PAT }), { ...orderRow(98), tenant_id: TENANT_B });
    v['timeline']!.push(specRow(1, 0, 'ordered'), specRow(2, 0, 'collected', { collected_at: minus(30) }), specRow(2, 1, 'received', { received_at: minus(20), specimen_version: 9 }), specRow(3, 0, 'rejected', { rejected_at: minus(10), rejection_reason_code: 'hemolysed', specimen_version: 5 }),
      specRow(3, 1, 'recollection_ordered', { replaces_specimen_id: sid(3, 0), specimen_version: 2 }), specRow(99, 0, 'collected'), { ...specRow(98, 0, 'collected'), tenant_id: TENANT_B });
    v['balances']!.push(balRow(2, { invoiced_paisa: 150000, paid_paisa: 100000, balance_due_paisa: 50000, balance_version: 6, release_basis: 'due_outstanding' }), balRow(3));
  };

  it('projects the patient\'s orders (and nobody else\'s, nor another tenant\'s) with the view columns, balances and payment_due', async () => {
    const f = await setup(); seedViews(f); await f.run();
    expect(ordersOf(f).map((r) => r['order_id']).sort()).toEqual([oid(1), oid(2), oid(3)].sort());
    expect(orderOf(f, 2)).toMatchObject({ tenant_id: TENANT_A, patient_id: PAT, centre_id: CENTRE, branch_id: BRANCH, source: 'front_desk', order_status: 'in_progress', invoiced_paisa: 150000, paid_paisa: 100000, balance_due_paisa: 50000, balance_version: 6, release_basis: 'due_outstanding', payment_due: true });
    expect(Date.parse(orderOf(f, 2)['registered_at'])).toBe(Date.parse(minus(2))); expect(Date.parse(orderOf(f, 2)['visible_at'])).toBe(Date.parse(minus(2)));
    expect(orderOf(f, 3)).toMatchObject({ source: 'home_collection', balance_due_paisa: 0, release_basis: 'paid_in_full', payment_due: false });
    expect(orderOf(f, 1)).toMatchObject({ invoiced_paisa: null, paid_paisa: null, balance_due_paisa: null, balance_version: null, release_basis: null, payment_due: false }); // no invoice yet
    expect(Date.parse(orderOf(f, 1)['synced_at'])).toBe(Date.parse(T0));
    for (const v of f.w.viewQueries) expect(v.text).toMatch(/tenant_id\s*=\s*\$\d+/i);                                    // REQ-SEC-024
    expect(new Set(f.w.viewQueries.map((v) => v.view))).toEqual(new Set(['v_pub_order_status', 'v_pub_specimen_timeline', 'v_pub_order_balance']));
    expect(f.w.viewQueries.find((v) => v.view === 'v_pub_order_status')!.text).toMatch(/order by registered_at desc, order_id/i);
  });

  it('projects specimens: status_seq = specimen_version, replaces_specimen_id, recollection_required from recollection_ordered, rejection reason kept (staff-only), ordinals 1..n per order', async () => {
    const f = await setup(); seedViews(f); await f.run();
    expect(specOf(f, 2, 1)).toMatchObject({ tenant_id: TENANT_A, order_id: oid(2), patient_id: PAT, specimen_type_code: 'SER', status: 'received', status_seq: 9, recollection_required: false, replaces_specimen_id: null });
    expect(specOf(f, 3, 0)).toMatchObject({ status: 'rejected', status_seq: 5, rejection_reason_code: 'hemolysed' }); expect(Date.parse(specOf(f, 3, 0)['rejected_at'])).toBe(Date.parse(minus(10)));
    expect(specOf(f, 3, 1)).toMatchObject({ status: 'recollection_ordered', status_seq: 2, recollection_required: true, replaces_specimen_id: sid(3, 0) });
    expect(Date.parse(specOf(f, 2, 0)['collected_at'])).toBe(Date.parse(minus(30))); expect(Date.parse(specOf(f, 2, 1)['received_at'])).toBe(Date.parse(minus(20)));
    expect(f.w.t['patient_order_specimens']).toHaveLength(5);                                                           // orders 1-3 only
    for (const n of [1, 2, 3]) expect(f.w.t['patient_order_specimens']!.filter((s) => s['order_id'] === oid(n)).map((s) => s['ordinal']).sort()).toEqual(Array.from({ length: f.w.t['patient_order_specimens']!.filter((s) => s['order_id'] === oid(n)).length }, (_, i) => i + 1));
  });

  it('stages (TRD §4.5): registered / sample_collected / in_lab / recollection_needed / cancelled / partial_report / report_ready', async () => {
    const rp = [report(6), report(7, { kind: 'partial' })];
    const f = await setup({ reports: rp }); const v = f.w.t;
    v['orders']!.push(orderRow(1), orderRow(2), orderRow(3), orderRow(4), orderRow(5, { status: 'cancelled' }), orderRow(6), orderRow(7), orderRow(8));
    v['timeline']!.push(specRow(1, 0, 'ordered'), specRow(2, 0, 'collected'), specRow(3, 0, 'received'), specRow(4, 0, 'recollection_ordered'), specRow(4, 1, 'received'), specRow(5, 0, 'collected'), specRow(6, 0, 'reported'), specRow(7, 0, 'in_process'));
    await f.run();
    const stage = (n: number) => orderOf(f, n)['stage'];
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(stage)).toEqual(['registered', 'sample_collected', 'in_lab', 'recollection_needed', 'cancelled', 'report_ready', 'partial_report', 'registered']);
  });

  it('partner_manifest orders are not projected unless show_partner_orders; pre-existing rows of other patients are untouched', async () => {
    const off = await setup(); off.w.t['orders']!.push(orderRow(1), orderRow(2, { source: 'partner_manifest', partner_id: ID(0x9100) })); await off.run();
    expect(ordersOf(off).map((r) => r['order_id'])).toEqual([oid(1)]);
    const on = await setup({ showPartner: true }); on.w.t['orders']!.push(orderRow(1), orderRow(2, { source: 'partner_manifest', partner_id: ID(0x9100) })); await on.run();
    expect(ordersOf(on).map((r) => r['order_id']).sort()).toEqual([oid(1), oid(2)].sort());
  });

  it('paging: 450 orders -> every order projected, no view page above 200 rows, timeline / balance read in batches (no N+1)', async () => {
    const f = await setup(); for (let n = 1; n <= 450; n++) { f.w.t['orders']!.push(orderRow(n)); f.w.t['timeline']!.push(specRow(n, 0, 'collected')); }
    await f.run();
    expect(ordersOf(f)).toHaveLength(450);
    const oq = f.w.viewQueries.filter((v) => v.view === 'v_pub_order_status'); expect(oq.length).toBeGreaterThanOrEqual(3); for (const q of oq) expect(q.limit).toBeLessThanOrEqual(200);
    for (const view of ['v_pub_specimen_timeline', 'v_pub_order_balance']) expect(f.w.viewQueries.filter((v) => v.view === view).length).toBeLessThanOrEqual(Math.ceil(450 / 50));
  });

  it('caps at 1,000 orders [CONV], newest registered_at first', async () => {
    const f = await setup(); for (let n = 1; n <= 1005; n++) f.w.t['orders']!.push(orderRow(n)); await f.run();
    expect(ordersOf(f)).toHaveLength(1000); for (let n = 1001; n <= 1005; n++) expect(ordersOf(f).some((r) => r['order_id'] === oid(n))).toBe(false); expect(ordersOf(f).some((r) => r['order_id'] === oid(1))).toBe(true);
  });
});

describe('backfill of reports via ReportingPort.getReleasedReports (TRD §4.4)', () => {
  it('asks C6 for the link patient only with includeSuperseded, as the system actor; projects every version with kind, status, released_at, panel names, smart flag; other patients\' reports never', async () => {
    const f = await setup({ reports: [report(1), report(1, { id: rid(11), versionNo: 2, status: 'valid', kind: 'amended', releasedAt: minus(1) }), report(1, { id: rid(12), versionNo: 1, reportId: ID(0x4099), status: 'superseded', orderId: oid(1), releasedAt: minus(5) }),
      report(2, { patientId: OTHER_PAT }), report(3, { smartSummary: { x: 1 } as any })] });
    f.w.t['orders']!.push(orderRow(1), orderRow(3)); await f.run();
    const calls = f.rp.calls('getReleasedReports'); expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) { expect(c.input.filter).toEqual({ patientId: PAT, includeSuperseded: true }); /* 03-IC §4.7 ReportsFilter */ expect(c.ctx.actorId ?? '').not.toBe(''); if (c.input.limit !== undefined) expect(c.input.limit).toBeLessThanOrEqual(200); }
    const rows = f.w.t['patient_reports']!; expect(rows).toHaveLength(4);
    const r1 = rows.find((r) => r['report_id'] === ID(0x4001) && r['version_no'] === 1)!;
    expect(r1).toMatchObject({ tenant_id: TENANT_A, patient_id: PAT, order_id: oid(1), report_kind: 'final', status: 'valid', smart_summary_available: false, panel_names: ['Synthetic Panel', 'Lipid Profile'] }); expect(Date.parse(r1['released_at'])).toBe(Date.parse(minus(1)));
    expect(rows.find((r) => r['report_id'] === ID(0x4001) && r['version_no'] === 2)).toMatchObject({ report_kind: 'amended' });
    expect(rows.find((r) => r['report_id'] === ID(0x4099))).toMatchObject({ status: 'superseded' });
    expect(rows.find((r) => r['report_id'] === ID(0x4003))).toMatchObject({ smart_summary_available: true });
    expect(rows.some((r) => r['patient_id'] === OTHER_PAT)).toBe(false);
  });
  it('follows nextCursor: 250 reports -> all 250 projected', async () => {
    const f = await setup({ reports: Array.from({ length: 250 }, (_, i) => report(i + 1, { id: ID(0x5000 + i), reportId: ID(0x6000 + i), releasedAt: minus(i + 1) })) });
    for (let n = 1; n <= 250; n++) f.w.t['orders']!.push(orderRow(n)); await f.run();
    expect(f.w.t['patient_reports']).toHaveLength(250); expect(f.rp.calls('getReleasedReports').length).toBeGreaterThanOrEqual(3);
  });
});

describe('idempotent upserts and the seq guard (02-CV §7.4)', () => {
  const full = async () => {
    const f = await setup({ reports: [report(2), report(3, { kind: 'partial' })] }); const v = f.w.t;
    v['orders']!.push(orderRow(1), orderRow(2), orderRow(3)); v['timeline']!.push(specRow(1, 0, 'ordered'), specRow(2, 0, 'received', { specimen_version: 4 }), specRow(3, 0, 'collected')); v['balances']!.push(balRow(2));
    return f;
  };
  it('run twice -> the same rows (no duplicates, same business columns)', async () => {
    const f = await full(); await f.run();
    const a = [stable(f.w.t['patient_orders']!, ['order_id']), stable(f.w.t['patient_order_specimens']!, ['specimen_id']), stable(f.w.t['patient_reports']!, ['report_id', 'version_no'])];
    const counts = [f.w.t['patient_orders']!.length, f.w.t['patient_order_specimens']!.length, f.w.t['patient_reports']!.length]; expect(counts).toEqual([3, 3, 2]);
    f.w.advance(60_000); await f.run();
    expect([stable(f.w.t['patient_orders']!, ['order_id']), stable(f.w.t['patient_order_specimens']!, ['specimen_id']), stable(f.w.t['patient_reports']!, ['report_id', 'version_no'])]).toEqual(a);
    expect([f.w.t['patient_orders']!.length, f.w.t['patient_order_specimens']!.length, f.w.t['patient_reports']!.length]).toEqual(counts);
  });
  it('a re-run picks up a changed view row (collected -> received, seq 3 -> 8) and a new order', async () => {
    const f = await full(); await f.run();
    Object.assign(f.w.t['timeline']!.find((r) => r['specimen_id'] === sid(1, 0))!, { status: 'received', specimen_version: 8, received_at: minus(1) }); f.w.t['orders']!.push(orderRow(4));
    await f.run();
    expect(specOf(f, 1)).toMatchObject({ status: 'received', status_seq: 8 }); expect(orderOf(f, 1)['stage']).toBe('in_lab'); expect(ordersOf(f)).toHaveLength(4);
  });
  it('a projection row already ahead of the view (an event with a higher seq) is NOT overwritten by the older backfill state', async () => {
    const f = await full(); await f.run();
    Object.assign(specOf(f, 2), { status: 'verified', status_seq: 9 });                                                  // an event applied after the view row was read
    await f.run();
    expect(specOf(f, 2)).toMatchObject({ status: 'verified', status_seq: 9 });
  });
});

describe('which links are backfilled', () => {
  it('a revoked, a missing, or another tenant\'s link -> silent no-op (no view read, no port call, no rows)', async () => {
    for (const mk of ['revoked', 'missing', 'other_tenant'] as const) {
      const f = await setup(); f.w.t['orders']!.push(orderRow(1)); let payload: any = { tenant_id: f.w.tenantId, link_id: f.link['id'] };
      if (mk === 'revoked') Object.assign(f.link, { status: 'revoked', revoked_by_kind: 'account', revoked_reason_code: 'patient_request', revoked_at: T0 });
      if (mk === 'missing') payload = { tenant_id: f.w.tenantId, link_id: ID(0xdead) };
      if (mk === 'other_tenant') f.link['tenant_id'] = TENANT_B;
      await f.run(payload);
      expect(f.w.viewQueries, mk).toHaveLength(0); expect(f.rp.calls('getReleasedReports'), mk).toHaveLength(0); expect(f.w.t['patient_orders'], mk).toHaveLength(0);
    }
  });
  it('bad payloads (not a uuid, missing, tenant mismatch) do not throw and read nothing', async () => {
    const f = await setup();
    for (const p of [{ tenant_id: f.w.tenantId, link_id: 'nope' }, { tenant_id: f.w.tenantId }, {}, { tenant_id: TENANT_B, link_id: f.link['id'] }]) await expect(f.run(p)).resolves.toBeUndefined();
    expect(f.w.viewQueries).toHaveLength(0); expect(f.w.t['patient_orders']).toHaveLength(0);
  });
  it('a SUSPENDED link is still projected (§4.4: "patient ids with an active or suspended link")', async () => {
    const f = await setup({ link: { status: 'suspended', suspend_reason: 'dormant', suspended_at: T0 } }); f.w.t['orders']!.push(orderRow(1)); await f.run();
    expect(ordersOf(f)).toHaveLength(1); expect(f.link['status']).toBe('suspended');
  });
});

describe('link refresh at backfill (TRD §4.3.3 step 4, §4.3.5)', () => {
  const asked = (f: Fx) => f.w.frontdesk.calls.map((c) => c.input);
  it('report_link: display_name and sex_snapshot come from FrontdeskPort.getPatientDemographics({purpose:\'patient_app_link\'}) as the system actor', async () => {
    const f = await setup({ method: 'report_link', link: { display_name: 'pending', sex_snapshot: null, visible_from: minus(60) } }); f.w.setDemographics(PAT, { fullName: 'Rupa Synthetic Name', sex: 'male', phoneE164: PHONE });
    await f.run();
    expect(asked(f)).toContainEqual({ patientId: PAT, purpose: 'patient_app_link' }); expect(f.w.frontdesk.calls.every((c) => c.actor === 'system')).toBe(true);
    expect(f.link).toMatchObject({ display_name: 'Rupa Synthetic Name', sex_snapshot: 'male', status: 'active' });
  });
  it('merged / anonymised patient -> the link is suspended (patient_merged / patient_anonymised) with suspended_at; an active patient leaves it active', async () => {
    for (const [st, reason] of [['merged', 'patient_merged'], ['anonymised', 'patient_anonymised']] as const) {
      const f = await setup(); f.w.setDemographics(PAT, { status: st, phoneE164: PHONE }); await f.run();
      expect(f.link, st).toMatchObject({ status: 'suspended', suspend_reason: reason }); expect(f.link['suspended_at']).toBeTruthy();
    }
    const ok = await setup(); await ok.run(); expect(ok.link['status']).toBe('active');
  });
});

describe('failure handling: the transaction is all-or-nothing and the job retries', () => {
  it('a C6 failure after the orders were read rolls every projection write back and throws (so the queue retries); the retry completes', async () => {
    const f = await setup({ reports: [report(1)] }); f.w.t['orders']!.push(orderRow(1)); f.w.t['timeline']!.push(specRow(1, 0, 'collected'));
    f.rp.failNext('getReleasedReports', 'common.internal');
    const e = await rejection(f.run()); expect(e).toBeTruthy();
    expect(f.w.t['patient_orders']).toHaveLength(0); expect(f.w.t['patient_order_specimens']).toHaveLength(0); expect(f.w.t['patient_reports']).toHaveLength(0);
    await f.run(); expect(f.w.t['patient_orders']).toHaveLength(1); expect(f.w.t['patient_reports']).toHaveLength(1);
  });
  it('nothing sensitive in logs: no phone, no patient name, no rejection reason', async () => {
    const f = await setup(); f.w.t['orders']!.push(orderRow(1)); f.w.t['timeline']!.push(specRow(1, 0, 'rejected', { rejection_reason_code: 'hemolysed_secret_reason' })); await f.run();
    const seen = f.w.observed(); for (const bad of [PHONE, PHONE.slice(1), 'Synthetic Patient', 'hemolysed_secret_reason']) expect(seen).not.toContain(bad);
  });
});

describe('source guards (02-CV §5.13; TRD §3 layout)', () => {
  const api = join(REPO_ROOT, 'services/api/src/modules/engagement'), worker = join(REPO_ROOT, 'services/worker/src/jobs/engagement');
  const files = (d: string): string[] => { const out: string[] = []; for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) { if (e.name !== '__tests__') out.push(...files(p)); } else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p); } return out; };
  it('the three files exist: service/projection.service.ts, repository/views.repo.ts, tasks/backfill_link.ts', () => {
    for (const p of [join(api, 'service/projection.service.ts'), join(api, 'repository/views.repo.ts'), join(worker, 'tasks/backfill_link.ts')]) expect(() => readFileSync(p, 'utf8'), p).not.toThrow();
  });
  it('the link / projection code names the other schemas\' v_pub_* views ONLY in repository/views.repo.ts (T-B4\'s existing booking_jobs.ts read is out of scope here)', () => {
    const mine = [...files(join(api, 'service')), ...files(join(api, 'handlers')), join(worker, 'tasks/backfill_link.ts'), join(api, 'service/projection.service.ts')].filter((p, i, a) => a.indexOf(p) === i);
    for (const p of mine) { let s: string; try { s = readFileSync(p, 'utf8'); } catch { continue; } expect(s, relative(REPO_ROOT, p)).not.toMatch(/v_pub_order_status|v_pub_specimen_timeline|v_pub_order_balance/); }
    expect(readFileSync(join(api, 'repository/views.repo.ts'), 'utf8')).toMatch(/v_pub_order_status[\s\S]*v_pub_specimen_timeline[\s\S]*v_pub_order_balance|v_pub_specimen_timeline[\s\S]*v_pub_order_balance[\s\S]*v_pub_order_status/);
  });
  it('the task writes read models only through the shared projection service (consumers, backfill and reconcile share it)', () => {
    expect(readFileSync(join(worker, 'tasks/backfill_link.ts'), 'utf8')).toMatch(/projection\.service/);
    expect(readFileSync(join(worker, 'tasks/backfill_link.ts'), 'utf8')).not.toMatch(/INSERT\s+INTO\s+engagement\.patient_/i);
  });
});
