// HC-T11 A2/A4 + tenant settings: SnapshotConfig (§5.3.1: all keys required inside `config`), D-IDENT second identifier (CR-C17-003: birth_on only when second_identifier = birth_date), settings.version in the cursor,
// US-06-6 `426 homecollection.app_version_unsupported` on every app endpoint (CR-C17-007). These cases MUTATE tenant settings, so they run in tenant B (tenant A's parallel files keep their defaults).
// Fails now: A2 / A4 are HC-T01 stubs (501).
import { beforeAll, describe, expect, it } from 'vitest';
import { HC_CENTRE, MEMBER, PHLEBO_B, T, TENANT_B, ack, ackBody, ackFails, birthOf, cursorOf, deviceRow, hc, hdr, mkRoute, nextDay, noonOf, ownerRows, pull, pullFails, schemaErrors, seed, seedDevice, seedVisit, setSettings, getSettingsRow,
  superTx, strings, allAccessRows } from './helpers.js';

const FILE = 3;
const stage = async () => {
  await seed('homecollection.settings', hc.settings('b'));
  const date = nextDay(FILE);
  const route = await mkRoute('b', MEMBER.b, date);
  const v = await seedVisit('b', { route, member: MEMBER.b, seq: 1, date });
  const device = await seedDevice('b');
  return { date, now: noonOf(date), route, v, device };
};
const reset = (o: Record<string, unknown> = {}) => superTx(async (tx) => {
  await tx.query(`UPDATE homecollection.settings SET min_app_version = '1.0.0', second_identifier = 'phone', version = version + 1 WHERE tenant_id = $1`, [TENANT_B]);
}, TENANT_B).then(() => o);

describe('SnapshotConfig mirrors the tenant settings (TRD §6.2 example keys, all required inside config)', () => {
  let X: Awaited<ReturnType<typeof stage>>; let R: Awaited<ReturnType<typeof pull>>;
  const PM = [{ code: 'cash', display: 'Cash', requires_reference: false }, { code: 'fonepay_qr', display: 'Fonepay QR', requires_reference: true }];
  beforeAll(async () => {
    X = await stage();
    await seed('homecollection.g_cs_reasons', hc.reason('visit_fail_reasons', 'patient_not_home'));   // global seed table (D-130); ON CONFLICT DO NOTHING keeps the real seed rows
    await seed('homecollection.g_cs_reasons', hc.reason('specimen_not_collected_reasons', 'unable_to_draw'));
    await setSettings(TENANT_B, `capture_gps = true, sync_interval_seconds = 120, offline_purge_hours = 8, map_handoff_enabled = false, manual_barcode_entry_allowed = false,
      collection_consent_text_version = 'hc-consent-v9', collection_consent_text = 'Synthetic consent text v9', payment_methods = $2::jsonb, min_app_version = '1.2.3'`, [JSON.stringify(PM)]);
    R = await pull(X.device.id, { who: PHLEBO_B, now: X.now, headers: hdr(X.device.id, '1.2.3') });
  }, T);

  it('config carries the settings row values verbatim', { timeout: T }, () => {
    expect(R.status).toBe(200);
    expect(schemaErrors('SnapshotDto', R.body)).toEqual([]);
    expect(R.body.config).toMatchObject({ sync_interval_seconds: 120, offline_purge_hours: 8, capture_gps: true, map_handoff_enabled: false, manual_barcode_entry_allowed: false, second_identifier: 'phone',
      collection_consent_text_version: 'hc-consent-v9', collection_consent_text: 'Synthetic consent text v9', payment_methods: PM, min_app_version: '1.2.3' });
  });
  it('config.reasons = the active coded sets visit_fail_reasons / specimen_not_collected_reasons as {code, display}; handover_centres = {centre_id, name} of tenant B only', { timeout: T }, () => {
    const { reasons, handover_centres } = R.body.config;
    expect(reasons.visit_fail_reasons.map((r: any) => r.code)).toContain('patient_not_home');
    expect(reasons.specimen_not_collected_reasons.map((r: any) => r.code)).toContain('unable_to_draw');
    for (const r of [...reasons.visit_fail_reasons, ...reasons.specimen_not_collected_reasons]) expect(Object.keys(r).sort()).toEqual(['code', 'display']);
    for (const c of handover_centres) { expect(Object.keys(c).sort()).toEqual(['centre_id', 'name']); expect(c.centre_id).toMatch(/00000000b/); }
  });
  it('the cursor follows settings.version: a settings change makes the old cursor "changed" and the new config is served; the same cursor then is unchanged', { timeout: T }, async () => {
    const hdrs = hdr(X.device.id, '1.2.3');
    const first = await pull(X.device.id, { who: PHLEBO_B, now: X.now, headers: hdrs });
    expect((await pull(X.device.id, { who: PHLEBO_B, now: X.now, headers: hdrs, cursor: first.body.cursor })).body.unchanged).toBe(true);
    await setSettings(TENANT_B, 'sync_interval_seconds = 240', []);
    const r = await pull(X.device.id, { who: PHLEBO_B, now: X.now, headers: hdrs, cursor: first.body.cursor });
    expect(r.body.unchanged).toBe(false);
    expect(r.body.config.sync_interval_seconds).toBe(240);
    expect(cursorOf(r.body.cursor).s).toBe((await getSettingsRow(TENANT_B)).version);
    expect((await pull(X.device.id, { who: PHLEBO_B, now: X.now, headers: hdrs, cursor: r.body.cursor })).body.unchanged).toBe(true);
  });
});

describe('D-IDENT / CR-C17-003: birth_on only when second_identifier = birth_date', () => {
  it('phone (default): the port returns birthOn but the snapshot has no birth_on; birth_date: patient.birth_on = the port\'s birthOn (IsoDate), phone still present', { timeout: T }, async () => {
    const X = await stage();
    await reset();
    const a = await pull(X.device.id, { who: PHLEBO_B, now: X.now });
    expect(a.body.visits[0].patient).not.toHaveProperty('birth_on');
    expect(strings(a.body).join()).not.toContain(birthOf(X.v.patient.id));
    await setSettings(TENANT_B, `second_identifier = 'birth_date'`, []);
    try {
      const b = await pull(X.device.id, { who: PHLEBO_B, now: X.now, cursor: a.body.cursor });
      expect(b.body.unchanged).toBe(false);   // the settings version moved
      expect(schemaErrors('SnapshotDto', b.body)).toEqual([]);
      expect(b.body.config.second_identifier).toBe('birth_date');
      expect(b.body.visits[0].patient).toMatchObject({ full_name: expect.any(String), phone_e164: expect.any(String), birth_on: birthOf(X.v.patient.id) });
    } finally { await reset(); }
  });
});

describe('US-06-6 app version below min_app_version -> 426 homecollection.app_version_unsupported on every app endpoint (CR-C17-007)', () => {
  it('A2 and A4: 1.4.9 < 1.5.0 -> 426 (checked numerically: 1.10.0 >= 1.9.0 passes); nothing is read, written or logged; exactly min_app_version passes', { timeout: T }, async () => {
    const X = await stage();
    await setSettings(TENANT_B, `min_app_version = '1.5.0'`, []);
    try {
      const before = await deviceRow(X.device.id);
      const e = await pullFails(X.device.id, { who: PHLEBO_B, now: X.now, headers: hdr(X.device.id, '1.4.9') });
      expect([e.code, e.statusCode]).toEqual(['homecollection.app_version_unsupported', 426]);
      expect([e.probe.batch.length, e.probe.lab.length, e.probe.balance.length]).toEqual([0, 0, 0]);
      expect(await allAccessRows(e.probe.requestId)).toHaveLength(0);
      const a = await ackFails(ackBody(X.device.id, 'c3ludGhldGlj'), { who: PHLEBO_B, now: X.now, headers: hdr(X.device.id, '1.4.9') });
      expect([a.code, a.statusCode]).toEqual(['homecollection.app_version_unsupported', 426]);
      const after = await deviceRow(X.device.id);
      expect([after.last_snapshot_at, after.last_ack_at, after.last_ack_cursor, after.version]).toEqual([before.last_snapshot_at, before.last_ack_at, before.last_ack_cursor, before.version]);
      for (const v of ['1.5.0', '1.10.0', '2.0.0']) {
        expect((await pull(X.device.id, { who: PHLEBO_B, now: X.now, headers: hdr(X.device.id, v) })).status, v).toBe(200);
        expect((await ack(ackBody(X.device.id, 'c3ludGhldGlj'), { who: PHLEBO_B, now: X.now, headers: hdr(X.device.id, v) })).status, v).toBe(204);
      }
      expect((await pullFails(X.device.id, { who: PHLEBO_B, now: X.now, headers: hdr(X.device.id, '1.4.10') })).code).toBe('homecollection.app_version_unsupported');
    } finally { await reset(); }
  });
  it('a missing or malformed x-lims-app-version header is never accepted as "new enough" on an app endpoint (426 or 400, no snapshot)', { timeout: T }, async () => {
    const X = await stage();
    await setSettings(TENANT_B, `min_app_version = '1.5.0'`, []);
    try {
      for (const h of [{ 'x-lims-device-id': X.device.id }, { 'x-lims-device-id': X.device.id, 'x-lims-app-version': 'latest' }, { 'x-lims-device-id': X.device.id, 'x-lims-app-version': '99' }]) {
        const e = await pullFails(X.device.id, { who: PHLEBO_B, now: X.now, headers: h });
        expect(['homecollection.app_version_unsupported', 'common.validation_failed']).toContain(e.code);
        expect(e.probe.batch).toHaveLength(0);
      }
    } finally { await reset(); }
  });
});

describe('tenant isolation of the snapshot (RLS + explicit tenant filter)', () => {
  it('tenant B\'s phlebotomist sees only tenant B visits and settings; tenant A\'s rows are never read even though the membership ids differ only by tenant', { timeout: T }, async () => {
    const X = await stage();
    const r = await pull(X.device.id, { who: PHLEBO_B, now: X.now });
    expect(r.body.visits.map((v: any) => v.visit_id)).toEqual([X.v.row.id]);
    const aVisits = (await ownerRows('homecollection.visits', 'tenant_id <> $1', [TENANT_B])).map((v) => v.id);
    expect(r.body.visits.map((v: any) => v.visit_id).filter((id: string) => aVisits.includes(id))).toEqual([]);
    expect(HC_CENTRE.b).toBe(r.body.routes[0].centre_id);
  });
});
