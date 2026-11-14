// HC-T16 task homecollection.purge_retention (1st of month 03:10 Asia/Kathmandu, per_tenant; 02-TRD §10 review m#25, 05-SCHEMA §4.2, 08 A19 P-41, REQ-SEC-139, B15).
// "SELECT * FROM app.homecollection_anonymise_retired_visits(now() − retentionYears) (retentionYears from IdentityPort.getTenantSettings): anonymises address/landmark/coordinates/note/reason text of
//  closed visits and the copied handover_items.barcode; rows kept, never DELETE of class C/A rows."
// Live PG17 (tests/homecollection/HC-T16.pg.sh). The job runs as lims_worker under the SYSTEM actor's claims (the only role with EXECUTE on the DEFINER); FAKE CLOCK = ctx.now(). Missing env = HARD FAILURE.
// The DEFINER itself (T1-T5) is covered in anonymise_definer.live.test.ts; this file proves the TASK feeds it correctly.
// ASSUMED (spec silent; the implementer disputes if wrong):
//  - file tasks/purge_retention.ts exports `purgeRetention` (TaskHandler, payload {tenant_id}); payload.tenant_id != ctx.tenantId -> resolves, writes nothing.
//  - p_before = ctx.now() minus retentionYears calendar years (tests keep >= 30 days away from the cutoff). retentionYears is read through ctx.ports.identity.getTenantSettings with keys containing 'retentionYears'.
//  - fail closed: a port error propagates (queue retry); a retentionYears that is missing / not a positive integer (0, -1, NaN, '5', 1.5) makes the task THROW and anonymise nothing (0 would anonymise every closed visit).
//  - the task logs no address / barcode text.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TENANT_A, TENANT_B, closePools, runTask, uid } from './hc16.helpers.js';
import { collectedVisit, handOver, ownerRows, visitOf } from './hc16.fixtures.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
const NOW = '2026-11-13T12:00:00.000Z';
const yearsAgo = (y: number, plusDays = 0) => { const d = new Date(NOW); d.setUTCFullYear(d.getUTCFullYear() - y); return new Date(d.getTime() + plusDays * 86_400_000).toISOString(); };
let purgeRetention: (payload: any, ctx: any) => Promise<void>;
beforeAll(async () => { purgeRetention = (await import('../tasks/purge_retention.js')).purgeRetention; });
afterAll(async () => { await closePools(); });

type Closed = 'completed' | 'failed' | 'cancelled';
const PII = { address_text: 'Synthetic Lane 9, Ward 3', landmark: 'Near the synthetic well', latitude: 27.701234, longitude: 85.301234, note_for_phlebotomist: 'synthetic gate code note', status_reason_text: 'synthetic reason text' };
const times = (st: Closed, at: string) => st === 'completed' ? { status: st, outcome: 'collected', completed_at: at } : st === 'failed' ? { status: st, outcome: 'none', completed_at: null, failed_at: at } : { status: st, outcome: null, completed_at: null, cancelled_at: at };
/** closed visit (+ one applied tube and a handover item carrying a copied barcode) closed at `at` */
async function closed(s: 'a' | 'b', st: Closed, at: string) {
  const c = await collectedVisit(s, at, { visit: { ...PII, ...times(st, at) } });
  const { item } = await handOver(s, c);
  return { ...c, item };
}
const item = async (id: string) => (await ownerRows('homecollection.handover_items', 'id = $1', [id]))[0];
const run = (o: { tenant?: string; payload?: unknown; retentionYears?: number; raw?: Record<string, unknown>; err?: Error; calls?: unknown[][] } = {}) =>
  runTask(purgeRetention, 'payload' in o ? o.payload : { tenant_id: o.tenant ?? TENANT_A },o.tenant ?? TENANT_A, { now: NOW, ...(o.retentionYears !== undefined ? { retentionYears: o.retentionYears } : {}), ...(o.raw ? { rawSettings: o.raw } : {}), ...(o.err ? { settingsError: o.err } : {}), ...(o.calls ? { settingsCalls: o.calls } : {}) });
const anonymised = (v: any) => [v.address_text, v.landmark, v.latitude, v.longitude, v.note_for_phlebotomist, v.status_reason_text].every((x) => x === null);
const intact = (v: any) => v.address_text === PII.address_text && v.landmark === PII.landmark && v.note_for_phlebotomist === PII.note_for_phlebotomist && v.status_reason_text === PII.status_reason_text && Number(v.latitude) === PII.latitude;

describe('retention anonymisation of closed visits past retentionYears (default 5)', () => {
  it('a visit closed 5 y + 30 d ago is anonymised (all six P2 columns NULL, version++, row and status kept) and so is its copied handover barcode; one closed 5 y - 30 d ago is not', async () => {
    const old = await closed('a', 'completed', yearsAgo(5, -30)); const young = await closed('a', 'completed', yearsAgo(5, 30));
    const before = await visitOf(old.visit.id);
    const r = await run();
    expect(r.threw).toBeUndefined();
    const v = await visitOf(old.visit.id);
    expect(anonymised(v)).toBe(true);
    expect(v).toMatchObject({ status: 'completed', order_id: old.visit.order_id, patient_id: old.visit.patient_id, tenant_id: TENANT_A });
    expect(Number(v.version)).toBe(Number(before.version) + 1);
    expect((await item(old.item.id)).barcode).toBe('ANONYMISED');
    expect(intact(await visitOf(young.visit.id))).toBe(true);
    expect((await item(young.item.id)).barcode).toBe(young.item.barcode);
    // rows are kept: never a DELETE of class C/A rows
    for (const c of [old, young]) {
      expect((await ownerRows('homecollection.collections', 'id = $1', [c.col.id])).length).toBe(1);
      expect((await ownerRows('homecollection.handover_items', 'id = $1', [c.item.id])).length).toBe(1);
    }
  });
  it('failed and cancelled visits are closed visits too (their own closing time counts)', async () => {
    const f = await closed('a', 'failed', yearsAgo(5, -40)); const c = await closed('a', 'cancelled', yearsAgo(5, -40));
    expect((await run()).threw).toBeUndefined();
    for (const x of [f, c]) { expect(anonymised(await visitOf(x.visit.id))).toBe(true); expect((await item(x.item.id)).barcode).toBe('ANONYMISED'); }
  });
  it('open visits are never anonymised, however old: unassigned (no closing time) with PII and an old created_at stays intact', async () => {
    const c = await collectedVisit('a', yearsAgo(9), { visit: { ...PII, status: 'unassigned', outcome: null, completed_at: null, assigned_membership_id: null, assigned_at: null, created_at: yearsAgo(9) } });
    const { item: it } = await handOver('a', c);
    expect((await run()).threw).toBeUndefined();
    expect(intact(await visitOf(c.visit.id))).toBe(true);
    expect((await item(it.id)).barcode).toBe(it.barcode);
  });
  it('retentionYears comes from the tenant settings through the identity port: with 2 y a visit closed 3 y ago goes, with the default 5 y it stays', async () => {
    const mid = await closed('a', 'completed', yearsAgo(3));
    expect((await run({ retentionYears: 5 })).threw).toBeUndefined();
    expect(intact(await visitOf(mid.visit.id))).toBe(true);
    const calls: unknown[][] = [];
    expect((await run({ retentionYears: 2, calls })).threw).toBeUndefined();
    expect(anonymised(await visitOf(mid.visit.id))).toBe(true);
    expect((await item(mid.item.id)).barcode).toBe('ANONYMISED');
    expect(calls.some((a) => JSON.stringify(a[1] ?? {}).includes('retentionYears'))).toBe(true);   // a[0] is ctx (HC-T16 ruling)
  });
  it('idempotent monthly run: a second run changes nothing (no version bump on already anonymised rows)', async () => {
    const old = await closed('a', 'completed', yearsAgo(6));
    expect((await run()).threw).toBeUndefined();
    const snap = async () => JSON.stringify([await visitOf(old.visit.id), await item(old.item.id)]);
    const first = await snap();
    expect((await run()).threw).toBeUndefined();
    expect(await snap()).toBe(first);
  });
  it('tenant isolation: the run for tenant A leaves an equally old tenant-B visit and item intact (B\'s own run anonymises it)', async () => {
    const a = await closed('a', 'completed', yearsAgo(6)); const b = await closed('b', 'completed', yearsAgo(6));
    expect((await run({ tenant: TENANT_A })).threw).toBeUndefined();
    expect(anonymised(await visitOf(a.visit.id))).toBe(true);
    expect(intact(await visitOf(b.visit.id))).toBe(true);
    expect((await item(b.item.id)).barcode).toBe(b.item.barcode);
    expect((await run({ tenant: TENANT_B })).threw).toBeUndefined();
    expect(anonymised(await visitOf(b.visit.id))).toBe(true);
  });
  it('out of scope of the function (05-SCHEMA §4.2 notes): mutations.payload (class A) of an anonymised visit is not touched', async () => {
    const old = await closed('a', 'completed', yearsAgo(6));
    const mutBefore = JSON.stringify((await ownerRows('homecollection.mutations', 'id = $1', [old.mut.id]))[0].payload);
    expect((await run()).threw).toBeUndefined();
    expect(JSON.stringify((await ownerRows('homecollection.mutations', 'id = $1', [old.mut.id]))[0].payload)).toBe(mutBefore);
  });
});

describe('fail closed and guards', () => {
  it('a port error propagates (the queue retries) and nothing is anonymised', async () => {
    const old = await closed('a', 'completed', yearsAgo(6));
    const r = await run({ err: new Error('identity unavailable') });
    expect(String(r.threw)).toContain('identity unavailable');
    expect(intact(await visitOf(old.visit.id))).toBe(true);
  });
  it('retentionYears missing or not a positive integer (undefined, 0, -1, NaN, "5", 1.5, null) -> the task throws and anonymises NOTHING (0 would wipe every closed visit)', async () => {
    const old = await closed('a', 'completed', yearsAgo(1));
    for (const raw of [{}, { retentionYears: 0 }, { retentionYears: -1 }, { retentionYears: Number.NaN }, { retentionYears: '5' }, { retentionYears: 1.5 }, { retentionYears: null }]) {
      const r = await run({ raw });
      expect(r.threw, JSON.stringify(raw)).toBeDefined();
      expect(intact(await visitOf(old.visit.id)), JSON.stringify(raw)).toBe(true);
    }
  });
  it('payload.tenant_id different from ctx.tenantId, malformed payloads: resolves, anonymises nothing', async () => {
    const old = await closed('a', 'completed', yearsAgo(6));
    for (const p of [{ tenant_id: TENANT_B }, {}, null, 'x', { tenant_id: 'not-a-uuid' }, { tenant_id: uid() }]) expect((await run({ payload: p })).threw, JSON.stringify(p)).toBeUndefined();
    expect(intact(await visitOf(old.visit.id))).toBe(true);
  });
  it('logs no address, landmark, note or barcode', async () => {
    const old = await closed('a', 'completed', yearsAgo(6));
    const r = await run();
    expect(r.threw).toBeUndefined();
    const text = r.logs.join('\n');
    for (const s of [PII.address_text, PII.landmark, PII.note_for_phlebotomist, PII.status_reason_text, old.item.barcode]) expect(text).not.toContain(s);
  });
});
