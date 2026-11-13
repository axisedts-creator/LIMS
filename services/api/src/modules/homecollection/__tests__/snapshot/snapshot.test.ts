// HC-T11 A2 getSyncSnapshot (GET /v1/homecollection/sync/snapshot?device_id&cursor, `homecollection.sync.upload` floor + `homecollection.visit.read` via assertRole).
// 01-PRD US-06-1..8, 02-TRD §5.2 A2 + device binding, §5.3.1 (SnapshotDto / SnapshotVisit / SnapshotStub / BalanceItem field tables), §6.2 (algorithm: cursor, unchanged path, one demographics batch call, lookupSpecimens on
// every changed snapshot, savepoints, access log, last_snapshot_at), 07-SECURITY AB1 / probes 2-3 / REQ-SEC-081 / REQ-SEC-096-097, review #2 (no barcode persisted, no read-model fallback). Fails now: A2 is an HC-T01 stub (501).
// Tenant A only, default settings (settings-mutating cases live in settings.test.ts on tenant B). ASSUMED where the spec is silent: see .orchestra/notes/HC-T11-tests.md.
import { beforeAll, describe, expect, it } from 'vitest';
import { HC_CENTRE, MEMBER, MEMBER2, NOBODY, P, PHLEBO, PHLEBO2, T, TENANT_A, addDays, allAccessRows, as, barcodeOf, birthOf, cursorOf, deviceRow, hc, keysDeep, nameOf, noonOf, ownerRows, phoneOf, pull, pullFails, regOf,
  responseErrors, routeRow, schemaErrors, scenario, seed, seedDevice, seedVisit, snapshotAccessRows, specimenIdOf, strings, superTx, uid, bumpRoute, pullS, v7, TYPES, BALANCE_PAISA, type Scenario } from './helpers.js';

const FILE = 0;
const ids = (b: any) => b.visits.map((v: any) => v.visit_id);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('US-06-1 pull with no cursor: today\'s route, exactly the actor\'s visits', () => {
  let S: Scenario; let R: Awaited<ReturnType<typeof pullS>>;
  beforeAll(async () => { S = await scenario(FILE); R = await pullS(S); }, T);

  it('200; the body is a valid SnapshotDto (additionalProperties false, §5.3.1) and the A2 response schema; server_time = the request clock; no `null` anywhere', { timeout: T }, () => {
    expect(R.status).toBe(200);
    expect(schemaErrors('SnapshotDto', R.body)).toEqual([]);
    expect(responseErrors('getSyncSnapshot', R.body)).toEqual([]);
    expect(R.body.server_time).toBe(S.now.toISOString());
    expect(JSON.stringify(R.body)).not.toMatch(/:null/);
  });
  it('changed snapshot: unchanged false, device_command none, route_date = today, balances [] (they sit on each visit), config + routes + visits present', { timeout: T }, () => {
    expect(R.body).toMatchObject({ unchanged: false, device_command: 'none', route_date: S.date, balances: [] });
    expect(R.body.config).toBeTruthy();
    expect(R.body.routes).toEqual([{ route_id: S.route.id, centre_id: HC_CENTRE.a, version: S.route.version ?? 1 }]);
  });
  it('visits = exactly the 2 of today (tomorrow\'s, PHLEBO2\'s and tenant B\'s are absent), ordered by route_sequence', { timeout: T }, () => {
    expect(ids(R.body)).toEqual([S.v1.row.id, S.v2.row.id]);
    expect(ids(R.body)).not.toContain(S.tomorrow.row.id);
    expect(ids(R.body)).not.toContain(S.other.row.id);
  });
  it('each visit carries: id, version, route_id, sequence, window, status, kind, order_id, patient full name + phone, address text, landmark, coordinates (if set), dispatcher note, specimens, balance with as_of', { timeout: T }, () => {
    const [a, b] = R.body.visits;
    expect(a).toEqual({
      visit_id: S.v1.row.id, version: S.v1.row.version ?? 1, route_id: S.route.id, route_sequence: 1, status: 'assigned', kind: 'front_desk',
      window_start: expect.any(String), window_end: expect.any(String), order_id: S.v1.order.id,
      patient: { full_name: nameOf(S.v1.patient.id), phone_e164: phoneOf(S.v1.patient.id) },
      address: { address_text: 'Ward 4, Synthetic Tole 12', landmark: 'Opposite the synthetic bakery', latitude: expect.stringMatching(/^27\.7172(0*)$/), longitude: expect.stringMatching(/^85\.324(0*)$/) },
      note_for_phlebotomist: 'Synthetic gate code 0000',
      specimens: [
        { specimen_id: specimenIdOf(S.v1.order.id, 0), barcode: barcodeOf(S.v1.order.id, 0), specimen_type_code: TYPES[0], container_code: 'TUBE_A', status: 'ordered' },
        { specimen_id: specimenIdOf(S.v1.order.id, 1), barcode: barcodeOf(S.v1.order.id, 1), specimen_type_code: TYPES[1], status: 'ordered' },
      ],
      balance: { balance_due: { amount_paisa: BALANCE_PAISA, currency: 'NPR' }, as_of: S.now.toISOString() },
    });
    expect(new Date(a.window_start).getTime()).toBe(Date.parse(S.v1.row.window_start));
    expect(new Date(a.window_end).getTime()).toBe(Date.parse(S.v1.row.window_end));
    // v2: no coordinates and no landmark -> the keys are absent (never null, coordinates both-or-neither)
    expect(b.visit_id).toBe(S.v2.row.id);
    expect(b.address).toEqual({ address_text: S.v2.row.address_text });
    expect(b.route_sequence).toBe(2);
  });
  it('REQ-SEC-081: no test names, registration number, birth date, patient id/code, assignee or booking data anywhere in the snapshot (second identifier = phone)', { timeout: T }, () => {
    const keys = keysDeep(R.body);
    for (const k of ['registration_no', 'registrationNo', 'tests', 'test_names', 'orderable_ids', 'patient_id', 'patient_code', 'birth_on', 'sex', 'assigned_membership_id', 'booking_id', 'phlebotomist', 'status_reason_code'])
      expect(keys.has(k), `key ${k} leaked into the snapshot`).toBe(false);
    const all = strings(R.body).join('\n');
    for (const v of [S.v1, S.v2]) {
      expect(all).not.toContain(v.order.registration_no);
      expect(all).not.toContain(regOf(v.order.id));
      expect(all).not.toContain(birthOf(v.patient.id));
      expect(all).not.toContain(v.patient.birth_on);
    }
  });
  it('a patient without a phone on file -> `phone_e164` absent (not null)', { timeout: T }, async () => {
    const r = await pullS(S, { fx: { noPhone: [S.v1.patient.id] } });
    expect(r.body.visits[0].patient).toEqual({ full_name: nameOf(S.v1.patient.id) });
    expect(r.body.visits[1].patient.phone_e164).toBe(phoneOf(S.v2.patient.id));
  });
  it('ports: ONE getPatientDemographicsBatch for the 2 patients (purpose home_visit); lookupSpecimens per visit with {orderId, statuses:[ordered]}; getOrderBalance per visit; tenant timezone read through IdentityPort', { timeout: T }, () => {
    expect(R.probe.batch).toHaveLength(1);
    expect(R.probe.batch[0]!.purpose).toBe('home_visit');
    expect([...R.probe.batch[0]!.patientIds].sort()).toEqual([S.v1.patient.id, S.v2.patient.id].sort());
    expect(R.probe.lab.map((c) => c.orderId).sort()).toEqual([S.v1.order.id, S.v2.order.id].sort());
    for (const c of R.probe.lab) expect(c.statuses).toEqual(['ordered']);
    expect([...R.probe.balance].sort()).toEqual([S.v1.order.id, S.v2.order.id].sort());
    expect(JSON.stringify(R.probe.tenantSettings)).toContain('timezone');
  });
  it('permissions: visit.read is checked with IdentityPort.assertRole (08 A13 P-10); a caller holding only sync.upload is refused auth.forbidden and nothing is read or written', { timeout: T }, async () => {
    expect(R.probe.identity.map((c) => c.permission)).toContain(P.read);
    const e = await pullFails(S.device.id, { now: S.now, who: as(PHLEBO, { grants: [P.sync] }) });
    expect(e.code).toBe('auth.forbidden');
    expect(e.probe.batch).toHaveLength(0);
    expect(await allAccessRows(e.probe.requestId)).toHaveLength(0);
  });
  it('REQ-SEC-081: no patient name, phone, address, note, barcode or birth date is written to the logs', { timeout: T }, () => {
    const logs = R.probe.logs.join('\n');
    for (const v of [S.v1, S.v2]) {
      expect(logs).not.toContain(nameOf(v.patient.id));
      expect(logs).not.toContain(phoneOf(v.patient.id));
      expect(logs).not.toContain(barcodeOf(v.order.id, 0));
    }
    expect(logs).not.toContain('Synthetic Tole');
    expect(logs).not.toContain('Synthetic gate code');
  });
  it('last_snapshot_at is set on the device and on today\'s route only (tomorrow\'s route and PHLEBO2\'s are untouched)', { timeout: T }, async () => {
    expect(new Date((await deviceRow(S.device.id)).last_snapshot_at).getTime()).toBe(S.now.getTime());
    expect(new Date((await routeRow(S.route.id)).last_snapshot_at).getTime()).toBe(S.now.getTime());
    expect((await routeRow(S.routeTomorrow.id)).last_snapshot_at).toBeNull();
    expect((await routeRow(S.otherRoute.id)).last_snapshot_at).toBeNull();
  });
  it('a phlebotomist with no route today gets a valid changed snapshot with no visits and no routes', { timeout: T }, async () => {
    const d = await seedDevice('a', { membership_id: MEMBER2.a });
    const r = await pull(d.id, { who: PHLEBO2, now: noonOf(addDays(S.date, 30)) });
    expect(r.status).toBe(200);
    expect(schemaErrors('SnapshotDto', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ unchanged: false, visits: [], routes: [], balances: [] });
    expect(r.probe.lab).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('US-06-1 / REQ-ARCH: lookupSpecimens on EVERY changed snapshot; barcodes only from that call, never persisted (review #2)', () => {
  let S: Scenario;
  beforeAll(async () => { S = await scenario(FILE); }, T);

  it('two changed pulls (no cursor, then a stale cursor) -> 2 x (1 demographics batch + 1 lookupSpecimens per visit); nothing cached between them', { timeout: T }, async () => {
    const a = await pullS(S);
    const b = await pullS(S, { cursor: 'c3RhbGUtY3Vyc29y' });
    for (const r of [a, b]) { expect(r.body.unchanged).toBe(false); expect(r.probe.batch).toHaveLength(1); expect(r.probe.lab).toHaveLength(2); }
    expect(b.body.visits.map((v: any) => v.specimens.map((s: any) => s.barcode))).toEqual(a.body.visits.map((v: any) => v.specimens.map((s: any) => s.barcode)));
  });
  it('the barcodes returned by the port are in no homecollection table (visit_specimens has no barcode column) and not in the logs', { timeout: T }, async () => {
    const r = await pullS(S);
    const bc = barcodeOf(S.v1.order.id, 0);
    expect(JSON.stringify(r.body)).toContain(bc);
    const tables = await ownerRows('information_schema.tables', `table_schema = 'homecollection' AND table_type = 'BASE TABLE'`);
    for (const t of tables) {
      const n = await superTx(async (tx) => Number((await tx.query(`SELECT count(*) AS n FROM homecollection.${t.table_name} x WHERE to_jsonb(x)::text LIKE $1`, [`%${bc}%`])).rows[0].n), TENANT_A);
      expect(n, `barcode persisted in homecollection.${t.table_name}`).toBe(0);
    }
    expect(r.probe.logs.join('\n')).not.toContain(bc);
  });
  it('no fallback to the visit_specimens read model: a visit whose lookupSpecimens fails shows specimens [] + specimens_stale even though the read model holds a row (and its barcode is never shown)', { timeout: T }, async () => {
    const specimen = { id: uid(), tenant_id: TENANT_A, centre_id: HC_CENTRE.a, order_id: S.v1.order.id, patient_id: S.v1.patient.id, barcode: 'FALLBACKBC1', creation_key: `hct11-${uid()}`, specimen_type_code: 'SST',
      priority: 'routine', patient_sex: 'female', status: 'ordered', ordered_at: '2026-11-10T04:00:00Z' };
    await seed('lab.specimens', specimen);
    await seed('homecollection.visit_specimens', hc.visitSpecimen('a', { specimen, order: S.v1.order }, S.v1.row.id));
    const r = await pullS(S, { fx: { labFailsFor: [S.v1.order.id] } });
    expect(r.body.visits[0]).toMatchObject({ visit_id: S.v1.row.id, specimens: [], specimens_stale: true });
    expect(JSON.stringify(r.body)).not.toContain('FALLBACKBC1');
    expect(JSON.stringify(r.body)).not.toContain(specimen.id);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('US-06-2 unchanged path: same cursor, no server change -> unchanged:true with fresh balances only', () => {
  let S: Scenario; let first: any;
  beforeAll(async () => { S = await scenario(FILE); first = await pullS(S); }, T);

  it('cursor = base64url(JSON{v:1, d: today, r: [[route_id, route_version]...], s: settings.version, w: device.status}), <= 512 chars, opaque URL-safe', { timeout: T }, async () => {
    const c = first.body.cursor as string;
    expect(c).toMatch(/^[A-Za-z0-9_-]{1,512}$/);
    const settings = (await ownerRows('homecollection.settings', 'tenant_id = $1', [TENANT_A]))[0];
    expect(cursorOf(c)).toEqual({ v: 1, d: S.date, r: [[S.route.id, S.route.version ?? 1]], s: settings.version, w: 'active' });
  });
  it('200 unchanged:true with exactly {server_time, cursor, unchanged, device_command, balances}: the same cursor, one balance per active visit with an order, no visits / config / routes / route_date', { timeout: T }, async () => {
    const r = await pullS(S, { cursor: first.body.cursor, now: new Date(S.now.getTime() + 60_000) });
    expect(r.status).toBe(200);
    expect(schemaErrors('SnapshotDto', r.body)).toEqual([]);
    expect(Object.keys(r.body).sort()).toEqual(['balances', 'cursor', 'device_command', 'server_time', 'unchanged']);
    expect(r.body).toMatchObject({ unchanged: true, cursor: first.body.cursor, device_command: 'none' });
    expect(r.body.server_time).toBe(new Date(S.now.getTime() + 60_000).toISOString());
    expect(r.body.balances).toHaveLength(2);
    expect(r.body.balances.map((b: any) => b.visit_id).sort()).toEqual([S.v1.row.id, S.v2.row.id].sort());
    for (const b of r.body.balances) expect(b).toEqual({ visit_id: expect.any(String), balance_due: { amount_paisa: BALANCE_PAISA, currency: 'NPR' }, as_of: new Date(S.now.getTime() + 60_000).toISOString() });
  });
  it('the unchanged path makes NO demographics call and NO lookupSpecimens call (spy), only getOrderBalance per visit; writes no access-log row (no patient fields are returned)', { timeout: T }, async () => {
    const r = await pullS(S, { cursor: first.body.cursor });
    expect(r.probe.batch).toHaveLength(0);
    expect(r.probe.lab).toHaveLength(0);
    expect([...r.probe.balance].sort()).toEqual([S.v1.order.id, S.v2.order.id].sort());
    expect(await allAccessRows(r.probe.requestId)).toHaveLength(0);
  });
  it('a failing balance read on the unchanged path does not fail the pull: that visit is simply left out of balances [ASSUMED: BalanceItem has no unavailable marker]', { timeout: T }, async () => {
    const r = await pullS(S, { cursor: first.body.cursor, fx: { balanceFailsFor: [S.v1.order.id] } });
    expect(r.status).toBe(200);
    expect(r.body.unchanged).toBe(true);
    expect(r.body.balances.map((b: any) => b.visit_id)).toEqual([S.v2.row.id]);
  });
  it('a route version bump (cancel / reassign / specimen status, §4.1) -> the old cursor is changed: full snapshot again, new cursor with the new version', { timeout: T }, async () => {
    await bumpRoute(TENANT_A, S.route.id);
    const r = await pullS(S, { cursor: first.body.cursor });
    expect(r.body.unchanged).toBe(false);
    expect(r.body.cursor).not.toBe(first.body.cursor);
    expect(cursorOf(r.body.cursor).r).toEqual([[S.route.id, (S.route.version ?? 1) + 1]]);
    expect(r.probe.batch).toHaveLength(1);
    expect(r.probe.lab).toHaveLength(2);
    expect((await pullS(S, { cursor: r.body.cursor })).body.unchanged).toBe(true);
  });
  it('an unparseable / foreign / yesterday cursor is simply "changed" (200 full snapshot), never an error', { timeout: T }, async () => {
    const other = Buffer.from(JSON.stringify({ v: 1, d: addDays(S.date, -1), r: [], s: 1, w: 'active' })).toString('base64url');
    for (const c of ['bm90LWpzb24', other, 'e30', 'A'.repeat(512)]) {
      const r = await pullS(S, { cursor: c });
      expect(r.status, c).toBe(200);
      expect(r.body.unchanged).toBe(false);
      expect(r.body.visits).toHaveLength(2);
    }
  });
  it('device wipe requested -> device_command wipe; the cursor changes (w) so the device gets the full snapshot with the command; still bound and 200', { timeout: T }, async () => {
    const d = await seedDevice('a');
    const s2 = { ...S, device: d };
    const a = await pullS(s2);
    expect(a.body.device_command).toBe('none');
    await superTx(async (tx) => { await tx.query(`UPDATE homecollection.devices SET status = 'wipe_requested', wipe_requested_at = now(), wipe_requested_by = $2, wipe_reason_code = 'lost', version = version + 1 WHERE id = $1`, [d.id, MEMBER2.a]); }, TENANT_A);
    const b = await pullS(s2, { cursor: a.body.cursor });
    expect(b.status).toBe(200);
    expect(b.body.unchanged).toBe(false);
    expect(b.body.device_command).toBe('wipe');
    expect(cursorOf(b.body.cursor).w).toBe('wipe_requested');
    const c = await pullS(s2, { cursor: b.body.cursor });
    expect(c.body).toMatchObject({ unchanged: true, device_command: 'wipe' });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('US-06-3 cancelled after assignment -> stub; closed visits carry no patient fields', () => {
  let S: Scenario; let cancelled: any; let done: any; let failed: any; let neverOnRoute: any; let R: Awaited<ReturnType<typeof pullS>>;
  beforeAll(async () => {
    S = await scenario(FILE);
    cancelled = await seedVisit('a', { route: S.route, member: MEMBER.a, seq: 3, date: S.date, status: 'cancelled' });
    done = await seedVisit('a', { route: S.route, member: MEMBER.a, seq: 4, date: S.date, status: 'completed' });
    failed = await seedVisit('a', { route: S.route, member: MEMBER.a, seq: 5, date: S.date, status: 'failed' });
    neverOnRoute = await seedVisit('a', { date: S.date, status: 'cancelled' });   // unassigned -> cancelled: no route
    R = await pullS(S);
  }, T);
  const by = (id: string) => R.body.visits.find((v: any) => v.visit_id === id);

  it('visits = 2 active + 1 stub + 2 closed, ordered by route_sequence; the visit cancelled without ever being on the route is not listed', { timeout: T }, () => {
    expect(R.status).toBe(200);
    expect(schemaErrors('SnapshotDto', R.body)).toEqual([]);
    expect(ids(R.body)).toEqual([S.v1.row.id, S.v2.row.id, cancelled.row.id, done.row.id, failed.row.id]);
    expect(ids(R.body)).not.toContain(neverOnRoute.row.id);
  });
  it('the cancelled visit is a stub {visit_id, version, route_id, route_sequence, status: cancelled, kind, window}: no patient, address, note, specimens, balance, order_id', { timeout: T }, () => {
    expect(by(cancelled.row.id)).toEqual({ visit_id: cancelled.row.id, version: cancelled.row.version ?? 1, route_id: S.route.id, route_sequence: 3, status: 'cancelled', kind: 'front_desk',
      window_start: expect.any(String), window_end: expect.any(String) });
  });
  it('completed / failed visits: status + outcome, `specimens: []`, no patient / address / note / balance / patient_unavailable', { timeout: T }, () => {
    expect(by(done.row.id)).toEqual({ visit_id: done.row.id, version: done.row.version ?? 1, route_id: S.route.id, route_sequence: 4, status: 'completed', kind: 'front_desk', order_id: done.order.id, outcome: 'collected',
      window_start: expect.any(String), window_end: expect.any(String), specimens: [] });
    expect(by(failed.row.id)).toEqual({ visit_id: failed.row.id, version: failed.row.version ?? 1, route_id: S.route.id, route_sequence: 5, status: 'failed', kind: 'front_desk', order_id: failed.order.id, outcome: 'none',
      window_start: expect.any(String), window_end: expect.any(String), specimens: [] });
  });
  it('no port is called for the stub or the closed visits (patients, orders): demographics / lookupSpecimens / balance see only the 2 active ones', { timeout: T }, () => {
    expect([...R.probe.batch[0]!.patientIds].sort()).toEqual([S.v1.patient.id, S.v2.patient.id].sort());
    expect(R.probe.lab.map((c) => c.orderId).sort()).toEqual([S.v1.order.id, S.v2.order.id].sort());
    expect([...R.probe.balance].sort()).toEqual([S.v1.order.id, S.v2.order.id].sort());
  });
  it('US-06-4: access log rows only for the 2 visits returned with patient fields — none for the stub or the closed visits', { timeout: T }, async () => {
    const rows = await snapshotAccessRows(R.probe.requestId);
    expect(rows.map((r) => r.entity_id).sort()).toEqual([S.v1.row.id, S.v2.row.id].sort());
  });
  it('the unchanged path lists no balance for the stub / closed visits either', { timeout: T }, async () => {
    const r = await pullS(S, { cursor: R.body.cursor });
    expect(r.body.balances.map((b: any) => b.visit_id).sort()).toEqual([S.v1.row.id, S.v2.row.id].sort());
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('US-06-4 access log: one home_visit.view / home_visit_snapshot row per visit with patient fields', () => {
  let S: Scenario;
  beforeAll(async () => { S = await scenario(FILE); }, T);

  it('2 visits -> 2 rows {tenant, action home_visit.view, entity_type home_visit, entity_id, purpose_code home_visit_snapshot, outcome allowed, membership = caller, request_id}; nothing else is logged for the request', { timeout: T }, async () => {
    const r = await pullS(S);
    const rows = await snapshotAccessRows(r.probe.requestId);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ tenant_id: TENANT_A, action: 'home_visit.view', entity_type: 'home_visit', purpose_code: 'home_visit_snapshot', outcome: 'allowed', membership_id: PHLEBO.membershipId, request_id: r.probe.requestId });
    expect(rows.map((x) => x.entity_id).sort()).toEqual([S.v1.row.id, S.v2.row.id].sort());
    expect(await allAccessRows(r.probe.requestId)).toHaveLength(2);
  });
  it('every changed pull writes its rows again (no dedupe, review #18): 3 pulls -> 6 rows for this device\'s visits in total (>= 6 incl. earlier tests of this describe)', { timeout: T }, async () => {
    const before = (await ownerRows('audit.access_log', `entity_id = $1 AND purpose_code = 'home_visit_snapshot'`, [S.v1.row.id])).length;
    for (let i = 0; i < 3; i++) await pullS(S);
    expect((await ownerRows('audit.access_log', `entity_id = $1 AND purpose_code = 'home_visit_snapshot'`, [S.v1.row.id])).length).toBe(before + 3);
  });
  it('patient fields not returned -> no row for that visit: demographics batch down -> 0 rows; one patient missing from the result -> a row only for the other visit', { timeout: T }, async () => {
    const down = await pullS(S, { fx: { batchFails: true } });
    expect(await snapshotAccessRows(down.probe.requestId)).toHaveLength(0);
    const part = await pullS(S, { fx: { omit: [S.v1.patient.id] } });
    expect((await snapshotAccessRows(part.probe.requestId)).map((x) => x.entity_id)).toEqual([S.v2.row.id]);
  });
  it('a refused pull (unregistered device) writes no row and no last_snapshot_at', { timeout: T }, async () => {
    const e = await pullFails(v7(), { now: S.now });
    expect(await allAccessRows(e.probe.requestId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('US-06-8 / review #2: a port failure marks only that visit; the pull still succeeds', () => {
  let S: Scenario;
  beforeAll(async () => { S = await scenario(FILE); }, T);

  it('lookupSpecimens fails for v1 -> v1 `specimens: []` + `specimens_stale: true` (patient, address, balance intact); v2 unaffected and has no specimens_stale key; schema valid', { timeout: T }, async () => {
    const r = await pullS(S, { fx: { labFailsFor: [S.v1.order.id] } });
    expect(r.status).toBe(200);
    expect(schemaErrors('SnapshotDto', r.body)).toEqual([]);
    const [a, b] = r.body.visits;
    expect(a).toMatchObject({ visit_id: S.v1.row.id, specimens: [], specimens_stale: true, patient: { full_name: nameOf(S.v1.patient.id) }, balance: { balance_due: { amount_paisa: BALANCE_PAISA } } });
    expect(a.address).toBeTruthy();
    expect(b.visit_id).toBe(S.v2.row.id);
    expect(b.specimens).toHaveLength(2);
    expect('specimens_stale' in b).toBe(false);
    expect(r.probe.lab).toHaveLength(2);   // v2 was still looked up after v1 failed
  });
  it('an unexpected (non-LimsError) failure of the port is handled the same way', { timeout: T }, async () => {
    const r = await pullS(S, { fx: { labFails: true, labPlain: true } });
    expect(r.status).toBe(200);
    for (const v of r.body.visits) expect(v).toMatchObject({ specimens: [], specimens_stale: true });
  });
  it('the failure does not poison the request: access rows and last_snapshot_at are still written for the stale visits', { timeout: T }, async () => {
    const d = await seedDevice('a');
    const r = await pullS({ ...S, device: d }, { fx: { labFails: true } });
    expect((await snapshotAccessRows(r.probe.requestId)).map((x) => x.entity_id).sort()).toEqual([S.v1.row.id, S.v2.row.id].sort());
    expect((await deviceRow(d.id)).last_snapshot_at).not.toBeNull();
  });
  it('an order with no expected specimens is NOT stale: `specimens: []` without the specimens_stale key', { timeout: T }, async () => {
    const r = await pullS(S, { fx: { specimens: 0 } });
    for (const v of r.body.visits) { expect(v.specimens).toEqual([]); expect('specimens_stale' in v).toBe(false); }
  });
  it('balance read fails -> `balance_unavailable: true`, no `balance` key; demographics batch fails -> `patient_unavailable: true` for both visits, no `patient` key, address and specimens still present', { timeout: T }, async () => {
    const r = await pullS(S, { fx: { balanceFailsFor: [S.v1.order.id], batchFails: true } });
    expect(r.status).toBe(200);
    expect(schemaErrors('SnapshotDto', r.body)).toEqual([]);
    const [a, b] = r.body.visits;
    expect(a).toMatchObject({ balance_unavailable: true, patient_unavailable: true });
    expect('balance' in a).toBe(false); expect('patient' in a).toBe(false);
    expect(a.address.address_text).toBeTruthy(); expect(a.specimens).toHaveLength(2);
    expect(b).toMatchObject({ patient_unavailable: true }); expect('balance_unavailable' in b).toBe(false); expect(b.balance).toBeTruthy();
  });
  it('a patient missing from the batch result -> only that visit is patient_unavailable (review m#34)', { timeout: T }, async () => {
    const r = await pullS(S, { fx: { omit: [S.v2.patient.id] } });
    expect(r.body.visits[0].patient).toBeTruthy();
    expect(r.body.visits[1]).toMatchObject({ patient_unavailable: true });
    expect('patient' in r.body.visits[1]).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('US-06-5 own visits only; US-06-7 device binding (07-SECURITY AB1, probes 2-3)', () => {
  let S: Scenario;
  beforeAll(async () => { S = await scenario(FILE); }, T);

  it('PHLEBO2 pulls only her own visit; PHLEBO\'s patients never reach the demographics call of PHLEBO2 and vice versa', { timeout: T }, async () => {
    const d2 = await seedDevice('a', { membership_id: MEMBER2.a });
    const r = await pull(d2.id, { who: PHLEBO2, now: S.now });
    expect(ids(r.body)).toEqual([S.other.row.id]);
    expect(r.probe.batch[0]!.patientIds).toEqual([S.other.patient.id]);
    expect(r.body.routes.map((x: any) => x.route_id)).toEqual([S.otherRoute.id]);
    const mine = await pullS(S);
    expect(mine.probe.batch[0]!.patientIds).not.toContain(S.other.patient.id);
  });
  it('AB1: PHLEBO2 presenting PHLEBO\'s device_id -> 409 homecollection.device_not_registered; no port call, no access row, last_snapshot_at untouched', { timeout: T }, async () => {
    const before = (await deviceRow(S.device.id)).last_snapshot_at;
    const e = await pullFails(S.device.id, { who: PHLEBO2, now: S.now });
    expect(e.code).toBe('homecollection.device_not_registered');
    expect(e.statusCode).toBe(409);
    expect(e.probe.batch).toHaveLength(0); expect(e.probe.lab).toHaveLength(0); expect(e.probe.balance).toHaveLength(0);
    expect(await allAccessRows(e.probe.requestId)).toHaveLength(0);
    expect((await deviceRow(S.device.id)).last_snapshot_at).toEqual(before);
  });
  it('unknown device_id, a tenant B device and terminal devices (signed_off, wiped) -> 409 homecollection.device_not_registered', { timeout: T }, async () => {
    const b = await seedDevice('b');
    const so = await seedDevice('a', { status: 'signed_off', signed_off_at: '2027-03-01T00:00:00Z' });
    const wi = await seedDevice('a', { status: 'wiped', wiped_at: '2027-03-01T00:00:00Z' });
    for (const id of [v7(), b.id, so.id, wi.id]) {
      const e = await pullFails(id, { now: S.now });
      expect([e.code, e.statusCode], id).toEqual(['homecollection.device_not_registered', 409]);
    }
  });
  it('device-id header vs query mismatch -> 400 common.id_mismatch (TRD §5 preamble) [ASSUMED enforced in the handler, as HC-T10]', { timeout: T }, async () => {
    const e = await pullFails(S.device.id, { now: S.now, headers: { 'x-lims-device-id': v7(), 'x-lims-app-version': '1.0.0' } });
    expect([e.code, e.statusCode]).toEqual(['common.id_mismatch', 400]);
    expect(e.probe.batch).toHaveLength(0);
  });
  it('probe 2: a phlebotomist whose membership lacks the visit centre never gets that visit (dropped, or refused auth.forbidden) and its patient is never requested', { timeout: T }, async () => {
    const d = await seedDevice('a');
    try {
      const r = await pullS({ ...S, device: d }, { fx: { deniedCentres: [HC_CENTRE.a] } });
      expect(ids(r.body)).toEqual([]);
      expect(r.probe.batch.flatMap((c) => c.patientIds)).toEqual([]);
    } catch (e: any) { expect(e.code).toBe('auth.forbidden'); }
  });
  it('NOBODY (no grants) -> auth.forbidden', { timeout: T }, async () => {
    expect((await pullFails(S.device.id, { who: NOBODY, now: S.now })).code).toBe('auth.forbidden');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('S-1 "today" is the local date in the tenant timezone (Asia/Kathmandu, UTC+05:45)', () => {
  it('19:00Z the day before = 00:45 local: today\'s route is served although the UTC date is yesterday; 19:00Z of the route day = tomorrow local: no visits', { timeout: T }, async () => {
    const S = await scenario(FILE);
    const early = new Date(`${addDays(S.date, -1)}T19:00:00.000Z`);
    const r = await pullS(S, { now: early });
    expect(r.body.route_date).toBe(S.date);
    expect(ids(r.body)).toEqual([S.v1.row.id, S.v2.row.id]);
    const late = new Date(`${S.date}T19:00:00.000Z`);
    const t = await pullS(S, { now: late });
    expect(t.body.route_date).toBe(addDays(S.date, 1));
    expect(ids(t.body)).toEqual([S.tomorrow.row.id]);
    expect(cursorOf(t.body.cursor).d).toBe(addDays(S.date, 1));
    expect(cursorOf(r.body.cursor).d).toBe(S.date);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('many users at once: concurrent pulls', () => {
  it('5 devices of 2 phlebotomists pull in parallel: all 200, each sees only its own visits, every pull logs its own rows', { timeout: T }, async () => {
    const S = await scenario(FILE);
    const mine = await Promise.all([0, 1, 2].map(() => seedDevice('a')));
    const theirs = await Promise.all([0, 1].map(() => seedDevice('a', { membership_id: MEMBER2.a })));
    const rs = await Promise.all([...mine.map((d) => pullS({ ...S, device: d })), ...theirs.map((d) => pull(d.id, { who: PHLEBO2, now: S.now }))]);
    for (const r of rs.slice(0, 3)) expect(ids(r.body)).toEqual([S.v1.row.id, S.v2.row.id]);
    for (const r of rs.slice(3)) expect(ids(r.body)).toEqual([S.other.row.id]);
    for (const [i, r] of rs.entries()) expect(await snapshotAccessRows(r.probe.requestId)).toHaveLength(i < 3 ? 2 : 1);
  });
});
