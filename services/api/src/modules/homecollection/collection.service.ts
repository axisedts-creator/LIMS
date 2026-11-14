// HC-T13: H9 reviewHeldCollection (01-PRD US-09-1..4; 02-TRD §5.1 H9 + §8.1 trigger (b) = CR-C17-006; 03-APP-FLOW §1.2 C3 apply / C4 discard; CR-C17-007 = collection_not_held).
// Order of checks: permission without a centre (403, before any lookup: no existence oracle) -> id (400) -> If-Match present (428) -> body (400) -> load (404) -> lock the visit + assertRole on its centre (403)
// -> re-read the collection under the lock -> state (409 collection_not_held) -> version (409 common.version_conflict) -> apply guards (409 mutation_superseded / 422 barcode_mismatch) -> write.
// Apply emits ONE homecollection.collection.synced.v1 with THIS collection only (typed publisher of HC-T12); the visit row lock serialises two reviews and a push of the same visit (the loser re-reads: not held).
// Discard emits nothing. A thrown error rolls the whole request tx back (no event without the row). Logs: none (07 §6: no barcode / free text / PHI anywhere in a log line).
import { LimsError } from '../../core/errors.js';
import { assertCollectionTransition, type CollectionStatus } from './domain/collection.state.js';
import { createHomecollectionEvents } from './events/publish.js';
import { toCollectionDto } from './mappers/visit.mapper.js';
import { HOMECOLLECTION_PERMISSIONS } from './permissions.js';
import { getCollectionById, listAppliedCollectionsBySpecimenIds, updateCollection } from './repository/collections.repo.js';
import { listVisitFlagsByVisit, updateVisitFlag } from './repository/visitFlags.repo.js';
import { lockVisitsForUpdate } from './repository/visits.repo.js';
import { bad, dctxOf, expectedVersionOf, isObj, noExtra, type Obj, type Result } from './route.service.js';
import { staffNames, userNames, uuidParam } from './service/visitRead.service.js';

const PERM_VISIT_ASSIGN = HOMECOLLECTION_PERMISSIONS[1];   // 'homecollection.visit.assign'
/**
 * 05-SCHEMA §2 review_reasons (global seed, D-130); `other` = requires_text.
 * ponytail: mirrors the seed migration, same as visit.service.ts REASONS. Read reasons.repo once P-1 seeds it in every environment.
 */
const REASONS: Readonly<Record<string, readonly string[]>> = {
  review_reasons: ['confirmed_with_phlebotomist', 'order_still_valid', 'specimen_destroyed', 'duplicate_draw', 'wrong_patient', 'other'],
};
const superseded = (): LimsError => new LimsError('homecollection.mutation_superseded');

/** `{ decision: apply | discard, reason_code (review_reasons), reason_text?: 1..500 }`; `other` needs the text. */
function parseReview(body: unknown): { decision: 'apply' | 'discard'; code: string; text: string | null } {
  if (!isObj(body)) throw new LimsError('common.validation_failed');
  noExtra(body, ['decision', 'reason_code', 'reason_text']);
  const d = body['decision'], c = body['reason_code'], t = body['reason_text'];
  if (d !== 'apply' && d !== 'discard') throw bad('/decision');
  if (typeof c !== 'string' || !(REASONS['review_reasons'] ?? []).includes(c)) throw bad('/reason_code');
  if (t !== undefined && (typeof t !== 'string' || t.includes('\u0000') || [...t].length < 1 || [...t].length > 500)) throw bad('/reason_text');
  if (c === 'other' && t === undefined) throw bad('/reason_text');
  return { decision: d, code: c, text: typeof t === 'string' ? t : null };
}

/** C3 guards that need other contexts: the order is active in C4 and the specimen is still `ordered` in C5; no other applied collection holds the specimen. */
async function assertApplicable(ctx: ReturnType<typeof dctxOf>, col: Obj, visit: Obj): Promise<void> {
  if (col['hold_code'] === 'homecollection.barcode_mismatch') throw new LimsError('homecollection.barcode_mismatch');
  const order = await ctx.ports.FrontdeskPort['getOrderSummary'](ctx, { orderId: visit['order_id'] });   // a port failure propagates: never a silent apply
  if (order?.status === 'cancelled') throw superseded();
  const refs: Obj[] = (await (ctx.ports as Obj)['LabPort']['lookupSpecimens'](ctx, { orderId: visit['order_id'] })) ?? [];
  const ref = refs.find((r) => r['specimenId'] === col['specimen_id']);
  if (!ref || ref['status'] !== 'ordered' || ref['isActive'] === false) throw superseded();
  if ((await listAppliedCollectionsBySpecimenIds(ctx.tx, ctx.tenantId, [col['specimen_id']])).some((a) => a['id'] !== col['id'])) throw superseded();
}

export async function reviewHeldCollection(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const ctx = dctxOf(hctx);
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: PERM_VISIT_ASSIGN });                    // 07 §4 item 5: a phlebotomist never reaches the lookup
  const collectionId = uuidParam(isObj(params) ? params['collection_id'] : undefined, '/collection_id');
  const expectedVersion = expectedVersionOf(headers);
  const review = parseReview(body);

  const first = await getCollectionById(ctx.tx, ctx.tenantId, collectionId);                          // tenant-filtered: another tenant's id is a 404
  if (!first) throw new LimsError('common.not_found');
  const visit = (await lockVisitsForUpdate(ctx.tx, ctx.tenantId, [first['visit_id']]))[0];
  if (!visit) throw new LimsError('common.not_found');
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: PERM_VISIT_ASSIGN, centreId: visit['centre_id'] });
  const col = await getCollectionById(ctx.tx, ctx.tenantId, collectionId);                            // under the lock: a concurrent review is visible now
  if (!col) throw new LimsError('common.not_found');

  const target: CollectionStatus = review.decision === 'apply' ? 'applied' : 'discarded';
  if (col['status'] !== 'held') throw new LimsError('homecollection.collection_not_held');            // applied | discarded: a second review loses (CR-C17-007)
  assertCollectionTransition('held', target);                                                         // C3 / C4: only `held` -> applied | discarded
  if (Number(col['version']) !== expectedVersion) throw new LimsError('common.version_conflict');
  if (review.decision === 'apply') await assertApplicable(ctx, col, visit);

  const now = new Date(ctx.now());
  let appliedEventId: string | undefined;
  if (review.decision === 'apply') {                                                                  // CR-C17-006: ONE event, this collection only, the corrected capture time (TRD §7.5)
    const sent = await createHomecollectionEvents((ctx as Obj)['events']).collectionSynced(ctx, {
      visit_id: visit['id'], order_id: visit['order_id'], phlebotomist_membership_id: col['collected_by_membership_id'],
      ...(visit['kind'] === 'booking' && visit['booking_id'] ? { booking_id: visit['booking_id'] } : {}),
      synced_at: now.toISOString(),
      collections: [{ client_mutation_id: col['client_mutation_id'], specimen_id: col['specimen_id'], barcode_verified: col['barcode_verified'] === true, collected_at_device: new Date(col['collected_at']).toISOString() }],
    }, { visitVersion: Number(visit['version']) });
    appliedEventId = sent.eventId;
  }
  const row = await updateCollection(ctx.tx, ctx.tenantId, collectionId, expectedVersion, {
    status: target, review_decision: review.decision, review_reason_code: review.code, review_reason_text: review.text, reviewed_by: ctx.actor.id, reviewed_at: now,
    ...(appliedEventId ? { applied_event_id: appliedEventId } : {}),
  });
  if (!row) throw new LimsError('common.version_conflict');

  // the held_collection work item is done either way (discard: US-09-3 "flag resolved with the reason"; [CONV] apply resolves it too)
  const flag = (await listVisitFlagsByVisit(ctx.tx, ctx.tenantId, visit['id'])).find((f) => f['kind'] === 'held_collection' && f['status'] === 'open' && f['related_id'] === collectionId);
  if (flag && !(await updateVisitFlag(ctx.tx, ctx.tenantId, flag['id'], Number(flag['version']), { status: 'resolved', resolution_code: review.code, resolution_note: review.text, resolved_by: ctx.actor.id, resolved_at: now }))) {
    throw new LimsError('common.version_conflict');
  }

  const me = ctx.actor.membershipId;
  const staff = await staffNames(ctx, [...new Set([String(row['collected_by_membership_id']), ...(me ? [me] : [])])]);   // ONE batched call (P-17)
  const users = me && staff.has(me) ? new Map([[ctx.actor.id, staff.get(me)!]]) : await userNames(ctx, [ctx.actor.id]);
  return { status: 200, body: toCollectionDto(row, { staff, users }) };
}
