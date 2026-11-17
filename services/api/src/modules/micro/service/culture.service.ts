// onSpecimenStatusChanged (02-TRD §8.2 row lab.specimen.status_changed.v1; PRD AC-01.1–01.9). Called by the worker consumer inside the C0 wrapper's transaction:
// this file opens no transaction and publishes no event (C10 produces none). Tenant comes from ctx.tenantId only; a foreign-tenant envelope is refused before any I/O.
// [CONV] a LabPort/CatalogPort failure rejects, so the job retries and dead-letters; "cannot place" (ambiguity) and "nothing to do" resolve.
import { LimsError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { assertCultureChildEditable, nextCultureStatus, type CultureStatus } from '../domain/culture.state.js';
import { finalDueAt, hoursSincePlanting, nextReadDueAt } from '../domain/schedule.js';
import { selectPlatingProtocol } from '../domain/selection.js';
import * as dto from '../mappers/culture.dto.js';
import * as sets from '../repository/codedsets.repo.js';
import * as cfg from '../repository/config.repo.js';
import * as repo from '../repository/cultures.repo.js';
import * as obsRepo from '../repository/observations.repo.js';
import * as plateRepo from '../repository/plates.repo.js';
import { cultureDetail, memberNames, testLookup, type ChainCtx } from './chain.service.js';

type Obj = Record<string, any>;
export interface SpecimenEventCtx {
  readonly tenantId: string | undefined; readonly actor: { readonly id: string }; readonly tx: any;
  readonly metrics: { inc(name: string, labels?: Record<string, string>): void };
  readonly ports: { LabPort: any; CatalogPort: any };
  isNewer(last: number | undefined, seq: number): boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const bad = (path: string): never => { throw new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' }]); };
export const uuid = (v: unknown, p: string): string => (typeof v === 'string' && UUID.test(v) ? v : bad(p));
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
    await repo.releaseOpenRecords(ctx.tx, { tenantId, cultureId: c['id'], userId });               // C9 effect (T-16): open instrument records -> pending_match / culture_cancelled
  }
}

// ================================================================ T-08: M3 setupCulture, M4 addCulturePlate, M5 discardCulturePlate, M6 recordCultureObservation
// (02-TRD §4.1, §5, §12, §13; PRD AC-03.1–03.4, AC-04.1–04.5; 07-SECURITY S-01, S-03, S-05). The request transaction is the unit of work: every refusal throws before or instead of a
// partial write. The culture is loaded FOR UPDATE first (RLS + tenant; absent = 404, same as another tenant's), THEN IdentityPort.assertRole(micro.culture.work, culture.centre_id) (02-CV §10.1).
// Error bodies are fixed text: no submitted value is echoed, nothing submitted is logged (TRD §11). Only M2 writes an access-log row.
export type WriteCtx = ChainCtx & { readonly actor: { readonly id: string; readonly membershipId?: string | undefined } };
type Out = { body: Obj; version?: number };

export const WORK = 'micro.culture.work';
const CODE = /^[a-z0-9_]{2,64}$/;
const ISO_UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const HOUR_MS = 3_600_000;
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown, p: string, max: number): string => (typeof v === 'string' && v.length >= 1 && v.length <= max ? v : bad(p));
export const code = (v: unknown, p: string): string => (typeof v === 'string' && CODE.test(v) ? v : bad(p));
const instant = (v: unknown, p: string): Date => {
  const d = typeof v === 'string' && ISO_UTC.test(v) ? new Date(v) : undefined;
  return d && !Number.isNaN(d.getTime()) && d.toISOString() === v ? d : bad(p);
};
export function strictKeys(o: Obj, allowed: readonly string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new LimsError('common.validation_failed', undefined, [{ path: `/${k.slice(0, 64)}`, code: 'common.unknown_field', message: 'Unknown field' }]);
}
export const conflict = (): never => { throw new LimsError('common.version_conflict'); };
export const needVersion = (v: number | undefined): number => { if (v === undefined) throw new LimsError('common.precondition_required'); return v >= 1 ? v : bad('/If-Match'); };
export const nowOf = (c: WriteCtx): Date => (typeof c.now === 'function' ? c.now() : new Date());

/** DB-raised P0001 (05-SCHEMA triggers) -> registry codes (02-TRD §12); the service pre-checks the same rules, the trigger is the backstop. */
export async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    const x = e as { code?: unknown; message?: unknown } | null;
    if (x?.code === 'P0001' && x.message === 'immutable_row') throw new LimsError('micro.report_final_locked');
    if (x?.code === 'P0001' && x.message === 'culture_invalid_transition') throw new LimsError('micro.culture_invalid_transition');
    throw e;
  }
}

/** Object first (404 when absent / not visible), then the permission with the object's centre. */
export async function loadForWork(c: WriteCtx, params: unknown): Promise<{ tx: any; tenantId: string; userId: string; row: Obj }> {
  if (typeof c?.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
  const id = uuid(isObj(params) ? params['culture_id'] : undefined, '/culture_id').toLowerCase();
  const row = await repo.lockCulture(c.tx as any, { tenantId: c.tenantId, id });
  if (!row) throw new LimsError('common.not_found');
  const identity = c.ports?.IdentityPort;
  if (!identity) throw new LimsError('auth.forbidden');   // fail closed
  await identity.assertRole(c, { permission: WORK, centreId: row['centre_id'] });
  return { tx: c.tx, tenantId: c.tenantId, userId: c.actor.id, row };
}

/** A client-given id must exist in the tenant (404) and belong to THIS culture (400 common.id_mismatch, S-03). */
export function sameCulture(owner: Obj | undefined, cultureId: string): void {
  if (!owner) throw new LimsError('common.not_found');
  if (String(owner['culture_id']) !== cultureId) throw new LimsError('common.id_mismatch');
}

interface PlateIn { media_code: string; incubation_text?: string }
function parsePlates(v: unknown): PlateIn[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 12) return bad('/plates');
  return v.map((p, i) => {
    if (!isObj(p)) return bad(`/plates/${i}`);
    strictKeys(p, ['media_code', 'incubation_text']);
    const out: PlateIn = { media_code: code(p['media_code'], `/plates/${i}/media_code`) };
    if (p['incubation_text'] !== undefined) out.incubation_text = str(p['incubation_text'], `/plates/${i}/incubation_text`, 120);
    return out;
  });
}

/** Every media code must be active in the resolved set (tenant over global). */
async function assertMedia(tx: any, tenantId: string, plates: readonly PlateIn[], at: (i: number) => string): Promise<void> {
  const rows = await sets.codeRows(tx, { view: 'media', tenantId, codes: [...new Set(plates.map((p) => p.media_code))] });
  plates.forEach((p, i) => { if (rows.get(p.media_code)?.['is_active'] !== true) bad(at(i)); });
}

// ---------------------------------------------------------------- M3
export async function setupCulture(c: WriteCtx, input: { params: unknown; ifMatch: number | undefined; body: unknown }): Promise<Out> {
  const { tx, tenantId, userId, row } = await loadForWork(c, input.params);
  const expected = needVersion(input.ifMatch);
  const b = isObj(input.body) ? input.body : bad('/');
  strictKeys(b, ['plating_protocol_id', 'specimen_site_code', 'planted_at', 'plates']);
  const protocolId = b['plating_protocol_id'] === undefined ? undefined : uuid(b['plating_protocol_id'], '/plating_protocol_id');
  const siteCode = b['specimen_site_code'] === undefined ? undefined : code(b['specimen_site_code'], '/specimen_site_code');
  const now = nowOf(c);
  const plantedAt = b['planted_at'] === undefined ? now : instant(b['planted_at'], '/planted_at');
  if (plantedAt.getTime() > now.getTime() || plantedAt.getTime() < now.getTime() - 72 * HOUR_MS) bad('/planted_at');   // 02-TRD §4.1 [CONV]: [now - 72 h, now]
  const given = b['plates'] === undefined ? undefined : parsePlates(b['plates']);

  if (Number(row['version']) !== expected) conflict();                                            // AC-03.4
  nextCultureStatus(row['status'] as CultureStatus, 'setup');                                     // AC-03.3: only awaiting_setup (C2)

  // Protocol: the one given (must be current and active), else the §4.2 selection; none = the caller supplies plates.
  let protocol: Obj | undefined;
  if (protocolId !== undefined) {
    protocol = await plateRepo.getProtocolForSetup(tx, { tenantId, id: protocolId });
    if (!protocol || protocol['is_active'] === false || protocol['superseded_at'] != null) bad('/plating_protocol_id');
  } else {
    const keys = (await repo.activeProtocolKeys(tx, tenantId)).map((k) => ({ protocol_code: k['protocol_code'], test_id: k['test_id'] ?? null, specimen_type_code: k['specimen_type_code'] ?? null, is_active: k['is_active'] !== false }));
    const picked = selectPlatingProtocol(keys, { test_id: row['test_id'], specimen_type_code: row['specimen_type_code'] });
    const current = picked === null ? undefined : await repo.currentProtocolByCode(tx, { tenantId, code: picked });
    if (current) protocol = await plateRepo.getProtocolForSetup(tx, { tenantId, id: current['id'] });
  }
  let plates: PlateIn[] | undefined = given;
  if (!plates) {
    const media = protocol ? await plateRepo.protocolMedia(tx, { tenantId, protocolId: protocol['id'] }) : [];
    plates = media.slice(0, 12).map((m) => (m['incubation_text'] == null ? { media_code: m['media_code'] } : { media_code: m['media_code'], incubation_text: m['incubation_text'] }));
    if (plates.length === 0) bad('/plates');                                                      // no protocol resolves and none given
  }
  await assertMedia(tx, tenantId, plates, (i) => `/plates/${i}/media_code`);
  if (siteCode !== undefined && (await sets.codeRows(tx, { view: 'specimen_sites', tenantId, codes: [siteCode] })).get(siteCode)?.['is_active'] !== true) bad('/specimen_site_code');

  const dflt = protocol ? 0 : Number((await cfg.getSettings(tx, { tenantId }))?.['default_final_no_growth_hours'] ?? 48);
  const finalDue = finalDueAt({ plantedAt, finalNoGrowthHours: protocol ? Number(protocol['final_no_growth_hours']) : null, defaultFinalNoGrowthHours: dflt });
  const nextRead = protocol ? nextReadDueAt({ plantedAt, readScheduleHours: protocol['read_schedule_hours'] }) : null;
  const cultureId = row['id'] as string;
  const membershipId = c.actor.membershipId ?? null;

  await guarded(async () => {
    const upd = await repo.setupCulture(tx, { tenantId, id: cultureId, expectedVersion: expected, userId, plantedAt, nextReadDueAt: nextRead, finalDueAt: finalDue,
      protocolId: protocol ? (protocol['id'] as string) : null, siteCode: siteCode ?? row['specimen_site_code'] ?? null });
    if (!upd) conflict();
    for (const [i, p] of plates!.entries()) {
      await plateRepo.insertPlate(tx, { id: uuidv7(), tenantId, centreId: row['centre_id'], cultureId, plateNo: i + 1, mediaCode: p.media_code, incubationText: p.incubation_text ?? null,
        parentPlateId: null, sourceIsolateId: null, plantedAt, membershipId, userId });
    }
    await repo.insertTransition(tx, { id: uuidv7(), tenantId, centreId: row['centre_id'], cultureId, from: 'awaiting_setup', to: 'incubating', reason: null, occurredAt: now.toISOString(), userId });
  });
  const fresh = (await repo.reloadCulture(tx, { tenantId, id: cultureId }))!;
  return { body: await cultureDetail(c, tx, tenantId, fresh), version: Number(fresh['version']) };
}

// ---------------------------------------------------------------- M4
export async function addCulturePlate(c: WriteCtx, input: { params: unknown; body: unknown }): Promise<Out> {
  const { tx, tenantId, userId, row } = await loadForWork(c, input.params);
  const b = isObj(input.body) ? input.body : bad('/');
  strictKeys(b, ['media_code', 'incubation_text', 'parent_plate_id', 'source_isolate_id', 'planted_at']);
  const mediaCode = code(b['media_code'], '/media_code');
  const incubation = b['incubation_text'] === undefined ? null : str(b['incubation_text'], '/incubation_text', 120);
  const parentId = b['parent_plate_id'] === undefined ? null : uuid(b['parent_plate_id'], '/parent_plate_id');
  const isolateId = b['source_isolate_id'] === undefined ? null : uuid(b['source_isolate_id'], '/source_isolate_id');
  const plantedAt = b['planted_at'] === undefined ? nowOf(c) : instant(b['planted_at'], '/planted_at');

  assertCultureChildEditable(row['status'] as CultureStatus);                                    // AC-04.5: final -> report_final_locked, cancelled -> invalid
  if (row['status'] === 'awaiting_setup') throw new LimsError('micro.culture_invalid_transition');   // [CONV] plates enter through setup (M3)
  const cultureId = row['id'] as string;
  await assertMedia(tx, tenantId, [{ media_code: mediaCode }], () => '/media_code');
  if (parentId !== null) sameCulture(await obsRepo.ownerOfPlate(tx, { tenantId, id: parentId }), cultureId);
  if (isolateId !== null) sameCulture(await plateRepo.ownerOfIsolate(tx, { tenantId, id: isolateId }), cultureId);

  const plateNo = (await plateRepo.maxPlateNo(tx, { tenantId, cultureId })) + 1;
  if (plateNo > 50) bad('/');                                                                     // culture_plates__no__ck (plate_no BETWEEN 1 AND 50); review T-08 #1
  const plate = await guarded(async () => plateRepo.insertPlate(tx, { id: uuidv7(), tenantId, centreId: row['centre_id'], cultureId, plateNo,
    mediaCode, incubationText: incubation, parentPlateId: parentId, sourceIsolateId: isolateId, plantedAt, membershipId: c.actor.membershipId ?? null, userId }));
  return { body: dto.plateDto(plate), version: Number(plate['version']) };
}

// ---------------------------------------------------------------- M5
export async function discardCulturePlate(c: WriteCtx, input: { params: unknown; ifMatch: number | undefined; body: unknown }): Promise<Out> {
  const { tx, tenantId, userId, row } = await loadForWork(c, input.params);
  const expected = needVersion(input.ifMatch);
  if (input.body !== undefined && !(isObj(input.body) && Object.keys(input.body).length === 0)) bad('/');
  const plateId = uuid((input.params as Obj)['plate_id'], '/plate_id').toLowerCase();
  const plate = await plateRepo.getPlateForUpdate(tx, { tenantId, id: plateId });
  sameCulture(plate, row['id'] as string);
  assertCultureChildEditable(row['status'] as CultureStatus);                                    // AC-04.5
  if (Number(plate!['version']) !== expected) conflict();
  if (plate!['status'] === 'discarded') return { body: dto.plateDto(plate!), version: Number(plate!['version']) };   // [CONV] already discarded: nothing to do, same answer
  const done = await guarded(() => plateRepo.discardPlate(tx, { tenantId, id: plateId, expectedVersion: expected, userId }));
  if (!done) return conflict();
  return { body: dto.plateDto(done), version: Number(done['version']) };
}

// ---------------------------------------------------------------- M6
const KINDS = ['plate_read', 'gram_stain', 'microscopy', 'other'];
export async function recordCultureObservation(c: WriteCtx, input: { params: unknown; body: unknown }): Promise<Out> {
  const { tx, tenantId, userId, row } = await loadForWork(c, input.params);
  const b = isObj(input.body) ? input.body : bad('/');
  strictKeys(b, ['kind', 'plate_id', 'growth_code', 'quantity_text', 'finding_text', 'observed_at', 'corrects_observation_id']);
  const kind = typeof b['kind'] === 'string' && KINDS.includes(b['kind']) ? b['kind'] : bad('/kind');
  const isRead = kind === 'plate_read';
  const plateId = b['plate_id'] === undefined ? (isRead ? bad('/plate_id') : null) : uuid(b['plate_id'], '/plate_id');
  const growthCode = b['growth_code'] === undefined ? (isRead ? bad('/growth_code') : null) : code(b['growth_code'], '/growth_code');
  const finding = b['finding_text'] === undefined ? (isRead ? null : bad('/finding_text')) : str(b['finding_text'], '/finding_text', 2000);
  const quantity = b['quantity_text'] === undefined ? null : str(b['quantity_text'], '/quantity_text', 80);
  const correctsId = b['corrects_observation_id'] === undefined ? null : uuid(b['corrects_observation_id'], '/corrects_observation_id');
  const now = nowOf(c);
  const observedAt = b['observed_at'] === undefined ? now : instant(b['observed_at'], '/observed_at');

  const status = row['status'] as CultureStatus;
  assertCultureChildEditable(status);                                                            // AC-04.5
  const cultureId = row['id'] as string;
  let grows = false;
  if (growthCode !== null) {
    const g = (await sets.codeRows(tx, { view: 'growth_codes', tenantId, codes: [growthCode] })).get(growthCode);
    if (g?.['is_active'] !== true) bad('/growth_code');
    grows = g?.['indicates_growth'] === true;
  }
  if (plateId !== null) sameCulture(await obsRepo.ownerOfPlate(tx, { tenantId, id: plateId }), cultureId);
  if (correctsId !== null) sameCulture(await obsRepo.ownerOfObservation(tx, { tenantId, id: correctsId }), cultureId);   // AC-04.4: a correction is a NEW row
  const planted = row['planted_at'] == null ? null : new Date(row['planted_at']);
  const hours = planted === null ? null : hoursSincePlanting(planted, observedAt);
  if (hours !== null && Math.abs(hours) >= 1_000_000) bad('/observed_at');                       // numeric(8,2)

  const membershipId = c.actor.membershipId ?? null;
  const observation = await guarded(async () => {
    const o = await obsRepo.insertObservation(tx, { id: uuidv7(), tenantId, centreId: row['centre_id'], cultureId, plateId, kind, growthCode, quantityText: quantity, findingText: finding,
      observedAt, hoursSincePlanting: hours, membershipId, correctsId, userId });
    if (isRead && (status === 'incubating' || status === 'growth_detected')) {
      const to = status === 'incubating' && grows ? nextCultureStatus(status, 'growth') : status;                        // AC-04.1 (C3) / AC-04.2
      const current = row['next_read_due_at'] == null ? null : new Date(row['next_read_due_at']);
      let next = current;
      const protocol = row['plating_protocol_id'] && planted ? await repo.getProtocol(tx, { tenantId, id: row['plating_protocol_id'] }) : undefined;
      if (protocol && planted) {
        next = nextReadDueAt({ plantedAt: planted, readScheduleHours: protocol['read_schedule_hours'], latestReadObservedAt: await obsRepo.latestReadAt(tx, { tenantId, cultureId }) });   // TRD §4.1
      }
      if (to !== status || (next?.getTime() ?? null) !== (current?.getTime() ?? null)) {
        await repo.updateAfterRead(tx, { tenantId, id: cultureId, status: to, nextReadDueAt: next, userId });
        if (to !== status) await repo.insertTransition(tx, { id: uuidv7(), tenantId, centreId: row['centre_id'], cultureId, from: status, to, reason: null, occurredAt: now.toISOString(), userId });
      }
    }
    return o;
  });
  const fresh = (await repo.reloadCulture(tx, { tenantId, id: cultureId }))!;
  const name =await memberNames(c, [membershipId]);
  return { body: { observation: dto.observationDto(observation, name(membershipId), false), culture: dto.cultureSummaryDto(fresh, await testLookup(c)(fresh['test_id']), now) } };
}
