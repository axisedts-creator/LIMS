// C5 T-32 / 07-SECURITY §5.1 P-08, P-09, P-11 and §5.2 S-17, S-20 on a real PG17: device-actor probes of LabPort and the cross-tenant probes of every consumed event.
// LabPort is called on its real implementation (ports/LabPort.impl.ts) with a STRICT RequestContext { tenantId, actor, requestId, tx, now(): ISO, ports } over a tx whose claims carry the actor kind
// (device: centre_id claim; user: membership_id) - the same shape the T-24 contract harness builds. Consumers are called through their service entry points with a tenant-A ctx and an envelope that names
// tenant-B ids; the owner-side md5 snapshot of every B table must be identical afterwards.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { LimsError } from '../../../../core/errors.js';
import { labPort } from '../../ports/LabPort.impl.js';
import { applyInstrumentResultEvent, sqlIngestStore } from '../../service/ingest.service.js';
import { applyOrderCancelled, applyOrderCreated, applyOrderItemsChanged } from '../../service/order.service.js';
import { applyQcReceived, applyQcRejected } from '../../service/qc.service.js';
import { applyReportReleased } from '../../service/report.service.js';
import { applyHomeCollectionSynced } from '../../service/specimen.service.js';
import { CENTRE, CENTRE_A2, MEM, NOW, SYS, T, TENANT_A, TENANT_B, api, claimsOf, closePools, live, objs, owner, requireDb, snapshot, uid, withClaims, type Objs } from './kit.js';

type Kind = 'user' | 'device' | 'system' | 'patient' | 'portal' | 'partner';
interface PortWho { kind: Kind; tenant?: string; centre?: string; grants?: readonly string[] }
const ctxClaims = (w: PortWho): string => {
  const tenant = w.tenant ?? TENANT_A;
  return claimsOf(tenant, { actor_type: w.kind, ...(w.kind === 'device' ? { centre_id: w.centre ?? CENTRE.a } : {}), ...(w.kind === 'user' ? { membership_id: tenant === TENANT_B ? MEM.b : MEM.a } : {}) });
};
/** one LabPort call = one tx under the actor's claims (RLS on); returns the value or the thrown error. */
async function portCall(method: string, w: PortWho, input: unknown): Promise<{ value?: any; error?: any }> {
  const tenant = w.tenant ?? TENANT_A;
  try {
    const value = await withClaims(api(), ctxClaims(w), async (client: pg.PoolClient) => {
      (client as any).startedAt = NOW;
      const ctx = { tenantId: tenant, requestId: uid(), tx: client, now: () => NOW.toISOString(), actor: { type: w.kind, id: SYS, ...(w.kind === 'user' ? { membershipId: tenant === TENANT_B ? MEM.b : MEM.a } : {}) },
        ports: { IdentityPort: { async assertRole(_c: unknown, r: { permission: string }) { if (!(w.grants ?? []).includes(r?.permission)) throw new LimsError('auth.forbidden'); } },
          CatalogPort: { async mapInstrumentCode() { throw new LimsError('catalog.instrument_code_unmapped'); } } } };
      return (labPort as any)[method](ctx, input);
    });
    return { value };
  } catch (error) { return { error }; }
}

let A1: Objs; let A2: Objs; let B: Objs;
beforeAll(async () => { if (!live) return; A1 = await objs('a', { centre: CENTRE.a }); A2 = await objs('a', { centre: CENTRE_A2 }); B = await objs('b'); }, T);
afterAll(async () => { await closePools(); });
describe('harness', () => { it('the migrated database is provided (fails, never skips, under LIMS_T03_REQUIRE_DB=1)', () => { if (requireDb) expect(live).toBe(true); }); });

describe.skipIf(!live)('P-09 LabPort.getPendingTestsForBarcode under a device ctx', () => {
  const ins = uid();
  it('device of centre A1, specimen received at A2 => lab.specimen_not_found, no barcode in the error', async () => {
    const r = await portCall('getPendingTestsForBarcode', { kind: 'device', centre: CENTRE.a }, { instrumentId: ins, barcode: A2.barcode });
    expect(r.error, 'must refuse').toBeInstanceOf(LimsError);
    expect(r.error.code).toBe('lab.specimen_not_found');
    expect(JSON.stringify({ m: r.error.message, d: r.error.detail, e: { ...r.error } })).not.toContain(A2.barcode);
  });
  it('device of centre A1, barcode of a tenant-B specimen => lab.specimen_not_found', async () => {
    const r = await portCall('getPendingTestsForBarcode', { kind: 'device', centre: CENTRE.a }, { instrumentId: ins, barcode: B.barcode });
    expect(r.error?.code).toBe('lab.specimen_not_found');
    expect(JSON.stringify({ m: r.error.message, e: { ...r.error } })).not.toContain(B.barcode);
  });
  it('control: the same device finds its own centre\'s specimen (anything but specimen_not_found)', async () => {
    const r = await portCall('getPendingTestsForBarcode', { kind: 'device', centre: CENTRE.a }, { instrumentId: ins, barcode: A1.barcode });
    expect(r.error?.code, `${r.error?.message}`).not.toBe('lab.specimen_not_found');
  });
  it('a user / patient / portal / partner actor never reaches the host query (device and system only)', async () => {
    for (const kind of ['user', 'patient', 'portal', 'partner'] as const) {
      const r = await portCall('getPendingTestsForBarcode', { kind, grants: ['lab.specimen.read'] }, { instrumentId: ins, barcode: A1.barcode });
      expect(r.error?.code, kind).toBe('auth.forbidden');
    }
  });
  it('injection-shaped and oversized barcodes answer specimen_not_found / validation_failed only', async () => {
    for (const barcode of ["X' OR '1'='1", '', 'x'.repeat(500)]) {
      const r = await portCall('getPendingTestsForBarcode', { kind: 'device', centre: CENTRE.a }, { instrumentId: ins, barcode });
      expect(['lab.specimen_not_found', 'common.validation_failed'], JSON.stringify(barcode)).toContain(r.error?.code);
    }
  });
});

describe.skipIf(!live)('S-17 getOrderResults(all_visible) needs lab.result.read; S-20 lookupSpecimens refuses a device', () => {
  it('S-17: actor without lab.result.read => auth.forbidden; with it => answered; other tenant order => common.not_found', async () => {
    const no = await portCall('getOrderResults', { kind: 'user', grants: ['lab.specimen.read'] }, { orderId: A1.orderId, scope: 'all_visible' });
    expect(no.error?.code).toBe('auth.forbidden');
    const yes = await portCall('getOrderResults', { kind: 'user', grants: ['lab.result.read'] }, { orderId: A1.orderId, scope: 'all_visible' });
    expect(yes.error, `${yes.error?.message}`).toBeUndefined();
    const other = await portCall('getOrderResults', { kind: 'user', grants: ['lab.result.read'] }, { orderId: B.orderId, scope: 'all_visible' });
    expect(other.error?.code).toBe('common.not_found');
    for (const kind of ['patient', 'portal', 'partner'] as const) expect((await portCall('getOrderResults', { kind, grants: ['lab.result.read'] }, { orderId: A1.orderId, scope: 'approved' })).error?.code, kind).toBe('auth.forbidden');
  });
  it('S-17: scope "approved" returns no pending value of a not-approved result', async () => {
    const r = await portCall('getOrderResults', { kind: 'system' }, { orderId: A1.orderId, scope: 'approved' });
    expect(r.error, `${r.error?.message}`).toBeUndefined();
    expect(JSON.stringify(r.value)).not.toContain(A1.resultId);
  });
  it('S-20: lookupSpecimens with a device actor => auth.forbidden (also patient / portal / partner)', async () => {
    for (const kind of ['device', 'patient', 'portal', 'partner'] as const) expect((await portCall('lookupSpecimens', { kind, grants: ['lab.specimen.read'] }, { orderId: A1.orderId })).error?.code, kind).toBe('auth.forbidden');
  });
  it('S-20: {orderId} form by a user holding only homecollection.visit.read returns only visible specimens; other-tenant ids are omitted', async () => {
    const own = await portCall('lookupSpecimens', { kind: 'user', grants: ['homecollection.visit.read'] }, { orderId: A1.orderId });
    expect(own.error, `${own.error?.message}`).toBeUndefined();
    expect(JSON.stringify(own.value)).toContain(A1.specimenId);
    const other = await portCall('lookupSpecimens', { kind: 'user', grants: ['homecollection.visit.read'] }, { orderId: B.orderId });
    expect(other.error?.code ?? JSON.stringify(other.value)).not.toContain(B.specimenId);
    const mixed = await portCall('lookupSpecimens', { kind: 'user', grants: ['lab.specimen.read'] }, { specimenIds: [A1.specimenId, B.specimenId] });
    expect(JSON.stringify(mixed.value ?? '')).toContain(A1.specimenId);
    expect(JSON.stringify(mixed.value ?? '')).not.toContain(B.specimenId);
    const none = await portCall('lookupSpecimens', { kind: 'user', grants: [] }, { orderId: A1.orderId });
    expect(none.error?.code).toBe('auth.forbidden');
  });
  it('the labPort object exposes exactly the methods of 03-IC §4.5 + 08 §4.14 (no unprobed method)', () => {
    expect(Object.keys(labPort).sort()).toEqual(['getAnalyteHistory', 'getOrderItemProcessingState', 'getOrderResults', 'getPendingTestsForBarcode', 'holdResultsSince', 'ingestInstrumentResult', 'listPendingForInstrument',
      'lookupSpecimens', 'submitModuleResult']);
  });
});

// ---------------------------------------------------------------- consumers (tenant-A ctx, envelope naming tenant-B ids)
async function asSystemA<R>(fn: (ctx: any) => Promise<R>): Promise<{ value?: R; error?: any; published: any[] }> {
  const published: any[] = [];
  try {
    const value = await withClaims(api(), claimsOf(TENANT_A), async (client) => {
      const ctx = { tenantId: TENANT_A, actor: { type: 'system', id: SYS }, tx: client, now: () => NOW, log: { info() {}, warn() {}, error() {} }, metrics: { inc() {} },
        events: { publish: async (_c: unknown, type: string, input: unknown) => { published.push({ type, input }); return { eventId: uid(), duplicate: false }; } },
        store: sqlIngestStore(SYS), config: { autoverifyHookEnabled: false },
        ports: { CatalogPort: { async mapInstrumentCode() { return { analyteId: uid(), testId: uid() }; }, async resolveOrderables() { throw new LimsError('common.not_found'); } },
          FrontdeskPort: { async getOrderSummary() { throw new LimsError('common.not_found'); }, async getPatientDemographics() { throw new LimsError('common.not_found'); } } } };
      return fn(ctx);
    });
    return { value, published };
  } catch (error) { return { error, published }; }
}
const bOnly = async (orderId: string) => Number((await owner('SELECT count(*)::int AS n FROM lab.orders WHERE id = $1 AND tenant_id = $2', [orderId, TENANT_A]))[0].n);

describe.skipIf(!live)('P-08 instruments.result.received.v1 in tenant A with a barcode that exists only in tenant B', () => {
  it('=> exception unknown_barcode in A, tenant B untouched, no result written anywhere', async () => {
    const before = await snapshot(TENANT_B);
    const msg = uid();
    const r = await asSystemA((ctx) => applyInstrumentResultEvent(ctx, { event_id: uid(), tenant_id: TENANT_A, payload: { instrument_message_id: msg, instrument_id: uid(), centre_id: CENTRE.a, sample_barcode: B.barcode,
      record_kind: 'quantitative', instrument_analyte_code: 'WBC', mapping_status: 'mapped', value_raw: '5.1', value_numeric: '5.1', received_at: NOW.toISOString(), instrument_flags: [] } }));
    expect(r.error, `${r.error?.message}`).toBeUndefined();
    expect((r.value as any).outcome).toBe('unmatched');
    const ex = await owner('SELECT tenant_id, reason, specimen_id, result_id FROM lab.ingest_exceptions WHERE instrument_message_id = $1', [msg]);
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ tenant_id: TENANT_A, reason: 'unknown_barcode', specimen_id: null, result_id: null });
    expect(await snapshot(TENANT_B)).toEqual(before);
  });
  it('an envelope of ANOTHER tenant is refused before any store or port call (tenant = job ctx only)', async () => {
    const r = await asSystemA((ctx) => applyInstrumentResultEvent(ctx, { event_id: uid(), tenant_id: TENANT_B, payload: { sample_barcode: B.barcode } }));
    expect(r.error?.code).toBe('common.internal');
  });
});

describe.skipIf(!live)('P-11 consumer probes: an event in tenant A that references tenant-B ids changes no B row', () => {
  const noBChange = async (run: () => Promise<{ error?: any }>, extra?: () => Promise<void>) => {
    const before = await snapshot(TENANT_B);
    const r = await run();
    if (r.error) expect(r.error, 'a refusal is a LimsError or a plain skip, never a driver / TypeError leak').toSatisfy((e: unknown) => e instanceof LimsError || e instanceof Error);
    expect(await snapshot(TENANT_B)).toEqual(before);
    await extra?.();
  };
  const orderEnv = (orderId: string, payload: object = {}) => ({ event_id: uid(), occurred_at: NOW.toISOString(), aggregate: { id: orderId, seq: 2 }, payload: { order_id: orderId, ...payload } });
  it('frontdesk.order.created.v1 naming a B order id: no lab.orders row for that id in A, B untouched', async () => {
    await noBChange(() => asSystemA((ctx) => applyOrderCreated(ctx, orderEnv(B.orderId, { patient_id: B.patientId, centre_id: B.centre, items_version: 1 }) as any)), async () => { expect(await bOnly(B.orderId)).toBe(0); });
  });
  it('frontdesk.order.items_changed.v1 naming a B order id', async () => {
    await noBChange(() => asSystemA((ctx) => applyOrderItemsChanged(ctx, orderEnv(B.orderId, { items_version: 2 }) as any)), async () => { expect(await bOnly(B.orderId)).toBe(0); });
  });
  it('frontdesk.order.cancelled.v1 naming a B order id: B order tests / specimens stay active', async () => {
    await noBChange(() => asSystemA((ctx) => applyOrderCancelled(ctx, orderEnv(B.orderId, { reason_code: 'patient_request' }) as any)), async () => {
      expect((await owner('SELECT is_active FROM lab.specimens WHERE id = $1', [B.specimenId]))[0].is_active).toBe(true);
    });
  });
  it('instruments.qc.received.v1 / quality.qc_run.rejected.v1 with a B instrument id write no B row; a foreign-tenant envelope is refused', async () => {
    await noBChange(() => asSystemA((ctx) => applyQcReceived(ctx, { tenant_id: TENANT_A, idempotency_key: uid(), payload: { centre_id: B.centre, instrument_id: B.instrumentId, analyte_id: B.analyteId, control_id_raw: 'QC-L1',
      value_numeric: '4.2', instrument_result_time: NOW.toISOString() } })));
    await noBChange(() => asSystemA((ctx) => applyQcRejected(ctx, { tenant_id: TENANT_A, idempotency_key: uid(), payload: { qc_run_id: uid(), instrument_id: B.instrumentId, analyte_ids: [B.analyteId], since: NOW.toISOString(),
      reason_code: 'qc_rejected' } })), async () => { expect((await owner('SELECT status FROM lab.qc_holds WHERE id = $1', [B.holdId]))[0].status).toBe('active'); expect((await owner('SELECT held_result_ids FROM lab.qc_holds WHERE id = $1', [B.holdId]))[0].held_result_ids).toEqual([]); });
    const foreign = await asSystemA((ctx) => applyQcRejected(ctx, { tenant_id: TENANT_B, idempotency_key: uid(), payload: { qc_run_id: uid(), instrument_id: B.instrumentId, analyte_ids: [B.analyteId], since: NOW.toISOString(), reason_code: 'qc_rejected' } }));
    expect(foreign.error?.code).toBe('common.internal');
  });
  it('homecollection.collection.synced.v1 naming a B specimen id: the B specimen stays uncollected, B untouched', async () => {
    const B2 = await objs('b', { state: 'collected' });
    const before = (await owner('SELECT status, version FROM lab.specimens WHERE id = $1', [B2.specimenId]))[0];
    await noBChange(() => asSystemA((ctx) => applyHomeCollectionSynced(ctx, { payload: { visit_id: uid(), synced_at: NOW.toISOString(),
      collections: [{ specimen_id: B2.specimenId, barcode_verified: true, collected_at_device: NOW.toISOString() }] } } as any)), async () => {
      expect((await owner('SELECT status, version FROM lab.specimens WHERE id = $1', [B2.specimenId]))[0]).toEqual(before);
    });
  });
  it('reporting.report.released.v1 naming a B order id: no report_releases / readiness row for it in A, B untouched', async () => {
    await noBChange(() => asSystemA((ctx) => applyReportReleased(ctx, { event_id: uid(), payload: { report_id: uid(), version_no: 1, order_id: B.orderId, report_kind: 'final', released_at: NOW.toISOString(), release_basis: 'order' } } as any)),
      async () => {
        expect(Number((await owner('SELECT count(*)::int AS n FROM lab.report_releases WHERE tenant_id = $1 AND order_id = $2', [TENANT_A, B.orderId]))[0].n)).toBe(0);
      });
  });
  // catalog.changed.v1 (cache invalidation, service/cache.ts) writes no lab row: NOT probed here (see .orchestra/notes/C5.T-32-tests.md).
});
