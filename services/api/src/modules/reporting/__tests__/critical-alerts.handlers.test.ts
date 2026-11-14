// C6-T24 — R18 listCriticalAlerts (02-TRD §6.1 CriticalAlert, §6.2 R18; 01-PRD AC-14.3; 07-SECURITY REQ-SEC-017/024/080 (centre RLS), PHI rules; review fix #16).
// GET /v1/reporting/critical-alerts, permission reporting.report.read, query centre_id? / since? (IsoUtc, default now - 24 h, max 7 days back) / cursor / limit.
// Built from reporting.deliveries with purpose = 'critical_value_alert' and related_entity_type 'critical_event', grouped by related_entity_id; alerted_at = earliest delivery created_at of the group;
// recipients[] = one entry per delivery {recipient_kind referrer|staff, membership_id? (staff: recipient_id), status, failure_code?}; report_id / order_id / registration_no from the report (absent when none).
// ASSUMED (repeated in .orchestra/notes/C6-T24-tests.md): handler `manifest.handlers.listCriticalAlerts(req, ctx)` with the R1-R5 ctx of reports-read.helpers.ts (readSetup); page = { limit, next_cursor? };
// newest alert first (alerted_at DESC, then id) [CONV]; single-table SQL (deliveries, then reports by id); centre scope = RLS (a centre the caller cannot see -> empty list, never an error).
// SPEC GAP: the OpenAPI example shows membership_id on a referrer recipient; the TRD says membership_id is for staff — tested: staff only.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../core/module.js';
import { CENTRE_A, CENTRE_B, NOW, OID, RID, SENTINEL_PHONE, TENANT_A, TENANT_B, hasNull, idN, readSetup, rejection, reportRow, type ReadOpts, type Row } from './reports-read.helpers.js';

const OP = 'listCriticalAlerts';
const SENTINEL_NAME = 'SENTINEL-patient-Sita-Karki';
const SENTINEL_LAB_PHONE = '+9779811100099';
const CE = (n: number) => idN(0x160000 + n);
const MEM = (n: number) => idN(0x3100 + n);
const REFERRER = idN(0xd0c1);
const hoursAgo = (h: number, extraMs = 0) => new Date(Date.parse(NOW) - h * 3_600_000 + extraMs).toISOString();
let seq = 0;
/** One reporting.deliveries row of a critical alert (what the T24 consumer writes). */
const alertRow = (ce: number, kind: 'referrer' | 'staff', over: Row = {}): Row => {
  const staff = kind === 'staff'; const n = ++seq;
  return { tenant_id: TENANT_A, centre_id: CENTRE_A, id: idN(0x57100 + n), channel: 'sms', purpose: 'critical_value_alert', template_code: 'reporting.critical_value_alert', recipient_kind: kind,
    recipient_id: staff ? MEM(n) : REFERRER, status: staff ? 'suppressed' : 'queued', failure_code: staff ? 'no_contact' : null, related_entity_type: 'critical_event', related_entity_id: CE(ce),
    report_id: RID(1), report_version_no: null, destination_masked: staff ? null : '+97798•••••077', destination: SENTINEL_PHONE, destination_sha256: staff ? null : Buffer.alloc(32, 7),
    params: { lab_name: 'Synthetic Lab', lab_phone: SENTINEL_LAB_PHONE, ref: CE(ce).slice(0, 8) }, idempotency_key: `${CE(ce)}:${kind}:${n}`, language: 'en', attempt_no: 1,
    created_at: hoursAgo(1), created_by: idN(0xa009), updated_at: hoursAgo(1), version: 1, ...over };
};
const reportA = (over: Row = {}) => reportRow(1, { patient_display_name: SENTINEL_NAME, ...over });
const setup = (rows: Row[], o: ReadOpts = {}) => readSetup({ reports: [reportA()], deliveries: rows, ...o });

let manifest: any;
beforeAll(async () => {
  const k = join(mkdtempSync(join(tmpdir(), 'c6-t24-')), 'otp.key'); writeFileSync(k, Buffer.alloc(32, 7));
  process.env.LIMS_CORE_ENV = 'dev'; delete process.env.NODE_ENV; delete process.env.LIMS_REPORTING_ALLOW_REAL_PROVIDERS; process.env.LIMS_REPORTING_OTP_HMAC_KEY_FILE = k;
  manifest = (await import('../index.js')).manifest;
});
const call = (s: ReturnType<typeof readSetup>, query: Row = {}, ctx: Row = s.ctx({ operationId: OP })) => manifest.handlers[OP]({ params: {}, query, headers: {}, body: undefined }, ctx);
const ids = (r: { body: any }) => r.body.data.map((a: any) => a.critical_event_id);
const ALERT_KEYS = ['critical_event_id', 'report_id', 'order_id', 'registration_no', 'centre_id', 'alerted_at', 'recipients'];
const RECIPIENT_KEYS = ['recipient_kind', 'membership_id', 'status', 'failure_code'];

describe('contract', () => {
  const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/reporting.yaml'));
  const op: any = Object.values(spec.paths).flatMap((p: any) => Object.values(p) as any[]).find((x: any) => x?.operationId === OP);
  it('listCriticalAlerts: GET /critical-alerts, x-permission reporting.report.read, no idempotency key', () => {
    expect(op['x-permission']).toBe('reporting.report.read'); expect(op['x-idempotency']).toBe('none');
    expect(Object.keys(spec.paths).some((p) => p.endsWith('/critical-alerts') && (spec.paths[p] as any).get?.operationId === OP)).toBe(true);
  });
  it('is no longer a 501 stub: without a request context it fails closed (auth.unauthenticated), echoing no input', async () => {
    const planted = 'PLANTED-TOKEN-7d2e';
    const e = await rejection(manifest.handlers[OP]({ params: {}, query: { cursor: planted, centre_id: planted }, headers: { authorization: planted }, body: undefined },
      { operationId: OP, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } }));
    expect(e?.code).toBe('auth.unauthenticated'); expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.details })).not.toContain(planted);
  });
});

describe('AC-14.3 list (centre C000000099)', () => {
  const world = () => setup([alertRow(1, 'referrer', { created_at: hoursAgo(2, 5000) }), alertRow(1, 'staff', { created_at: hoursAgo(2) }), alertRow(1, 'staff', { created_at: hoursAgo(2, 9000) })]);
  it('200 {data, page}: the event with registration no., alert time (= earliest delivery created_at), report/order/centre ids and EACH recipient with its delivery status', async () => {
    const s = world(); const r = await call(s);
    expect(r.status).toBe(200); expect(r.body.page).toMatchObject({ limit: 50 }); expect(r.body.page.next_cursor).toBeUndefined();
    expect(r.body.data).toHaveLength(1); const a = r.body.data[0];
    expect(Object.keys(a).filter((k) => !ALERT_KEYS.includes(k))).toEqual([]);
    expect(a).toMatchObject({ critical_event_id: CE(1), report_id: RID(1), order_id: OID(1), registration_no: '0001SY000001', centre_id: CENTRE_A, alerted_at: hoursAgo(2) });
    expect(a.recipients).toHaveLength(3);
    const ref = a.recipients.filter((x: any) => x.recipient_kind === 'referrer'); const st = a.recipients.filter((x: any) => x.recipient_kind === 'staff');
    expect(ref).toHaveLength(1); expect(ref[0]).toMatchObject({ status: 'queued' }); expect(ref[0].membership_id).toBeUndefined(); expect(ref[0].failure_code).toBeUndefined();
    expect(st).toHaveLength(2); for (const x of st) expect(x).toMatchObject({ status: 'suppressed', failure_code: 'no_contact' });
    expect(st.map((x: any) => x.membership_id).sort()).toEqual(s.db.all('reporting.deliveries').filter((d) => d['recipient_kind'] === 'staff').map((d) => d['recipient_id']).sort());
    for (const x of a.recipients) expect(Object.keys(x).filter((k) => !RECIPIENT_KEYS.includes(k))).toEqual([]);
    expect(hasNull(r.body)).toBe(false);
  });
  it('recipient status follows the delivery lifecycle (sent / delivered / failed + failure_code)', async () => {
    const s = setup([alertRow(1, 'referrer', { status: 'failed', failure_code: 'provider_unavailable' }), alertRow(1, 'staff')]);
    const r = await call(s); const rec = r.body.data[0].recipients;
    expect(rec.find((x: any) => x.recipient_kind === 'referrer')).toMatchObject({ status: 'failed', failure_code: 'provider_unavailable' });
  });
  it('NO value, analyte, patient name, destination, params or template in the body (review fix #16)', async () => {
    const s = world(); const r = await call(s); const text = JSON.stringify(r.body);
    for (const x of [SENTINEL_NAME, SENTINEL_PHONE, SENTINEL_LAB_PHONE, '+97798', 'Synthetic Lab', 'reporting.critical_value_alert', 'params', 'destination', 'analyte', 'direction', 'value', 'patient', 'template', 'idempotency']) {
      expect(text.toLowerCase(), x).not.toContain(x.toLowerCase());
    }
  });
  it('the SQL never selects params / destination / patient columns (defence in depth) and every statement carries the tenant', async () => {
    const s = world(); await call(s); const sql = s.stmtText();
    expect(sql).not.toMatch(/\bparams\b|\bdestination\w*\b|\bpatient_display_name\b|\bpatient_id\b|\bcontent_snapshot\b/i);
    expect(sql).toMatch(/critical_value_alert/);
    for (const st of s.db.stmts.filter((x) => /\breporting\./i.test(x.text))) expect(st.text, st.text).toMatch(/\btenant_id\b/);
  });
  it('purposes other than critical_value_alert and rows not related to a critical_event are not alerts', async () => {
    const s = setup([alertRow(1, 'referrer'), alertRow(9, 'referrer', { purpose: 'report_ready', template_code: 'reporting.report_ready', related_entity_type: 'report', related_entity_id: RID(1) }),
      alertRow(8, 'staff', { related_entity_type: 'order', related_entity_id: OID(1) }), alertRow(7, 'staff', { related_entity_type: null, related_entity_id: null })]);
    expect(ids(await call(s))).toEqual([CE(1)]);
  });
  it('an alert whose report is not there (yet) lists without report_id / order_id / registration_no (absent, not null)', async () => {
    const s = setup([alertRow(1, 'referrer', { report_id: null }), alertRow(1, 'staff', { report_id: null })]);
    const a = (await call(s)).body.data[0];
    expect(a).toMatchObject({ critical_event_id: CE(1), centre_id: CENTRE_A }); for (const k of ['report_id', 'order_id', 'registration_no']) expect(k in a, k).toBe(false);
    expect(a.recipients).toHaveLength(2);
  });
  it('empty -> 200 { data: [], page: { limit: 50 } }', async () => {
    const r = await call(setup([])); expect(r.status).toBe(200); expect(r.body.data).toEqual([]); expect(r.body.page).toMatchObject({ limit: 50 });
  });
});

describe('centre scope (AC-14.3, REQ-SEC-017)', () => {
  const rows = () => [alertRow(1, 'referrer'), alertRow(1, 'staff'), alertRow(2, 'referrer', { centre_id: CENTRE_B, report_id: RID(2), created_at: hoursAgo(3) }), alertRow(2, 'staff', { centre_id: CENTRE_B, report_id: RID(2), created_at: hoursAgo(3) })];
  const opts = (centres?: readonly string[]): ReadOpts => ({ reports: [reportA(), reportRow(2, { centre_id: CENTRE_B })], ...(centres ? { centres } : {}) });
  it('a user of centre B does not see the centre-A event; a user of centre A sees only theirs; a user of both centres sees both', async () => {
    expect(ids(await call(setup(rows(), opts([CENTRE_B]))))).toEqual([CE(2)]);
    expect(ids(await call(setup(rows(), opts([CENTRE_A]))))).toEqual([CE(1)]);
    expect(ids(await call(setup(rows(), opts([CENTRE_A, CENTRE_B]))))).toEqual([CE(1), CE(2)]);
  });
  it('centre_id filter narrows within the caller\'s centres; a centre the caller cannot see yields an EMPTY list (no 403/404 oracle)', async () => {
    expect(ids(await call(setup(rows(), opts()), { centre_id: CENTRE_B }))).toEqual([CE(2)]);
    const r = await call(setup(rows(), opts([CENTRE_A])), { centre_id: CENTRE_B }); expect(r.status).toBe(200); expect(r.body.data).toEqual([]);
  });
  it('the statements are tenant-scoped (RLS is not the only guard); another tenant\'s rows never appear', async () => {
    const s = setup([...rows(), alertRow(3, 'referrer', { tenant_id: TENANT_B })]); const r = await call(s);
    expect(ids(r)).toEqual([CE(1), CE(2)]);
    for (const st of s.db.stmts.filter((x) => /reporting\.deliveries/i.test(x.text))) { expect(st.text).toMatch(/\btenant_id\b/); expect(st.values).toContain(TENANT_A); }
  });
});

describe('window: since (default now - 24 h, at most 7 days back)', () => {
  const rows = () => [alertRow(1, 'referrer', { created_at: hoursAgo(23) }), alertRow(2, 'referrer', { created_at: hoursAgo(25) }), alertRow(3, 'referrer', { created_at: hoursAgo(24 * 3) }), alertRow(4, 'referrer', { created_at: hoursAgo(24 * 8) })];
  it('default: only alerts of the last 24 hours', async () => { expect(ids(await call(setup(rows())))).toEqual([CE(1)]); });
  it('since widens the window up to 7 days; older alerts stay hidden', async () => {
    expect(ids(await call(setup(rows()), { since: hoursAgo(24 * 4) }))).toEqual([CE(1), CE(2), CE(3)]);
    expect(ids(await call(setup(rows()), { since: hoursAgo(24 * 7 - 1) }))).toEqual([CE(1), CE(2), CE(3)]);
  });
  it('the 24 h window is applied in SQL on created_at with a bound parameter (index deliveries__tenant_id_purpose_created_at__idx)', async () => {
    const s = setup(rows()); await call(s); const q = s.db.stmts.find((x) => /reporting\.deliveries/i.test(x.text))!;
    expect(q.text).toMatch(/\bpurpose\b/i); expect(q.text).toMatch(/\bcreated_at\b/i); expect(q.values.map((v) => (v instanceof Date ? v.toISOString() : v))).toContain(hoursAgo(24));
  });
  it.each([['since', hoursAgo(24 * 7 + 1)], ['since', '2026-01-01T00:00:00.000Z'], ['since', 'yesterday'], ['since', "2026-11-07T00:00:00Z' OR '1'='1"], ['centre_id', 'not-a-uuid'], ['limit', '0'], ['limit', '201'], ['limit', 'abc']])
  ('invalid %s=%s -> 400 common.validation_failed, nothing read, no echo', async (k, v) => {
    const s = setup(rows()); const e = await rejection(call(s, { [k]: v }));
    expect(e?.code).toBe('common.validation_failed'); expect(s.db.stmts.filter((x) => /reporting\.deliveries/i.test(x.text))).toEqual([]); expect(JSON.stringify({ m: e?.message, d: e?.details })).not.toContain("OR '1'");
  });
});

describe('order + pagination', () => {
  const fleet = (n: number) => Array.from({ length: n }, (_, k) => [alertRow(k + 1, 'referrer', { created_at: hoursAgo(10 - k) }), alertRow(k + 1, 'staff', { created_at: hoursAgo(10 - k, 1000) }), alertRow(k + 1, 'staff', { created_at: hoursAgo(10 - k, 2000) })]).flat();
  it('newest alert first (by alerted_at = earliest delivery of the event)', async () => { expect(ids(await call(setup(fleet(4))))).toEqual([CE(4), CE(3), CE(2), CE(1)]); });
  it('limit + cursor: every event exactly once, last page has no next_cursor, an event\'s recipients are never split across pages', async () => {
    const s = setup(fleet(5)); const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const r = await call(s, { limit: '2', ...(cursor ? { cursor } : {}) }); pages++; seen.push(...ids(r));
      for (const a of r.body.data) expect(a.recipients, a.critical_event_id).toHaveLength(3);
      cursor = r.body.page.next_cursor; expect(r.body.data.length).toBeLessThanOrEqual(2);
    } while (cursor && pages < 10);
    expect(seen).toEqual([CE(5), CE(4), CE(3), CE(2), CE(1)]); expect(pages).toBe(3);
  });
  it('events created in the same millisecond are each returned once across a page boundary', async () => {
    const same = hoursAgo(5); const s = setup([1, 2, 3].flatMap((n) => [alertRow(n, 'referrer', { created_at: same }), alertRow(n, 'staff', { created_at: same })]));
    const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do { const r = await call(s, { limit: '1', ...(cursor ? { cursor } : {}) }); pages++; seen.push(...ids(r)); cursor = r.body.page.next_cursor; } while (cursor && pages < 10);
    expect([...seen].sort()).toEqual([CE(1), CE(2), CE(3)]);
  });
  it.each(['%%%', 'AAAA', Buffer.from('{"k":"x"}').toString('base64url'), "PLANTED'; DROP TABLE reporting.deliveries;--"])('a malformed / tampered cursor %s -> 400 common.invalid_cursor (no echo)', async (c) => {
    const e = await rejection(call(setup(fleet(2)), { cursor: c })); expect(e?.code).toBe('common.invalid_cursor'); expect(JSON.stringify({ m: e?.message, d: e?.details })).not.toContain('PLANTED');
  });
});

describe('PHI hygiene', () => {
  it('registration_no and names never reach the log; no access-log row is required for the panel (no report content is opened)', async () => {
    const s = setup([alertRow(1, 'referrer')]); await call(s);
    expect(s.allText()).not.toContain('0001SY000001'); expect(s.allText()).not.toContain(SENTINEL_NAME); expect(s.allText()).not.toContain(SENTINEL_PHONE);
    expect(s.portCalls).toEqual([]);                                                                                                         // snapshot columns only: no port is called
  });
});

describe('index (done_when: R18 + index)', () => {
  it('the migration defines deliveries__tenant_id_purpose_created_at__idx (tenant_id, purpose, created_at DESC) on reporting.deliveries', () => {
    const sql = readFileSync(join(REPO_ROOT, 'db/migrations/20261105001900_reporting__create_reporting_schema.sql'), 'utf8').replace(/\s+/g, ' ');
    expect(sql).toContain('CREATE INDEX deliveries__tenant_id_purpose_created_at__idx ON reporting.deliveries (tenant_id, purpose, created_at DESC)');
  });
});
