// T16 settings / flags / IRD tenant view (01-PRD US-C2, AC-C3.1-3, AC-C5.1, AC-C5.2, AC-C5.4; 02-TRD s5.6, s7.3; 03-APP-FLOW s6.1, s6.3, s2.5; 05-SCHEMA 4.6-4.8;
// 08 A13 P-6, P-15; 07-SECURITY D-T21). Service level over the in-memory repo seams of settings.helpers.ts; the cache tests use the REAL createIdentityPort
// (two instances, one shared store). Branding upload / content: branding.service.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bsToAd, fiscalYearBs } from '../../../../../../../packages/shared-ts/src/bsdate/index.js';
import { makeFakeRepo } from '../../ports/__tests__/helpers.js';
import { createIdentityPort } from '../../ports/IdentityPort.impl.js';
import { NOW, TENANT_A, TENANT_B, USER, idN, ird, makeCtx, makeRepos, rejection, settingsRow, IRD_A2, IRD_A3, IRD_A7, IRD_PLATFORM_A1, type Repos } from './settings.helpers.js';

const { createSettingsService } = await import('../settings.service.js');

let R: Repos; let invalidated: string[]; let svc: ReturnType<typeof createSettingsService>;
const make = (seed: Parameters<typeof makeRepos>[0] = {}) => {
  R = makeRepos(seed); invalidated = [];
  svc = createSettingsService({ repo: R.settingsRepo, flagsRepo: R.flagsRepo, port: { invalidateTenantSettings: (t: string) => { invalidated.push(t); R.order.push('invalidate'); } } } as any);
};
beforeEach(() => make());
const patch = async (p: Record<string, unknown>, o: { expectedVersion?: number | undefined; tenantId?: string } = {}) => {
  const { ctx } = await makeCtx(o.tenantId ? { tenantId: o.tenantId } : {});
  return svc.updateSettings(ctx, { expectedVersion: 'expectedVersion' in o ? o.expectedVersion : 4, patch: p } as any);
};
const noWrite = () => { expect(R.writes).toEqual([]); expect(invalidated).toEqual([]); };

describe('getSettings', () => {
  it('200 TenantSettingsDto of the context tenant, version from the row, no billing_live_on / tenant_id leaked; pending_numbering absent when nothing pending', async () => {
    const { ctx } = await makeCtx(); const r: any = await svc.getSettings(ctx, {} as any);
    expect(r.status).toBe(200); expect(r.version).toBe(4);
    expect(r.body).toMatchObject({ timezone: 'Asia/Kathmandu', idle_timeout_minutes: 15, display_name: 'Demo Lab', numbering_prefix: 'DL', version: 4 });
    expect(r.body.pending_numbering).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toMatch(/billing_live_on|tenant_id|pending_invoice_no_pattern/);
    expect(R.calls.filter((c) => c.m === 'findSettings').map((c) => [c.tenantId, c.tx])).toEqual([[TENANT_A, ctx.tx]]);
  });
  it('tenant B context sees B values only (REQ-SEC-024 explicit tenant bind)', async () => {
    const { ctx } = await makeCtx({ tenantId: TENANT_B }); const r: any = await svc.getSettings(ctx, {} as any);
    expect(r.body.display_name).toBe('Tenant B Lab'); expect(r.body.idle_timeout_minutes).toBe(20);
  });
  it('a pending invoice/credit-note pattern is shown as pending_numbering {invoice_no_pattern, credit_note_no_pattern, effective_fy_bs}', async () => {
    make({ settings: { [TENANT_A]: settingsRow({ pending_invoice_no_pattern: 'INV-{fyl}-{seq:7}', pending_credit_note_no_pattern: 'CN-{fyl}-{seq:7}', pending_effective_fy_bs: '2084/85' }) } });
    const { ctx } = await makeCtx(); const r: any = await svc.getSettings(ctx, {} as any);
    expect(r.body.pending_numbering).toEqual({ invoice_no_pattern: 'INV-{fyl}-{seq:7}', credit_note_no_pattern: 'CN-{fyl}-{seq:7}', effective_fy_bs: '2084/85' });
    expect(r.body.invoice_no_pattern).toBe('{fy}-{seq:6}');   // the current pattern stays in effect
  });
  it('no settings row -> 404 common.not_found, not a 500', async () => {
    make({ settings: { [TENANT_B]: settingsRow() } }); const { ctx } = await makeCtx();
    expect((await rejection(svc.getSettings(ctx, {} as any))).code).toBe('common.not_found');
  });
});

describe('US-C2 range tests - 422 identity.setting_out_of_range with the field pointer; nothing written, cache untouched', () => {
  const bad: Array<[string, unknown]> = [
    ['idle_timeout_minutes', 14], ['idle_timeout_minutes', 31], ['absolute_session_hours', 0], ['absolute_session_hours', 13], ['report_link_ttl_days', 29], ['report_link_ttl_days', 91],
    ['retention_clinical_years', 4], ['retention_audit_years', 4], ['retention_raw_instrument_years', 0], ['password_min_length', 11], ['password_min_length', 65],
    ['retention_clinical_years', 51], ['idle_timeout_minutes', 20.5], ['idle_timeout_minutes', '20'],
  ];
  it.each(bad)('%s = %j', async (field, value) => {
    const e = await rejection(patch({ [field]: value }));
    expect(e.code).toBe('identity.setting_out_of_range'); expect(e.statusCode).toBe(422);
    expect(e.errors?.map((x: any) => x.path)).toEqual([`/${field}`]); noWrite();
  });
  it('several offenders -> one pointer each, still nothing written', async () => {
    const e = await rejection(patch({ idle_timeout_minutes: 99, report_link_ttl_days: 1, display_name: 'ok' }));
    expect(e.code).toBe('identity.setting_out_of_range'); expect(e.errors.map((x: any) => x.path).sort()).toEqual(['/idle_timeout_minutes', '/report_link_ttl_days']); noWrite();
  });
  it.each([['idle_timeout_minutes', 15], ['idle_timeout_minutes', 30], ['absolute_session_hours', 1], ['absolute_session_hours', 12], ['report_link_ttl_days', 30], ['report_link_ttl_days', 90],
    ['retention_clinical_years', 5], ['retention_audit_years', 50], ['retention_raw_instrument_years', 1], ['password_min_length', 12], ['password_min_length', 64]])(
    'boundary %s = %j is accepted', async (field, value) => {
      const r: any = await patch({ [field]: value }); expect(r.status).toBe(200); expect(r.body[field]).toBe(value);
    });
  it('format failures are 400 common.validation_failed at the field pointer (not 422)', async () => {
    const e = await rejection(patch({ accent_color: 'blue', website: 'http://x.example' }));
    expect(e.code).toBe('common.validation_failed'); expect(e.errors.map((x: any) => x.path).sort()).toEqual(['/accent_color', '/website']);
    expect(e.errors.every((x: any) => x.code === 'common.field_invalid')).toBe(true); noWrite();
  });
});

describe('P-15 / D-T21 timezone only Asia/Kathmandu', () => {
  it.each(['Asia/Kolkata', 'UTC', 'asia/kathmandu', 'Asia/Katmandu', ' Asia/Kathmandu', ''])('timezone %j -> 422 at /timezone, nothing written', async (tz) => {
    const e = await rejection(patch({ timezone: tz }));
    expect(e.code).toBe('identity.setting_out_of_range'); expect(e.errors.map((x: any) => x.path)).toEqual(['/timezone']); noWrite();
  });
  it('Asia/Kathmandu is accepted (idempotent write)', async () => { expect((await patch({ timezone: 'Asia/Kathmandu' }) as any).status).toBe(200); });
});

describe('AC-C3.1 / AC-C3.2 numbering patterns (C2 applies the C4 grammar)', () => {
  it('invoice pattern without {fy}/{fyl} -> 400 common.validation_failed at /invoice_no_pattern; nothing written', async () => {
    const e = await rejection(patch({ invoice_no_pattern: 'INV-{seq:6}' }));
    expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400); expect(e.errors.map((x: any) => x.path)).toEqual(['/invoice_no_pattern']); noWrite();
  });
  it.each(['credit_note_no_pattern', 'receipt_no_pattern'])('%s without a fiscal-year token -> 400 at its pointer', async (f) => {
    const e = await rejection(patch({ [f]: 'X-{seq:6}' })); expect(e.code).toBe('common.validation_failed'); expect(e.errors.map((x: any) => x.path)).toEqual([`/${f}`]);
  });
  it('registration pattern without {branch} -> 400 at /registration_no_pattern', async () => {
    const e = await rejection(patch({ registration_no_pattern: '{prefix}{seq:6}' }));
    expect(e.code).toBe('common.validation_failed'); expect(e.errors.map((x: any) => x.path)).toEqual(['/registration_no_pattern']); noWrite();
  });
  it('pattern grammar errors (two {seq}, unknown token, lowercase literal, too long barcode) -> 400 at the pointer', async () => {
    for (const [f, v] of [['patient_code_pattern', '{seq:4}{seq:4}'], ['patient_code_pattern', '{nope}{seq:4}'], ['invoice_no_pattern', 'inv-{fy}-{seq:6}'], ['barcode_pattern', '{prefix}{yy}{seq:12}ABCDEFGH']] as const) {
      const e = await rejection(patch({ [f]: v })); expect(e.code).toBe('common.validation_failed'); expect(e.errors.map((x: any) => x.path)).toEqual([`/${f}`]);
    }
    noWrite();
  });
  it('valid patterns are stored as sent when billing is not live', async () => {
    const r: any = await patch({ invoice_no_pattern: 'INV-{fyl}-{seq:7}', registration_no_pattern: '{branch}{seq:6}' });
    expect(r.status).toBe(200); expect(r.body.invoice_no_pattern).toBe('INV-{fyl}-{seq:7}'); expect(r.body.pending_numbering).toBeUndefined();
    expect(R.settingsOf(TENANT_A)['pending_invoice_no_pattern']).toBeNull();
  });
});

describe('AC-C3.3 pending numbering when billing_live_on is set (08 A13 P-6)', () => {
  const NEXT_FY = '2084/85';
  beforeEach(() => make({ settings: { [TENANT_A]: settingsRow({ billing_live_on: '2026-07-20' }) } }));
  it('test clock sanity (bsdate): 2026-11-08 is in fiscal year 2083/84, so the next Shrawan 1 starts 2084/85', () => {
    expect(fiscalYearBs(NOW.slice(0, 10) as any).long).toBe('2083/84');
  });
  it('invoice pattern change is stored as pending_* with pending_effective_fy_bs = next FY; the current pattern stays; response shows pending_numbering', async () => {
    const r: any = await patch({ invoice_no_pattern: 'INV-{fyl}-{seq:7}' });
    expect(r.status).toBe(200);
    const row = R.settingsOf(TENANT_A);
    expect(row['invoice_no_pattern']).toBe('{fy}-{seq:6}'); expect(row['pending_invoice_no_pattern']).toBe('INV-{fyl}-{seq:7}'); expect(row['pending_effective_fy_bs']).toBe(NEXT_FY);
    expect(r.body.invoice_no_pattern).toBe('{fy}-{seq:6}');
    expect(r.body.pending_numbering).toMatchObject({ invoice_no_pattern: 'INV-{fyl}-{seq:7}', effective_fy_bs: NEXT_FY });
    const sent = R.calls.find((c) => c.m === 'updateSettings')!.args[1] as Row2; expect(Object.keys(sent)).not.toContain('invoice_no_pattern');
  });
  it('credit-note change is pending too; both patterns share one effective FY', async () => {
    const r: any = await patch({ invoice_no_pattern: 'INV-{fyl}-{seq:7}', credit_note_no_pattern: 'CN-{fyl}-{seq:7}' });
    expect(r.body.pending_numbering).toEqual({ invoice_no_pattern: 'INV-{fyl}-{seq:7}', credit_note_no_pattern: 'CN-{fyl}-{seq:7}', effective_fy_bs: NEXT_FY });
    expect(R.settingsOf(TENANT_A)['credit_note_no_pattern']).toBe('CN-{fy}-{seq:6}');
  });
  it('a pending pattern is still validated (AC-C3.1) - no {fy} -> 400, nothing pending written', async () => {
    const e = await rejection(patch({ invoice_no_pattern: 'INV-{seq:6}' })); expect(e.code).toBe('common.validation_failed'); noWrite();
  });
  it('only invoice + credit-note are deferred: receipt / registration / patient-code changes apply at once', async () => {
    const r: any = await patch({ receipt_no_pattern: 'R-{fy}-{seq:6}', patient_code_pattern: 'P{seq:7}' });
    expect(r.body.receipt_no_pattern).toBe('R-{fy}-{seq:6}'); expect(r.body.patient_code_pattern).toBe('P{seq:7}'); expect(r.body.pending_numbering).toBeUndefined();
  });
  it('re-sending the CURRENT pattern is not a change -> nothing becomes pending', async () => {
    const r: any = await patch({ invoice_no_pattern: '{fy}-{seq:6}', display_name: 'Renamed Lab' });
    expect(r.body.pending_numbering).toBeUndefined(); expect(R.settingsOf(TENANT_A)['pending_effective_fy_bs']).toBeNull();
  });
  it('boundaries: first and last day of 2083/84 -> effective 2084/85; on Shrawan 1 2084 (2084/85 current) -> 2085/86', async () => {
    const cur = fiscalYearBs(NOW.slice(0, 10) as any);
    for (const [day, want] of [[cur.startsOn, '2084/85'], [cur.endsOn, '2084/85'], [bsToAd({ year: 2084, month: 4, day: 1 }), '2085/86']] as const) {
      make({ settings: { [TENANT_A]: settingsRow({ billing_live_on: '2026-07-20' }) } });
      const { ctx } = await makeCtx(); ctx.now = () => `${day}T06:00:00.000Z`;
      const r: any = await svc.updateSettings(ctx, { expectedVersion: 4, patch: { invoice_no_pattern: 'INV-{fyl}-{seq:7}' } } as any);
      expect(r.body.pending_numbering.effective_fy_bs).toBe(want);
    }
  });
});
type Row2 = Record<string, unknown>;

describe('updateSettings - concurrency, mass assignment, platform-only fields, audit', () => {
  it('missing If-Match -> 428; non-integer / 0 / negative -> 400; stale -> 409 common.version_conflict; none writes', async () => {
    expect((await rejection(patch({ display_name: 'X' }, { expectedVersion: undefined }))).code).toBe('common.precondition_required');
    for (const v of [0, -1, 1.5, NaN]) expect((await rejection(patch({ display_name: 'X' }, { expectedVersion: v as number }))).code).toBe('common.validation_failed');
    const e = await rejection(patch({ display_name: 'X' }, { expectedVersion: 3 })); expect(e.code).toBe('common.version_conflict'); expect(e.statusCode).toBe(409);
    expect(R.settingsOf(TENANT_A)['display_name']).toBe('Demo Lab'); expect(invalidated).toEqual([]);
  });
  it('success: row updated, version +1, body is the new DTO, process cache invalidated for THIS tenant only AFTER the write', async () => {
    const r: any = await patch({ idle_timeout_minutes: 20 });
    expect(r.status).toBe(200); expect(r.version).toBe(5); expect(r.body.idle_timeout_minutes).toBe(20); expect(r.body.version).toBe(5);
    expect(invalidated).toEqual([TENANT_A]); expect(R.order.indexOf('invalidate')).toBeGreaterThan(R.order.indexOf('updateSettings'));
    expect(R.settingsOf(TENANT_B)['idle_timeout_minutes']).toBe(20); expect(R.settingsOf(TENANT_B)['version']).toBe(4);
  });
  it('unset[] NULLs the listed optional columns; unset of a required column is refused', async () => {
    make({ settings: { [TENANT_A]: settingsRow({ website: 'https://demo.example', accent_color: '#112233' }) } });
    const r: any = await patch({ unset: ['website', 'accent_color'] }); expect(r.body.website).toBeUndefined(); expect(r.body.accent_color).toBeUndefined();
    expect(R.settingsOf(TENANT_A)['website']).toBeNull();
    for (const col of ['display_name', 'timezone', 'version', 'tenant_id']) expect((await rejection(patch({ unset: [col] }))).code).toBe('common.validation_failed');
  });
  it('a field both set and unset in one patch is refused (400)', async () => {
    expect((await rejection(patch({ website: 'https://a.example', unset: ['website'] }))).code).toBe('common.validation_failed');
  });
  it.each(['ird_pan', 'ird_annex_1_record_id'])('platform-only field %s from a tenant admin -> 403 auth.forbidden, nothing written', async (f) => {
    const e = await rejection(patch({ [f]: f === 'ird_pan' ? '123456789' : idN(0x701) })); expect(e.code).toBe('auth.forbidden'); noWrite();
  });
  it('platform-only column in unset[] -> 403 auth.forbidden', async () => {
    expect((await rejection(patch({ unset: ['ird_pan'] }))).code).toBe('auth.forbidden');
  });
  it('mass assignment: tenant_id, version, pending_*, system columns, legal_name_snapshot, unknown keys never reach the repo', async () => {
    const e = await patch({ idle_timeout_minutes: 20, tenant_id: TENANT_B, version: 99, pending_invoice_no_pattern: 'X-{fy}-{seq:3}', pending_effective_fy_bs: '2090/91', legal_name_snapshot: 'Evil', updated_by: idN(1), is_admin: true } as any).then(() => undefined, (x) => x);
    if (e) { expect(['common.validation_failed', 'auth.forbidden']).toContain(e.code); expect(R.writes).toEqual([]); return; }
    const call = R.calls.find((c) => c.m === 'updateSettings')!; const set = call.args[1] as Row2;
    expect(call.tenantId).toBe(TENANT_A); expect(Object.keys(set)).toEqual(['idle_timeout_minutes']);
    expect(R.settingsOf(TENANT_A)['legal_name_snapshot']).toBe('Demo Lab Pvt. Ltd.'); expect(R.settingsOf(TENANT_B)['display_name']).toBe('Tenant B Lab');
  });
  it('writes only the context tenant (repo called with ctx tenant + ctx.tx), actor id from ctx, never from the patch', async () => {
    const { ctx } = await makeCtx({ tenantId: TENANT_B });
    await svc.updateSettings(ctx, { expectedVersion: 4, patch: { idle_timeout_minutes: 25 } } as any);
    const call = R.calls.find((c) => c.m === 'updateSettings')!; expect(call.tenantId).toBe(TENANT_B); expect(call.tx).toBe(ctx.tx); expect(call.args[3]).toBe(USER);
    expect(R.settingsOf(TENANT_A)['idle_timeout_minutes']).toBe(15); expect(invalidated).toEqual([TENANT_B]);
  });
  it('access-log settings.change / tenant_settings with the changed KEYS only, never values (03-APP-FLOW 6.1 step 4)', async () => {
    const { ctx, access } = await makeCtx();
    await svc.updateSettings(ctx, { expectedVersion: 4, patch: { idle_timeout_minutes: 22, display_name: 'Value-Sentinel-Lab', unset: ['website'] } } as any);
    expect(access).toHaveLength(1); expect(access[0]).toMatchObject({ action: 'settings.change', entityType: 'tenant_settings', outcome: 'allowed' });
    expect(JSON.stringify(access[0])).not.toContain('Value-Sentinel-Lab'); expect(JSON.stringify(access[0])).not.toContain('22');
    expect(JSON.stringify(access[0].detail)).toMatch(/idle_timeout_minutes/); expect(JSON.stringify(access[0].detail)).toMatch(/display_name/);
  });
  it('a rejected update writes no settings.change access-log row', async () => {
    const { ctx, access } = await makeCtx(); await rejection(svc.updateSettings(ctx, { expectedVersion: 4, patch: { idle_timeout_minutes: 99 } } as any)); expect(access).toEqual([]);
  });
  it('a repo failure propagates and the cache is NOT invalidated', async () => {
    R.fail['updateSettings'] = new Error('db down'); await rejection(patch({ display_name: 'X' })); expect(invalidated).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------- cache: two real IdentityPort instances over one store
describe('cache invalidation + TTL with two port instances over the same DB (02-TRD 7.3, C2-3, US-C2 "within 30 s on every instance")', () => {
  type Store = { idle: number; ttl: number; referral: boolean };
  function twoPorts(store: Store) {
    const clock = { t: 1_000_000 };
    const fake = makeFakeRepo();
    const camel = () => ({
      calendarDisplay: 'AD', timezone: 'Asia/Kathmandu', idleTimeoutMinutes: store.idle, absoluteSessionHours: 12, reportLinkTtlDays: store.ttl, releaseRequiresPayment: false,
      partialReleaseAllowed: false, letterheadDefault: 'with', numbering: {}, channels: {}, branding: {}, retentionYears: 5, retention: {}, featureFlags: { referral_incentive_report: store.referral },
      referralIncentiveReportEnabled: store.referral, autoVerificationEnabled: false, westgardMode: 'classic', ird: { cbmsRealtimeRequired: false, annexReadiness: 'incomplete' },
    });
    let loads = 0;
    const repo = { ...fake.repo, async tenantSettings() { loads += 1; return camel(); } } as any;
    const mk = () => createIdentityPort({ repo, systemActorPermissions: () => [], nowMs: () => clock.t, settingsTtlMs: 30_000 } as any);
    return { a: mk(), b: mk(), clock, loads: () => loads };
  }
  const read = (p: any, keys: string[]) => p.getTenantSettings({ tenantId: TENANT_A, actor: { type: 'user', id: USER }, requestId: idN(0xe2), tx: {}, now: () => NOW, ports: {} }, { keys });

  it('US-C2: a write through instance A is visible on A at once (same-process invalidation) and on B within the 30 s TTL - not necessarily before', async () => {
    const store: Store = { idle: 15, ttl: 30, referral: false }; const P = twoPorts(store);
    make(); svc = createSettingsService({ repo: R.settingsRepo, flagsRepo: R.flagsRepo, port: P.a } as any);
    expect((await read(P.a, ['idleTimeoutMinutes'])).idleTimeoutMinutes).toBe(15); expect((await read(P.b, ['idleTimeoutMinutes'])).idleTimeoutMinutes).toBe(15);
    const { ctx } = await makeCtx();
    const r: any = await svc.updateSettings(ctx, { expectedVersion: 4, patch: { idle_timeout_minutes: 25 } } as any); expect(r.status).toBe(200);
    store.idle = 25;   // "commit": the shared DB now holds the new value
    expect((await read(P.a, ['idleTimeoutMinutes'])).idleTimeoutMinutes).toBe(25);                 // invalidated by the service
    expect((await read(P.b, ['idleTimeoutMinutes'])).idleTimeoutMinutes).toBe(15);                 // B serves its cached copy ...
    P.clock.t += 29_999; expect((await read(P.b, ['idleTimeoutMinutes'])).idleTimeoutMinutes).toBe(15);   // ... until the TTL elapses
    P.clock.t += 2; expect((await read(P.b, ['idleTimeoutMinutes'])).idleTimeoutMinutes).toBe(25);        // <= 30 s everywhere
  });
  it('AC-C5.4 B13 flag toggled by the tenant admin: getTenantSettings([referralIncentiveReportEnabled]) reflects it (A at once, B within TTL)', async () => {
    const store: Store = { idle: 15, ttl: 30, referral: false }; const P = twoPorts(store);
    make(); svc = createSettingsService({ repo: R.settingsRepo, flagsRepo: R.flagsRepo, port: P.a } as any);
    expect((await read(P.a, ['referralIncentiveReportEnabled'])).referralIncentiveReportEnabled).toBe(false); await read(P.b, ['referralIncentiveReportEnabled']);
    const { ctx } = await makeCtx();
    const r: any = await svc.setTenantFeatureFlag(ctx, { flagCode: 'referral_incentive_report', isEnabled: true, expectedVersion: 1 } as any); expect(r.status).toBe(200);
    store.referral = true;
    expect((await read(P.a, ['referralIncentiveReportEnabled'])).referralIncentiveReportEnabled).toBe(true);
    expect((await read(P.b, ['referralIncentiveReportEnabled'])).referralIncentiveReportEnabled).toBe(false);
    P.clock.t += 30_001; expect((await read(P.b, ['referralIncentiveReportEnabled'])).referralIncentiveReportEnabled).toBe(true);
  });
  it('every settings-visible write invalidates the tenant: updateSettings, setTenantFeatureFlag (not a read, not a rejected write)', async () => {
    const { ctx } = await makeCtx();
    await svc.getSettings(ctx, {} as any); await svc.listFeatureFlags(ctx, {} as any); await svc.listOwnIrdAnnexes(ctx, {} as any); expect(invalidated).toEqual([]);
    await svc.setTenantFeatureFlag(ctx, { flagCode: 'smart_report', isEnabled: true, expectedVersion: 1 } as any); expect(invalidated).toEqual([TENANT_A]);
    await rejection(svc.setTenantFeatureFlag(ctx, { flagCode: 'smart_report', isEnabled: false, expectedVersion: 1 } as any)); expect(invalidated).toEqual([TENANT_A]);
  });
});

// ---------------------------------------------------------------------------------------------------- feature flags
describe('listFeatureFlags (AC-C5.1)', () => {
  it('new tenant: every registry flag (incl. B11 x3, B13 referral_incentive_report) is off; shape = FeatureFlag; no approval_ref value', async () => {
    const { ctx } = await makeCtx(); const r: any = await svc.listFeatureFlags(ctx, {} as any);
    expect(r.status).toBe(200); expect(r.body.data.map((f: any) => f.code).sort()).toEqual(['breached_password_online_check', 'referral_incentive_report', 'smart_report', 'smart_report_llm', 'whatsapp_pdf_attachment']);
    for (const f of r.body.data) { expect(f.is_enabled).toBe(false); expect(f.approval_ref_present).toBe(false); expect(Object.keys(f).sort()).not.toContain('approval_ref'); expect(Object.keys(f)).not.toContain('requires_founder_approval'); }
    expect(r.body.data.find((f: any) => f.code === 'referral_incentive_report')).toMatchObject({ scope: 'tenant', settable_by: 'tenant', blocker_ref: 'B13' });
    expect(r.body.data.find((f: any) => f.code === 'whatsapp_pdf_attachment')).toMatchObject({ settable_by: 'platform', blocker_ref: 'B11' });
    expect(R.calls.filter((c) => c.m === 'listFlags').map((c) => c.tenantId)).toEqual([TENANT_A]);
  });
  it('shows only the context tenant\'s state', async () => {
    make({ flags: { [TENANT_B]: [{ code: 'referral_incentive_report', is_enabled: true }] } });
    const { ctx } = await makeCtx(); const r: any = await svc.listFeatureFlags(ctx, {} as any);
    expect(r.body.data.find((f: any) => f.code === 'referral_incentive_report').is_enabled).toBe(false);
  });
});

describe('setTenantFeatureFlag (AC-C5.2, AC-C5.4, 03-APP-FLOW 6.3)', () => {
  const put = async (code: string, enabled: boolean, v: number | undefined = 1, tenantId?: string) => {
    const { ctx, access } = await makeCtx(tenantId ? { tenantId } : {});
    return { access, p: svc.setTenantFeatureFlag(ctx, { flagCode: code, isEnabled: enabled, expectedVersion: v } as any) };
  };
  it('AC-C5.4 tenant-settable B13 flag on -> 200 FeatureFlag, version+1, ETag source; and back off', async () => {
    const { p } = await put('referral_incentive_report', true); const r: any = await p;
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ code: 'referral_incentive_report', is_enabled: true, settable_by: 'tenant', version: 2 }); expect(r.version).toBe(2);
    const { p: p2 } = await put('referral_incentive_report', false, 2); expect(((await p2) as any).body.is_enabled).toBe(false);
  });
  it.each(['whatsapp_pdf_attachment', 'smart_report_llm', 'breached_password_online_check'])('AC-C5.2 B11 / platform-only flag %s -> 403 auth.forbidden; row untouched', async (code) => {
    const { p } = await put(code, true); const e = await rejection(p);
    expect(e.code).toBe('auth.forbidden'); expect(e.statusCode).toBe(403); expect(R.writes).toEqual([]); expect(invalidated).toEqual([]);
  });
  it('disabling a platform-only flag is forbidden as well (tenant cannot touch it in either direction)', async () => {
    make({ flags: { [TENANT_A]: [{ code: 'whatsapp_pdf_attachment', is_enabled: true }] } });
    expect((await rejection((await put('whatsapp_pdf_attachment', false)).p)).code).toBe('auth.forbidden'); expect(R.writes).toEqual([]);
  });
  it('unknown / malformed flag code -> 404 common.not_found (same answer for both, no registry probing)', async () => {
    for (const c of ['no_such_flag', 'X', "x'; drop table", 'a'.repeat(80)]) expect((await rejection((await put(c, true)).p)).code).toBe('common.not_found');
    expect(R.writes).toEqual([]);
  });
  it('If-Match: missing -> 428, invalid -> 400, stale -> 409 common.version_conflict', async () => {
    const { ctx } = await makeCtx();   // direct call: put()'s default param would turn undefined into 1
    expect((await rejection(svc.setTenantFeatureFlag(ctx, { flagCode: 'smart_report', isEnabled: true, expectedVersion: undefined } as any))).code).toBe('common.precondition_required');
    expect(R.writes).toEqual([]); expect(invalidated).toEqual([]);
    expect((await rejection((await put('smart_report', true, 0)).p)).code).toBe('common.validation_failed');
    expect((await rejection((await put('smart_report', true, 7)).p)).code).toBe('common.version_conflict'); expect(R.writes).toEqual([]);
  });
  it('non-boolean is_enabled -> 400', async () => {
    const { ctx } = await makeCtx(); for (const v of ['true', 1, null, undefined]) expect((await rejection(svc.setTenantFeatureFlag(ctx, { flagCode: 'smart_report', isEnabled: v, expectedVersion: 1 } as any))).code).toBe('common.validation_failed');
  });
  it('only the context tenant\'s row is written (repo gets ctx tenant + ctx.tx); tenant B untouched', async () => {
    await (await put('smart_report', true)).p;
    const c = R.calls.find((x) => x.m === 'updateFlag')!; expect(c.tenantId).toBe(TENANT_A);
    expect(R.st.flags.get(TENANT_B)!.find((f) => f.code === 'smart_report')!.is_enabled).toBe(false);
  });
  it('access-log feature_flag.change / feature_flag with the flag code, no approval/other values', async () => {
    const { access, p } = await put('smart_report', true); await p;
    expect(access).toHaveLength(1); expect(access[0]).toMatchObject({ action: 'feature_flag.change', entityType: 'feature_flag', outcome: 'allowed' });
  });
});

// ---------------------------------------------------------------------------------------------------- IRD tenant view
describe('listOwnIrdAnnexes (02-TRD 5.6; 03-APP-FLOW 2.5; 05-SCHEMA D-216)', () => {
  const own = [ird({ id: IRD_A2, annex_code: 'annex_2' }), ird({ id: IRD_A3, annex_code: 'annex_3', office_name: 'Synthetic Office' }), ird({ id: IRD_A7, annex_code: 'annex_7', counterparty_name: 'Synthetic DC' })];
  const a1 = ird({ id: IRD_PLATFORM_A1, annex_code: 'annex_1', tenant_id: null, software_version: '1.0.0' });
  const list = async (rows: Row2[], tenantId?: string, leaky = false) => {
    make({ settings: { [TENANT_A]: settingsRow({ ird_annex_1_record_id: IRD_PLATFORM_A1 }), [TENANT_B]: settingsRow() }, ird: rows as any }); R.st.leaky = leaky;
    const { ctx } = await makeCtx(tenantId ? { tenantId } : {}); return svc.listOwnIrdAnnexes(ctx, {} as any) as Promise<any>;
  };
  it('lists own records + the referenced platform annex_1 row; IrdAnnexRecord shape; readiness complete when annex_2/3/7 + annex_1 are completed', async () => {
    const r = await list([...own, a1]); expect(r.status).toBe(200);
    expect(r.body.data.map((x: any) => x.annex_code).sort()).toEqual(['annex_1', 'annex_2', 'annex_3', 'annex_7']); expect(r.body.annex_readiness).toBe('complete');
    expect(r.body.data.find((x: any) => x.annex_code === 'annex_1').tenant_id).toBeUndefined();
    expect(r.body.data.find((x: any) => x.annex_code === 'annex_3')).toMatchObject({ record_id: IRD_A3, status: 'completed', office_name: 'Synthetic Office', version: 1 });
    expect(r.body.data.every((x: any) => !('is_active' in x) && !('created_by' in x))).toBe(true);
  });
  it.each([
    ['annex_7 missing', [own[0]!, own[1]!, a1]], ['annex_7 only in preparation', [own[0]!, own[1]!, ird({ id: IRD_A7, annex_code: 'annex_7', status: 'in_preparation' }), a1]],
    ['platform annex_1 not completed', [...own, ird({ ...a1, status: 'in_preparation' })]], ['no platform annex_1 visible', [...own]],
    ['annex_2 rejected', [ird({ id: IRD_A2, annex_code: 'annex_2', status: 'rejected' }), own[1]!, own[2]!, a1]],
  ])('readiness incomplete: %s', async (_n, rows) => { expect((await list(rows as Row2[])).body.annex_readiness).toBe('incomplete'); });
  it('a superseded record does not count; the current completed one does', async () => {
    const r = await list([ird({ id: idN(0x7f1), annex_code: 'annex_2', status: 'superseded' }), ...own, a1]); expect(r.body.annex_readiness).toBe('complete');
    const r2 = await list([ird({ id: idN(0x7f1), annex_code: 'annex_2', status: 'superseded' }), own[1]!, own[2]!, a1]); expect(r2.body.annex_readiness).toBe('incomplete');
  });
  it('other tenant\'s records and unreferenced platform rows never appear (cross-tenant probe + defense in depth against a leaky repo)', async () => {
    const leaky = [...own, a1, ird({ id: idN(0x7b1), tenant_id: TENANT_B, annex_code: 'annex_2', notes: 'B-SENTINEL' }), ird({ id: idN(0x7b2), tenant_id: null, annex_code: 'annex_1', notes: 'OTHER-PLATFORM-SENTINEL' })];
    const r = await list(leaky, undefined, true); const text = JSON.stringify(r.body);
    expect(text).not.toContain('B-SENTINEL'); expect(text).not.toContain('OTHER-PLATFORM-SENTINEL'); expect(r.body.data).toHaveLength(4);
  });
  it('reads with the context tenant + ctx.tx; empty tenant -> 200 {data: [], annex_readiness: incomplete}', async () => {
    const r = await list([a1], TENANT_B); expect(r.body.data).toEqual([]); expect(r.body.annex_readiness).toBe('incomplete');
    expect(R.calls.find((c) => c.m === 'listIrdAnnexes')!.tenantId).toBe(TENANT_B);
  });
});
