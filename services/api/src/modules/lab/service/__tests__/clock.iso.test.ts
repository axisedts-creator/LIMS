// T0D-FIX-6 (LD-448, CR DEPLOY-AXIS-012 item 4): the pipeline's ctx.now() returns an ISO STRING (core/pipeline/index.ts:169); the unit fakes of this module return a Date, so the write paths
// were never run the way production runs them. Every scenario here runs TWICE on the same fake: with a Date clock (control: proves the fake and the scenario are valid) and with an ISO string
// clock exactly like the pipeline. Before the fix the string rows fail with `... is not a function` (TypeError); after it both rows give the same answer.
// Paths: specimen collect (single), bulk dispatch (in transit), home-collection sync (in-transit step), result entry with a critical value, approve (plain and with the LD-316 sign-off chain), amend.
// No database, no outside call. Synthetic data only.
import { describe, expect, it } from 'vitest';
import { applyHomeCollectionSynced, bulkDispatchSpecimens, collectSpecimen } from '../specimen.service.js';
import { amendResult, approveResult, bulkEnterResults } from '../result.service.js';
import { ACTOR, amendRow, APPROVER, approveRow, CENTRE, id, ITEM, make, NOW, ORDER, PATIENT, SPEC1, TENANT } from './approve.fixtures.js';

const ISO_NOW = NOW.toISOString();
const CLOCKS: [string, () => unknown][] = [['Date clock (existing fakes)', () => NOW], ['ISO string clock (the pipeline)', () => ISO_NOW]];
const noTypeError = (e: unknown) => expect(String((e as Error)?.message ?? e)).not.toMatch(/is not a function|Cannot read prop|toISOString|getTime/);
const SPEC = '01a1a98a-ac40-7000-8000-0000000e0101';
const MEMBER = APPROVER;

// ------------------------------------------------------------------------------ specimen: a recording fake tx that applies the UPDATE of lab.specimens
function specimenWorld(status: string) {
  const row: Record<string, any> = {
    id: SPEC, version: 1, status, is_active: true, centre_id: CENTRE, order_id: ORDER, patient_id: PATIENT, specimen_type_code: 'WB', barcode: 'E2600000042', registration_no: 'R0001',
    processing_centre_id: null, collected_at: null, in_transit_at: null, created_at: new Date('2026-06-15T04:00:00Z'), updated_at: new Date('2026-06-15T04:00:00Z'),
  };
  const stmts: { text: string; values: unknown[] }[] = [];
  const tx = {
    async query(text: string, values: unknown[] = []) {
      stmts.push({ text, values });
      if (/FROM lab\.specimens s JOIN lab\.orders o/.test(text)) return { rows: values.includes(SPEC) ? [{ ...row }] : [] };
      const up = /UPDATE lab\.specimens SET (.*?), version = version \+ 1/s.exec(text);
      if (up) { up[1]!.split(',').forEach((c, i) => { row[c.split('=')[0]!.trim()] = values[4 + i]; }); row['version'] = Number(row['version']) + 1; return { rows: [{ ...row }] }; }
      if (/INSERT INTO lab\.specimen_transitions/.test(text)) return { rows: [{}] };
      return { rows: [] };
    },
  };
  const published: { type: string; input: any }[] = [];
  const mkCtx = (clock: () => unknown) => ({
    tenantId: TENANT, actor: { type: 'user', id: ACTOR, membershipId: MEMBER }, tx, now: clock,
    ports: { IdentityPort: { async assertRole() {}, async getActor() { return { centreScope: { all: true, centreIds: [] } }; } } },
    events: { async publish(...a: unknown[]) { published.push({ type: a.find((x) => typeof x === 'string') as string, input: a[a.length - 1] }); return { eventId: 'ev', duplicate: false }; } },
    audit: { async access() {} }, log: { info() {}, warn() {}, error() {} },
  }) as any;
  return { row, stmts, published, mkCtx };
}
const iso = (v: unknown) => (typeof v === 'string' ? v : v instanceof Date ? v.toISOString() : String(v));

describe.each(CLOCKS)('lab specimen write paths, %s', (_n, clock) => {
  it('collect (single action): ordered -> collected, collected_at is the clock instant as ISO text, the status event carries it', async () => {
    const w = specimenWorld('ordered');
    const r: any = await collectSpecimen(w.mkCtx(clock), { specimen_id: SPEC }, { 'if-match': '"1"' }, {});
    expect(r.status).toBe(200);
    expect(w.row['status']).toBe('collected');
    expect(iso(w.row['collected_at'])).toBe(ISO_NOW);
    const ev = w.published.find((e) => e.type === 'lab.specimen.status_changed.v1');
    expect(ev?.input.payload.changed_at).toBe(ISO_NOW);
  });
  it('bulk dispatch (in transit): collected -> in_transit, in_transit_at is the clock instant', async () => {
    const w = specimenWorld('collected');
    const r: any = await bulkDispatchSpecimens(w.mkCtx(clock), { items: [{ id: SPEC, version: 1 }] });
    expect(r.status).toBe(200);
    expect(w.row['status']).toBe('in_transit');
    expect(iso(w.row['in_transit_at'])).toBe(ISO_NOW);
  });
  it('home-collection sync (specimen.service.ts:578, the in-transit step): ordered -> collected -> in_transit, never before the collection instant', async () => {
    const w = specimenWorld('ordered');
    const collectedDevice = '2026-06-15T03:00:00.000Z';
    await applyHomeCollectionSynced(w.mkCtx(clock), { payload: { visit_id: id(0x77), synced_at: '2026-06-15T04:30:00.000Z', phlebotomist_membership_id: MEMBER,
      collections: [{ specimen_id: SPEC, collected_at_device: collectedDevice, barcode_verified: true }] } } as never);
    expect(w.row['status']).toBe('in_transit');
    expect(iso(w.row['collected_at'])).toBe(collectedDevice);
    expect(iso(w.row['in_transit_at'])).toBe(ISO_NOW);   // max(now, collected) = now: the clock is 05:00Z, collected 03:00Z
  });
});

// ------------------------------------------------------------------------------ result entry (critical value -> detectedAt) and approve / sign-off / amend, over the T-17 fixture
const entryRow = (resultId: string) => ({ resultId, rowVersion: 3, status: 'pending', orderId: ORDER, orderItemId: ITEM, specimenId: SPEC1, patientId: PATIENT, testId: 't-cbc', analyteId: 'a-HB', centreId: CENTRE,
  currentVersionNo: 1, sex: 'female', patientAgeDays: 10950, specimenTypeCode: 'WB', unitCode: 'g/dL', analyte: { id: 'a-HB', code: 'HB', resultType: 'numeric', decimals: 1 } });

describe.each(CLOCKS)('lab result write paths, %s', (_n, clock) => {
  it('manual entry of a critical value: saved, the critical log row and the event carry detectedAt = the clock instant', async () => {
    const m = make();
    const ctx: any = { ...(m.ctx as any), now: clock };
    ctx.store = { ...ctx.store,
      async lockResults(_t: unknown, _x: unknown, ids: string[]) { return ids.map(entryRow); },
      async saveEntry(_t: unknown, _x: unknown, a: any) { m.log.push({ fn: 'saveEntry', tenantId: TENANT, arg: a, tx: m.tx }); return { id: a.resultId, version: a.expectedRowVersion + 1, status: 'resulted', origin: 'manual', order_id: ORDER,
        order_item_id: ITEM, specimen_id: SPEC1, test_id: 't-cbc', analyte_id: 'a-HB', analyte_code: 'HB', value_numeric: a.value?.numeric ?? null, flag: a.evaluation?.flag ?? null, on_hold: false }; } };
    const out = await bulkEnterResults(ctx, { entries: [{ resultId: id(1), version: 3, valueNumeric: '25.0' }] } as never);
    expect(out.results[0]).toMatchObject({ resultId: id(1), outcome: 'ok' });
    const crit = m.of('insertCriticalLog')[0]!.arg;
    expect(crit.detectedAt).toBe(ISO_NOW);
    expect(m.emitted.find((e) => e.type === 'lab.critical_value.detected.v1')?.input.payload.detected_at).toBe(ISO_NOW);
  });

  it('approve (plain two-step flow): approved_at, the store call and the R6 close carry the clock instant; readiness is evaluated', async () => {
    const m = make({ approveRows: [approveRow(id(1))] });
    const r = await approveResult({ ...(m.ctx as any), now: clock }, { resultId: id(1), version: 7 });
    expect(r).toMatchObject({ id: id(1), status: 'approved' });
    expect(m.stored('approve')[0].occurredAt).toBe(ISO_NOW);
    expect(m.stored('closeOpenCriticalEvents')[0].closedAt).toBe(ISO_NOW);
    expect(m.approvedEvents()[0]!.input.payload.approved_at).toBe(ISO_NOW);
    expect(m.stored('lockReadiness')).toEqual([ORDER]);
  });

  it('sign-off (LD-316 chain): the chain row signedAt and lab.result.signed_off.v1 signed_at carry the clock instant', async () => {
    const m = make({ approveRows: [approveRow(id(1))] });
    const appended: any[] = [];
    const ctx: any = { ...(m.ctx as any), now: clock };
    ctx.store = { ...ctx.store, signoffs: {
      async state() { return { count: 1, frozen: undefined, signers: ['someone-else'], entererMembershipId: undefined, policy: { level: 2, allowEntererVerify: true, requirePathologist: false } }; },
      async append(_t: unknown, _x: unknown, a: any) { appended.push(a); return { seq: 2, count: 2, required: 2 }; },
      async counters() { return new Map(); },
    } };
    ctx.ports = { ...ctx.ports, IdentityPort: { ...ctx.ports.IdentityPort, async getActor() { return { displayName: 'Synthetic Signer', roles: ['pathologist'], permissions: [], signature: {} }; } } };
    let err: unknown;
    try { await approveResult(ctx, { resultId: id(1), version: 7 }); } catch (e) { err = e; }
    noTypeError(err);
    expect(appended).toHaveLength(1);
    expect(appended[0].signedAt).toBe(ISO_NOW);
    const ev = m.emitted.find((e) => e.type === 'lab.result.signed_off.v1');
    expect(ev?.input.payload.signed_at).toBe(ISO_NOW);
  });

  it('amend an approved result: amended_at and the critical detection time carry the clock instant', async () => {
    const m = make({ amendRows: [amendRow(id(1))] });
    const r = await amendResult({ ...(m.ctx as any), now: clock }, { resultId: id(1), version: 9, value: { numeric: '25.0' }, reasonCode: 'syn_fix' } as never);
    expect(r).toMatchObject({ id: id(1) });
    const a = m.stored('amendResult')[0];
    expect(a.occurredAt).toBe(ISO_NOW);
    const crit = m.of('insertCriticalLog')[0]?.arg;
    if (crit) expect(crit.detectedAt).toBe(ISO_NOW);
  });
});

describe('lab clock: an invalid clock value is a typed refusal, never a TypeError', () => {
  it('ctx.now() returning garbage in approve -> LimsError (typed), not "toISOString is not a function"', async () => {
    const m = make({ approveRows: [approveRow(id(1))] });
    let err: any;
    try { await approveResult({ ...(m.ctx as any), now: () => 'garbage' }, { resultId: id(1), version: 7 }); } catch (e) { err = e; }
    expect(err, 'a garbage clock must not be accepted silently').toBeDefined();
    expect(err.name).toBe('LimsError');
  });
});
