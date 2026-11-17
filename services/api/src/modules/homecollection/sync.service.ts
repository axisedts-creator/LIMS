// HC-T12: A3 pushSyncMutations (POST /sync/mutations, homecollection.sync.upload) — 02-TRD §6.3, §7.5, §8.1; 03-APP-FLOW §4, §5.7; 01-PRD US-07 / US-08 / US-12-1,3; 07-SECURITY AB2-AB6, AB14, AB15.
// ONE transaction per batch (the core tx wrapper commits / rolls back): a thrown error (LabPort down -> 503, anything unexpected) leaves nothing behind.
// Per mutation, in device_seq order: SELECT the stored row (getMutationByClientId) -> guard (conflict.service.ts) -> INSERT with the outcome -> effects. sync_batches is inserted LAST (append-only table,
// mutations.batch_id FK is deferred). Identity = the claims (ctx.tenantId / ctx.actor.membershipId); a device belongs to its registering membership. SQL lives in repository/*.repo.ts only.
// Logs carry codes only: never a barcode, payload, reference, GPS or free text (07 §6). Events go through the typed publisher (events/publish.ts).
// [CONV] the device row is compare-and-bumped FIRST (last_push_at, max_device_seq_received = greatest(existing, max seq of the batch)): the row lock serialises concurrent pushes of one device
//   (the handover mutation has no visit row to lock) and a rollback undoes it. Visits are locked right after, in ascending id order.
// ponytail: a concurrent dispatcher action on a touched visit waits for this tx or loses with 409 version_conflict; its route-lock vs our visit-lock order is left to the deadlock detector.
import { createHash } from 'node:crypto';
import { LimsError } from '../../core/errors.js';
import { uuidv7 } from '../../../../../packages/shared-ts/src/uuidv7/index.js';
import { loadHomecollectionConfig } from './config.js';
import { CODE, HANDOVER_ITEM, decide, decideHandover, sortHandoverItems, type AssignmentFact, type FlagKind, type HandoverItemFact, type PriorFact, type Verdict } from './conflict.service.js';
import { APP_VERSION, UUID_V7, bad, belowMin, deviceIdOf, isObj, noExtra } from './device.service.js';
import { correctCapturedTime, type ClockAnchor } from './domain/clock.js';
import { isMutationType, mutationRequiresVisitId, validateMutationPayload, type MutationType } from './domain/mutation.js';
import { createHomecollectionEvents } from './events/publish.js';
import { hcMetrics } from './metrics.js';
import { HOMECOLLECTION_PERMISSIONS } from './permissions.js';
import { bumpVersion } from './route.service.js';
import { insertCollection, listAppliedCollectionsBySpecimenIds } from './repository/collections.repo.js';
import { getDeviceById, updateDevice } from './repository/devices.repo.js';
import { getActiveCentreId, getHandoverById, insertHandover, insertHandoverItem, listHandoverItemsByCollectionIds } from './repository/handovers.repo.js';
import * as mutations from './repository/mutations.repo.js';
import { getSettings } from './repository/settings.repo.js';
import type { Tx } from './repository/shared.repo.js';
import * as syncBatches from './repository/syncBatches.repo.js';
import { insertVisitFlag, listVisitFlagsByVisit } from './repository/visitFlags.repo.js';
import { listAssignmentsByVisit } from './repository/visitAssignments.repo.js';
import { insertVisitLocation } from './repository/visitLocations.repo.js';
import { listCollectionsByVisit } from './repository/visitQueries.repo.js';
import { insertVisitTransition } from './repository/visitTransitions.repo.js';
import { lockVisitsForUpdate, updateVisit } from './repository/visits.repo.js';
import { settingsDefaults } from './settings.service.js';

const PERM_SYNC_UPLOAD = HOMECOLLECTION_PERMISSIONS[5];   // 'homecollection.sync.upload'
type Obj = Record<string, any>;
type Result = { status: number; body?: unknown };
interface Ctx {
  readonly tenantId: string; readonly tx: Tx; readonly requestId?: string; readonly actor: { readonly id: string; readonly membershipId?: string };
  readonly centreId?: string;
  readonly now: () => Date | string;
  readonly log: { warn(o: object, m?: string): void };
  readonly ports: {
    readonly IdentityPort: { assertRole(ctx: unknown, r: { permission: string; centreId?: string }): Promise<void> };
    readonly LabPort: { lookupSpecimens(ctx: unknown, i: { orderId: string }): Promise<readonly Obj[]> };
  };
  readonly events: { publish(ctx: unknown, type: string, input: any): Promise<{ eventId: string; duplicate: boolean }> };
}
function ctxOf(c: unknown): Ctx {
  const x = c as Partial<Ctx> | null;
  if (typeof x?.tenantId !== 'string' || !x.tx || typeof x.actor?.id !== 'string' || typeof x.now !== 'function' || !x.ports?.IdentityPort || !x.ports.LabPort) throw new LimsError('auth.unauthenticated');   // fail closed
  if (typeof x.events?.publish !== 'function') throw new LimsError('common.internal');
  return x as Ctx;
}
const code = (e: unknown): string => (typeof (e as Obj)?.['code'] === 'string' ? (e as Obj)['code'] : 'unknown');

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// JCS (RFC 8785) payload hash — computed by the server, never taken from the device (review m#38). Payloads are JSON: strings, safe integers, booleans, null, arrays, objects.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export function canonicalize(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw bad('/payload'); return JSON.stringify(v); }   // ECMAScript number serialisation = the JCS number form
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(',')}}`;   // member names sorted by UTF-16 code units
  throw bad('/payload');
}
export const payloadSha256 = (payload: unknown): string => createHash('sha256').update(canonicalize(payload), 'utf8').digest('hex');

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// envelope (TRD §6.3 PushRequest; the core pipeline validates the OpenAPI schema first, this is the defence in depth + the checks the schema cannot express)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isoOf = (v: unknown, path: string): string => { if (typeof v !== 'string' || !ISO_UTC.test(v) || Number.isNaN(Date.parse(v))) throw bad(path); return v; };
const intOf = (v: unknown, min: number, path: string): number => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) throw bad(path); return v; };

interface Mut {
  readonly clientMutationId: string; readonly deviceSeq: number; readonly type: MutationType; readonly visitId: string | null;
  readonly captured: { readonly deviceWallTime: string; readonly anchorId: string; readonly elapsedSinceAnchorMs: number }; readonly payload: Obj;
}
interface Envelope {
  readonly deviceId: string; readonly batchId: string; readonly sentAtDevice: string; readonly anchors: Obj[];
  readonly now: { readonly deviceWallTime: string; readonly monotonicMs: number; readonly bootId: string }; readonly mutations: Mut[];
}

function parseGps(payload: Obj, path: string): void {
  const g = payload['gps'];
  if (!isObj(g) || g['status'] !== 'ok') return;
  const lat = Number(g['latitude']), lon = Number(g['longitude']);
  if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) throw bad(`${path}/gps`);   // visit_locations CHECK: a violation would abort the whole batch
}

function parseEnvelope(body: Obj): Envelope {
  noExtra(body, ['device_id', 'batch_id', 'sent_at_device', 'anchors', 'now', 'mutations']);
  const deviceId = deviceIdOf(body['device_id'], '/device_id'), batchId = deviceIdOf(body['batch_id'], '/batch_id');
  const sentAtDevice = isoOf(body['sent_at_device'], '/sent_at_device');
  const rawAnchors = body['anchors'];
  if (!Array.isArray(rawAnchors) || rawAnchors.length > 20) throw bad('/anchors');
  const anchors = rawAnchors.map((a, i): Obj => {
    if (!isObj(a)) throw bad(`/anchors/${i}`);
    noExtra(a, ['anchor_id', 'server_time', 'device_wall_time', 'monotonic_ms', 'boot_id']);
    if (typeof a['boot_id'] !== 'string' || a['boot_id'].length < 1 || a['boot_id'].length > 64) throw bad(`/anchors/${i}/boot_id`);
    return { anchor_id: deviceIdOf(a['anchor_id'], `/anchors/${i}/anchor_id`), server_time: isoOf(a['server_time'], `/anchors/${i}/server_time`), device_wall_time: isoOf(a['device_wall_time'], `/anchors/${i}/device_wall_time`),
      monotonic_ms: intOf(a['monotonic_ms'], 0, `/anchors/${i}/monotonic_ms`), boot_id: a['boot_id'] };
  });
  const n = body['now'];
  if (!isObj(n)) throw bad('/now');
  noExtra(n, ['device_wall_time', 'monotonic_ms', 'boot_id']);
  if (typeof n['boot_id'] !== 'string' || n['boot_id'].length < 1 || n['boot_id'].length > 64) throw bad('/now/boot_id');
  const now = { deviceWallTime: isoOf(n['device_wall_time'], '/now/device_wall_time'), monotonicMs: intOf(n['monotonic_ms'], 0, '/now/monotonic_ms'), bootId: n['boot_id'] };
  const raw = body['mutations'];
  if (!Array.isArray(raw) || raw.length < 1) throw bad('/mutations');
  const seen = new Set<string>();
  let last = 0;
  const list = raw.map((m, i): Mut => {
    const p = `/mutations/${i}`;
    if (!isObj(m)) throw bad(p);
    noExtra(m, ['client_mutation_id', 'device_seq', 'type', 'visit_id', 'captured', 'payload']);
    const clientMutationId = deviceIdOf(m['client_mutation_id'], `${p}/client_mutation_id`);
    if (seen.has(clientMutationId)) throw bad(`${p}/client_mutation_id`);
    seen.add(clientMutationId);
    const deviceSeq = intOf(m['device_seq'], 1, `${p}/device_seq`);
    if (deviceSeq <= last) throw bad(`${p}/device_seq`);   // strictly increasing inside the batch
    last = deviceSeq;
    const type = m['type'];
    if (!isMutationType(type)) throw bad(`${p}/type`);
    const visit = m['visit_id'];
    if (mutationRequiresVisitId(type) ? typeof visit !== 'string' || !UUID.test(visit) : visit !== undefined) throw bad(`${p}/visit_id`);
    const c = m['captured'];
    if (!isObj(c)) throw bad(`${p}/captured`);
    noExtra(c, ['device_wall_time', 'anchor_id', 'elapsed_since_anchor_ms']);
    if (typeof c['anchor_id'] !== 'string' || !UUID_V7.test(c['anchor_id'])) throw bad(`${p}/captured/anchor_id`);
    if (typeof c['elapsed_since_anchor_ms'] !== 'number' || !Number.isSafeInteger(c['elapsed_since_anchor_ms'])) throw bad(`${p}/captured/elapsed_since_anchor_ms`);
    if (!validateMutationPayload(type, m['payload']).ok) throw bad(`${p}/payload`);
    parseGps(m['payload'], `${p}/payload`);
    return { clientMutationId, deviceSeq, type, visitId: typeof visit === 'string' ? visit : null,
      captured: { deviceWallTime: isoOf(c['device_wall_time'], `${p}/captured/device_wall_time`), anchorId: c['anchor_id'], elapsedSinceAnchorMs: c['elapsed_since_anchor_ms'] }, payload: m['payload'] };
  });
  return { deviceId, batchId, sentAtDevice, anchors, now, mutations: list };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// batch state
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
interface Corrected { readonly iso: string; readonly ms: number; readonly source: string; readonly suspect: boolean }
interface EventAcc { collections: Obj[]; payments: Obj[] }
interface State {
  readonly ctx: Ctx; readonly tx: Tx; readonly tenantId: string; readonly author: string; readonly env: Envelope; readonly settings: Obj; readonly receivedAt: Date;
  readonly visits: Map<string, Obj>;
  readonly assignments: Map<string, AssignmentFact[]>; readonly prior: Map<string, PriorFact[]>; readonly flags: Map<string, Obj[]>;
  readonly lab: Map<string, readonly Obj[]>; readonly centreOk: Map<string, boolean>;
  readonly routes: Set<string>; readonly eventAcc: Map<string, EventAcc>;
  readonly results: Obj[]; readonly handoverItems: Obj[]; readonly unresolved: Obj[];
  readonly counts: { applied: number; held: number; rejected: number; duplicate: number };
}

function record(S: State, m: Mut, outcome: 'applied' | 'held' | 'rejected' | 'duplicate', c?: string): void {
  S.counts[outcome]++;
  hcMetrics.mutation(S.ctx, m.type, outcome);   // HC-T17: type + outcome only (TRD §14)
  S.results.push({ client_mutation_id: m.clientMutationId, device_seq: m.deviceSeq, outcome, ...(c ? { code: c } : {}) });
}

/** LabPort.lookupSpecimens({orderId}) once per distinct order (memoised). Any failure fails the whole batch: 503, nothing committed; the device retries the same frozen body. */
async function labFor(S: State, orderId: string): Promise<readonly Obj[]> {
  const hit = S.lab.get(orderId);
  if (hit) return hit;
  let refs: readonly Obj[];
  try { refs = await S.ctx.ports.LabPort.lookupSpecimens(S.ctx, { orderId }); }
  catch (e) { S.ctx.log.warn({ code: code(e) }, 'homecollection.lab_unavailable'); throw new LimsError('common.dependency_unavailable'); }
  if (!Array.isArray(refs)) throw new LimsError('common.dependency_unavailable');
  S.lab.set(orderId, refs);
  return refs;
}

/** 07 §5.2: the actor must hold sync.upload in the centre of the visit (cached per centre). */
async function centreAllowed(S: State, centreId: string): Promise<boolean> {
  const hit = S.centreOk.get(centreId);
  if (hit !== undefined) return hit;
  let ok = true;
  try { await S.ctx.ports.IdentityPort.assertRole(S.ctx, { permission: PERM_SYNC_UPLOAD, centreId }); }
  catch (e) { if (code(e) !== 'auth.forbidden') throw e; ok = false; }
  S.centreOk.set(centreId, ok);
  return ok;
}

async function assignmentsOf(S: State, visitId: string): Promise<AssignmentFact[]> {
  let rows = S.assignments.get(visitId);
  if (!rows) {
    rows = (await listAssignmentsByVisit(S.tx, S.tenantId, visitId)).map((r) => ({ membershipId: r['membership_id'] ?? null, action: String(r['action']), at: new Date(r['created_at']).getTime() }));
    S.assignments.set(visitId, rows);
  }
  return rows;
}
const priorFact = (r: Obj): PriorFact => ({ type: String(r['type']), membershipId: String(r['membership_id']), deviceSeq: Number(r['device_seq']), outcome: String(r['outcome']), payload: r['payload'] });
async function priorOf(S: State, visitId: string): Promise<PriorFact[]> {
  let rows = S.prior.get(visitId);
  if (!rows) { rows = (await mutations.listMutationsByVisit(S.tx, S.tenantId, visitId)).map(priorFact); S.prior.set(visitId, rows); }
  return rows;
}

/** One open flag per (visit, kind, related): an existing open one is kept (the DB index would refuse the second). */
async function openFlag(S: State, visit: Obj, kind: FlagKind, relatedId: string | null): Promise<void> {
  let rows = S.flags.get(visit['id']);
  if (!rows) { rows = await listVisitFlagsByVisit(S.tx, S.tenantId, visit['id']); S.flags.set(visit['id'], rows); }
  if (rows.some((f) => f['kind'] === kind && f['status'] === 'open' && (f['related_id'] ?? null) === relatedId)) return;
  const row = await insertVisitFlag(S.tx, S.tenantId, { id: uuidv7(), centre_id: visit['centre_id'], visit_id: visit['id'], kind, status: 'open', ...(relatedId ? { related_id: relatedId } : {}) });
  rows.push(row);
}

function correct(S: State, m: Mut, assignedAt: unknown): Corrected {
  const anchors: ClockAnchor[] = S.env.anchors.map((a) => ({ anchorId: a['anchor_id'], serverTime: a['server_time'], deviceWallTime: a['device_wall_time'], monotonicMs: a['monotonic_ms'], bootId: a['boot_id'] }));
  const c = correctCapturedTime({ captured: m.captured, anchors, now: S.env.now, receivedAt: S.receivedAt.toISOString(),
    assignedAt: assignedAt ? new Date(assignedAt as string).toISOString() : '1970-01-01T00:00:00.000Z', toleranceSeconds: Number(S.settings['clock_tolerance_seconds'] ?? 600) });
  hcMetrics.clockSkew(S.ctx, c.skewSeconds, c.clockSource);   // HC-T17: one observation per corrected mutation
  return { iso: c.correctedAt, ms: Date.parse(c.correctedAt), source: c.clockSource, suspect: c.clockSuspect };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// effects of applied / held mutations (TRD §6.3 step 4.6)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
async function moveVisit(S: State, visit: Obj, to: string, patch: Obj, mutationId: string, t: Corrected, reason?: string): Promise<void> {
  const next = await updateVisit(S.tx, S.tenantId, visit['id'], Number(visit['version']), { status: to, ...patch });
  if (!next) throw new LimsError('common.version_conflict');   // the row is locked by this tx: only a bug lands here
  S.visits.set(visit['id'], next);
  await insertVisitTransition(S.tx, S.tenantId, { id: uuidv7(), centre_id: visit['centre_id'], visit_id: visit['id'], from_status: visit['status'], to_status: to, cause: 'sync',
    ...(reason ? { reason_code: reason } : {}), mutation_id: mutationId, at: t.iso });
  if (visit['route_id']) S.routes.add(visit['route_id']);
}
/** V8 (assigned -> in_progress) on the first applied arrived / collected. */
const startVisit = (S: State, visit: Obj, mutationId: string, t: Corrected) =>
  visit['status'] === 'assigned' ? moveVisit(S, visit, 'in_progress', { arrived_at: t.iso }, mutationId, t) : Promise.resolve();

async function gpsRow(S: State, visit: Obj, mutationId: string, t: Corrected, kind: string, gps: unknown): Promise<void> {
  if (!isObj(gps) || gps['status'] !== 'ok') return;
  const days = Number(S.settings['gps_retention_days'] ?? 90);
  await insertVisitLocation(S.tx, S.tenantId, { id: uuidv7(), centre_id: visit['centre_id'], visit_id: visit['id'], mutation_id: mutationId, kind, latitude: gps['latitude'], longitude: gps['longitude'],
    ...(gps['accuracy_m'] !== undefined ? { accuracy_m: gps['accuracy_m'] } : {}), captured_at: t.iso, expires_at: new Date(t.ms + days * 86_400_000).toISOString() });
}

function accOf(S: State, visitId: string): EventAcc {
  let acc = S.eventAcc.get(visitId);
  if (!acc) { acc = { collections: [], payments: [] }; S.eventAcc.set(visitId, acc); }
  return acc;
}

async function applyEffects(S: State, m: Mut, visit: Obj, row: Obj, t: Corrected, v: Verdict, spec: Obj | undefined): Promise<void> {
  const p = m.payload;
  let related: string | null = null;
  if (m.type === 'specimen.collected') {
    if (spec && visit['order_id']) {   // a collection row needs the specimen (FK) and the order; an unknown specimen under guards 1-3 stays a held / rejected mutation only
      const verified = p['scan_method'] !== 'manual' && p['scanned_barcode'] === spec['barcode'];
      const col = await insertCollection(S.tx, S.tenantId, { id: uuidv7(), centre_id: visit['centre_id'], visit_id: visit['id'], specimen_id: p['specimen_id'], order_id: visit['order_id'], mutation_id: row['id'],
        client_mutation_id: m.clientMutationId, collected_by_membership_id: S.author, scan_method: p['scan_method'], barcode_verified: verified, collected_at: t.iso, collected_at_device: m.captured.deviceWallTime,
        clock_suspect: t.suspect, status: v.outcome === 'applied' ? 'applied' : 'held', ...(v.outcome === 'held' ? { hold_code: v.code } : {}) });
      related = col['id'];
      if (v.outcome === 'applied') accOf(S, visit['id']).collections.push({ client_mutation_id: m.clientMutationId, specimen_id: p['specimen_id'], barcode_verified: verified, collected_at_device: t.iso });
    }
    if (v.outcome === 'applied') { await startVisit(S, visit, row['id'], t); await gpsRow(S, S.visits.get(visit['id'])!, row['id'], t, 'collected', p['gps']); }
  } else if (v.outcome === 'applied') {
    switch (m.type) {
      case 'visit.arrived': await startVisit(S, visit, row['id'], t); await gpsRow(S, visit, row['id'], t, 'arrived', p['gps']); break;
      case 'specimen.not_collected': related = p['specimen_id']; break;
      case 'payment.captured':
        accOf(S, visit['id']).payments.push({ client_mutation_id: m.clientMutationId, payment_method_code: p['payment_method_code'], amount: { amount_paisa: p['amount']['amount_paisa'], currency: p['amount']['currency'] },
          ...(typeof p['reference'] === 'string' ? { reference: p['reference'] } : {}), captured_at_device: t.iso });
        break;
      case 'visit.completed': {
        const applied = (await listCollectionsByVisit(S.tx, S.tenantId, visit['id'])).filter((c) => c['status'] === 'applied').length;
        await startVisit(S, visit, row['id'], t);
        await moveVisit(S, S.visits.get(visit['id'])!, 'completed', { outcome: applied === 0 ? 'none' : p['outcome'], completed_at: t.iso }, row['id'], t);
        break;
      }
      case 'visit.failed':
        await moveVisit(S, visit, 'failed', { failed_at: t.iso, status_reason_code: p['reason_code'], ...(p['reason_text'] !== undefined ? { status_reason_text: p['reason_text'] } : {}) }, row['id'], t, p['reason_code']);
        await gpsRow(S, S.visits.get(visit['id'])!, row['id'], t, 'failed', p['gps']);
        break;
      default: break;
    }
  } else if (m.type === 'payment.captured') related = row['id'];
  if (v.flag) await openFlag(S, S.visits.get(visit['id']) ?? visit, v.flag, related);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// one mutation
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function mutationRow(S: State, m: Mut, hash: string, centreId: string, visitId: string | null, t: Corrected, v: Verdict): Obj {
  return { id: uuidv7(), centre_id: centreId, client_mutation_id: m.clientMutationId, device_id: S.env.deviceId, batch_id: S.env.batchId, membership_id: S.author, device_seq: m.deviceSeq, type: m.type,
    visit_id: visitId, payload: m.payload, payload_sha256: hash, captured_at_device: m.captured.deviceWallTime, captured_at: t.iso, clock_source: t.source, clock_suspect: t.suspect, outcome: v.outcome,
    ...(v.code ? { outcome_code: v.code } : {}), received_at: S.receivedAt.toISOString() };
}

/** SELECT: a stored row answers the mutation (same hash: duplicate with the STORED code; other hash: rejected idempotency_key_reused). True when answered. */
function answerFromStored(S: State, m: Mut, hash: string, stored: Obj | null): boolean {
  if (!stored) return false;
  if (stored['payload_sha256'] === hash) record(S, m, 'duplicate', typeof stored['outcome_code'] === 'string' ? stored['outcome_code'] : undefined);
  else record(S, m, 'rejected', CODE.reused);
  return true;
}
function unresolvedNotFound(S: State, m: Mut): void {
  S.unresolved.push({ client_mutation_id: m.clientMutationId, type: m.type, device_seq: m.deviceSeq });   // ids, type, seq only: no payload; NOT stored in mutations, evaluated again on resend
  record(S, m, 'rejected', CODE.notFound);
}

async function processVisitMutation(S: State, m: Mut): Promise<void> {
  const hash = payloadSha256(m.payload);
  if (answerFromStored(S, m, hash, await mutations.getMutationByClientId(S.tx, S.tenantId, m.clientMutationId))) return;
  const visit = S.visits.get(m.visitId!);
  if (!visit) return unresolvedNotFound(S, m);
  const t = correct(S, m, visit['assigned_at']);

  let verdict: Verdict; let spec: Obj | undefined;
  if (!(await centreAllowed(S, visit['centre_id']))) verdict = { outcome: 'rejected', code: 'auth.forbidden' };
  else {
    let appliedCollectionExists = false;
    if (m.type === 'specimen.collected') {
      if (visit['order_id']) spec = (await labFor(S, visit['order_id'])).find((r) => r['specimenId'] === m.payload['specimen_id']);
      appliedCollectionExists = (await listAppliedCollectionsBySpecimenIds(S.tx, S.tenantId, [m.payload['specimen_id']])).length > 0;
    }
    verdict = decide({ type: m.type, payload: m.payload, author: S.author, deviceSeq: m.deviceSeq, at: t.ms,
      visit: { status: visit['status'], orderId: visit['order_id'] ?? null, assignedMembershipId: visit['assigned_membership_id'] ?? null },
      assignments: await assignmentsOf(S, visit['id']), prior: await priorOf(S, visit['id']),
      ...(spec ? { specimen: { specimenId: spec['specimenId'], barcode: spec['barcode'], status: spec['status'], isActive: spec['isActive'] !== false } } : {}),
      appliedCollectionExists, paymentMethods: Array.isArray(S.settings['payment_methods']) ? S.settings['payment_methods'] : [] });
  }
  const row = await mutations.insertMutation(S.tx, S.tenantId, mutationRow(S, m, hash, visit['centre_id'], visit['id'], t, verdict));
  S.prior.get(visit['id'])?.push(priorFact(row));
  record(S, m, verdict.outcome, verdict.code);
  if (verdict.code !== 'auth.forbidden') await applyEffects(S, m, visit, row, t, verdict, spec);
}

/** handover.recorded (03-APP-FLOW §4 + §5.7, D-125): no visit row; per-specimen outcomes; items copy barcode + specimen type FROM LabPort, never from the device. */
async function processHandover(S: State, m: Mut): Promise<void> {
  const hash = payloadSha256(m.payload);
  if (answerFromStored(S, m, hash, await mutations.getMutationByClientId(S.tx, S.tenantId, m.clientMutationId))) return;
  const p = m.payload;
  const applied = new Map((await listAppliedCollectionsBySpecimenIds(S.tx, S.tenantId, p['specimen_ids'])).map((c) => [String(c['specimen_id']), c] as const));
  const handed = new Set((await listHandoverItemsByCollectionIds(S.tx, S.tenantId, [...applied.values()].map((c) => c['id']))).map((i) => String(i['collection_id'])));
  let items: HandoverItemFact[] = sortHandoverItems(p['specimen_ids'], S.author, applied, handed);

  const barcodes = new Map<string, Obj>();   // specimen -> lab ref of the included ones (a tube the lab cannot show cannot be handed over)
  for (const it of items.filter((i) => i.outcome === HANDOVER_ITEM.included)) {
    const ref = (await labFor(S, it.collection!['order_id'])).find((r) => r['specimenId'] === it.specimenId);
    if (ref) barcodes.set(it.specimenId, ref);
  }
  items = items.map((i) => (i.outcome === HANDOVER_ITEM.included && !barcodes.has(i.specimenId) ? { specimenId: i.specimenId, outcome: HANDOVER_ITEM.notCollected } : i));

  const decided = decideHandover(items);
  let verdict = decided.verdict;
  if (verdict.outcome === 'applied' && !(await getActiveCentreId(S.tx, S.tenantId, p['to_centre_id']))) verdict = { outcome: 'rejected', code: CODE.invalid };
  if (verdict.outcome === 'applied' && (await getHandoverById(S.tx, S.tenantId, p['handover_id']))) verdict = { outcome: 'rejected', code: CODE.invalid };
  const centreId = decided.centreId ?? [...applied.values()][0]?.['centre_id'] ?? S.ctx.centreId;   // a mutation row needs a centre (NOT NULL): the collections' one, else the request's
  if (!centreId) return unresolvedNotFound(S, m);
  if (verdict.outcome === 'applied' && !(await centreAllowed(S, centreId))) verdict = { outcome: 'rejected', code: 'auth.forbidden' };

  const t = correct(S, m, null);
  const row = await mutations.insertMutation(S.tx, S.tenantId, mutationRow(S, m, hash, centreId, null, t, verdict));
  record(S, m, verdict.outcome, verdict.code);
  for (const it of items) if (verdict.outcome === 'applied' || it.outcome !== HANDOVER_ITEM.included) S.handoverItems.push({ handover_id: p['handover_id'], specimen_id: it.specimenId, outcome: it.outcome });
  if (verdict.outcome !== 'applied') return;

  const confirmed = S.settings['handover_confirmation_required'] === false;   // 03-APP-FLOW §1.3: no receiver step -> confirmed at once, nobody received it
  await insertHandover(S.tx, S.tenantId, { id: p['handover_id'], centre_id: centreId, to_centre_id: p['to_centre_id'], from_membership_id: S.author, mutation_id: row['id'], handed_over_at: t.iso,
    handed_over_at_device: m.captured.deviceWallTime, status: confirmed ? 'confirmed' : 'pending', ...(confirmed ? { received_at: t.iso } : {}) });
  for (const it of items.filter((i) => i.outcome === HANDOVER_ITEM.included)) {
    const ref = barcodes.get(it.specimenId)!;
    await insertHandoverItem(S.tx, S.tenantId, { id: uuidv7(), centre_id: centreId, to_centre_id: p['to_centre_id'], handover_id: p['handover_id'], collection_id: it.collection!['id'], specimen_id: it.specimenId,
      visit_id: it.collection!['visit_id'], barcode: ref['barcode'], specimen_type_code: ref['specimenTypeCode'] });
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// A3
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export async function pushSyncMutations(hctx: unknown, headers: unknown, body: unknown): Promise<Result> {
  const ctx = ctxOf(hctx);
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: PERM_SYNC_UPLOAD });
  const author = ctx.actor.membershipId;
  if (!author) throw new LimsError('auth.forbidden');
  if (!isObj(body) || typeof body['device_id'] !== 'string') throw bad('/device_id');
  const header = (name: string): unknown => (isObj(headers) ? headers[name] : undefined);
  if (header('x-lims-device-id') !== body['device_id']) throw new LimsError('common.id_mismatch');   // §5 preamble: before any other check

  const cfg = loadHomecollectionConfig();
  if ((Array.isArray(body['mutations']) && body['mutations'].length > cfg.pushMaxMutations) || Buffer.byteLength(JSON.stringify(body), 'utf8') > cfg.pushMaxBytes) throw new LimsError('common.payload_too_large');
  const env = parseEnvelope(body);

  const device0 = await getDeviceById(ctx.tx, ctx.tenantId, env.deviceId);   // a foreign / signed-off / unknown device looks the same (409), nothing about the owner
  if (!device0 || device0['membership_id'] !== author || (device0['status'] !== 'active' && device0['status'] !== 'wipe_requested')) throw new LimsError('homecollection.device_not_registered');
  const settings: Obj = (await getSettings(ctx.tx, ctx.tenantId)) ?? { ...settingsDefaults() };
  const app = header('x-lims-app-version');
  if (typeof app !== 'string' || !APP_VERSION.test(app)) throw bad('/x-lims-app-version');
  const min = String(settings['min_app_version'] ?? '1.0.0');
  if (APP_VERSION.test(min) && belowMin(app, min)) throw new LimsError('homecollection.app_version_unsupported');
  if (await syncBatches.getSyncBatchById(ctx.tx, ctx.tenantId, env.batchId)) throw new LimsError('common.idempotency_key_reused');   // a batch id is never reused for another body

  const receivedAt = new Date(ctx.now());
  const maxSeq = env.mutations.reduce((n, m) => Math.max(n, m.deviceSeq), 0);
  let device: Obj = device0;
  for (let attempt = 0; ; attempt++) {   // compare-and-bump = the device row lock for the rest of the tx; a concurrent push / ack / wipe request bumped it: re-read and decide again
    const done = await updateDevice(ctx.tx, ctx.tenantId, env.deviceId, Number(device['version']), { last_push_at: receivedAt, max_device_seq_received: Math.max(Number(device['max_device_seq_received'] ?? 0), maxSeq) });
    if (done) { device = done; break; }
    if (attempt >= 9) throw new LimsError('common.version_conflict');
    const again = await getDeviceById(ctx.tx, ctx.tenantId, env.deviceId);
    if (!again || again['membership_id'] !== author || (again['status'] !== 'active' && again['status'] !== 'wipe_requested')) throw new LimsError('homecollection.device_not_registered');
    device = again;
  }

  // lock every touched visit, ascending id (+ the visits of already-applied collections named by handover mutations)
  const named = env.mutations.filter((m) => m.type === 'handover.recorded').flatMap((m) => m.payload['specimen_ids'] as string[]);
  const handoverVisits = named.length > 0 ? (await listAppliedCollectionsBySpecimenIds(ctx.tx, ctx.tenantId, named)).map((c) => String(c['visit_id'])) : [];
  const ids = [...new Set([...env.mutations.flatMap((m) => (m.visitId ? [m.visitId] : [])), ...handoverVisits])].sort();
  const S: State = { ctx, tx: ctx.tx, tenantId: ctx.tenantId, author, env, settings, receivedAt, visits: new Map((ids.length > 0 ? await lockVisitsForUpdate(ctx.tx, ctx.tenantId, ids) : []).map((r) => [String(r['id']), r] as const)),
    assignments: new Map(), prior: new Map(), flags: new Map(), lab: new Map(), centreOk: new Map(), routes: new Set(), eventAcc: new Map(), results: [], handoverItems: [], unresolved: [],
    counts: { applied: 0, held: 0, rejected: 0, duplicate: 0 } };

  for (const m of env.mutations) await (m.type === 'handover.recorded' ? processHandover(S, m) : processVisitMutation(S, m));   // device_seq order

  // §8.1: one event per visit per batch (more when > 50 collections / > 10 payments): disjoint mutation sets, so every key differs
  const typed = createHomecollectionEvents(ctx.events);
  for (const visitId of [...S.eventAcc.keys()].sort()) {
    const acc = S.eventAcc.get(visitId)!, visit = S.visits.get(visitId)!;
    const n = Math.max(Math.ceil(acc.collections.length / 50), Math.ceil(acc.payments.length / 10));
    for (let i = 0; i < n; i++) {
      const pub = await typed.collectionSynced(ctx, { visit_id: visitId, order_id: visit['order_id'], phlebotomist_membership_id: author, ...(visit['kind'] === 'booking' && visit['booking_id'] ? { booking_id: visit['booking_id'] } : {}),
        synced_at: receivedAt.toISOString(), collections: acc.collections.slice(i * 50, (i + 1) * 50), payments: acc.payments.slice(i * 10, (i + 1) * 10) }, { visitVersion: Number(visit['version']) });
      if (!pub.duplicate) hcMetrics.eventPublished(ctx);   // HC-T17
    }
  }

  await syncBatches.insertSyncBatch(ctx.tx, ctx.tenantId, { id: env.batchId, device_id: env.deviceId, membership_id: author, sent_at_device: env.sentAtDevice, now_device_wall_time: env.now.deviceWallTime,
    now_monotonic_ms: env.now.monotonicMs, now_boot_id: env.now.bootId, anchors: env.anchors, mutation_count: env.mutations.length, applied_count: S.counts.applied, held_count: S.counts.held,
    rejected_count: S.counts.rejected, duplicate_count: S.counts.duplicate, ...(S.unresolved.length > 0 ? { unresolved_mutations: S.unresolved } : {}), received_at: receivedAt.toISOString() });
  for (const routeId of [...S.routes].sort()) await bumpVersion(ctx.tx, ctx.tenantId, routeId);   // §4.1: every committed status change of a visit on a route

  return { status: 200, body: { server_time: receivedAt.toISOString(), batch_id: env.batchId, results: S.results, handover_items: S.handoverItems, device_command: device['status'] === 'wipe_requested' ? 'wipe' : 'none' } };
}
