// FD-T12: order flags raised by the frontdesk consumers (02-TRD §3.1, §8.2; 08 A13 D-6, A2.12). Everything runs in ctx.tx (the job tx); no transaction, no connection of its own.
// The flag is the unit of work: a flag is inserted-if-absent (the partial unique indexes make a redelivery, and the rejected + status_changed pair, one row - D-6);
// the recollection SMS is a best-effort side effect that never fails or rolls back the flag (TRD §6.4).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import { createCoreRepo } from '../../../core/core-repo/index.js';
import { decodeCursor, encodeCursor, isoUtc } from '../mappers/patient.dto.js';
import { FRONTDESK_PERMISSIONS as P } from '../permissions.js';
import { lockOrderFlagById, pageOrderFlags, resolveOrderFlagRow, upsertOrderFlag } from '../repository/flags.repo.js';
import { bad, expectedVersion, isObj, patientCtx, strict, type PatientCtx, type Result } from './patient.service.js';
import { listConsentsByPatient } from '../repository/consents.repo.js';
import { getOrderById } from '../repository/orders.repo.js';
import { getPatientById } from '../repository/patients.repo.js';
import type { Tx } from '../repository/shared.repo.js';

type Obj = Record<string, any>;
export interface FlagCtx { readonly tenantId: string; readonly tx: Tx; readonly log?: any; readonly ports?: Record<string, any> }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const core = createCoreRepo({} as never);

/** The stored order of THIS tenant for an event-supplied id; null for a malformed or unknown id (the event is a hint, never a key into another tenant). */
export async function orderForEvent(c: FlagCtx, orderId: unknown): Promise<Obj | null> {
  return typeof orderId === 'string' && UUID.test(orderId) ? getOrderById(c.tx, c.tenantId, orderId) : null;
}

/** open recollection_required flag for the specimen; the centre comes from the stored order, never from the event. Idempotent. */
export async function raiseRecollectionFlag(c: FlagCtx, order: Obj, specimenId: string, sourceEventId?: string): Promise<void> {
  await upsertOrderFlag(c.tx, c.tenantId, { id: uuidv7(), centre_id: order['centre_id'], order_id: order['id'], kind: 'recollection_required', specimen_id: specimenId,
    ...(sourceEventId ? { source_event_id: sourceEventId } : {}) });
}

/** open booking_cancelled_after_registration flag (one per order); the order itself is never touched (08 A2.12). Idempotent. */
export async function raiseBookingCancelledFlag(c: FlagCtx, order: Obj): Promise<void> {
  await upsertOrderFlag(c.tx, c.tenantId, { id: uuidv7(), centre_id: order['centre_id'], order_id: order['id'], kind: 'booking_cancelled_after_registration' });
}

/**
 * recollection_request SMS (TRD §8.2): params exactly {lab_name, centre_phone}; the key is per specimen so the port dedupes every redelivery.
 * C4 decides tenant channel + consent (as registration does); the port decides the rest. Never throws.
 */
export async function sendRecollectionSms(c: FlagCtx & { ports: Record<string, any> }, order: Obj, specimenId: string): Promise<void> {
  try {
    const { IdentityPort: identity, NotificationPort: notify } = c.ports;
    if (!identity || !notify) return;
    const tenant = (await identity.getTenantSettings(c, { keys: ['branding', 'channels'] })) ?? {};
    if (tenant.channels?.smsEnabled !== true) return;
    const patient = await getPatientById(c.tx, c.tenantId, order['patient_id']);
    if (!patient || patient['anonymised_at'] != null || !patient['phone_e164']) return;
    if ((await listConsentsByPatient(c.tx, c.tenantId, patient['id']))[0]?.['sms'] !== true) return;
    const phone = (await core.centre(c as never, { centreId: order['centre_id'] })).phoneDisplay;
    if (!phone) return;                                    // nothing true to put in the message: the flag stays the work item
    await notify.sendSms(c, { recipient: { kind: 'patient', patientId: patient['id'] }, templateCode: 'frontdesk.recollection_request', purpose: 'recollection_request',
      params: { lab_name: String(tenant.branding?.displayName ?? ''), centre_phone: phone }, idempotencyKey: `${specimenId}:recollection_sms`,
      related: { entityType: 'specimen', entityId: specimenId } });
  } catch (e) {
    c.log?.warn?.({ code: String((e as { code?: unknown } | null)?.code ?? 'unknown'), specimen_id: specimenId }, 'recollection sms not attempted');
  }
}

// ======================= F22 listOrderFlags / F23 resolveOrderFlag (02-TRD §5.1; PRD US-FD-13) =======================
// One request = ctx.tx (RLS on) + explicit tenant filter. Centre scope = IdentityPort.getActor().centreScope (as F10/F11): outside it = not listed / 404, never 403.
// No log line: the free-text note never reaches the logs (07-SECURITY §5).
type DeskCtx = PatientCtx & { readonly core?: { membership?: (c: unknown, i: { membershipId: string }) => Promise<{ displayName: string }> } };
const KINDS = ['recollection_required', 'booking_cancelled_after_registration'];
const SORT = '-created_at';

async function scopeOf(c: DeskCtx): Promise<{ all: boolean; centreIds: readonly string[] }> {
  const s = (await c.ports.IdentityPort.getActor(c)).centreScope as { all?: boolean; centreIds?: readonly string[] } | undefined;
  return { all: s?.all === true, centreIds: s?.centreIds ?? [] };      // no scope = no centre (fail closed)
}

async function flagDto(c: DeskCtx, f: Obj): Promise<Obj> {
  let resolvedBy: Obj | undefined;
  if (f['resolved_by']) {     // [CONV] resolved_by holds the membership id (as getOrder); display name '' without a core lookup
    const look = c.core?.membership;
    const displayName = look ? await look(c, { membershipId: f['resolved_by'] }).then((m) => m.displayName, () => '') : '';
    resolvedBy = { membership_id: f['resolved_by'], display_name: displayName };
  }
  return Object.fromEntries(Object.entries({
    id: f['id'], order_id: f['order_id'], kind: f['kind'], status: f['status'], specimen_id: f['specimen_id'], created_at: isoUtc(f['created_at']),
    resolved_at: isoUtc(f['resolved_at']), resolved_by: resolvedBy, resolution_code: f['resolution_code'], version: Number(f['version']),
  }).filter(([, v]) => v !== undefined && v !== null));
}

export async function listOrderFlags(hctx: unknown, query: unknown): Promise<Result> {
  const c = patientCtx(hctx) as DeskCtx;
  await c.ports.IdentityPort.assertRole(c, { permission: P.orderRead });
  const q = strict(query ?? {}, ['status', 'kind', 'centre_id', 'cursor', 'limit']);
  const status = q['status'] ?? 'open';
  if (status !== 'open' && status !== 'resolved') throw bad('/status');
  if (q['kind'] !== undefined && !KINDS.includes(q['kind'])) throw bad('/kind');
  if (q['centre_id'] !== undefined && (typeof q['centre_id'] !== 'string' || !UUID.test(q['centre_id']))) throw bad('/centre_id');
  const raw = q['limit'];
  const limit = raw === undefined ? 50 : typeof raw === 'string' && /^[0-9]{1,3}$/.test(raw) ? Number(raw) : raw;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 200) throw bad('/limit');
  const after = q['cursor'] === undefined ? undefined : decodeCursor(q['cursor'], SORT);
  const scope = await scopeOf(c);
  const rows = await pageOrderFlags(c.tx, c.tenantId, { status, ...(q['kind'] ? { kind: q['kind'] } : {}), ...(q['centre_id'] ? { centreId: q['centre_id'] } : {}),
    ...(scope.all ? {} : { scopeCentreIds: scope.centreIds }) }, { limit: limit as number, ...(after ? { after } : {}) });
  const page = rows.slice(0, limit as number);
  const last = page[page.length - 1];
  return { status: 200, body: { data: await Promise.all(page.map((f) => flagDto(c, f))),
    page: { limit, ...(rows.length > (limit as number) && last ? { next_cursor: encodeCursor(SORT, last['sort_key'], last['id']) } : {}) } } };
}

export async function resolveOrderFlag(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c = patientCtx(hctx) as DeskCtx;
  await c.ports.IdentityPort.assertRole(c, { permission: P.orderEdit });
  const version = expectedVersion(headers);
  const b = strict(body, ['resolution_code', 'note']);
  const code = b['resolution_code'];
  // coded-set membership (frontdesk.flag_resolutions) is not checked here: no owner named in the spec (as the FD-T09 cancel reason)
  if (typeof code !== 'string' || code.length < 1 || code.length > 64 || code.includes('\u0000')) throw bad('/resolution_code');
  const note = b['note'];
  if (note !== undefined && (typeof note !== 'string' || note.length > 500 || note.includes('\u0000'))) throw bad('/note');
  const id = isObj(params) ? params['flag_id'] : undefined;
  const f = typeof id === 'string' && UUID.test(id) ? await lockOrderFlagById(c.tx, c.tenantId, id) : null;
  if (!f) throw new LimsError('common.not_found');
  const scope = await scopeOf(c);
  if (!scope.all && !scope.centreIds.includes(f['centre_id'])) throw new LimsError('common.not_found');
  if (f['status'] !== 'open') throw new LimsError('common.immutable_record');
  if (Number(f['version']) !== version) throw new LimsError('common.version_conflict');
  const row = await resolveOrderFlagRow(c.tx, c.tenantId, f['id'], version,
    { resolutionCode: code, ...(typeof note === 'string' ? { note } : {}), at: c.now(), by: c.actor.membershipId ?? c.actor.id });
  if (!row) throw new LimsError('common.version_conflict');
  return { status: 200, body: await flagDto(c, row) };
}
