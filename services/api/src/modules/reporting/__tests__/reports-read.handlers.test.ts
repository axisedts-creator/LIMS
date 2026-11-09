// C6-T15 — R1-R5 staff read endpoints (02-TRD §6.1/§6.2/§12.1; 01-PRD AC-08.4; 07-SECURITY REQ-SEC-017/080/081; P-10 for R2 barcode).
// listReports, searchReports, getReport, getReportVersion, downloadReportVersionPdf leave the 501 list. Helpers + ASSUMED shapes: reports-read.helpers.ts.
// Request shapes: list query values are raw HTTP strings (display_status as comma list OR array), limit/has_review_flag strings; `page` = { limit, next_cursor? } (as O6/N1).
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../core/module.js';
import {
  CENTRE_A, CENTRE_B, DELIVERY_STATES, ITEM_KEYS, OID, PDF, REPORT_DETAIL_KEYS, REPORT_SUMMARY_KEYS, REPORT_SUMMARY_REQUIRED, REPORTS_BUCKET, RELEASED, RID, SENTINEL_PHONE, SENTINEL_SNAPSHOT,
  TENANT_A, TENANT_B, VERSION_SUMMARY_KEYS, VERSION_SUMMARY_REQUIRED, VID, deliveryRow, hasNull, idN, iso, itemRow, lower, readSetup, rejection, reportRow, versionRow, type ReadOpts, type Row,
} from './reports-read.helpers.js';

const OPS = ['listReports', 'searchReports', 'getReport', 'getReportVersion', 'downloadReportVersionPdf'];
let manifest: any;
beforeAll(async () => {
  const k = join(mkdtempSync(join(tmpdir(), 'c6-t15-')), 'otp.key'); writeFileSync(k, Buffer.alloc(32, 7));
  process.env.LIMS_CORE_ENV = 'dev'; delete process.env.NODE_ENV; delete process.env.LIMS_REPORTING_ALLOW_REAL_PROVIDERS; process.env.LIMS_REPORTING_OTP_HMAC_KEY_FILE = k;
  manifest = (await import('../index.js')).manifest;
});
const call = (op: string, s: ReturnType<typeof readSetup>, req: { params?: Row; query?: Row; body?: unknown } = {}, ctx: Row = s.ctx({ operationId: op })) =>
  manifest.handlers[op]({ params: req.params ?? {}, query: req.query ?? {}, headers: {}, body: req.body }, ctx);
const list = (s: ReturnType<typeof readSetup>, query: Row = {}) => call('listReports', s, { query });
const ids = (r: { body: any }) => r.body.data.map((x: any) => x.id);
const keysOk = (obj: Row, allowed: readonly string[], required: readonly string[] = []) => {
  expect(Object.keys(obj).filter((k) => !allowed.includes(k))).toEqual([]); expect(required.filter((k) => !(k in obj))).toEqual([]);
};
/** reports 1..n with distinct updated_at (1 oldest), each with the given latest-version row (if any). */
const fleet = (n: number, over: (i: number) => Row = () => ({})): ReadOpts => ({ reports: Array.from({ length: n }, (_, k) => reportRow(k + 1, over(k + 1))) });

describe('contract', () => {
  const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/reporting.yaml'));
  const find = (op: string) => Object.values(spec.paths).flatMap((p: any) => Object.values(p) as any[]).find((x: any) => x?.operationId === op);
  it.each(OPS)('%s exists with x-permission reporting.report.read, no idempotency key', (op) => {
    const o = find(op); expect(o['x-permission']).toBe('reporting.report.read'); expect(o['x-idempotency']).toBe('none');
  });
  it.each(OPS)('%s is no longer a 501 stub: without a request context it fails closed (auth.unauthenticated), echoing no input', async (op) => {
    const planted = 'PLANTED-TOKEN-7d2e';
    const e = await rejection(manifest.handlers[op]({ params: { report_id: planted, report_version_id: planted }, query: { cursor: planted }, headers: { authorization: planted }, body: { registration_no: planted } },
      { operationId: op, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } }));
    expect(e?.code).toBe('auth.unauthenticated'); expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.details })).not.toContain(planted);
  });
});

describe('R1 listReports — ReportSummary (field allowlist, snapshot columns, delivery-free)', () => {
  it('200 {data, page}; each row has only allowlisted keys, all required ones, no null, snake_case; no port is called (snapshot columns, review fix #6)', async () => {
    const s = readSetup({ ...fleet(3), versions: [versionRow(1, 1)] });
    const r = await list(s);
    expect(r.status).toBe(200); expect(r.body.data).toHaveLength(3); expect(r.body.page).toMatchObject({ limit: 50 });
    for (const x of r.body.data) keysOk(x, REPORT_SUMMARY_KEYS, REPORT_SUMMARY_REQUIRED);
    expect(hasNull(r.body)).toBe(false);
    expect(s.portCalls).toEqual([]);
  });
  it('maps the snapshot columns verbatim', async () => {
    const s = readSetup(fleet(1, () => ({ registration_no: '0001SY123456', patient_display_name: 'Test Patient 77', centre_code: 'C000000099', referrer_name: 'Dr. Synthetic Referrer' })));
    const x = (await list(s)).body.data[0];
    expect(x).toMatchObject({ id: RID(1), order_id: OID(1), family: 'laboratory', centre_id: CENTRE_A, state: 'open', registration_no: '0001SY123456', patient_display_name: 'Test Patient 77',
      centre_code: 'C000000099', referrer_name: 'Dr. Synthetic Referrer', version: 5, registered_at: iso(1, 1), updated_at: iso(2, 1) });
  });
  it('NULL snapshot columns are omitted (no nulls): patient_display_name (anonymised), referrer_name, held_basis, balance_due_paisa', async () => {
    const x = (await list(readSetup(fleet(1, () => ({ patient_display_name: null, referrer_name: null }))))).body.data[0];
    for (const k of ['patient_display_name', 'referrer_name', 'held_basis', 'balance_due_paisa', 'first_released_at', 'released_version_no']) expect(k in x).toBe(false);
  });
  it('balance_due_paisa = the billing hint column, as a JSON number (pg returns bigint as a string)', async () => {
    const x = (await list(readSetup(fleet(1, () => ({ billing_balance_due_paisa: '50000' }))))).body.data[0];
    expect(x.balance_due_paisa).toBe(50000);
  });
  it('internal / PHI columns never leave the mapper (patient_id, hashes, counters, created_by, tenant_id, branch_id, referrer_id, review billing hints)', async () => {
    const s = readSetup({ ...fleet(1), versions: [versionRow(1, 1)] }); const r = await list(s); const t = JSON.stringify(r.body);
    for (const k of ['patient_id', 'lab_approved_set_hash', 'regeneration_counter', 'lab_ready_seq', 'created_by', 'tenant_id', 'branch_id', 'referrer_id', 'billing_release_eligible', 'billing_balance_version', 'needs_assembly', 'content_snapshot', 'pdf_object_path'])
      expect(t).not.toContain(`"${k}"`);
    expect(t).not.toContain(SENTINEL_SNAPSHOT);
  });
  it('summaries are delivery-free: no deliveries_summary / destination / delivery ids even when deliveries exist', async () => {
    const s = readSetup({ ...fleet(1), deliveries: [deliveryRow(1, 1, 'sent')] }); const t = JSON.stringify((await list(s)).body);
    expect(t).not.toContain('deliveries_summary'); expect(t).not.toContain(SENTINEL_PHONE); expect(t).not.toContain('destination');
    expect(s.stmtText()).not.toMatch(/reporting\.deliveries/);              // not even read: R1 stays one cheap query set
  });
  it('items_total / items_ready count active items; an item is ready when every flag it requires is ready; removed items are ignored [ASSUMED]', async () => {
    const s = readSetup({ ...fleet(1), items: [itemRow(1, 1), itemRow(1, 2, { lab_ready: false }), itemRow(1, 3, { item_status: 'removed', lab_ready: false }),
      itemRow(1, 4, { requires_lab: false, requires_outsourced: true, lab_ready: false, outsourced_ready: true })] });
    expect((await list(s)).body.data[0]).toMatchObject({ items_total: 3, items_ready: 2 });
  });
  it('latest_version_no / released_version_no come from the report row', async () => {
    const x = (await list(readSetup(fleet(1, () => ({ latest_version_no: 3, released_version_no: 2, first_released_at: iso(3, 5) }))))).body.data[0];
    expect(x).toMatchObject({ latest_version_no: 3, released_version_no: 2, first_released_at: iso(3, 5) });
  });
  it('PHI (patient_display_name, registration_no) never reaches logs or the access log', async () => {
    const s = readSetup(fleet(2)); expect((await list(s)).status).toBe(200);
    for (const t of ['Test Patient 000001', '0001SY000001']) expect(s.allText()).not.toContain(t);
  });
});

describe('R1 display_status (03-APP-FLOW §1: first match wins)', () => {
  const status = async (rep: Row, versions: Row[] = []) => (await list(readSetup({ reports: [reportRow(1, rep)], versions }))).body.data[0].display_status;
  const V = (n: number, over: Row = {}) => versionRow(1, n, over);
  it.each<[string, Row, Row[], string]>([
    ['cancelled wins over everything', { state: 'cancelled', needs_assembly: true, latest_version_no: 1 }, [V(1, RELEASED)], 'cancelled'],
    ['render_failed: latest version failed', { latest_version_no: 1 }, [V(1, { status: 'render_failed', pdf_object_path: null })], 'render_failed'],
    ['rendering: latest version rendering', { latest_version_no: 1 }, [V(1, { status: 'rendering', pdf_object_path: null })], 'rendering'],
    ['held: latest rendered with held_basis', { latest_version_no: 1 }, [V(1, { held_basis: 'due_outstanding', held_checked_at: iso(2, 1) })], 'held'],
    ['ready_to_release: latest rendered, no held_basis', { latest_version_no: 1 }, [V(1)], 'ready_to_release'],
    ['released: latest version released', { latest_version_no: 1, released_version_no: 1, first_released_at: iso(3, 5) }, [V(1, RELEASED)], 'released'],
    ['assembling: needs_assembly and no version yet', { needs_assembly: true }, [], 'assembling'],
    ['awaiting_content: nothing yet', {}, [], 'awaiting_content'],
  ])('%s', async (_n, rep, versions, want) => expect(await status(rep, versions)).toBe(want));
  it('only the LATEST version counts (v1 released, v2 failed => render_failed; superseded/discarded older rows are ignored)', async () => {
    expect(await status({ latest_version_no: 2, released_version_no: 1 }, [versionRow(1, 1, { ...RELEASED, status: 'superseded' }), versionRow(1, 2, { status: 'render_failed', pdf_object_path: null })])).toBe('render_failed');
  });
  it('held_basis is exposed on the summary of a held report', async () => {
    const s = readSetup({ reports: [reportRow(1, { latest_version_no: 1 })], versions: [versionRow(1, 1, { held_basis: 'no_invoice' })] });
    expect((await list(s)).body.data[0]).toMatchObject({ display_status: 'held', held_basis: 'no_invoice' });
  });
});

describe('R1 filters, sort, paging', () => {
  const mixed = (): ReadOpts => ({
    reports: [reportRow(1, { latest_version_no: 1, released_version_no: 1, first_released_at: iso(3, 10), registered_at: iso(1, 30), updated_at: iso(4, 1) }),
      reportRow(2, { latest_version_no: 1, registered_at: iso(1, 20), updated_at: iso(4, 3) }),
      reportRow(3, { family: 'narrative', registered_at: iso(1, 10), updated_at: iso(4, 2), review_flag: 'released_order_cancelled', latest_version_no: 1, released_version_no: 1, first_released_at: iso(5, 10) }),
      reportRow(4, { registered_at: iso(1, 40), updated_at: iso(4, 4) })],
    versions: [versionRow(1, 1, RELEASED), versionRow(2, 1), versionRow(3, 1, RELEASED)] });
  it.each([['comma list', 'released,ready_to_release'], ['array', ['released', 'ready_to_release']]])('display_status multi (%s)', async (_n, v) => {
    expect(ids(await list(readSetup(mixed()), { display_status: v })).sort()).toEqual([RID(1), RID(2), RID(3)].sort());
  });
  it('display_status=released only -> the released reports', async () => expect(ids(await list(readSetup(mixed()), { display_status: 'released' })).sort()).toEqual([RID(1), RID(3)].sort()));
  it('family filter', async () => expect(ids(await list(readSetup(mixed()), { family: 'narrative' }))).toEqual([RID(3)]));
  it('has_review_flag=true -> flagged only; false -> unflagged only', async () => {
    expect(ids(await list(readSetup(mixed()), { has_review_flag: 'true' }))).toEqual([RID(3)]);
    expect(ids(await list(readSetup(mixed()), { has_review_flag: 'false' })).sort()).toEqual([RID(1), RID(2), RID(4)].sort());
  });
  it('registered_at_from / _to bound reports.registered_at (inclusive from, exclusive to is not required: boundaries are not used)', async () => {
    expect(ids(await list(readSetup(mixed()), { registered_at_from: iso(1, 15), registered_at_to: iso(1, 35) })).sort()).toEqual([RID(1), RID(2)].sort());
  });
  it('released_at_from / _to filter on reports.first_released_at; unreleased reports never match', async () => {
    expect(ids(await list(readSetup(mixed()), { released_at_from: iso(3, 0), released_at_to: iso(4, 0) }))).toEqual([RID(1)]);
    expect(ids(await list(readSetup(mixed()), { released_at_from: iso(1, 0) })).sort()).toEqual([RID(1), RID(3)].sort());
  });
  it('sort: default -updated_at; registered_at ascending; -released_at (= -first_released_at)', async () => {
    expect(ids(await list(readSetup(mixed())))).toEqual([RID(4), RID(2), RID(3), RID(1)]);
    expect(ids(await list(readSetup(mixed()), { sort: '-updated_at' }))).toEqual([RID(4), RID(2), RID(3), RID(1)]);
    expect(ids(await list(readSetup(mixed()), { sort: 'registered_at' }))).toEqual([RID(3), RID(2), RID(1), RID(4)]);
    expect((await list(readSetup(mixed()), { sort: '-released_at', display_status: 'released' })).body.data.map((x: any) => x.id)).toEqual([RID(3), RID(1)]);
  });
  it('limit + cursor: pages cover every report exactly once, last page has no next_cursor', async () => {
    const s = readSetup(fleet(7)); const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const r = await list(s, { limit: '3', ...(cursor ? { cursor } : {}) }); pages++;
      expect(r.body.data.length).toBeLessThanOrEqual(3); seen.push(...ids(r)); cursor = r.body.page.next_cursor;
      if (cursor) expect(typeof cursor).toBe('string');
    } while (cursor && pages < 10);
    expect(pages).toBe(3); expect(seen).toHaveLength(7); expect(new Set(seen).size).toBe(7);
    expect(seen).toEqual([...Array(7)].map((_, k) => RID(7 - k)));            // -updated_at: report 7 is the newest
  });
  // review C6-T15 #1: timestamptz has µs precision; a cursor truncated to ms drops / repeats rows that share the cursor row's millisecond (R7 bulk release = one now() for up to 200 reports).
  it.each([2, 3])('limit %i + cursor: reports whose updated_at share one millisecond (µs differ or tie) are each returned exactly once across the page boundary', async (limit) => {
    const at = (us: string) => `2026-11-04T00:10:00.123${us}Z`;
    const s = readSetup({ reports: [reportRow(1, { updated_at: iso(4, 1) }), reportRow(2, { updated_at: iso(4, 2) }),
      reportRow(6, { updated_at: iso(4, 30) }), reportRow(3, { updated_at: at('789') }), reportRow(5, { updated_at: at('456') }), reportRow(4, { updated_at: at('456') })] });  // newest-first: 6, 3, 5, 4 (id desc on the tie), 2, 1
    const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const r = await list(s, { limit: String(limit), ...(cursor ? { cursor } : {}) }); pages++; seen.push(...ids(r)); cursor = r.body.page.next_cursor;
    } while (cursor && pages < 10);
    expect(seen).toEqual([6, 3, 5, 4, 2, 1].map(RID));
  });
  it('a malformed / tampered cursor -> 400 common.invalid_cursor (no SQL, no echo)', async () => {
    const planted = "PLANTED';DROP TABLE reporting.reports;--";
    // review C6-T15 round 2 #1: well-formed ISO shape but not a real date (would reach `$10::timestamptz` -> Postgres 22008 -> 500)
    const impossibleDate = Buffer.from(JSON.stringify({ k: '2026-99-99T00:00Z', i: RID(1), s: '-updated_at' })).toString('base64url');
    // LD-74 / review round 3: realStamp is a strict round-trip check; year 0, Feb 30, month 13, day 00 must be 400, never a PG 22008 500
    const badStamps = ['0000-01-01T00:00Z', '2026-02-30T00:00Z', '2026-13-01T00:00Z', '2026-01-00T00:00Z']
      .map((k) => Buffer.from(JSON.stringify({ k, i: RID(1), s: '-updated_at' })).toString('base64url'));
    for (const c of ['not-a-cursor', planted, Buffer.from('{"k":"x","i":1}').toString('base64url'), 'A'.repeat(600), impossibleDate, ...badStamps]) {
      const s = readSetup(fleet(2)); const e = await rejection(list(s, { cursor: c }));
      expect(e?.code).toBe('common.invalid_cursor'); expect(JSON.stringify({ m: e?.message, d: e?.details })).not.toContain('PLANTED');
      expect(s.stmtText()).not.toMatch(/from\s+reporting\.reports/i);
    }
  });
  it.each([['limit', '0'], ['limit', '201'], ['limit', 'abc'], ['family', 'other'], ['sort', 'patient_name'], ['display_status', 'bogus'], ['has_review_flag', 'maybe'], ['registered_at_from', 'yesterday'], ['centre_id', 'not-a-uuid'],
    // LD-74: impossible calendar values pass Date.parse/shape but fail PG -> must be 400 for both date filters
    ['registered_at_from', '2026-02-30T00:00Z'], ['registered_at_to', '2026-02-30T00:00Z'], ['registered_at_from', '0000-01-01T00:00Z'], ['registered_at_to', '0000-01-01T00:00Z'],
    ['registered_at_from', '2026-13-01T00:00Z'], ['registered_at_to', '2026-13-01T00:00Z'], ['registered_at_from', '2026-01-00T00:00Z'], ['registered_at_to', '2026-01-00T00:00Z']])
  ('invalid %s=%s -> 400 common.validation_failed', async (k, v) => expect((await rejection(list(readSetup(fleet(2)), { [k]: v })))?.code).toBe('common.validation_failed'));
  it('patient_display_name / registration_no are never accepted as list query params (PHI in params, 02-CV §4.1)', async () => {
    for (const k of ['patient_display_name', 'registration_no', 'patient_id', 'barcode', 'q'])
      expect((await rejection(list(readSetup(fleet(2)), { [k]: 'x' })))?.code).toBe('common.validation_failed');
  });
  it('query values travel as bind parameters: planted SQL in a filter never appears in a statement text', async () => {
    const planted = "x' OR '1'='1"; const s = readSetup(fleet(2));
    await rejection(list(s, { family: planted })); await rejection(list(s, { display_status: planted }));
    expect(s.stmtText()).not.toContain('1\'=\'1');
  });
});

describe('AC-08.4 centre scoping', () => {
  // A (own centre): 1 released, 2 unreleased. B (other centre): 3 released. Tenant B: 4 released.
  const world = (): ReadOpts => ({
    reports: [reportRow(1, { latest_version_no: 1, released_version_no: 1, first_released_at: iso(3, 5) }), reportRow(2, { latest_version_no: 1 }),
      reportRow(3, { centre_id: CENTRE_B, latest_version_no: 1, released_version_no: 1, first_released_at: iso(3, 6) }),
      reportRow(4, { tenant_id: TENANT_B, latest_version_no: 1, released_version_no: 1, first_released_at: iso(3, 7) })],
    versions: [versionRow(1, 1, RELEASED), versionRow(2, 1), versionRow(3, 1, { ...RELEASED, centre_id: CENTRE_B }), versionRow(4, 1, { ...RELEASED, tenant_id: TENANT_B })],
    items: [itemRow(3, 1, { centre_id: CENTRE_B })], deliveries: [deliveryRow(3, 1, 'sent', { centre_id: CENTRE_B })],
    pdf: { [versionRow(1, 1)['pdf_object_path']]: PDF, [versionRow(3, 1)['pdf_object_path']]: PDF } });
  const scoped = () => readSetup({ ...world(), centres: [CENTRE_A] });
  it('Given a user of centre C000000099, listing released reports shows that centre only', async () => {
    const r = await list(scoped(), { display_status: 'released' });
    expect(ids(r)).toEqual([RID(1)]); expect(r.body.data[0].centre_code).toBe('C000000099');
  });
  it('unfiltered list: other centre and other tenant never appear', async () => {
    const got = ids(await list(scoped())); expect(got).not.toContain(RID(3)); expect(got).not.toContain(RID(4)); expect(got.sort()).toEqual([RID(1), RID(2)].sort());
  });
  it('an unscoped user of tenant A sees both centres, never tenant B', async () => {
    const got = ids(await list(readSetup(world()))); expect(got.sort()).toEqual([RID(1), RID(2), RID(3)].sort());
  });
  it('centre_id=<other centre> filter by a scoped user -> 200 empty (not 403: no existence oracle)', async () => {
    const r = await list(scoped(), { centre_id: CENTRE_B }); expect(r.status).toBe(200); expect(r.body.data).toEqual([]);
  });
  it('R3 / R4 / R5 on another centre\'s ids -> 404 common.not_found, same code and message as an id that does not exist; nothing read from storage or logged as viewed', async () => {
    const ghost = idN(0xdead00);
    const probe = async (op: string, params: Row) => { const s = scoped(); const e = await rejection(call(op, s, { params })); return { s, code: e?.code, msg: e?.message }; };
    for (const [op, other, none] of [['getReport', { report_id: RID(3) }, { report_id: ghost }], ['getReportVersion', { report_version_id: VID(3, 1) }, { report_version_id: ghost }],
      ['downloadReportVersionPdf', { report_version_id: VID(3, 1) }, { report_version_id: ghost }]] as const) {
      const a = await probe(op, other); const b = await probe(op, none);
      expect(a.code).toBe('common.not_found'); expect({ c: a.code, m: a.msg }).toEqual({ c: b.code, m: b.msg });
      expect(a.s.access).toEqual([]); expect(a.s.storage.reads()).toEqual([]);
    }
  });
  it('tenant B ids -> 404 for a tenant A user, even without centre scoping', async () => {
    for (const [op, params] of [['getReport', { report_id: RID(4) }], ['getReportVersion', { report_version_id: VID(4, 1) }], ['downloadReportVersionPdf', { report_version_id: VID(4, 1) }]] as const)
      expect((await rejection(call(op, readSetup(world()), { params })))?.code).toBe('common.not_found');
  });
  it('R2 search results are centre-scoped too (registration_no, order_id, patient_id, barcode)', async () => {
    const s = readSetup({ ...world(), centres: [CENTRE_A], specimens: { BC3: [{ orderId: OID(3), centreId: CENTRE_B }] } });
    for (const body of [{ registration_no: '0001SY000003' }, { order_id: OID(3) }, { patient_id: reportRow(3)['patient_id'] }, { barcode: 'BC3' }]) {
      const r = await call('searchReports', s, { body }); expect(r.status).toBe(200); expect(r.body.data).toEqual([]);
    }
  });
});

describe('R2 searchReports', () => {
  const two = (): ReadOpts => ({ reports: [reportRow(1), reportRow(1, { id: RID(11), family: 'narrative' }), reportRow(2)] });
  const search = (s: ReturnType<typeof readSetup>, body: unknown) => call('searchReports', s, { body });
  it('registration_no -> every report (both families) of that registration; ReportSummary allowlist', async () => {
    const r = await search(readSetup(two()), { registration_no: '0001SY000001' });
    expect(r.status).toBe(200); expect(ids(r).sort()).toEqual([RID(1), RID(11)].sort()); for (const x of r.body.data) keysOk(x, REPORT_SUMMARY_KEYS, REPORT_SUMMARY_REQUIRED);
    expect('page' in r.body).toBe(false);
  });
  it('order_id and patient_id', async () => {
    expect(ids(await search(readSetup(two()), { order_id: OID(2) }))).toEqual([RID(2)]);
    expect(ids(await search(readSetup(two()), { patient_id: reportRow(2)['patient_id'] }))).toEqual([RID(2)]);
  });
  it('unknown key -> 200 {data: []}', async () => expect((await search(readSetup(two()), { registration_no: '9999' })).body).toEqual({ data: [] }));
  it('at most 50 results', async () => {
    const s = readSetup({ reports: Array.from({ length: 60 }, (_, k) => reportRow(k + 1, { patient_id: idN(0x777) })) });
    expect((await search(s, { patient_id: idN(0x777) })).body.data).toHaveLength(50);
  });
  it.each<[string, unknown]>([['no key', {}], ['two keys', { registration_no: 'a', order_id: OID(1) }], ['unknown key', { name: 'Sita' }], ['empty body', undefined], ['array body', []],
    ['registration_no > 20', { registration_no: 'x'.repeat(21) }], ['barcode > 20', { barcode: 'x'.repeat(21) }], ['order_id not a uuid', { order_id: 'nope' }], ['patient_id not a uuid', { patient_id: 'nope' }],
    ['non-string registration_no', { registration_no: 7 }]])
  ('%s -> 400 common.validation_failed, no lookup, no echo', async (_n, body) => {
    const s = readSetup(two()); const e = await rejection(search(s, body));
    expect(e?.code).toBe('common.validation_failed'); expect(s.lookups).toEqual([]); expect(JSON.stringify({ m: e?.message, d: e?.details })).not.toContain('Sita');
  });
  it('planted SQL in registration_no is a bind parameter, never statement text', async () => {
    const s = readSetup(two()); const r = await search(s, { registration_no: "x' OR '1'='1" });
    expect(r.body.data).toEqual([]); expect(s.stmtText()).not.toContain("'1'='1");
  });
  it('PHI in the body is not logged or access-logged', async () => {
    const s = readSetup(two()); expect((await search(s, { registration_no: '0001SY000001' })).status).toBe(200); expect(s.allText()).not.toContain('0001SY000001');
  });
  describe('barcode (P-10): reporting.report.read + lab.specimen.read, resolved through LabPort.lookupSpecimens as the user', () => {
    it('checks lab.specimen.read with IdentityPort.assertRole BEFORE any lab call; denied -> 403 auth.forbidden and no lookup', async () => {
      const s = readSetup({ ...two(), denied: ['lab.specimen.read'], specimens: { BC1: [{ orderId: OID(1) }] } });
      const e = await rejection(search(s, { barcode: 'BC1' }));
      expect(e?.code).toBe('auth.forbidden'); expect(s.lookups).toEqual([]); expect(s.roleCalls.map((c) => c.permission)).toContain('lab.specimen.read');
    });
    it('allowed -> lookupSpecimens(ctx, { barcode }) -> orderId -> reports of that order', async () => {
      const s = readSetup({ ...two(), specimens: { BC1: [{ orderId: OID(1) }] } });
      const r = await search(s, { barcode: 'BC1' });
      expect(s.lookups).toEqual([{ barcode: 'BC1' }]); expect(ids(r).sort()).toEqual([RID(1), RID(11)].sort());
      expect(s.roleCalls.map((c) => c.permission)).toContain('lab.specimen.read');
    });
    it('lookup returns nothing -> 200 {data: []}; no snapshot of the barcode is searched in reporting.reports', async () => {
      const s = readSetup(two()); const r = await search(s, { barcode: 'NOPE' });
      expect(r.status).toBe(200); expect(r.body).toEqual({ data: [] }); expect(s.stmtText()).not.toMatch(/barcode/i);
    });
    it('several specimens of different orders -> reports of all those orders (deduplicated)', async () => {
      const s = readSetup({ ...two(), specimens: { BC1: [{ orderId: OID(1) }, { orderId: OID(1) }, { orderId: OID(2) }] } });
      const got = ids(await search(s, { barcode: 'BC1' })); expect(got.sort()).toEqual([RID(1), RID(11), RID(2)].sort());
    });
    it('a lab outage surfaces as an error, never as a silent empty result', async () => {
      const s = readSetup(two()); s.ports.lab.lookupSpecimens = async () => { throw Object.assign(new Error('lab down'), { code: 'common.unavailable' }); };
      expect((await rejection(search(s, { barcode: 'BC1' })))?.code).toBe('common.unavailable');
    });
    it('the other three keys do NOT need lab.specimen.read (and do not call the lab)', async () => {
      const s = readSetup({ ...two(), denied: ['lab.specimen.read'] });
      for (const body of [{ registration_no: '0001SY000001' }, { order_id: OID(1) }, { patient_id: reportRow(1)['patient_id'] }]) expect((await search(s, body)).status).toBe(200);
      expect(s.lookups).toEqual([]); expect(s.roleCalls.map((c) => c.permission)).not.toContain('lab.specimen.read');
    });
    it('without an IdentityPort the barcode path fails closed (never skips the check)', async () => {
      const s = readSetup({ ...two(), specimens: { BC1: [{ orderId: OID(1) }] } }); delete s.ports.IdentityPort;
      const e = await rejection(search(s, { barcode: 'BC1' })); expect(e?.code).toBe('common.internal'); expect(s.lookups).toEqual([]);
    });
  });
});

describe('R3 getReport — ReportDetail', () => {
  const full = (over: ReadOpts = {}): ReadOpts => ({
    reports: [reportRow(1, { latest_version_no: 2, released_version_no: 1, first_released_at: iso(3, 5), review_flag: 'released_item_removed', billing_balance_due_paisa: '0' })],
    versions: [versionRow(1, 1, { ...RELEASED, status: 'superseded', superseded_at: iso(4, 1), superseded_by_version_no: 2 }), versionRow(1, 2, { report_kind: 'amended', supersedes_version_no: 1 })],
    items: [itemRow(1, 1), itemRow(1, 2, { lab_ready: false })],
    deliveries: [deliveryRow(1, 1, 'sent'), deliveryRow(1, 2, 'sent'), deliveryRow(1, 3, 'delivered'), deliveryRow(1, 4, 'failed'), deliveryRow(1, 5, 'suppressed'), deliveryRow(1, 6, 'queued'),
      deliveryRow(2, 1, 'read')], ...over });
  const get = (s: ReturnType<typeof readSetup>, id = RID(1)) => call('getReport', s, { params: { report_id: id } });
  it('200 ReportDetail: only allowlisted keys, summary + items[] + versions[] + deliveries_summary + review_flag, no null, no port call', async () => {
    const s = readSetup(full()); const r = await get(s); const b = r.body;
    expect(r.status).toBe(200); keysOk(b, REPORT_DETAIL_KEYS, [...REPORT_SUMMARY_REQUIRED, 'items', 'versions', 'deliveries_summary']);
    expect(b).toMatchObject({ id: RID(1), review_flag: 'released_item_removed', latest_version_no: 2, released_version_no: 1, items_total: 2, items_ready: 1 });
    expect(hasNull(b)).toBe(false); expect(s.portCalls).toEqual([]);
  });
  it('items[]: allowlisted keys only (ids of orderables/tests, ready_marker, approved_results stay inside)', async () => {
    const b = (await get(readSetup(full()))).body; expect(b.items).toHaveLength(2);
    for (const it of b.items) { keysOk(it, ITEM_KEYS, ITEM_KEYS); expect(Array.isArray(it.test_names)).toBe(true); expect(it.test_names.every((x: unknown) => typeof x === 'string')).toBe(true); }
    expect(b.items[0]).toMatchObject({ order_item_id: itemRow(1, 1)['order_item_id'], item_kind: 'test', requires_lab: true, lab_ready: true, item_status: 'active' });
    const t = JSON.stringify(b.items); for (const k of ['orderable_id', 'test_ids', 'ready_marker', 'approved_results', 'tenant_id', 'report_id']) expect(t).not.toContain(`"${k}"`);
  });
  it('versions[]: ReportVersionSummary allowlist, newest first, no snapshot / hashes / object path', async () => {
    const b = (await get(readSetup(full()))).body; expect(b.versions.map((v: any) => v.version_no)).toEqual([2, 1]);
    for (const v of b.versions) keysOk(v, VERSION_SUMMARY_KEYS, VERSION_SUMMARY_REQUIRED);
    const t = JSON.stringify(b); for (const k of ['content_snapshot', 'content_sha256', 'pdf_object_path', 'pdf_sha256', 'content_fingerprint', 'approved_set_hash', 'template_version_id', 'patient_id']) expect(t).not.toContain(`"${k}"`);
    expect(t).not.toContain(SENTINEL_SNAPSHOT);
  });
  it('deliveries_summary counts this report\'s deliveries per status (all six keys, zeros included); no destination, id or body leaks', async () => {
    const s = readSetup(full()); const b = (await get(s)).body;
    expect(b.deliveries_summary).toEqual({ queued: 1, sent: 2, delivered: 1, read: 0, failed: 1, suppressed: 1 });
    expect(Object.keys(b.deliveries_summary).sort()).toEqual([...DELIVERY_STATES].sort());
    expect(JSON.stringify(b)).not.toContain(SENTINEL_PHONE); expect(JSON.stringify(b)).not.toContain('destination');
  });
  it('a report with no deliveries -> all counts 0', async () => {
    expect((await get(readSetup(full({ deliveries: [] })))).body.deliveries_summary).toEqual({ queued: 0, sent: 0, delivered: 0, read: 0, failed: 0, suppressed: 0 });
  });
  it('writes ONE access-log row { action: report.view, entityType: report, entityId, centreId, outcome: allowed } (P-3)', async () => {
    const s = readSetup(full()); await get(s);
    expect(s.access).toHaveLength(1); expect(s.access[0]).toMatchObject({ action: 'report.view', entityType: 'report', entityId: RID(1), centreId: CENTRE_A, outcome: 'allowed' });
    expect(JSON.stringify(s.access)).not.toContain('Test Patient');
  });
  it('unknown id and malformed id -> 404 common.not_found, no access-log row, id not echoed', async () => {
    for (const id of [idN(0xbeef), "x' OR '1'='1", '']) {
      const s = readSetup(full()); const e = await rejection(get(s, id));
      expect(e?.code).toBe('common.not_found'); expect(s.access).toEqual([]); expect(JSON.stringify({ m: e?.message, d: e?.details })).not.toContain("OR '1'");
      expect(s.stmtText()).not.toContain("'1'='1");
    }
  });
  it('read is a pure read: no INSERT / UPDATE / DELETE statement', async () => {
    const s = readSetup(full()); expect((await get(s)).status).toBe(200); expect(s.db.writes()).toEqual([]);
  });
});

describe('R4 getReportVersion — ReportVersionSummary', () => {
  const get = (s: ReturnType<typeof readSetup>, id = VID(1, 1)) => call('getReportVersion', s, { params: { report_version_id: id } });
  it('released version: allowlisted keys, mapped values, pdf_bytes as number, timestamps ISO, no null', async () => {
    const s = readSetup({ versions: [versionRow(1, 1, { ...RELEASED, supersedes_version_no: null })] }); const r = await get(s); const b = r.body;
    expect(r.status).toBe(200); keysOk(b, VERSION_SUMMARY_KEYS, VERSION_SUMMARY_REQUIRED); expect(hasNull(b)).toBe(false); expect(s.portCalls).toEqual([]);
    expect(b).toMatchObject({ id: VID(1, 1), version_no: 1, status: 'released', report_kind: 'final', completeness: 'complete', page_count: 2, pdf_bytes: 1000, rendered_at: iso(1, 40),
      released_at: iso(3, 5), release_basis: 'paid_in_full', audiences: ['patient', 'centre'], version: 4 });
  });
  it('internal columns never leave: content_snapshot (P3), hashes, object path, patient_id, partner_id, released_by, order_item_ids, render_attempts', async () => {
    const t = JSON.stringify((await get(readSetup({ versions: [versionRow(1, 1, RELEASED)] }))).body);
    for (const k of ['content_snapshot', 'content_sha256', 'content_fingerprint', 'approved_set_hash', 'pdf_object_path', 'pdf_sha256', 'template_version_id', 'patient_id', 'partner_id', 'released_by', 'order_item_ids',
      'render_attempts', 'tenant_id', 'centre_id', 'created_by', 'report_id', 'order_id', 'release_override_id', 'release_mode']) expect(t).not.toContain(`"${k}"`);
    expect(t).not.toContain(SENTINEL_SNAPSHOT);
  });
  it('failed render shows last_render_error_code and no pdf fields; held version shows held_basis / held_checked_at; amended shows supersedes_version_no', async () => {
    const f = (await get(readSetup({ versions: [versionRow(1, 1, { status: 'render_failed', pdf_object_path: null, pdf_bytes: null, page_count: null, rendered_at: null, last_render_error_code: 'reporting.render_unavailable' })] }))).body;
    expect(f).toMatchObject({ status: 'render_failed', last_render_error_code: 'reporting.render_unavailable' }); for (const k of ['pdf_bytes', 'page_count', 'rendered_at', 'released_at']) expect(k in f).toBe(false);
    expect((await get(readSetup({ versions: [versionRow(1, 1, { held_basis: 'due_outstanding', held_checked_at: iso(2, 2) })] }))).body).toMatchObject({ held_basis: 'due_outstanding', held_checked_at: iso(2, 2) });
    expect((await get(readSetup({ versions: [versionRow(1, 2, { report_kind: 'amended', supersedes_version_no: 1 })] }), VID(1, 2))).body).toMatchObject({ report_kind: 'amended', supersedes_version_no: 1 });
  });
  it('unknown / malformed id -> 404 common.not_found', async () => {
    for (const id of [idN(0xbeef), 'nope', '']) expect((await rejection(get(readSetup({ versions: [versionRow(1, 1)] }), id)))?.code).toBe('common.not_found');
  });
  it('a discarded version is not served (404)', async () => {
    expect((await rejection(get(readSetup({ versions: [versionRow(1, 1, { status: 'discarded', discarded_at: iso(2, 1), discard_reason: 'superseded_before_render' })] }))))?.code).toBe('common.not_found');
  });
});

describe('R5 downloadReportVersionPdf', () => {
  const dl = (s: ReturnType<typeof readSetup>, id = VID(1, 1)) => call('downloadReportVersionPdf', s, { params: { report_version_id: id } });
  const rel = versionRow(1, 1, RELEASED); const unrel = versionRow(1, 2, {});
  const withPdf = (vs: Row[], denied: string[] = []) => readSetup({ reports: [reportRow(1, { latest_version_no: 2 })], versions: vs, denied, pdf: Object.fromEntries(vs.filter((v) => v['pdf_object_path']).map((v) => [v['pdf_object_path'], PDF])) });
  it('released: 200 application/pdf bytes of the stored object; attachment filename report-v{n}.pdf; nosniff; no-store (P-2)', async () => {
    const s = withPdf([rel]); const r = await dl(s); const h = lower(r.headers);
    expect(r.status).toBe(200); expect(Buffer.from(r.body).equals(Buffer.from(PDF))).toBe(true);
    expect(h['content-type']).toMatch(/^application\/pdf/); expect(h['content-disposition']).toBe('attachment; filename="report-v1.pdf"');
    expect(h['x-content-type-options']).toBe('nosniff'); expect(h['cache-control']).toBe('no-store');
    for (const v of Object.values(h)) expect(v).not.toMatch(/[\r\n]/);
    expect(s.storage.reads().map((c) => [c.bucket, c.path])).toEqual([[REPORTS_BUCKET, rel['pdf_object_path']]]);
  });
  it('the filename is built from version_no only (never from patient or registration data)', async () => {
    const v3 = versionRow(1, 3, { ...RELEASED }); const r = await dl(withPdf([v3]), VID(1, 3));
    expect(lower(r.headers)['content-disposition']).toBe('attachment; filename="report-v3.pdf"');
  });
  it('writes ONE access-log row { report.download, report_version, entityId, centreId, outcome allowed }', async () => {
    const s = withPdf([rel]); await dl(s);
    expect(s.access).toHaveLength(1); expect(s.access[0]).toMatchObject({ action: 'report.download', entityType: 'report_version', entityId: VID(1, 1), centreId: CENTRE_A, outcome: 'allowed' });
  });
  it('unreleased version + caller WITHOUT reporting.report.release -> 409 reporting.report_not_released; nothing read, nothing access-logged as allowed', async () => {
    const s = withPdf([unrel], ['reporting.report.release']); const e = await rejection(dl(s, VID(1, 2)));
    expect(e?.code).toBe('reporting.report_not_released'); expect(s.storage.reads()).toEqual([]); expect(s.access.filter((a) => a.outcome === 'allowed')).toEqual([]);
    expect(s.roleCalls.map((c) => c.permission)).toContain('reporting.report.release');
  });
  it('unreleased version + caller WITH reporting.report.release -> 200 (draft view for releasers) and access-logged', async () => {
    const s = withPdf([unrel]); const r = await dl(s, VID(1, 2));
    expect(r.status).toBe(200); expect(lower(r.headers)['content-disposition']).toBe('attachment; filename="report-v2.pdf"'); expect(s.access).toHaveLength(1);
  });
  it('a released version needs no release permission (reporting.report.read is the floor)', async () => {
    const s = withPdf([rel], ['reporting.report.release']); expect((await dl(s)).status).toBe(200);
  });
  it('a version without a PDF (rendering / render_failed) and no release permission -> report_not_released, never an object-path leak', async () => {
    const v = versionRow(1, 2, { status: 'render_failed', pdf_object_path: null }); const s = withPdf([v], ['reporting.report.release']); const e = await rejection(dl(s, VID(1, 2)));
    expect(e?.code).toBe('reporting.report_not_released'); expect(JSON.stringify({ m: e?.message, d: e?.details })).not.toContain(TENANT_A);
  });
  it('unknown / malformed / discarded -> 404', async () => {
    for (const [vs, id] of [[[rel], idN(0xbeef)], [[rel], 'nope'], [[versionRow(1, 1, { status: 'discarded', discarded_at: iso(2, 1) })], VID(1, 1)]] as const)
      expect((await rejection(dl(withPdf([...vs]), id)))?.code).toBe('common.not_found');
  });
  it('a missing object in storage is an error, not an empty 200', async () => {
    const s = readSetup({ versions: [rel], pdf: {} }); const e = await rejection(dl(s)); expect(e).toBeDefined(); expect(s.access.filter((a) => a.outcome === 'allowed')).toEqual([]);
  });
  it('a path outside the caller\'s tenant prefix is never read (cross-tenant object path)', async () => {
    const evil = versionRow(1, 1, { ...RELEASED, pdf_object_path: `${TENANT_B}/2026/11/${RID(1)}-v1.pdf` });
    const s = readSetup({ versions: [evil], pdf: { [evil['pdf_object_path']]: PDF } }); const e = await rejection(dl(s)); expect(e).toBeDefined();
  });
});

describe('probes', () => {
  it('PLANTED token in every id/param slot is never reflected in a response, error or log', async () => {
    const planted = 'PLANTED-TOKEN-5c1b';
    for (const [op, req] of [['listReports', { query: { cursor: planted, family: planted } }], ['searchReports', { body: { registration_no: planted } }], ['getReport', { params: { report_id: planted } }],
      ['getReportVersion', { params: { report_version_id: planted } }], ['downloadReportVersionPdf', { params: { report_version_id: planted } }]] as const) {
      const s = readSetup({ ...fleet(1), versions: [versionRow(1, 1, RELEASED)] });
      let out: unknown; try { out = await call(op, s, req as any); } catch (e: any) { out = { c: e?.code, m: e?.message, d: e?.details }; }
      expect((out as any)?.status).not.toBe(501); expect(JSON.stringify(out)).not.toContain(planted); expect(s.allText()).not.toContain(planted);
    }
  });
  it('device and portal actors are refused (staff endpoints)', async () => {
    for (const actor of [{ type: 'device', id: idN(0xa00a) }, { type: 'portal', id: idN(0xa00b) }]) {
      for (const [op, req] of [['listReports', {}], ['getReport', { params: { report_id: RID(1) } }], ['getReportVersion', { params: { report_version_id: VID(1, 1) } }], ['downloadReportVersionPdf', { params: { report_version_id: VID(1, 1) } }]] as const) {
        const s = readSetup({ ...fleet(1), versions: [versionRow(1, 1, RELEASED)], pdf: { [versionRow(1, 1)['pdf_object_path']]: PDF } });
        expect((await rejection(call(op, s, req as any, s.ctx({ actor }))))?.code).toBe('auth.forbidden'); expect(s.storage.reads()).toEqual([]);
      }
    }
  });
  it('no statement is ever written by R1-R5 (pure reads) and every statement filters on tenant_id as a bind parameter', async () => {
    const s = readSetup({ ...fleet(2), versions: [versionRow(1, 1, RELEASED)], pdf: { [versionRow(1, 1)['pdf_object_path']]: PDF }, items: [itemRow(1, 1)], deliveries: [deliveryRow(1, 1, 'sent')] });
    expect((await list(s)).status).toBe(200); await call('searchReports', s, { body: { registration_no: '0001SY000001' } }); await call('getReport', s, { params: { report_id: RID(1) } });
    await call('getReportVersion', s, { params: { report_version_id: VID(1, 1) } }); await call('downloadReportVersionPdf', s, { params: { report_version_id: VID(1, 1) } });
    expect(s.db.writes()).toEqual([]);
    for (const st of s.db.reportingStmts()) expect(st.text).toMatch(/\btenant_id\s*=\s*\$\d+/i);
  });
});

describe('schema (snapshot columns + indexes, review fix #6 / #42) — already in the C6-T02 migration; guards against regression', () => {
  const sql = readFileSync(join(REPO_ROOT, 'db/migrations/20261105001900_reporting__create_reporting_schema.sql'), 'utf8');
  it.each(['registration_no text NOT NULL', 'patient_display_name text', 'centre_code text NOT NULL', 'referrer_name text'])('reports has %s', (c) => expect(sql).toContain(c));
  it.each(['reports__tenant_id_registration_no__idx', 'reports__tenant_id_registered_at__idx', 'reports__tenant_id_first_released_at__p_idx', 'reports__tenant_id_centre_id_state_updated_at__idx'])('index %s exists', (i) => expect(sql).toContain(i));
});
