// HC-T11: A2 getSyncSnapshot (GET /sync/snapshot) + A4 ackSync (POST /sync/ack) — 02-TRD §5.2, §5.3.1, §6.2, §6.4; 01-PRD US-06, US-13-5; 07-SECURITY AB1 / REQ-SEC-081 / REQ-SEC-096.
// Identity = the claims (ctx.tenantId, ctx.actor.membershipId); a device belongs to its registering membership (else 409 device_not_registered, nothing about the owner).
// SQL lives in repository/*.repo.ts only. Port calls that may fail without failing the pull run in ctx.db.tx (savepoint, 08 A19 P-44); per-visit calls run up to 8 at a time, one savepoint per group (LD-156).
// access_log rows stay one insert per visit: the core writer (core/audit/access.ts) has no batch API (LD-156 "if the core writer allows it").
// Barcodes come from LabPort.lookupSpecimens on EVERY changed pull and are never stored or logged (review #2); no fallback to a read model. Logs carry codes only (REQ-SEC-081).
import { LimsError } from '../../core/errors.js';
import { decodeCursor, encodeCursor, cursorsEqual } from './domain/cursor.js';
import { APP_VERSION, bad, belowMin, deviceIdOf, isObj, noExtra } from './device.service.js';
import { HOMECOLLECTION_PERMISSIONS } from './permissions.js';
import { getDeviceById, updateDevice } from './repository/devices.repo.js';
import { listReasonsBySet } from './repository/reasons.repo.js';
import { listRoutesByMembershipDate, updateRouteStamps } from './repository/routes.repo.js';
import { getSettings, insertSettingsIfAbsent } from './repository/settings.repo.js';
import type { Tx } from './repository/shared.repo.js';
import { listVisitsByRoute } from './repository/visits.repo.js';
import { settingsDefaults } from './settings.service.js';
import { uuidv7 } from '../../../../../packages/shared-ts/src/uuidv7/index.js';

const [PERM_VISIT_READ, , , , , PERM_SYNC_UPLOAD] = HOMECOLLECTION_PERMISSIONS;   // 'homecollection.visit.read' / 'homecollection.sync.upload'
type Obj = Record<string, any>;
type Result = { status: number; body?: unknown };
interface Ctx {
  readonly tenantId: string; readonly tx: Tx; readonly actor: { readonly id: string; readonly membershipId?: string };
  readonly now: () => Date;
  readonly db: { tx<T>(fn: (c: any) => Promise<T>): Promise<T> };
  readonly log: { warn(o: object, m?: string): void };
  readonly ports: {
    readonly IdentityPort: { assertRole(ctx: unknown, r: { permission: string; centreId?: string }): Promise<void>; getTenantSettings(ctx: unknown, i: { keys: string[] }): Promise<Obj> };
    readonly FrontdeskPort: Obj; readonly BillingPort: Obj; readonly LabPort: Obj;
  };
  readonly core?: Obj;
  readonly audit: { access(e: { action: string; entityType: string; entityId?: string; centreId?: string; purpose?: string; outcome: 'allowed' | 'denied' }): Promise<void> };
}

function ctxOf(c: unknown): Ctx {
  const x = c as Partial<Ctx> | null;
  if (typeof x?.tenantId !== 'string' || !x.tx || typeof x.actor?.id !== 'string' || typeof x.now !== 'function' || !x.db || !x.ports?.IdentityPort || !x.audit) throw new LimsError('auth.unauthenticated');   // fail closed
  return x as Ctx;
}

const code = (e: unknown): string => (typeof (e as Obj)?.['code'] === 'string' ? (e as Obj)['code'] : 'unknown');
const base64url = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]+$/.test(s);   // cursor alphabet
const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();
const header = (headers: unknown, name: string): unknown => (isObj(headers) ? headers[name] : undefined);
/** TRD §5 preamble: X-Lims-Device-Id must equal the query / body device id. */
const sameDevice = (headers: unknown, deviceId: string): void => { if (header(headers, 'x-lims-device-id') !== deviceId) throw new LimsError('common.id_mismatch'); };
const callerMembership = (ctx: Ctx): string => { if (!ctx.actor.membershipId) throw new LimsError('auth.forbidden'); return ctx.actor.membershipId; };
const DEFAULT_TZ = 'Asia/Kathmandu';   // v1 tenants (05-SCHEMA P-15)
const ACTIVE = ['assigned', 'in_progress'];
const SNAPSHOT_STATUSES = [...ACTIVE, 'completed', 'failed', 'cancelled'];

/** A2 / A4 binding (§5.2): the device is the caller's and still usable. Terminal (signed_off, wiped) and foreign devices look like unknown ones. */
async function boundDevice(ctx: Ctx, deviceId: string, membershipId: string): Promise<Obj> {
  const row = await getDeviceById(ctx.tx, ctx.tenantId, deviceId);
  if (!row || row['membership_id'] !== membershipId || (row['status'] !== 'active' && row['status'] !== 'wipe_requested')) throw new LimsError('homecollection.device_not_registered');
  return row;
}

async function settingsOf(ctx: Ctx): Promise<Obj> {
  const row = (await getSettings(ctx.tx, ctx.tenantId)) ?? (await insertSettingsIfAbsent(ctx.tx, ctx.tenantId, { ...settingsDefaults(), id: uuidv7() })) ?? (await getSettings(ctx.tx, ctx.tenantId));   // lazy create (08 A17 P-22), race-safe
  if (!row) throw new LimsError('common.internal');
  return row;
}

/** REQ-SEC-113 / US-06-6 on every app endpoint: a missing or malformed version never counts as "new enough". */
function assertAppVersion(headers: unknown, settings: Obj): void {
  const app = header(headers, 'x-lims-app-version');
  if (typeof app !== 'string' || !APP_VERSION.test(app)) throw bad('/x-lims-app-version');
  const min = String(settings['min_app_version'] ?? '1.0.0');
  if (APP_VERSION.test(min) && belowMin(app, min)) throw new LimsError('homecollection.app_version_unsupported');
}

/** Local calendar date (YYYY-MM-DD) of `now` in the tenant timezone (S-1). */
async function todayOf(ctx: Ctx): Promise<string> {
  let tz = DEFAULT_TZ;
  try { const t = (await ctx.ports.IdentityPort.getTenantSettings(ctx, { keys: ['timezone'] }))['timezone']; if (typeof t === 'string' && t !== '') tz = t; }
  catch (e) { ctx.log.warn({ code: code(e) }, 'homecollection.timezone_unavailable'); }
  const fmt = (z: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ctx.now());
  try { return fmt(tz); } catch { return fmt(DEFAULT_TZ); }
}

/** The actor's routes of `today`, minus the centres the actor may not read (probe 2: dropped, their visits and patients are never touched). */
async function permittedRoutes(ctx: Ctx, membershipId: string, today: string): Promise<Obj[]> {
  const out: Obj[] = [];
  for (const r of await listRoutesByMembershipDate(ctx.tx, ctx.tenantId, membershipId, today)) {
    try { await ctx.ports.IdentityPort.assertRole(ctx, { permission: PERM_VISIT_READ, centreId: r['centre_id'] }); out.push(r); }
    catch (e) { if (code(e) !== 'auth.forbidden') throw e; }
  }
  return out;
}

const money = (m: Obj): { amount_paisa: number; currency: string } => ({ amount_paisa: Number(m['amountPaisa']), currency: String(m['currency']) });
type Balance = { balance_due: ReturnType<typeof money>; as_of: string };
const toBalance = (b: Obj): Balance => ({ balance_due: money(b['balanceDue']), as_of: iso(b['asOf']) });

const PORT_CONCURRENCY = 8;   // LD-156 (2): per-visit port calls of one request run concurrently, bounded
class BatchFailed extends Error {}
/**
 * Runs read-only port calls PORT_CONCURRENCY at a time; each group shares ONE ctx.db.tx savepoint (P-44), because savepoints on the
 * request connection cannot be opened concurrently. Any failure rolls the group's savepoint back; fulfilled results are still used.
 * ponytail: an SQL error in one call aborts the savepoint, so its siblings in flight may also fail and degrade to *_stale / *_unavailable
 * for this pull (the device re-pulls); per-call retry in its own savepoint if that shows up in practice.
 */
async function settledPortCalls<T>(ctx: Ctx, calls: ReadonlyArray<(x: unknown) => Promise<T>>): Promise<PromiseSettledResult<T>[]> {
  const out: PromiseSettledResult<T>[] = [];
  for (let i = 0; i < calls.length; i += PORT_CONCURRENCY) {
    const group = calls.slice(i, i + PORT_CONCURRENCY);
    let res: PromiseSettledResult<T>[] | undefined;
    try {
      await ctx.db.tx(async (x) => {
        res = await Promise.allSettled(group.map((f) => f(x)));
        if (res.some((r) => r.status === 'rejected')) throw new BatchFailed();   // roll the savepoint back
      });
    } catch (e) {
      if (!res) res = group.map(() => ({ status: 'rejected', reason: e }) as const);
      else if (!(e instanceof BatchFailed)) res = res.map((r) => (r.status === 'fulfilled' ? r : { status: 'rejected', reason: e }));
    }
    out.push(...res!);
  }
  return out;
}
/** BillingPort balance per order, or null when the read fails (the pull still succeeds, §2.1). */
const balanceCall = (ctx: Ctx, orderId: string) => (x: unknown): Promise<Obj> => ctx.ports.BillingPort['getOrderBalance'](x, { orderId });
function balanceOrNull(ctx: Ctx, r: PromiseSettledResult<Obj>): Balance | null {
  try { if (r.status === 'fulfilled') return toBalance(r.value); throw r.reason; }
  catch (e) { ctx.log.warn({ code: code(e) }, 'homecollection.balance_unavailable'); return null; }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// A2 getSyncSnapshot
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export async function getSyncSnapshot(hctx: unknown, params: unknown, headers: unknown): Promise<Result> {
  const ctx = ctxOf(hctx);
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: PERM_VISIT_READ });
  const membershipId = callerMembership(ctx);
  if (!isObj(params)) throw bad('');
  const deviceId = deviceIdOf(params['device_id'], '/device_id');
  const deviceCursor = params['cursor'];
  if (deviceCursor !== undefined && typeof deviceCursor !== 'string') throw bad('/cursor');
  sameDevice(headers, deviceId);

  let device = await boundDevice(ctx, deviceId, membershipId);
  const settings = await settingsOf(ctx);
  assertAppVersion(headers, settings);

  const now = ctx.now();
  const today = await todayOf(ctx);
  const routes = await permittedRoutes(ctx, membershipId, today);  const cursor = encodeCursor({ d: today, r: routes.map((r) => [r['id'], Number(r['version'])] as const), s: Number(settings['version']), w: String(device['status']) });
  const deviceCommand = device['status'] === 'wipe_requested' ? 'wipe' : 'none';

  const rows: Obj[] = [];   // visits of the routes in route order, then sequence
  for (const r of routes) rows.push(...(await listVisitsByRoute(ctx.tx, ctx.tenantId, r['id'])).filter((v) => SNAPSHOT_STATUSES.includes(v['status'])));

  if (cursorsEqual(deviceCursor, cursor)) {   // US-06-2: only fresh balances
    const due = rows.filter((v) => ACTIVE.includes(v['status']) && v['order_id']);
    const got = await settledPortCalls(ctx, due.map((v) => balanceCall(ctx, v['order_id'])));
    const balances: Obj[] = [];
    due.forEach((v, i) => { const b = balanceOrNull(ctx, got[i]!); if (b) balances.push({ visit_id: v['id'], ...b }); });
    return { status: 200, body: { server_time: now.toISOString(), cursor, unchanged: true, device_command: deviceCommand, balances } };
  }

  // ---- changed: full snapshot ----
  const active = rows.filter((v) => ACTIVE.includes(v['status']));
  const patients = new Map<string, Obj>();
  const patientIds = [...new Set(active.map((v) => v['patient_id'] as string))];
  if (patientIds.length > 0) {   // ONE batch call (review m#34)
    try {
      const found = await ctx.db.tx((x) => ctx.ports.FrontdeskPort['getPatientDemographicsBatch'](x, { patientIds, purpose: 'home_visit' }));
      for (const p of found as Obj[]) if (typeof p?.['patientId'] === 'string' && typeof p['fullName'] === 'string' && p['fullName'] !== '') patients.set(p['patientId'], p);
    } catch (e) { ctx.log.warn({ code: code(e) }, 'homecollection.demographics_unavailable'); }
  }
  const withBirth = settings['second_identifier'] === 'birth_date';   // D-IDENT / CR-C17-003

  // LD-156 (2): lookupSpecimens + getOrderBalance of every active visit with an order, bounded concurrency; index 2k = specimens, 2k+1 = balance
  const ordered = active.filter((v) => v['order_id']);
  const portRes = await settledPortCalls<Obj>(ctx, ordered.flatMap((v) => [
    (x: unknown) => ctx.ports.LabPort['lookupSpecimens'](x, { orderId: v['order_id'], statuses: ['ordered'] }), balanceCall(ctx, v['order_id'])]));
  const portOf = new Map(ordered.map((v, k) => [v['id'] as string, { refs: portRes[2 * k]!, bal: portRes[2 * k + 1]! }]));

  const visits: Obj[] = [];
  const logged: Obj[] = [];   // visits returned with patient fields (US-06-4)
  for (const v of rows) {
    const base = { visit_id: v['id'], version: Number(v['version']), route_id: v['route_id'], route_sequence: Number(v['route_sequence']), status: v['status'], kind: v['kind'],
      ...(v['window_start'] ? { window_start: iso(v['window_start']) } : {}), ...(v['window_end'] ? { window_end: iso(v['window_end']) } : {}) };
    if (v['status'] === 'cancelled') { visits.push(base); continue; }   // stub: no patient, order or balance
    if (!ACTIVE.includes(v['status'])) {   // closed: status + outcome only
      visits.push({ ...base, ...(v['order_id'] ? { order_id: v['order_id'] } : {}), ...(v['outcome'] ? { outcome: v['outcome'] } : {}), specimens: [] });
      continue;
    }
    const p = patients.get(v['patient_id']);
    const lat = v['latitude'], lon = v['longitude'];
    const dto: Obj = { ...base, ...(v['order_id'] ? { order_id: v['order_id'] } : {}),
      ...(p ? { patient: { full_name: p['fullName'], ...(typeof p['phoneE164'] === 'string' && p['phoneE164'] !== '' ? { phone_e164: p['phoneE164'] } : {}), ...(withBirth && typeof p['birthOn'] === 'string' ? { birth_on: p['birthOn'] } : {}) } } : { patient_unavailable: true }),
      address: { address_text: v['address_text'], ...(v['landmark'] ? { landmark: v['landmark'] } : {}), ...(lat != null && lon != null ? { latitude: String(lat), longitude: String(lon) } : {}) },
      ...(v['note_for_phlebotomist'] ? { note_for_phlebotomist: v['note_for_phlebotomist'] } : {}), specimens: [] };
    const pr = portOf.get(v['id']);
    if (pr) {
      try {
        if (pr.refs.status === 'rejected') throw pr.refs.reason;
        dto['specimens'] = (pr.refs.value as unknown as Obj[]).map((s) => ({ specimen_id: s['specimenId'], barcode: s['barcode'], specimen_type_code: s['specimenTypeCode'], ...(s['containerCode'] ? { container_code: s['containerCode'] } : {}), status: s['status'] }));
      } catch (e) { dto['specimens_stale'] = true; ctx.log.warn({ code: code(e) }, 'homecollection.specimens_unavailable'); }   // never a read-model fallback
      const b = balanceOrNull(ctx, pr.bal);
      if (b) dto['balance'] = b; else dto['balance_unavailable'] = true;
    }
    visits.push(dto);
    if (p) logged.push(v);
  }

  for (const v of logged) {   // REQ-SEC-096: one row per visit with patient fields, every changed pull (review #18)
    await ctx.audit.access({ action: 'home_visit.view', entityType: 'home_visit', entityId: v['id'], centreId: v['centre_id'], purpose: 'home_visit_snapshot', outcome: 'allowed' });
  }

  await updateRouteStamps(ctx.tx, ctx.tenantId, routes.map((r) => r['id']), { last_snapshot_at: now });
  for (let attempt = 0; attempt < 3; attempt++) {   // best effort: a concurrent writer of the device row bumps the version, re-read and stamp again
    if (await updateDevice(ctx.tx, ctx.tenantId, deviceId, Number(device['version']), { last_snapshot_at: now })) break;
    device = await boundDevice(ctx, deviceId, membershipId);
  }

  const config = await configOf(ctx, settings);
  return { status: 200, body: { server_time: now.toISOString(), cursor, unchanged: false, route_date: today, device_command: deviceCommand, config,
    routes: routes.map((r) => ({ route_id: r['id'], centre_id: r['centre_id'], version: Number(r['version']) })), visits, balances: [] } };
}

/** SnapshotConfig (all keys required): tenant settings + the active coded reasons + the centres a tube can be handed over to (ids and names only, CR-C17-013). */
async function configOf(ctx: Ctx, s: Obj): Promise<Obj> {
  const reasons = async (set: string) => (await listReasonsBySet(ctx.tx, set)).map((r) => ({ code: String(r['code']), display: String(r['display']) }));
  let centres: Array<{ centre_id: string; name: string }> = [];
  const listCentres = ctx.core?.['centres'];
  if (typeof listCentres === 'function') {
    try { centres = (await ctx.db.tx<Obj[]>((x) => listCentres.call(ctx.core, x, { kinds: ['own', 'franchise'], activeOnly: true }))).map((c: Obj) => ({ centre_id: c['id'], name: c['name'] })); }
    catch (e) { ctx.log.warn({ code: code(e) }, 'homecollection.handover_centres_unavailable'); }
  }
  return {
    sync_interval_seconds: Number(s['sync_interval_seconds']), offline_purge_hours: Number(s['offline_purge_hours']), capture_gps: s['capture_gps'] === true, map_handoff_enabled: s['map_handoff_enabled'] === true,
    manual_barcode_entry_allowed: s['manual_barcode_entry_allowed'] === true, second_identifier: String(s['second_identifier']),
    collection_consent_text_version: String(s['collection_consent_text_version']), collection_consent_text: String(s['collection_consent_text']),
    payment_methods: (s['payment_methods'] as Obj[]).map((m) => ({ code: String(m['code']), display: String(m['display']), requires_reference: m['requires_reference'] === true })),
    reasons: { visit_fail_reasons: await reasons('visit_fail_reasons'), specimen_not_collected_reasons: await reasons('specimen_not_collected_reasons') },
    handover_centres: centres, min_app_version: String(s['min_app_version']),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// A4 ackSync
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export async function ackSync(hctx: unknown, headers: unknown, body: unknown): Promise<Result> {
  const ctx = ctxOf(hctx);
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: PERM_SYNC_UPLOAD });
  const membershipId = callerMembership(ctx);
  if (!isObj(body)) throw bad('');
  noExtra(body, ['device_id', 'cursor', 'applied_at_device', 'max_device_seq_acked', 'wipe_completed']);
  const deviceId = deviceIdOf(body['device_id'], '/device_id');
  const cursor = body['cursor'];
  if (!base64url(cursor) || cursor.length > 512) throw bad('/cursor');
  const applied = body['applied_at_device'];
  if (typeof applied !== 'string' || !ISO_UTC.test(applied) || Number.isNaN(Date.parse(applied))) throw bad('/applied_at_device');
  const seq = body['max_device_seq_acked'];
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) throw bad('/max_device_seq_acked');
  const wipeCompleted = body['wipe_completed'];
  if (wipeCompleted !== undefined && typeof wipeCompleted !== 'boolean') throw bad('/wipe_completed');
  sameDevice(headers, deviceId);

  const now = ctx.now();   // the server clock is the authority (S-6): applied_at_device and max_device_seq_acked are validated, not stored
  for (let attempt = 0; attempt < 5; attempt++) {   // a concurrent writer (ack, wipe request, sign-off) bumps the version: re-read and decide again
    const device = await boundDevice(ctx, deviceId, membershipId);
    assertAppVersion(headers, await settingsOf(ctx));
    const wipe = wipeCompleted === true && device['status'] === 'wipe_requested';   // [CONV] wipe_completed only completes a requested wipe; on an active device it is an ordinary ack
    const done = await updateDevice(ctx.tx, ctx.tenantId, deviceId, Number(device['version']), { last_ack_at: now, last_ack_cursor: cursor, ...(wipe ? { status: 'wiped', wiped_at: now } : {}) });
    if (!done) continue;
    const named = decodeCursor(cursor);   // client data: only routes that are the caller's own, on the cursor's date, are touched; garbage touches none
    if (named) {
      const wanted = new Set(named.r.map(([id]) => id));
      const own = (await listRoutesByMembershipDate(ctx.tx, ctx.tenantId, membershipId, named.d)).map((r) => r['id'] as string).filter((id) => wanted.has(id));
      await updateRouteStamps(ctx.tx, ctx.tenantId, own, { last_ack_at: now });
    }
    return { status: 204 };
  }
  throw new LimsError('common.version_conflict');
}
