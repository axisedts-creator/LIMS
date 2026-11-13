// onSpecimenStatusChanged (02-TRD §8.2 row lab.specimen.status_changed.v1; PRD AC-01.1–01.9). Called by the worker consumer inside the C0 wrapper's transaction:
// this file opens no transaction and publishes no event (C10 produces none). Tenant comes from ctx.tenantId only; a foreign-tenant envelope is refused before any I/O.
// [CONV] a LabPort/CatalogPort failure rejects, so the job retries and dead-letters; "cannot place" (ambiguity) and "nothing to do" resolve.
import { LimsError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import * as repo from '../repository/cultures.repo.js';

type Obj = Record<string, any>;
export interface SpecimenEventCtx {
  readonly tenantId: string | undefined; readonly actor: { readonly id: string }; readonly tx: any;
  readonly metrics: { inc(name: string, labels?: Record<string, string>): void };
  readonly ports: { LabPort: any; CatalogPort: any };
  isNewer(last: number | undefined, seq: number): boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (path: string): never => { throw new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' }]); };
const uuid = (v: unknown, p: string): string => (typeof v === 'string' && UUID.test(v) ? v : bad(p));
const text = (v: unknown, p: string): string => (typeof v === 'string' && v.length >= 1 && v.length <= 200 ? v : bad(p));

export async function onSpecimenStatusChanged(ctx: SpecimenEventCtx, event: Obj): Promise<void> {
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || event?.tenant_id !== tenantId) throw new LimsError('auth.forbidden');
  const p: Obj = event.payload ?? {};
  const specimenId = uuid(p['specimen_id'], '/payload/specimen_id');
  const toStatus = text(p['to_status'], '/payload/to_status');
  const seq = event.aggregate?.seq;
  if (!Number.isSafeInteger(seq)) bad('/aggregate/seq');
  const userId = ctx.actor.id;

  if (toStatus === 'received') return onReceived(ctx, tenantId, userId, seq, specimenId, p);
  if (toStatus === 'rejected') return onRejected(ctx, tenantId, userId, seq, specimenId, p);
  await repo.bumpSeqBySpecimen(ctx.tx, { tenantId, specimenId, seq, userId });     // every other status (x-extensible): last_specimen_seq only
}

async function onReceived(ctx: SpecimenEventCtx, tenantId: string, userId: string, seq: number, specimenId: string, p: Obj): Promise<void> {
  const orderId = uuid(p['order_id'], '/payload/order_id');
  const centreId = uuid(p['centre_id'], '/payload/centre_id');
  const patientId = uuid(p['patient_id'], '/payload/patient_id');
  const specimenType = text(p['specimen_type_code'], '/payload/specimen_type_code');
  const changedAt = text(p['changed_at'], '/payload/changed_at');
  const parentId = p['parent_specimen_id'] === undefined ? undefined : uuid(p['parent_specimen_id'], '/payload/parent_specimen_id');
  const ids: string[] | undefined = p['order_item_ids'] === undefined ? undefined
    : Array.isArray(p['order_item_ids']) ? p['order_item_ids'].map((i: unknown, n: number) => uuid(i, `/payload/order_item_ids/${n}`)) : bad('/payload/order_item_ids');

  const rctx = ctx as any;
  const order = await ctx.ports.LabPort.getOrderResults(rctx, { orderId, scope: 'all_visible' });
  const tests = new Map<string, Obj>();
  const test = async (id: string): Promise<Obj> => { if (!tests.has(id)) tests.set(id, await ctx.ports.CatalogPort.getTest(rctx, { testId: id })); return tests.get(id)!; };
  const items: { orderItemId: string; testId: string }[] = (order.items ?? []).filter((i: Obj) => ids === undefined || ids.includes(i.orderItemId));
  const candidates: { orderItemId: string; testId: string }[] = [];
  for (const it of items) {
    const t = await test(it.testId);
    if (t['workflowType'] !== 'microbiology') continue;
    if (ids === undefined && !(t['specimenTypeCodes'] ?? []).includes(specimenType)) continue;    // AC-01.4a specimen-type filter
    candidates.push(it);
  }
  if (candidates.length === 0) return;                                                           // AC-01.4: no microbiology item
  if (ids === undefined && (order.specimens ?? []).filter((s: Obj) => s['specimenTypeCode'] === specimenType && s['status'] !== 'rejected').length > 1) {
    ctx.metrics.inc('lims_micro_unmapped_received_total', { tenant_id: tenantId });              // cannot place the item: no culture, finish
    return;
  }

  for (const it of candidates) {
    const own = await repo.findByItemSpecimen(ctx.tx, { tenantId, orderItemId: it.orderItemId, specimenId });
    if (own) { if (ctx.isNewer(own['last_specimen_seq'], seq)) await repo.bumpSeq(ctx.tx, { tenantId, id: own['id'], seq, userId }); continue; }   // duplicate / creation key
    if (parentId !== undefined) {
      const parent = await repo.findByItemSpecimen(ctx.tx, { tenantId, orderItemId: it.orderItemId, specimenId: parentId });
      if (parent) {                                                                              // AC-01.8: aliquot of a specimen that already has a culture
        if (parent['status'] !== 'awaiting_setup') ctx.metrics.inc('lims_micro_aliquot_after_setup_total');
        else await repo.repoint(ctx.tx, { tenantId, id: parent['id'], specimenId, seq, userId });
        continue;                                                                                // never a culture for (I, aliquot)
      }
    }
    const row = await repo.insertCulture(ctx.tx, { id: uuidv7(), tenantId, centreId, orderId, orderItemId: it.orderItemId, specimenId, patientId, testId: it.testId,
      specimenTypeCode: specimenType, receivedAt: changedAt, seq, userId });
    if (row) await repo.insertTransition(ctx.tx, { id: uuidv7(), tenantId, centreId, cultureId: row['id'], from: null, to: 'awaiting_setup', reason: null, occurredAt: changedAt, userId });
  }
}

async function onRejected(ctx: SpecimenEventCtx, tenantId: string, userId: string, seq: number, specimenId: string, p: Obj): Promise<void> {
  const changedAt = text(p['changed_at'], '/payload/changed_at');
  for (const c of await repo.listBySpecimen(ctx.tx, { tenantId, specimenId })) {
    if (!ctx.isNewer(c['last_specimen_seq'], seq)) continue;                                      // AC-01.5 stale / duplicate
    if (c['status'] === 'cancelled') { await repo.bumpSeq(ctx.tx, { tenantId, id: c['id'], seq, userId }); continue; }
    if (c['has_report'] || c['status'] === 'final_submitted' || c['status'] === 'amending') {      // AC-01.7: a submitted report is never changed
      ctx.metrics.inc('lims_micro_specimen_rejected_after_report_total');
      await repo.bumpSeq(ctx.tx, { tenantId, id: c['id'], seq, userId });
      continue;
    }
    await repo.cancelForRejection(ctx.tx, { tenantId, id: c['id'], seq, userId });                // AC-01.6
    await repo.insertTransition(ctx.tx, { id: uuidv7(), tenantId, centreId: c['centre_id'], cultureId: c['id'], from: c['status'], to: 'cancelled', reason: 'specimen_rejected', occurredAt: changedAt, userId });
  }
}
