// C6-T03 — settings.service (06-PLAN row C6-T03; 02-TRD §6.5 S1-S7 + R17, §10.2 defaults; 05-SCHEMA §2.13, §6.1, §8; 07-SECURITY REQ-SEC-002/024/080).
// Contract under test (ASSUMED, see .orchestra/notes/C6-T03-tests.md): ../service/settings.service.ts exports
//   createSettingsService({ core: { membershipPermissions(ctx,{membershipId}) }, newId?: () => string }) -> {
//     getSettings(ctx), updateSettings(ctx,{expectedVersion,patch}), listCentreContacts(ctx,{centreId?}), createCentreContact(ctx,input),
//     updateCentreContact(ctx,{centreContactId,expectedVersion,patch}), replaceStaffAssignments(ctx,input),
//     upsertReferrerPreference(ctx,{referrerId,disabledChannels}), listCodes(ctx,{setName}) }
//   ctx = { tenantId, actor:{type,id,membershipId}, requestId, tx, now(), ports } (same shape as core-repo). Results use the OpenAPI body shapes (snake_case).
// Errors are LimsError codes (common.*); raw FK/RLS SQLSTATEs (23503/42501) may pass through for core's mapDbError (-> common.not_found).
// What this fake cannot prove (real RLS, real constraints) is covered by db/tests/isolation/reporting.*.test.sql (generated probes, every table) and T0B-10.C6.
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../core/module.js';
import {
  CENTRE_A1, CENTRE_A2, CENTRE_B1, DOCTOR_A, DOCTOR_B, MEM, MEM_B, MEM_CLERK, MEM_NARR, MEM_SIGNER, SENTINEL, SETTINGS_DEFAULTS, TENANT_A, TENANT_B, USER,
  counterId, idN, isDbDenied, makeCore, makeCtx, makeDb, pgError, rejection,
} from './settings.helpers.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/reporting.yaml'));
const schemas = spec.components.schemas;
const keysOf = (name: string) => Object.keys(schemas[name].properties).sort();

let mod: any;
beforeAll(async () => { mod = await import('../service/settings.service.js'); });
const svc = (core = makeCore()) => mod.createSettingsService({ core, newId: counterId });
const code = (e: any) => e?.code;
const SETTINGS_ROW = { id: idN(0x5001), tenant_id: TENANT_A, created_by: USER, updated_by: USER };

describe('S1 getSettings — lazy defaults (05-SCHEMA §8, 02-TRD §10.2)', () => {
  it('first access creates the tenant row with the §10.2 defaults and returns exactly the ReportingSettings fields', async () => {
    const db = makeDb(); const s = svc();
    const out = await s.getSettings(makeCtx(db));
    expect(out).toMatchObject(SETTINGS_DEFAULTS);
    const keys = Object.keys(out).sort();
    for (const k of schemas.ReportingSettings.required) expect(keys).toContain(k);
    expect(keys.filter((k) => !keysOf('ReportingSettings').includes(k))).toEqual([]);          // no id / tenant_id / created_by leak
    const rows = db.store['settings']!;
    expect(rows).toHaveLength(1);
    expect(rows[0]!['tenant_id']).toBe(TENANT_A);
    expect([rows[0]!['created_by'], rows[0]!['updated_by']].every((v) => v === USER || v === MEM)).toBe(true);
  });
  it('second access does not insert again (idempotent)', async () => {
    const db = makeDb({ settings: [SETTINGS_ROW] }); const s = svc();
    await s.getSettings(makeCtx(db)); await s.getSettings(makeCtx(db));
    expect(db.writes()).toHaveLength(0);
    expect(db.store['settings']).toHaveLength(1);
  });
  it('concurrent first access (two requests): the loser of the insert race still returns the row — insert is ON CONFLICT-safe, never a 500', async () => {
    const db = makeDb(); const s = svc();
    const [a, b] = await Promise.all([s.getSettings(makeCtx(db)), s.getSettings(makeCtx(db))]);
    expect(a).toMatchObject(SETTINGS_DEFAULTS); expect(b).toMatchObject(SETTINGS_DEFAULTS);
    expect(db.store['settings']).toHaveLength(1);
    for (const w of db.writes().filter((x) => x.verb === 'insert')) expect(w.text).toMatch(/on\s+conflict/i);
  });
  it('existing row of another tenant is never returned for tenant A (explicit tenant predicate bound on every reporting statement)', async () => {
    const db = makeDb({ settings: [{ ...SETTINGS_ROW, id: idN(0x5002), tenant_id: TENANT_B, auto_release: 'manual', version: 9 }] });
    const out = await svc().getSettings(makeCtx(db));
    expect(out.auto_release).toBe('when_eligible'); expect(out.version).toBe(1);
    for (const st of db.reporting()) { expect(st.values).toContain(TENANT_A); expect(st.values).not.toContain(TENANT_B); expect(st.text).toMatch(/tenant_id/i); }
  });
  it('tenant comes from ctx only: no id is concatenated into SQL', async () => {
    const db = makeDb(); await svc().getSettings(makeCtx(db));
    for (const st of db.reporting()) expect(st.text).not.toContain(TENANT_A);
  });
});

describe('S2 updateSettings — partial update, optimistic lock, validation', () => {
  it('applies the patch, bumps version, binds the expected version and tenant, and records the actor', async () => {
    const db = makeDb({ settings: [{ ...SETTINGS_ROW, version: 3 }] });
    const out = await svc().updateSettings(makeCtx(db), { expectedVersion: 3, patch: { auto_release: 'manual', bulk_release_max: 50 } });
    expect(out).toMatchObject({ auto_release: 'manual', bulk_release_max: 50, version: 4, narrative_report_mode: 'separate' });
    const upd = db.writes().find((w) => w.verb === 'update')!;
    expect(upd.values).toEqual(expect.arrayContaining([TENANT_A, 3]));
    expect(JSON.stringify(upd.values)).toContain('manual'); expect(JSON.stringify(upd.values)).toContain('50');
    expect(upd.values.some((v) => v === USER || v === MEM)).toBe(true);                       // updated_by
    expect(upd.text).toMatch(/tenant_id/i); expect(upd.text).toMatch(/version/i);
  });
  it('stale version -> common.version_conflict and the row is unchanged', async () => {
    const db = makeDb({ settings: [{ ...SETTINGS_ROW, version: 4 }] });
    const e = await rejection(svc().updateSettings(makeCtx(db), { expectedVersion: 3, patch: { auto_release: 'manual' } }));
    expect(code(e)).toBe('common.version_conflict');
    expect(db.store['settings']![0]).toMatchObject({ auto_release: 'when_eligible', version: 4 });
  });
  it('missing If-Match -> common.precondition_required, no write', async () => {
    const db = makeDb({ settings: [SETTINGS_ROW] });
    const e = await rejection(svc().updateSettings(makeCtx(db), { expectedVersion: undefined, patch: { auto_release: 'manual' } }));
    expect(code(e)).toBe('common.precondition_required'); expect(db.writes()).toHaveLength(0);
  });
  it('If-Match beyond int4 (2147483648) -> common.validation_failed, no write (not a 500)', async () => {
    const db = makeDb({ settings: [SETTINGS_ROW] });
    const e = await rejection(svc().updateSettings(makeCtx(db), { expectedVersion: 2147483648, patch: { auto_release: 'manual' } }));
    expect(code(e)).toBe('common.validation_failed'); expect(db.writes()).toHaveLength(0);
  });
  it('update before the first read still works (row created lazily, then patched)', async () => {
    const db = makeDb();
    const out = await svc().updateSettings(makeCtx(db), { expectedVersion: 1, patch: { print_critical_label: true } });
    expect(out).toMatchObject({ print_critical_label: true, version: 2 });
  });
  it('two concurrent updates with the same If-Match: exactly one wins, the other gets common.version_conflict', async () => {
    const db = makeDb({ settings: [{ ...SETTINGS_ROW, version: 1 }] }); const s = svc();
    const r = await Promise.allSettled([
      s.updateSettings(makeCtx(db), { expectedVersion: 1, patch: { auto_release: 'manual' } }),
      s.updateSettings(makeCtx(db), { expectedVersion: 1, patch: { narrative_report_mode: 'combined' } }),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost = r.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(code(lost.reason)).toBe('common.version_conflict');
    expect(db.store['settings']![0]!['version']).toBe(2);
  });
  it('never touches another tenant\'s settings row', async () => {
    const db = makeDb({ settings: [{ ...SETTINGS_ROW, version: 1 }, { ...SETTINGS_ROW, id: idN(0x5002), tenant_id: TENANT_B, version: 1 }] });
    await svc().updateSettings(makeCtx(db), { expectedVersion: 1, patch: { auto_release: 'manual' } });
    expect(db.store['settings']!.find((r) => r['tenant_id'] === TENANT_B)).toMatchObject({ auto_release: 'when_eligible', version: 1 });
  });

  const bad: Array<[string, Record<string, unknown>]> = [
    ['whatsapp_fallback_minutes below 5', { whatsapp_fallback_minutes: 4 }],
    ['whatsapp_fallback_minutes above 240', { whatsapp_fallback_minutes: 241 }],
    ['whatsapp_fallback_minutes not an integer', { whatsapp_fallback_minutes: 5.5 }],
    ['whatsapp_fallback_minutes as string', { whatsapp_fallback_minutes: '30' }],
    ['bulk_release_max 0', { bulk_release_max: 0 }],
    ['bulk_release_max 201', { bulk_release_max: 201 }],
    ['link_reissue_max_per_day 6', { link_reissue_max_per_day: 6 }],
    ['link_reissue_max_per_day -1', { link_reissue_max_per_day: -1 }],
    ['auto_release unknown value', { auto_release: 'always' }],
    ['narrative_report_mode unknown value', { narrative_report_mode: 'merged' }],
    ['patient_mobile_channel_order empty', { patient_mobile_channel_order: [] }],
    ['patient_mobile_channel_order contains email', { patient_mobile_channel_order: ['email'] }],
    ['patient_mobile_channel_order duplicates', { patient_mobile_channel_order: ['sms', 'sms'] }],
    ['referrer_channels unknown channel', { referrer_channels: ['fax'] }],
    ['referrer_channels duplicates', { referrer_channels: ['sms', 'sms'] }],
    ['portal_payment_gateways fonepay (BLOCKED B8)', { portal_payment_gateways: ['fonepay'] }],
    ['portal_payment_gateways duplicates', { portal_payment_gateways: ['esewa', 'esewa'] }],
    ['boolean as string', { patient_email_enabled: 'false' }],
    ['unknown key (REQ-SEC-080; AC-13.3 analogue)', { is_admin: true }],
    ['mass assignment: tenant_id', { tenant_id: TENANT_B }],
    ['mass assignment: version', { version: 99 }],
    ['mass assignment: id', { id: idN(0x1) }],
    ['null value', { auto_release: null }],
  ];
  it.each(bad)('rejects %s with common.validation_failed and performs no write', async (_n, patch) => {
    const db = makeDb({ settings: [SETTINGS_ROW] });
    const e = await rejection(svc().updateSettings(makeCtx(db), { expectedVersion: 1, patch }));
    expect(code(e)).toBe('common.validation_failed');
    expect(db.writes()).toHaveLength(0);
  });
  it('accepts the boundary values 5/240, 1/200, 0/5 and eSewa+Khalti', async () => {
    const db = makeDb({ settings: [SETTINGS_ROW] });
    const out = await svc().updateSettings(makeCtx(db), { expectedVersion: 1, patch: { whatsapp_fallback_minutes: 5, bulk_release_max: 1, link_reissue_max_per_day: 0, portal_payment_gateways: ['esewa', 'khalti'] } });
    expect(out).toMatchObject({ whatsapp_fallback_minutes: 5, bulk_release_max: 1, link_reissue_max_per_day: 0, portal_payment_gateways: ['esewa', 'khalti'] });
  });
});

describe('S3 listCentreContacts', () => {
  const rows = [
    { id: idN(0x6001), tenant_id: TENANT_A, centre_id: CENTRE_A1, channel: 'whatsapp', address: '+9779800000100', label: 'Desk 1' },
    { id: idN(0x6002), tenant_id: TENANT_A, centre_id: CENTRE_A2, channel: 'email', address: 'desk2@lab.example', label: 'Desk 2' },
    { id: idN(0x6003), tenant_id: TENANT_B, centre_id: CENTRE_B1, channel: 'sms', address: '+9779811111111', label: 'Other tenant' },
  ];
  it('returns only this tenant\'s contacts, masked, with exactly the CentreContact fields — the raw address never leaves', async () => {
    const db = makeDb({ centre_contacts: rows });
    const out = await svc().listCentreContacts(makeCtx(db), {});
    expect(out.data).toHaveLength(2);
    for (const c of out.data) expect(Object.keys(c).sort()).toEqual(keysOf('CentreContact'));
    const json = JSON.stringify(out);
    for (const raw of ['+9779800000100', 'desk2@lab.example', '9779800000100', '9811111111']) expect(json).not.toContain(raw);
    const wa = out.data.find((c: any) => c.channel === 'whatsapp');
    expect(wa.address_masked).toContain('*'); expect(wa.address_masked.endsWith('0100')).toBe(true);
    expect(out.data.find((c: any) => c.channel === 'email').address_masked).toContain('*');
  });
  it('centre_id filter is bound as a parameter and narrows the list', async () => {
    const db = makeDb({ centre_contacts: rows });
    const out = await svc().listCentreContacts(makeCtx(db), { centreId: CENTRE_A2 });
    expect(out.data.map((c: any) => c.id)).toEqual([idN(0x6002)]);
    expect(db.reporting().some((s) => s.values.includes(CENTRE_A2))).toBe(true);
    for (const st of db.reporting()) { expect(st.text).not.toContain(CENTRE_A2); expect(st.values).toContain(TENANT_A); }
  });
  it('filtering by a centre of another tenant returns an empty list, not their rows', async () => {
    const db = makeDb({ centre_contacts: rows });
    const out = await svc().listCentreContacts(makeCtx(db), { centreId: CENTRE_B1 });
    expect(out.data).toEqual([]);
  });
});

describe('S4 createCentreContact', () => {
  const ok = { centre_id: CENTRE_A1, channel: 'whatsapp', address: '+9779800000100', label: 'Synthetic desk' };
  it('creates an inactive-or-active contact for this tenant, returns the masked shape (201 body), version 1', async () => {
    const db = makeDb(); const out = await svc().createCentreContact(makeCtx(db), ok);
    expect(Object.keys(out).sort()).toEqual(keysOf('CentreContact'));
    expect(out).toMatchObject({ centre_id: CENTRE_A1, channel: 'whatsapp', label: 'Synthetic desk', version: 1 });
    expect(JSON.stringify(out)).not.toContain('+9779800000100');
    const row = db.store['centre_contacts']![0]!;
    expect(row).toMatchObject({ tenant_id: TENANT_A, centre_id: CENTRE_A1, address: '+9779800000100' });
    expect([row['created_by'], row['updated_by']].every((v) => v === USER || v === MEM)).toBe(true);
    expect(out.id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('accepts sms E.164 and a valid e-mail address', async () => {
    const db = makeDb(); const s = svc();
    await s.createCentreContact(makeCtx(db), { ...ok, channel: 'sms', address: '+14155550100' });
    await s.createCentreContact(makeCtx(db), { ...ok, channel: 'email', address: 'desk@lab.example' });
    expect(db.store['centre_contacts']).toHaveLength(2);
  });
  const bad: Array<[string, Record<string, unknown>]> = [
    ['whatsapp number without +', { address: '9779800000100' }],
    ['sms number with spaces', { channel: 'sms', address: '+977 9800000100' }],
    ['E.164 too short', { address: '+12345' }],
    ['E.164 leading zero country code', { address: '+0123456789' }],
    ['whatsapp address that is an e-mail', { address: 'a@b.example' }],
    ['email channel with a phone number', { channel: 'email', address: '+9779800000100' }],
    ['email without domain dot', { channel: 'email', address: 'a@b' }],
    ['email longer than 254', { channel: 'email', address: `${'a'.repeat(250)}@b.example` }],
    ['unknown channel', { channel: 'fax' }],
    ['label longer than 80', { label: 'x'.repeat(81) }],
    ['missing label', { label: undefined }],
    ['centre_id not a uuid', { centre_id: 'not-a-uuid' }],
    ['unknown key', { is_active: true }],
    ['SQL in address', { channel: 'email', address: "a'; DROP TABLE reporting.centre_contacts;--@x.example" }],
  ];
  it.each(bad)('rejects %s with common.validation_failed and writes nothing', async (_n, over) => {
    const db = makeDb();
    const e = await rejection(svc().createCentreContact(makeCtx(db), { ...ok, ...over }));
    expect(code(e)).toBe('common.validation_failed'); expect(db.writes()).toHaveLength(0);
  });
  it('a centre of another tenant is indistinguishable from a missing one (404, no cross-tenant link)', async () => {
    const db = makeDb();
    const e = await rejection(svc().createCentreContact(makeCtx(db), { ...ok, centre_id: CENTRE_B1 }));
    expect(isDbDenied(e)).toBe(true);
    expect(db.store['centre_contacts']).toHaveLength(0);
  });
  it('a centre outside the caller\'s centre scope (RLS WITH CHECK) is denied, not created', async () => {
    const db = makeDb({}, { deniedCentres: [CENTRE_A2] });
    const e = await rejection(svc().createCentreContact(makeCtx(db), { ...ok, centre_id: CENTRE_A2 }));
    expect(isDbDenied(e)).toBe(true); expect(db.store['centre_contacts']).toHaveLength(0);
  });
  it('the address is only ever bound as a parameter (SQL-injection canary) and never logged', async () => {
    const db = makeDb(); const logged: string[] = [];
    const ctx = makeCtx(db, { log: { info: (o: object) => logged.push(JSON.stringify(o)), warn: (o: object) => logged.push(JSON.stringify(o)), error: (o: object) => logged.push(JSON.stringify(o)) } });
    await svc().createCentreContact(ctx, { ...ok, channel: 'email', address: `${SENTINEL.toLowerCase()}@lab.example` });
    for (const st of db.reporting()) expect(st.text).not.toContain(SENTINEL.toLowerCase());
    expect(logged.join('')).not.toContain(SENTINEL.toLowerCase());
  });
});

describe('S5 updateCentreContact', () => {
  const row = { id: idN(0x6001), tenant_id: TENANT_A, centre_id: CENTRE_A1, channel: 'whatsapp', address: '+9779800000100', label: 'Desk 1', version: 2, is_active: true, created_by: USER, updated_by: USER };
  it('updates label / is_active, bumps version, keeps address and channel, returns masked shape', async () => {
    const db = makeDb({ centre_contacts: [row] });
    const out = await svc().updateCentreContact(makeCtx(db), { centreContactId: row.id, expectedVersion: 2, patch: { label: 'Desk 1b', is_active: false } });
    expect(out).toMatchObject({ id: row.id, label: 'Desk 1b', is_active: false, version: 3, channel: 'whatsapp' });
    expect(JSON.stringify(out)).not.toContain('+9779800000100');
    expect(db.store['centre_contacts']![0]).toMatchObject({ address: '+9779800000100', channel: 'whatsapp', centre_id: CENTRE_A1 });
  });
  it('stale If-Match -> common.version_conflict; missing -> common.precondition_required', async () => {
    const db = makeDb({ centre_contacts: [row] }); const s = svc();
    expect(code(await rejection(s.updateCentreContact(makeCtx(db), { centreContactId: row.id, expectedVersion: 1, patch: { label: 'x' } })))).toBe('common.version_conflict');
    expect(code(await rejection(s.updateCentreContact(makeCtx(db), { centreContactId: row.id, expectedVersion: undefined, patch: { label: 'x' } })))).toBe('common.precondition_required');
    expect(db.store['centre_contacts']![0]).toMatchObject({ label: 'Desk 1', version: 2 });
  });
  it('If-Match beyond int4 (2147483648) -> common.validation_failed, no write (not a 500)', async () => {
    const db = makeDb({ centre_contacts: [row] });
    const e = await rejection(svc().updateCentreContact(makeCtx(db), { centreContactId: row.id, expectedVersion: 2147483648, patch: { label: 'x' } }));
    expect(code(e)).toBe('common.validation_failed'); expect(db.writes()).toHaveLength(0);
  });
  it('BOLA: another tenant\'s contact id -> common.not_found, and it is not modified', async () => {
    const other = { ...row, id: idN(0x6009), tenant_id: TENANT_B, centre_id: CENTRE_B1, version: 1 };
    const db = makeDb({ centre_contacts: [row, other] });
    const e = await rejection(svc().updateCentreContact(makeCtx(db), { centreContactId: other.id, expectedVersion: 1, patch: { is_active: false } }));
    expect(code(e)).toBe('common.not_found');
    expect(db.store['centre_contacts']!.find((r) => r['id'] === other.id)).toMatchObject({ is_active: true, version: 1 });
  });
  it('unknown id -> common.not_found (not a version conflict)', async () => {
    const db = makeDb({ centre_contacts: [row] });
    expect(code(await rejection(svc().updateCentreContact(makeCtx(db), { centreContactId: idN(0x6fff), expectedVersion: 1, patch: { label: 'x' } })))).toBe('common.not_found');
  });
  it.each([
    ['address (immutable: create a new contact)', { address: '+9779800000999' }], ['channel', { channel: 'sms' }], ['centre_id', { centre_id: CENTRE_A2 }],
    ['tenant_id', { tenant_id: TENANT_B }], ['version', { version: 50 }], ['label > 80', { label: 'x'.repeat(81) }], ['is_active as string', { is_active: 'no' }],
  ])('rejects patch with %s (common.validation_failed), no write', async (_n, patch) => {
    const db = makeDb({ centre_contacts: [row] });
    expect(code(await rejection(svc().updateCentreContact(makeCtx(db), { centreContactId: row.id, expectedVersion: 2, patch })))).toBe('common.validation_failed');
    expect(db.writes()).toHaveLength(0);
  });
});

describe('S6 replaceStaffAssignments', () => {
  it('replaces both lists; nominated must hold lab.result.approve or reporting.narrative.sign; response == request order', async () => {
    const db = makeDb(); const core = makeCore();
    const out = await svc(core).replaceStaffAssignments(makeCtx(db), { nominated_signatories: [MEM_NARR, MEM_SIGNER], critical_alert_recipients: [MEM_CLERK] });
    expect(out).toEqual({ nominated_signatories: [MEM_NARR, MEM_SIGNER], critical_alert_recipients: [MEM_CLERK] });
    const rows = db.store['staff_assignments']!;
    expect(rows.filter((r) => r['assignment'] === 'nominated_signatory' && r['is_active']).map((r) => r['membership_id'])).toEqual([MEM_NARR, MEM_SIGNER]);
    expect(rows.every((r) => r['tenant_id'] === TENANT_A)).toBe(true);
    expect(rows.filter((r) => r['assignment'] === 'nominated_signatory').map((r) => r['sort_order'])).toEqual([0, 1]);
    expect(core.calls).toEqual(expect.arrayContaining([MEM_NARR, MEM_SIGNER]));
  });
  it('a nominated signatory without either permission -> common.validation_failed and NOTHING is written (atomic)', async () => {
    const db = makeDb();
    const e = await rejection(svc().replaceStaffAssignments(makeCtx(db), { nominated_signatories: [MEM_SIGNER, MEM_CLERK], critical_alert_recipients: [] }));
    expect(code(e)).toBe('common.validation_failed'); expect(db.writes()).toHaveLength(0);
  });
  it('a membership of another tenant / unknown membership cannot be nominated or alerted (no cross-tenant link)', async () => {
    const core = makeCore({ [MEM_B]: ['lab.result.approve'] });   // core.membershipPermissions is tenant-scoped, so a real call returns [] for B; here even a lying core must not leak via FK
    const db = makeDb();
    const e1 = await rejection(svc(core).replaceStaffAssignments(makeCtx(db), { nominated_signatories: [MEM_B], critical_alert_recipients: [] }));
    expect(code(e1) === 'common.validation_failed' || isDbDenied(e1)).toBe(true);
    const e2 = await rejection(svc().replaceStaffAssignments(makeCtx(db), { nominated_signatories: [], critical_alert_recipients: [MEM_B] }));
    expect(code(e2) === 'common.validation_failed' || isDbDenied(e2)).toBe(true);
    expect(db.store['staff_assignments']!.some((r) => r['membership_id'] === MEM_B)).toBe(false);
  });
  it('removed people are deactivated, never deleted (lims_app has no DELETE); people kept are untouched', async () => {
    const seed = [
      { id: idN(0x7101), tenant_id: TENANT_A, membership_id: MEM_SIGNER, assignment: 'nominated_signatory', sort_order: 0, created_by: USER, updated_by: USER },
      { id: idN(0x7102), tenant_id: TENANT_A, membership_id: MEM_NARR, assignment: 'nominated_signatory', sort_order: 1, created_by: USER, updated_by: USER },
    ];
    const db = makeDb({ staff_assignments: seed });
    const out = await svc().replaceStaffAssignments(makeCtx(db), { nominated_signatories: [MEM_SIGNER], critical_alert_recipients: [] });
    expect(out.nominated_signatories).toEqual([MEM_SIGNER]);
    expect(db.stmts.some((s) => s.verb === 'delete')).toBe(false);
    expect(db.store['staff_assignments']!.find((r) => r['membership_id'] === MEM_NARR)).toMatchObject({ is_active: false });
    expect(db.store['staff_assignments']!.find((r) => r['membership_id'] === MEM_SIGNER)).toMatchObject({ is_active: true });
  });
  it('re-adding a previously removed person re-activates the row (UNIQUE tenant+assignment+membership must not 500)', async () => {
    const seed = [{ id: idN(0x7101), tenant_id: TENANT_A, membership_id: MEM_SIGNER, assignment: 'nominated_signatory', sort_order: 0, is_active: false, created_by: USER, updated_by: USER }];
    const db = makeDb({ staff_assignments: seed });
    const out = await svc().replaceStaffAssignments(makeCtx(db), { nominated_signatories: [MEM_SIGNER], critical_alert_recipients: [] });
    expect(out.nominated_signatories).toEqual([MEM_SIGNER]);
    expect(db.store['staff_assignments']!.filter((r) => r['membership_id'] === MEM_SIGNER)).toHaveLength(1);
    expect(db.store['staff_assignments']![0]!['is_active']).toBe(true);
  });
  it('the same person may be signatory and alert recipient (different assignment)', async () => {
    const db = makeDb();
    const out = await svc().replaceStaffAssignments(makeCtx(db), { nominated_signatories: [MEM_SIGNER], critical_alert_recipients: [MEM_SIGNER] });
    expect(out).toEqual({ nominated_signatories: [MEM_SIGNER], critical_alert_recipients: [MEM_SIGNER] });
  });
  it('empty lists clear every assignment', async () => {
    const seed = [{ id: idN(0x7101), tenant_id: TENANT_A, membership_id: MEM_SIGNER, assignment: 'nominated_signatory', sort_order: 0, created_by: USER, updated_by: USER }];
    const db = makeDb({ staff_assignments: seed });
    expect(await svc().replaceStaffAssignments(makeCtx(db), { nominated_signatories: [], critical_alert_recipients: [] })).toEqual({ nominated_signatories: [], critical_alert_recipients: [] });
    expect(db.store['staff_assignments']!.every((r) => r['is_active'] === false)).toBe(true);
  });
  it('does not touch tenant B\'s assignments', async () => {
    const seed = [{ id: idN(0x7201), tenant_id: TENANT_B, membership_id: MEM_B, assignment: 'critical_alert_recipient', sort_order: 0, created_by: USER, updated_by: USER }];
    const db = makeDb({ staff_assignments: seed });
    await svc().replaceStaffAssignments(makeCtx(db), { nominated_signatories: [], critical_alert_recipients: [] });
    expect(db.store['staff_assignments']!.find((r) => r['tenant_id'] === TENANT_B)).toMatchObject({ is_active: true });
  });
  const bad: Array<[string, Record<string, unknown>]> = [
    ['more than 4 nominated', { nominated_signatories: [1, 2, 3, 4, 5].map((n) => idN(0x3200 + n)), critical_alert_recipients: [] }],
    ['more than 20 alert recipients', { nominated_signatories: [], critical_alert_recipients: Array.from({ length: 21 }, (_, i) => idN(0x3300 + i)) }],
    ['duplicate nominated ids', { nominated_signatories: [MEM_SIGNER, MEM_SIGNER], critical_alert_recipients: [] }],
    ['duplicate recipient ids', { nominated_signatories: [], critical_alert_recipients: [MEM_CLERK, MEM_CLERK] }],
    ['non-uuid id', { nominated_signatories: ['x'], critical_alert_recipients: [] }],
    ['missing critical_alert_recipients', { nominated_signatories: [] }],
    ['unknown key', { nominated_signatories: [], critical_alert_recipients: [], admins: [] }],
  ];
  it.each(bad)('rejects %s with common.validation_failed, no write', async (_n, body) => {
    const db = makeDb();
    expect(code(await rejection(svc().replaceStaffAssignments(makeCtx(db), body)))).toBe('common.validation_failed'); expect(db.writes()).toHaveLength(0);
  });
});

describe('S7 upsertReferrerPreference', () => {
  it('creates then updates the single row per referrer (upsert), returns {referrer_id, disabled_channels}', async () => {
    const db = makeDb(); const s = svc();
    expect(await s.upsertReferrerPreference(makeCtx(db), { referrerId: DOCTOR_A, disabledChannels: ['whatsapp'] })).toEqual({ referrer_id: DOCTOR_A, disabled_channels: ['whatsapp'] });
    expect(await s.upsertReferrerPreference(makeCtx(db), { referrerId: DOCTOR_A, disabledChannels: ['sms', 'email'] })).toEqual({ referrer_id: DOCTOR_A, disabled_channels: ['sms', 'email'] });
    expect(db.store['referrer_preferences']).toHaveLength(1);
    expect(db.store['referrer_preferences']![0]).toMatchObject({ tenant_id: TENANT_A, referrer_id: DOCTOR_A, version: 2 });
  });
  it('empty list resets (all channels enabled)', async () => {
    const db = makeDb(); const s = svc();
    await s.upsertReferrerPreference(makeCtx(db), { referrerId: DOCTOR_A, disabledChannels: ['sms'] });
    expect((await s.upsertReferrerPreference(makeCtx(db), { referrerId: DOCTOR_A, disabledChannels: [] })).disabled_channels).toEqual([]);
  });
  it('a referrer of another tenant -> not found (no preference row is created, no cross-tenant link)', async () => {
    const db = makeDb();
    const e = await rejection(svc().upsertReferrerPreference(makeCtx(db), { referrerId: DOCTOR_B, disabledChannels: ['sms'] }));
    expect(isDbDenied(e)).toBe(true); expect(db.store['referrer_preferences']).toHaveLength(0);
  });
  it('the upsert never overwrites tenant B\'s row for the same referrer id', async () => {
    const seed = [{ id: idN(0x8001), tenant_id: TENANT_B, referrer_id: DOCTOR_A, disabled_channels: ['email'], created_by: USER, updated_by: USER }];
    const db = makeDb({ referrer_preferences: seed, doctors: [{ id: DOCTOR_A, tenant_id: TENANT_A }, { id: DOCTOR_A, tenant_id: TENANT_B }] });
    await svc().upsertReferrerPreference(makeCtx(db), { referrerId: DOCTOR_A, disabledChannels: ['sms'] });
    expect(db.store['referrer_preferences']!.find((r) => r['tenant_id'] === TENANT_B)).toMatchObject({ disabled_channels: ['email'] });
  });
  it.each([
    ['unknown channel', { referrerId: DOCTOR_A, disabledChannels: ['fax'] }], ['duplicates', { referrerId: DOCTOR_A, disabledChannels: ['sms', 'sms'] }],
    ['more than 3', { referrerId: DOCTOR_A, disabledChannels: ['sms', 'email', 'whatsapp', 'sms'] }], ['referrer id not a uuid', { referrerId: 'x', disabledChannels: [] }],
    ['not an array', { referrerId: DOCTOR_A, disabledChannels: 'sms' }],
  ])('rejects %s with common.validation_failed, no write', async (_n, input) => {
    const db = makeDb();
    expect(code(await rejection(svc().upsertReferrerPreference(makeCtx(db), input)))).toBe('common.validation_failed'); expect(db.writes()).toHaveLength(0);
  });
});

describe('R17 listCodes — coded sets (02-CV §5.5: tenant rows shadow global rows by code)', () => {
  const g = (set: string, code2: string, so: number, extra: Record<string, unknown> = {}) => ({ set_name: set, code: code2, display: `G ${code2}`, sort_order: so, is_active: true, ...extra });
  const seed = {
    g_cs_reasons: [g('regeneration_reasons', 'other', 9), g('regeneration_reasons', 'demographic_correction', 1), g('regeneration_reasons', 'template_correction', 3), g('regeneration_reasons', 'retired_code', 2, { is_active: false }), g('token_revoke_reasons', 'issued_in_error', 1)],
    cs_reasons: [
      { id: idN(0x9001), tenant_id: TENANT_A, set_name: 'regeneration_reasons', code: 'template_correction', display: 'A override', sort_order: 3, is_active: true },
      { id: idN(0x9002), tenant_id: TENANT_A, set_name: 'regeneration_reasons', code: 'a_custom', display: 'A custom', sort_order: 5, is_active: true },
      { id: idN(0x9003), tenant_id: TENANT_B, set_name: 'regeneration_reasons', code: 'b_secret', display: 'B custom', sort_order: 4, is_active: true },
    ],
  };
  it('merges global + this tenant\'s rows, tenant shadows by code, sorted by sort_order, exact {code, display, sort_order} items', async () => {
    const out = await svc().listCodes(makeCtx(makeDb(seed)), { setName: 'regeneration_reasons' });
    expect(out.data.map((r: any) => r.code)).toEqual(['demographic_correction', 'template_correction', 'a_custom', 'other']);
    expect(out.data.find((r: any) => r.code === 'template_correction').display).toBe('A override');
    for (const r of out.data) expect(Object.keys(r).sort()).toEqual(['code', 'display', 'sort_order']);
  });
  it('never returns tenant B\'s custom codes, inactive codes, or other sets', async () => {
    const out = await svc().listCodes(makeCtx(makeDb(seed)), { setName: 'regeneration_reasons' });
    const codes = out.data.map((r: any) => r.code);
    expect(codes).not.toContain('b_secret'); expect(codes).not.toContain('retired_code'); expect(codes).not.toContain('issued_in_error');
  });
  it('tenant B sees its own custom code and not tenant A\'s', async () => {
    const out = await svc().listCodes(makeCtx(makeDb(seed), { tenantId: TENANT_B }), { setName: 'regeneration_reasons' });
    const codes = out.data.map((r: any) => r.code);
    expect(codes).toContain('b_secret'); expect(codes).not.toContain('a_custom');
  });
  it.each(['regeneration_reasons', 'token_revoke_reasons', 'outsourced_withdraw_reasons', 'narrative_amend_reasons'])('%s is accepted (empty set -> {data: []})', async (setName) => {
    const out = await svc().listCodes(makeCtx(makeDb({})), { setName });
    expect(out).toEqual({ data: [] });
  });
  it.each(['centre_correction', 'rejection_reasons', '', 'regeneration_reasons; DROP TABLE x', '../core', 'REGENERATION_REASONS'])('unknown set_name %j -> common.validation_failed, no SQL issued', async (setName) => {
    const db = makeDb(seed);
    expect(code(await rejection(svc().listCodes(makeCtx(db), { setName })))).toBe('common.validation_failed');
    expect(db.stmts).toHaveLength(0);
  });
  it('response is capped at 200 items', async () => {
    const many = Array.from({ length: 250 }, (_, i) => g('narrative_amend_reasons', `c${String(i).padStart(3, '0')}`, i));
    const out = await svc().listCodes(makeCtx(makeDb({ g_cs_reasons: many })), { setName: 'narrative_amend_reasons' });
    expect(out.data.length).toBeLessThanOrEqual(200);
  });
  it('every tenant-table read carries the explicit tenant predicate', async () => {
    const db = makeDb(seed); await svc().listCodes(makeCtx(db), { setName: 'regeneration_reasons' });
    for (const st of db.reporting().filter((s) => /(?<![g_\w])cs_reasons\b/.test(s.text))) { expect(st.text).toMatch(/tenant_id/i); expect(st.values).toContain(TENANT_A); }
  });
});

describe('cross-cutting: SQL hygiene of every statement the service issues (REQ-SEC-024/026)', () => {
  it('every statement binds values (no ids/strings concatenated), only touches reporting.* tables, never DELETEs', async () => {
    const db = makeDb({ settings: [SETTINGS_ROW] }); const s = svc(); const c = makeCtx(db);
    await s.getSettings(c);
    await s.updateSettings(c, { expectedVersion: 1, patch: { auto_release: 'manual' } });
    await s.createCentreContact(c, { centre_id: CENTRE_A1, channel: 'sms', address: '+9779800000100', label: 'd' });
    await s.replaceStaffAssignments(c, { nominated_signatories: [MEM_SIGNER], critical_alert_recipients: [MEM_CLERK] });
    await s.upsertReferrerPreference(c, { referrerId: DOCTOR_A, disabledChannels: ['sms'] });
    await s.listCodes(c, { setName: 'regeneration_reasons' });
    for (const st of db.stmts) {
      expect(st.verb).not.toBe('delete');
      for (const v of [TENANT_A, USER, MEM, CENTRE_A1, MEM_SIGNER, DOCTOR_A, '+9779800000100']) expect(st.text).not.toContain(v);
      const tables = [...st.text.matchAll(/\b(?:from|join|into|update)\s+([a-z_]+\.[a-z_]+)/gi)].map((m) => m[1]!.toLowerCase());
      for (const t of tables) expect(t.startsWith('reporting.')).toBe(true);
    }
  });
  it('a database failure surfaces as an error (no partial success body, no swallowed rejection)', async () => {
    const db = makeDb({}, { failOn: [{ match: /insert\s+into\s+reporting\.settings/i, error: () => pgError('08006', 'connection lost') }] });
    const e = await rejection(svc().getSettings(makeCtx(db)));
    expect(e).toBeInstanceOf(Error);
  });
  it('no PHI-ish value (address) appears in any error message', async () => {
    const db = makeDb(); const secretAddr = `${SENTINEL.toLowerCase()}@lab.example`;
    const e = await rejection(svc().createCentreContact(makeCtx(db), { centre_id: CENTRE_B1, channel: 'email', address: secretAddr, label: 'x' }));
    expect(String(e?.message)).not.toContain(secretAddr); expect(JSON.stringify(e?.errors ?? [])).not.toContain(secretAddr);
  });
});
