// C16.T-L5 — task engagement.reconcile_links (06-PLAN row T-L5; 02-TRD §4.3.5 suspension, §4.4 (reconcile: display_name / sex_snapshot refresh, projection deletion on last revoke), §4.9 profile_paused, §8.2 crontab, §13 metric;
// 03-APP-FLOW §3.4 L-3 + projection retention; 05-SCHEMA §4 column guard / §5 DELETE policies *__delete__system; 01-PRD US-EN-06 AC1-3, AC5 (data level), US-EN-03.2 reactivation; 07-SECURITY AB-5, P-L5, P-L9, REQ-SEC-024.)
// done_when: rules per TRD §4.3.5. tests: fake demographics changes -> suspended; reactivation by new proof; deletion of projections; display_name / sex_snapshot refreshed.
// Fails now: manifest.tasks has no 'engagement.reconcile_links' and crontab has no row for it.
//
// SEAMS (spec fixes behaviour, not names; same convention as backfill_link.test.ts / close_queue_day.test.ts):
//   Task = manifest.tasks['engagement.reconcile_links'](payload {tenant_id}, JobContext) - cron-only (no §8.1 row). Tenant guard like close_queue_day: acts only when payload.tenant_id is a uuid equal to ctx.tenantId, else resolves
//   without a statement or a port call. Cron row: daily 02:20 Asia/Kathmandu = 20:35 UTC previous day -> `35 20 * * *` (UTC fields, core/manifest.ts), tenantScope 'per_tenant'; cron.ts exports the frozen crontab the manifest uses.
//   System actor, ONE transaction (a throw rolls everything back, the queue retries). FrontdeskPort.getPatientDemographics(ctx, {patientId, purpose:'patient_app_link'}) per patient with a live (active / suspended) link;
//   record phone check = HMAC-SHA256(phone HMAC key, `<tenant_id>:<phoneE164>`) 32-byte Buffer compared with record_phone_hmac_at_link (the same function as link / auth service); skipped when that column is NULL.
//   Writes: UPDATE account_patient_links SET status='suspended', suspend_reason, suspended_at = ctx.now(), version = version + 1, updated_by = system actor .. AND status = 'active' (conditional); reasons phone_mismatch |
//   patient_merged | patient_anonymised | dormant; dormant = accounts.last_login_at strictly older than now - settings.dormant_after_days days (pass the cut-off as a bound parameter: the world does no interval arithmetic).
//   Notification per newly suspended link: engagement.notifications {kind:'profile_paused', account_id, patient_id, entity_type:'profile', entity_id: link id, route_id: NULL, created_by: system actor, expires_at: now + 180 days},
//   inserted ON CONFLICT DO NOTHING (dedupe key (tenant, account, kind, entity_id, entity_seq)); metric lims_engagement_link_events_total {method: link.method, outcome:'suspended'}.
//   Refresh (active AND suspended links, all methods): display_name <- trim(fullName).slice(0,200) when non-empty, sex_snapshot <- sex when a string; unchanged values cause no write (version stays).
//   Projection deletion: system DELETE ... WHERE tenant_id = $n AND patient_id = ANY($m::uuid[]) on patient_orders, patient_order_specimens, patient_reports, smart_summaries for every patient with NO active / suspended link
//   (the world cascades orders -> specimens, reports -> smart_summaries like the FKs). SQL stays inside the world grammar (__tests__/link.world.ts header: no JOIN / sub-select / OR; read links and accounts with separate SELECTs).
// NOT pinned: order of the checks when several reasons apply at once; behaviour for a record whose phone was removed (phoneE164 absent) and accounts with last_login_at NULL; engagement.projection_drift repair of orders
// updated in the last 30 days (TRD §8.2 mentions it, the plan row and the ACs do not: see .orchestra/notes/T-L5-tests.md).
import '../../../../../api/src/__tests__/setup-env.js';
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';
import { manifest } from '../index.js';
import { handlers } from '../../../../../api/src/modules/engagement/handlers/index.js';
import { ID, SYSTEM_ACTOR, T0, TENANT_B, makeLinkWorld, phoneHmac, type LinkWorld } from '../../../../../api/src/modules/engagement/__tests__/link.world.js';

const DAY = 86_400_000;
const PHONE = '+99001000001', NEW_PHONE = '+99001000004', THIRD_PHONE = '+99001000005';
const P = ID(0x700), P2 = ID(0x701), P3 = ID(0x702), P4 = ID(0x703);
const TASK = 'engagement.reconcile_links';
const CODE = 'ABCDE-FGH23';
const rejection = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } return undefined; };
const ago = (ms: number) => new Date(Date.parse(T0) - ms).toISOString();
const later = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
const same = (a: unknown, b: unknown) => Date.parse(String(a)) === Date.parse(String(b));

interface Fx { w: LinkWorld; acct: Record<string, any>; link: Record<string, any>; run: (payload?: any, over?: Record<string, any>) => Promise<void>; row: (l: Record<string, any>) => Record<string, any>; links: () => Record<string, any>[] }
const taskOf = () => { const t = (manifest.tasks as Record<string, any> | undefined)?.[TASK]; if (typeof t !== 'function') throw new Error(`manifest.tasks['${TASK}'] is missing (T-L5 not implemented)`); return t as (p: any, c: any) => Promise<void>; };
/** Tenant-A world: account A1 (phone PHONE, signed in now) with an ACTIVE link_code link to patient P whose record phone at link time was PHONE; C4 still has PHONE on file. */
function setup(o: { dormantAfterDays?: number; link?: Record<string, any>; acct?: Record<string, any>; demo?: Record<string, any> } = {}): Fx {
  const w = makeLinkWorld();
  if (o.dormantAfterDays !== undefined) w.setSetting('dormant_after_days', o.dormantAfterDays); else w.setSetting('dormant_after_days', 180);
  const acct = w.seedAccount(PHONE, o.acct ?? {});
  for (const p of [P, P2, P3, P4]) w.setDemographics(p, { phoneE164: PHONE, fullName: 'Synthetic Patient', sex: 'female', ...(p === P ? o.demo ?? {} : {}) });
  const link = w.seedLink(acct['id'], P, { record_phone_hmac_at_link: phoneHmac(w.tenantId, PHONE), ...(o.link ?? {}) });
  const run = (payload: any = { tenant_id: w.tenantId }, over: Record<string, any> = {}) => w.inTx(() => taskOf()(payload, w.jobCtx(over)));
  return { w, acct, link, run, row: (l) => w.t['account_patient_links']!.find((r) => r['id'] === l['id'])!, links: () => w.t['account_patient_links']! };
}
/** A second account (own phone) with an active link to patient `patientId`. */
const another = (f: Fx, patientId: string, phone: string, over: Record<string, any> = {}, acctOver: Record<string, any> = {}) => {
  const a = f.w.seedAccount(phone, acctOver); return { acct: a, link: f.w.seedLink(a['id'], patientId, { record_phone_hmac_at_link: phoneHmac(f.w.tenantId, PHONE), ...over }) };
};
const SUSPENDED = { status: 'suspended', suspend_reason: 'phone_mismatch', suspended_at: ago(DAY) };
const notes = (w: LinkWorld, kind = 'profile_paused') => w.t['notifications']!.filter((n) => n['kind'] === kind);
const suspendMetrics = (w: LinkWorld) => w.metricCalls.filter((m) => m.name === 'lims_engagement_link_events_total' && m.labels['outcome'] === 'suspended');
const redeem = (f: Fx, code = CODE, acct = f.acct) => f.w.inTx(() => (handlers as any).redeemLinkCode({ params: {}, query: {}, headers: {}, body: { code } }, f.w.patientCtx(acct)));

// ---------------------------------------------------------------- projection fixtures (05-SCHEMA patient_orders / _order_specimens / _reports / smart_summaries)
let n = 0x6000;
function project(w: LinkWorld, patientId: string, tenant = w.tenantId) {
  const k = ++n; const order = ID(k), spec = ID(k + 0x100), rep = ID(k + 0x200), sum = ID(k + 0x300);
  const common = { tenant_id: tenant, patient_id: patientId, created_by: SYSTEM_ACTOR, updated_by: SYSTEM_ACTOR, created_at: T0, updated_at: T0 };
  w.t['patient_orders']!.push({ ...common, order_id: order, centre_id: ID(0xc01), branch_id: ID(0xb01), source: 'front_desk', booking_id: null, order_status: 'registered', registered_at: T0, visible_at: T0, stage: 'registered', payment_due: false, status_version: 1, synced_at: T0 });
  w.t['patient_order_specimens']!.push({ ...common, specimen_id: spec, order_id: order, specimen_type_code: 'SER', status: 'collected', status_seq: 1, ordinal: 1 });
  w.t['patient_reports']!.push({ ...common, report_id: rep, version_no: 1, order_id: order, report_kind: 'final', status: 'valid', released_at: T0, panel_names: [], smart_summary_available: true });
  w.t['smart_summaries']!.push({ id: sum, tenant_id: tenant, order_id: order, report_id: rep, report_version_no: 1, patient_id: patientId, summary: {}, approved_at: T0, fetched_at: T0, created_by: SYSTEM_ACTOR });
  return { order, spec, rep, sum };
}
const TABLES = ['patient_orders', 'patient_order_specimens', 'patient_reports', 'smart_summaries'] as const;
const rowsOf = (w: LinkWorld, patientId: string, tenant = w.tenantId) => Object.fromEntries(TABLES.map((t) => [t, w.t[t]!.filter((r) => r['patient_id'] === patientId && r['tenant_id'] === tenant).length]));
const FULL = { patient_orders: 1, patient_order_specimens: 1, patient_reports: 1, smart_summaries: 1 }, NONE = { patient_orders: 0, patient_order_specimens: 0, patient_reports: 0, smart_summaries: 0 };
const revoked = { status: 'revoked', revoked_by_kind: 'account', revoked_at: T0 };

describe('manifest + crontab (02-TRD §8.2)', () => {
  it('engagement.reconcile_links is a registered task (not the fail-closed stub) and the manifest still validates', async () => {
    expect(() => validateManifests([manifest])).not.toThrow();
    const f = setup(); const e = await rejection(f.run());
    expect(String(e?.message ?? '')).not.toMatch(/not implemented/);
  });
  it('one cron row: daily 02:20 Asia/Kathmandu = `35 20 * * *` (UTC fields), per_tenant; cron.ts exports the frozen crontab the manifest uses', async () => {
    const rows = ((manifest.crontab ?? []) as any[]).filter((x) => x.identifier === TASK);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ schedule: '35 20 * * *', tenantScope: 'per_tenant' });
    const cron: any = await import('../cron.js'); expect(cron.crontab).toBe(manifest.crontab); expect(Object.isFrozen(cron.crontab)).toBe(true);
  });
  it('tenant guard (REQ-SEC-024): a payload for another tenant, without a tenant or with a non-uuid tenant resolves without a statement or a port call', async () => {
    const f = setup({ link: SUSPENDED, acct: { last_login_at: ago(400 * DAY) } });
    for (const payload of [{ tenant_id: TENANT_B }, {}, { tenant_id: 'not-a-uuid' }, undefined, null]) {
      const before = f.w.stmts.length; await f.w.inTx(() => taskOf()(payload, f.w.jobCtx()));
      expect(f.w.stmts.length).toBe(before); expect(f.w.frontdesk.calls).toHaveLength(0);
    }
  });
});

describe('phone mismatch (US-EN-06.1, TRD §4.3.5)', () => {
  it('record phone changed P1 -> P4: the link becomes suspended (phone_mismatch) at ctx.now(), version + 1, by the system; nothing else on the link changes', async () => {
    const f = setup({ demo: { phoneE164: NEW_PHONE } }); const before = { ...f.row(f.link) };
    await f.run(); const l = f.row(f.link);
    expect(l).toMatchObject({ status: 'suspended', suspend_reason: 'phone_mismatch', version: before['version'] + 1, updated_by: SYSTEM_ACTOR });
    expect(same(l['suspended_at'], T0)).toBe(true);
    for (const c of ['patient_id', 'account_id', 'relationship', 'method', 'link_code_id', 'consent_id', 'visible_from', 'record_phone_hmac_at_link']) expect(l[c]).toEqual(before[c]);
    expect(f.w.frontdesk.calls[0]).toEqual({ actor: 'system', input: { patientId: P, purpose: 'patient_app_link' } });
  });
  it('record phone unchanged: the link stays active and is not written (version unchanged)', async () => {
    const f = setup(); const v = f.row(f.link)['version']; await f.run();
    expect(f.row(f.link)).toMatchObject({ status: 'active', suspend_reason: null, suspended_at: null, version: v }); expect(notes(f.w)).toHaveLength(0); expect(suspendMetrics(f.w)).toHaveLength(0);
  });
  it('record_phone_hmac_at_link NULL: the phone check is skipped (a different record phone does not suspend)', async () => {
    const f = setup({ link: { method: 'report_link', record_phone_hmac_at_link: null }, demo: { phoneE164: NEW_PHONE } }); await f.run();
    expect(f.row(f.link)).toMatchObject({ status: 'active', suspend_reason: null });
  });
  it('only the changed patient\'s links are suspended: the same account\'s link to a patient whose phone is unchanged stays active; every account linked to the changed patient is suspended', async () => {
    const f = setup({ demo: { phoneE164: NEW_PHONE } });
    const mine2 = f.w.seedLink(f.acct['id'], P2, { relationship: 'child', record_phone_hmac_at_link: phoneHmac(f.w.tenantId, PHONE) });
    const other = another(f, P, '+99001000002');
    await f.run();
    expect(f.row(f.link)['status']).toBe('suspended'); expect(f.row(other.link)).toMatchObject({ status: 'suspended', suspend_reason: 'phone_mismatch' }); expect(f.row(mine2)['status']).toBe('active');
  });
  it('rerun is idempotent: a suspended link keeps its suspended_at / version, no second notification, no second metric', async () => {
    const f = setup({ demo: { phoneE164: NEW_PHONE } }); await f.run(); const once = { ...f.row(f.link) }; f.w.advance(DAY); await f.run();
    expect(f.row(f.link)).toMatchObject({ status: 'suspended', suspend_reason: 'phone_mismatch', version: once['version'] }); expect(same(f.row(f.link)['suspended_at'], once['suspended_at'])).toBe(true);
    expect(notes(f.w)).toHaveLength(1); expect(suspendMetrics(f.w)).toHaveLength(1);
  });
  it('a suspended link is NOT reactivated by reconcile when the record phone is back to P1 (only a new proof reactivates, TRD §4.3.5)', async () => {
    const f = setup({ demo: { phoneE164: NEW_PHONE } }); await f.run();
    f.w.setDemographics(P, { phoneE164: PHONE }); f.w.advance(DAY); await f.run();
    expect(f.row(f.link)).toMatchObject({ status: 'suspended', suspend_reason: 'phone_mismatch' });
  });
  it('revoked links are ignored: no status change and no demographics call for a patient whose only link is revoked', async () => {
    const f = setup({ link: revoked, demo: { phoneE164: NEW_PHONE } }); await f.run();
    expect(f.row(f.link)).toMatchObject({ status: 'revoked', suspend_reason: null }); expect(f.w.frontdesk.calls).toHaveLength(0);
  });
});

describe('merged / anonymised (US-EN-06.2)', () => {
  it.each([['merged', 'patient_merged'], ['anonymised', 'patient_anonymised']])('C4 status %s: the link becomes suspended with %s (even when the phone check is skipped)', async (status, reason) => {
    const f = setup({ link: { record_phone_hmac_at_link: null, method: 'report_link' }, demo: { status } }); await f.run();
    expect(f.row(f.link)).toMatchObject({ status: 'suspended', suspend_reason: reason }); expect(same(f.row(f.link)['suspended_at'], T0)).toBe(true);
  });
  it('a merged patient does not suspend the account\'s other links (links of other patients stay active)', async () => {
    const f = setup({ demo: { status: 'merged' } }); const mine2 = f.w.seedLink(f.acct['id'], P2, { relationship: 'child', record_phone_hmac_at_link: phoneHmac(f.w.tenantId, PHONE) });
    await f.run(); expect(f.row(mine2)['status']).toBe('active');
  });
});

describe('dormant account (US-EN-06.3)', () => {
  it('last_login_at older than dormant_after_days (180): ALL of the account\'s active links become suspended (dormant); a link of an account that signed in recently is untouched', async () => {
    const f = setup({ acct: { last_login_at: ago(181 * DAY) } }); const l2 = f.w.seedLink(f.acct['id'], P2, { relationship: 'child', record_phone_hmac_at_link: phoneHmac(f.w.tenantId, PHONE) });
    const fresh = another(f, P3, '+99001000002', {}, { last_login_at: ago(179 * DAY) });
    await f.run();
    for (const l of [f.link, l2]) { expect(f.row(l)).toMatchObject({ status: 'suspended', suspend_reason: 'dormant', updated_by: SYSTEM_ACTOR }); expect(same(f.row(l)['suspended_at'], T0)).toBe(true); }
    expect(f.row(fresh.link)).toMatchObject({ status: 'active', suspend_reason: null });
  });
  it('the cut-off is strict and honours settings.dormant_after_days: exactly 180 days -> still active; 30-day setting suspends a 31-day-old login', async () => {
    const edge = setup({ acct: { last_login_at: ago(180 * DAY) } }); await edge.run(); expect(edge.row(edge.link)['status']).toBe('active');
    const short = setup({ dormantAfterDays: 30, acct: { last_login_at: ago(31 * DAY) } }); await short.run(); expect(short.row(short.link)).toMatchObject({ status: 'suspended', suspend_reason: 'dormant' });
    const long = setup({ dormantAfterDays: 365, acct: { last_login_at: ago(200 * DAY) } }); await long.run(); expect(long.row(long.link)['status']).toBe('active');
  });
  it('an already suspended link keeps its original reason and suspended_at; revoked links are untouched', async () => {
    const f = setup({ acct: { last_login_at: ago(400 * DAY) }, link: { ...SUSPENDED, suspended_at: ago(5 * DAY) } });
    const gone = f.w.seedLink(f.acct['id'], P2, { relationship: 'child', ...revoked });
    await f.run();
    expect(f.row(f.link)).toMatchObject({ status: 'suspended', suspend_reason: 'phone_mismatch' }); expect(same(f.row(f.link)['suspended_at'], ago(5 * DAY))).toBe(true); expect(f.row(gone)).toMatchObject({ status: 'revoked', suspend_reason: null });
  });
  it('a dormant account of ANOTHER tenant is not touched and its patient is never looked up (REQ-SEC-024)', async () => {
    const f = setup(); const b = f.w.seedAccount('+99001000009', { tenant_id: TENANT_B, last_login_at: ago(900 * DAY) });
    const bl = f.w.seedLink(b['id'], P4, { tenant_id: TENANT_B, method: 'self_registered', record_phone_hmac_at_link: null });
    await f.run(); expect(f.row(bl)['status']).toBe('active'); expect(f.w.frontdesk.calls.every((c) => c.input['patientId'] !== P4)).toBe(true);
  });
});

describe('notification, metric, access (TRD §4.9, §13; APP-FLOW L-3)', () => {
  it('each newly suspended link creates ONE profile_paused notification for ITS account (entity = the link, no route) and one suspended metric labelled with the link method', async () => {
    const f = setup({ demo: { phoneE164: NEW_PHONE } }); const o = another(f, P2, '+99001000002', { method: 'report_link', link_code_id: null }, { last_login_at: ago(300 * DAY) });
    await f.run();
    expect(notes(f.w)).toHaveLength(2);
    expect(notes(f.w).find((x) => x['account_id'] === f.acct['id'])).toMatchObject({ patient_id: P, entity_type: 'profile', entity_id: f.link['id'], route_id: null, created_by: SYSTEM_ACTOR });
    expect(notes(f.w).find((x) => x['account_id'] === o.acct['id'])).toMatchObject({ patient_id: P2, entity_type: 'profile', entity_id: o.link['id'] });
    for (const x of notes(f.w)) expect(same(x['expires_at'], later(180 * DAY))).toBe(true);
    expect(suspendMetrics(f.w).map((m) => m.labels['method']).sort()).toEqual(['link_code', 'report_link']);
  });
  it('no phone, name, HMAC or phone digits reach logs, audit rows or metric labels (P1 data)', async () => {
    const f = setup({ demo: { phoneE164: NEW_PHONE, fullName: 'Zzyzx Qwerty' } }); await f.run();
    const seen = f.w.observed(); for (const s of [PHONE.slice(4), NEW_PHONE.slice(4), 'Zzyzx', 'Qwerty', phoneHmac(f.w.tenantId, PHONE).toString('hex')]) expect(seen).not.toContain(s);
  });
  it('every statement names tenant_id (REQ-SEC-024) and the demographics are read only with purpose patient_app_link as the system actor', async () => {
    const f = setup({ demo: { phoneE164: NEW_PHONE } }); project(f.w, P3); await f.run();
    for (const s of f.w.stmts.filter((x) => /engagement\.|\b(accounts|account_patient_links|patient_\w+|smart_summaries|notifications|settings)\b/i.test(x.text))) expect(s.text).toMatch(/tenant_id/i);
    expect(f.w.frontdesk.calls.length).toBeGreaterThan(0); for (const c of f.w.frontdesk.calls) expect(c).toMatchObject({ actor: 'system', input: { purpose: 'patient_app_link' } });
  });
});

describe('display_name / sex_snapshot refresh (TRD §4.4 reconcile; 05-SCHEMA account_patient_links.sex_snapshot)', () => {
  it.each(['link_code', 'report_link', 'self_registered'])('%s link: display_name and sex_snapshot follow C4', async (method) => {
    const f = setup({ link: { method, display_name: 'Old Name', sex_snapshot: 'unknown', ...(method === 'link_code' ? {} : { link_code_id: null }) }, demo: { fullName: 'New Name', sex: 'male' } });
    await f.run(); expect(f.row(f.link)).toMatchObject({ status: 'active', display_name: 'New Name', sex_snapshot: 'male', updated_by: SYSTEM_ACTOR });
  });
  it('a SUSPENDED link is refreshed too; a REVOKED link is not (no personal data kept fresh for removed profiles)', async () => {
    const f = setup({ link: { ...SUSPENDED, suspended_at: ago(DAY), display_name: 'Old Name' }, demo: { fullName: 'New Name', sex: 'male', phoneE164: NEW_PHONE } });
    const gone = another(f, P2, '+99001000002', { ...revoked, display_name: 'Old Name' });
    f.w.setDemographics(P2, { fullName: 'Changed Too', sex: 'male' });
    await f.run(); expect(f.row(f.link)).toMatchObject({ status: 'suspended', display_name: 'New Name', sex_snapshot: 'male' }); expect(f.row(gone.link)).toMatchObject({ status: 'revoked', display_name: 'Old Name' });
  });
  it('the name is trimmed and capped at 200 characters; a blank name or a missing sex keeps the stored value (the CHECK display_name 1..200 must never fail the batch)', async () => {
    const long = setup({ link: { display_name: 'Old Name' }, demo: { fullName: `  ${'N'.repeat(260)}  ` } }); await long.run(); expect(long.row(long.link)['display_name']).toBe('N'.repeat(200));
    const blank = setup({ link: { display_name: 'Old Name', sex_snapshot: 'female' }, demo: { fullName: '   ', sex: undefined } }); await blank.run();
    expect(blank.row(blank.link)).toMatchObject({ status: 'active', display_name: 'Old Name', sex_snapshot: 'female' });
  });
  it('an unchanged snapshot causes no write: a second run leaves version and updated_at as they were', async () => {
    const f = setup({ link: { display_name: 'Old Name' }, demo: { fullName: 'New Name' } }); await f.run(); const once = { ...f.row(f.link) }; f.w.advance(DAY); await f.run();
    expect(f.row(f.link)['version']).toBe(once['version']); expect(same(f.row(f.link)['updated_at'], once['updated_at'])).toBe(true);
  });
});

describe('projection deletion when the last link of a patient is revoked (TRD §4.4, APP-FLOW §3.4, 05-SCHEMA §5 read-model retention)', () => {
  it('the only link revoked: every read-model row of that patient (orders, specimens, reports, smart summaries) is deleted; other patients and other tenants keep theirs', async () => {
    const f = setup({ link: revoked }); project(f.w, P); project(f.w, P);
    const keep = another(f, P2, '+99001000002'); project(f.w, P2); project(f.w, P, TENANT_B);
    expect(rowsOf(f.w, P)).toEqual({ patient_orders: 2, patient_order_specimens: 2, patient_reports: 2, smart_summaries: 2 });
    await f.run();
    expect(rowsOf(f.w, P)).toEqual(NONE); expect(rowsOf(f.w, P2)).toEqual(FULL); expect(rowsOf(f.w, P, TENANT_B)).toEqual(FULL); expect(f.row(keep.link)['status']).toBe('active');
  });
  it('a patient with a second link that is active or suspended keeps its projections; revoked on every account -> deleted', async () => {
    const f = setup({ link: revoked }); const act = another(f, P, '+99001000002'); project(f.w, P);
    await f.run(); expect(rowsOf(f.w, P)).toEqual(FULL);
    f.w.t['account_patient_links']!.splice(f.w.t['account_patient_links']!.indexOf(act.link), 1);
    const sus = another(f, P, '+99001000003', { ...SUSPENDED, suspended_at: ago(DAY) }); await f.run(); expect(rowsOf(f.w, P)).toEqual(FULL);
    Object.assign(sus.link, revoked, { status: 'revoked', suspend_reason: null, suspended_at: null }); await f.run(); expect(rowsOf(f.w, P)).toEqual(NONE);
  });
  it('a link suspended BY THIS RUN is still live: its projections are kept (reactivation by a new proof needs no re-projection of an empty patient)', async () => {
    const f = setup({ demo: { phoneE164: NEW_PHONE } }); project(f.w, P); await f.run();
    expect(f.row(f.link)['status']).toBe('suspended'); expect(rowsOf(f.w, P)).toEqual(FULL);
  });
  it('leftover rows of a patient without any link are deleted too; a patient whose only link is revoked is not looked up in C4', async () => {
    const f = setup({ link: revoked }); project(f.w, P4); project(f.w, P);
    await f.run(); expect(rowsOf(f.w, P4)).toEqual(NONE); expect(rowsOf(f.w, P)).toEqual(NONE); expect(f.w.frontdesk.calls.filter((c) => c.input['patientId'] === P)).toHaveLength(0);
  });
  it('rerun leaves the deleted state; DELETEs run as the system actor and every one is tenant-scoped (the world rejects a DELETE without tenant_id = $n and any non-system DELETE)', async () => {
    const f = setup({ link: revoked }); project(f.w, P); await f.run(); await f.run();
    expect(rowsOf(f.w, P)).toEqual(NONE); expect(f.row(f.link)).toMatchObject({ status: 'revoked' });
    const patient = f.w.patientCtx(f.acct); await expect(patient.tx.query('DELETE FROM engagement.patient_orders WHERE tenant_id = $1 AND patient_id = $2', [f.w.tenantId, P])).rejects.toMatchObject({ code: '42501' });
  });
});

describe('reactivation only by a new proof (US-EN-06.3, US-EN-03.2, TRD §4.3.5, probe P-L9)', () => {
  const issue = (f: Fx, record: string) => f.w.seedCode(P, { plain: CODE, boundPhone: PHONE, record_phone_hmac: phoneHmac(f.w.tenantId, record) });
  it('phone mismatch -> suspended -> the account redeems a new code (record phone P4) -> active, record_phone_hmac_at_link refreshed; the next reconcile keeps it active; a later phone change suspends it again without a duplicate-key failure', async () => {
    const f = setup({ demo: { phoneE164: NEW_PHONE } }); await f.run(); expect(f.row(f.link)['status']).toBe('suspended');
    issue(f, NEW_PHONE); const r = await redeem(f); expect([200, 201]).toContain(r.status);
    expect(f.row(f.link)).toMatchObject({ status: 'active', suspend_reason: null, suspended_at: null }); expect(Buffer.from(f.row(f.link)['record_phone_hmac_at_link']).equals(phoneHmac(f.w.tenantId, NEW_PHONE))).toBe(true);
    f.w.advance(DAY); await f.run(); expect(f.row(f.link)).toMatchObject({ status: 'active', suspend_reason: null });
    f.w.setDemographics(P, { phoneE164: THIRD_PHONE }); f.w.advance(DAY); await f.run();
    expect(f.row(f.link)).toMatchObject({ status: 'suspended', suspend_reason: 'phone_mismatch' }); expect(notes(f.w).length).toBeGreaterThanOrEqual(1);
  });
  it('a patient-actor UPDATE that tries to reactivate the suspended link is refused (immutable_row, P-L9) - reconcile never relies on it', async () => {
    const f = setup({ demo: { phoneE164: NEW_PHONE } }); await f.run();
    await expect(f.w.patientCtx(f.acct).tx.query(`UPDATE engagement.account_patient_links SET status = 'active', suspend_reason = NULL, suspended_at = NULL WHERE tenant_id = $1 AND id = $2`, [f.w.tenantId, f.link['id']])).rejects.toMatchObject({ message: expect.stringContaining('immutable_row') });
  });
  it('dormant: signing in again does not reactivate (links stay suspended through the next reconcile); a code proves only ITS patient - the account\'s other dormant link stays suspended', async () => {
    const f = setup({ acct: { last_login_at: ago(200 * DAY) } }); const l2 = f.w.seedLink(f.acct['id'], P2, { relationship: 'child', record_phone_hmac_at_link: phoneHmac(f.w.tenantId, PHONE) });
    await f.run(); expect([f.row(f.link)['suspend_reason'], f.row(l2)['suspend_reason']]).toEqual(['dormant', 'dormant']);
    f.acct['last_login_at'] = f.w.now(); f.w.advance(DAY); await f.run(); expect([f.row(f.link)['status'], f.row(l2)['status']]).toEqual(['suspended', 'suspended']);
    issue(f, PHONE); await redeem(f);
    expect(f.row(f.link)).toMatchObject({ status: 'active', suspend_reason: null }); expect(f.row(l2)).toMatchObject({ status: 'suspended', suspend_reason: 'dormant' });
    f.w.advance(DAY); await f.run(); expect(f.row(f.link)['status']).toBe('active'); expect(f.row(l2)['status']).toBe('suspended');
  });
  it('merged: a later run keeps the link suspended with patient_merged (no flapping; reason and suspended_at stable)', async () => {
    const f = setup({ demo: { status: 'merged' } }); await f.run(); expect(f.row(f.link)['suspend_reason']).toBe('patient_merged');
    f.w.advance(DAY); await f.run(); expect(f.row(f.link)).toMatchObject({ status: 'suspended', suspend_reason: 'patient_merged' }); expect(same(f.row(f.link)['suspended_at'], T0)).toBe(true);
  });
});

describe('failure handling (retry semantics, isolation)', () => {
  it('a patient C4 no longer knows (common.not_found) is skipped: the other links are still reconciled and the task resolves', async () => {
    const f = setup({ demo: { phoneE164: NEW_PHONE } }); const o = another(f, P2, '+99001000002'); f.w.demographics.delete(P2); f.w.setDemographics(P3, { phoneE164: NEW_PHONE });
    const o3 = another(f, P3, '+99001000003');
    await f.run(); expect(f.row(f.link)['status']).toBe('suspended'); expect(f.row(o3.link)['status']).toBe('suspended'); expect(f.row(o.link)['status']).toBe('active');
  });
  it('a transient port failure fails the whole run (the queue retries) and nothing is half-applied; the retry then succeeds', async () => {
    const f = setup({ demo: { phoneE164: NEW_PHONE }, acct: { last_login_at: ago(300 * DAY) } }); project(f.w, P4); const snap = JSON.stringify(f.links());
    f.w.frontdesk.failNext = Object.assign(new Error('c4 down'), { code: 'common.service_unavailable' });
    const e = await rejection(f.run()); expect(e).toBeDefined(); expect(JSON.stringify(f.links())).toBe(snap); expect(notes(f.w)).toHaveLength(0); expect(rowsOf(f.w, P4)).toEqual(FULL);
    await f.run(); expect(f.row(f.link)['status']).toBe('suspended'); expect(rowsOf(f.w, P4)).toEqual(NONE);
  });
  it('a tenant with no links resolves (no port call, no write)', async () => {
    const w = makeLinkWorld(); await w.inTx(() => taskOf()({ tenant_id: w.tenantId }, w.jobCtx())); expect(w.frontdesk.calls).toHaveLength(0); expect(w.t['account_patient_links']).toHaveLength(0); expect(w.t['notifications']).toHaveLength(0);
  });
});
