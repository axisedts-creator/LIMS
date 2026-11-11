// Specimen service: T-05 barcode allocation + T-07 specimen actions (collect, bulk collect, bulk dispatch, receive, bulk receive, store, discard, lookup, get, list).
// Runs in the caller's transaction (ctx.tx): a failure rolls the whole request back. Tenant and actor come from ctx only (REQ-SEC-024).
// LD-25 (2026-11-07, A33-2 downtime mode) T-07: collect/dispatch/receive/store/discard accept entry_mode 'live' (default) | 'downtime_backentry'; a back-entry carries
// occurred_at (<= now, >= now - 72 h) + downtime_ref (1..32), stores occurred_at as the action's own timestamp and transition time, keeps created_at = server time, is audited,
// and needs the same permission as the live action. A live write carries neither field.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, type FieldError } from '../../../core/errors.js';
import { DEFAULT_BARCODE_PATTERN, renderBarcode } from '../domain/barcode.js';
import { assertSpecimenReceivable, specimenTransition, type SpecimenStatus, SPECIMEN_STATUSES } from '../domain/specimen.state.js';
import { createLabEvents } from '../events/publish.js';
import { decodeCursor, encodeCursor, groupTests, specimenDetailDto, specimenDto } from '../mappers/specimen.mapper.js';
import { allocateBarcodeSeq } from '../repository/barcodeCounters.repo.js';
import type { RepoCtx, RepoTx } from '../repository/base.repo.js';
import { copyProcessingToExistingMaterialTests, markTestsAwaitingReceipt, startTestsOfSpecimen } from '../repository/orderTests.repo.js';
import { copyProcessingToExistingMaterialResults, copyProcessingToResultsOfSpecimen } from '../repository/results.repo.js';
import {
  findSpecimenWithOrderByBarcode, getSpecimenWithOrder, insertSpecimenTransition, listSpecimensWithOrderByRegistrationNo, listSpecimenTransitions, listTestsOfSpecimens, pageSpecimens,
  resultsSummaryOfSpecimen, updateSpecimen, type SpecimenFilter, type SpecimenSort,
} from '../repository/specimens.repo.js';

export interface LabCtx {
  readonly tenantId: string;
  readonly actor: { readonly type?: string; readonly id: string };
  readonly tx: RepoTx;
  now(): Date;
  readonly ports?: { readonly IdentityPort?: { getTenantSettings(ctx: any, input: { keys: readonly string[] }): Promise<any> } };
}

/** Next barcode for the ctx tenant: counter + numbering.barcodePattern/barcodePrefix (08 A13 D-8). Invalid config or overflow -> lab.barcode_pattern_invalid. */
export async function allocateBarcode(ctx: LabCtx): Promise<string> {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  const settings = await ctx.ports?.IdentityPort?.getTenantSettings(ctx, { keys: ['numbering'] });   // failure propagates: no silent default
  const numbering = settings?.numbering ?? {};
  const seq = await allocateBarcodeSeq({ tx: ctx.tx, tenantId: ctx.tenantId, actorId: ctx.actor.id });
  return renderBarcode(numbering.barcodePattern ?? DEFAULT_BARCODE_PATTERN, { seq, prefix: numbering.barcodePrefix, now: ctx.now() });
}

// ====================================================================== T-07 specimen actions ======================================================================
type Obj = Record<string, any>;
export interface Result { readonly status: number; readonly body?: unknown }
const P = { read: 'lab.specimen.read', collect: 'lab.specimen.collect', receive: 'lab.specimen.receive', reject: 'lab.specimen.reject' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const ISO_MS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const BARCODE = /^[A-Z0-9]{1,20}$/;
const REG_NO = /^[A-Z0-9]{1,40}$/;
const CODE = /^[A-Za-z0-9_.:^+\-]{1,64}$/;
const BACKENTRY_MAX_HOURS = 72;     // LD-25 default; the tenant setting downtime_backentry_max_hours is not in TenantSettings yet (same as frontdesk FD-T06)
const BULK_MAX = 200;
const MAX_VERSION = 2147483647;

interface SpecimenCtx {
  readonly tenantId: string;
  readonly tx: RepoTx;
  readonly actor: { readonly type?: string; readonly id: string; readonly membershipId?: string };
  now(): Date;
  readonly ports: { readonly IdentityPort: {
    assertRole(ctx: unknown, i: { permission: string; centreId?: string }): Promise<unknown>;
    getActor(ctx: unknown): Promise<{ centreScope?: { all?: boolean; centreIds?: readonly string[] } }>;
  } };
  readonly events: { publish(ctx: never, type: string, input: never): Promise<{ eventId: string; duplicate: boolean }> };
  readonly audit: { access(entry: Obj): Promise<void> };
  readonly core?: { readonly centres?: { list(tx: unknown, o: Obj): Promise<readonly Obj[]> } };
}

/** The handler ctx must carry tenant, tx, actor, clock, identity port, events and audit; anything missing fails closed (auth.unauthenticated). */
function specimenCtx(c: unknown): SpecimenCtx {
  const x = c as Partial<SpecimenCtx> | null;
  if (typeof x?.tenantId !== 'string' || !x.tx || typeof x.actor?.id !== 'string' || typeof x.now !== 'function' || !x.ports?.IdentityPort
    || typeof x.events?.publish !== 'function' || typeof x.audit?.access !== 'function') throw new LimsError('auth.unauthenticated');
  return x as SpecimenCtx;
}
const repoCtx = (c: SpecimenCtx): RepoCtx => ({ tx: c.tx, tenantId: c.tenantId, actorId: c.actor.id });

// ---- validation (fixed texts: no submitted value is ever echoed) ----
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const bad = (...paths: string[]): LimsError => new LimsError('common.validation_failed', undefined,
  paths.map((path): FieldError => ({ path, code: 'common.field_invalid', message: 'Field invalid' })));
function strict(v: unknown, allowed: readonly string[], path = ''): Obj {
  if (!isObj(v)) throw bad(path);
  for (const k of Object.keys(v)) if (!allowed.includes(k)) throw new LimsError('common.validation_failed', undefined, [{ path: `${path}/${k}`, code: 'common.unknown_field', message: 'Unknown field' }]);
  return v;
}
const uuidParam = (params: unknown, name: string): string => {
  const v = isObj(params) ? params[name] : undefined;
  if (typeof v !== 'string' || !UUID.test(v)) throw bad(`/${name}`);
  return v.toLowerCase();
};
function expectedVersion(headers: unknown): number {
  const h = isObj(headers) ? headers['if-match'] : undefined;
  if (h === undefined) throw new LimsError('common.precondition_required');
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  if (!m || Number(m[1]) > MAX_VERSION) throw bad('/headers/if-match');
  return Number(m[1]);
}
const text = (v: unknown, path: string, max: number): string => {
  if (typeof v !== 'string' || v.length < 1 || v.length > max || v.includes('\u0000') || v.trim() === '') throw bad(path);
  return v;
};
function instant(v: unknown, path: string, now: Date): Date {
  const ms = typeof v === 'string' && ISO_INSTANT.test(v) ? Date.parse(v) : NaN;
  if (!Number.isFinite(ms) || ms > now.getTime() || ms < now.getTime() - BACKENTRY_MAX_HOURS * 3_600_000) throw bad(path);
  return new Date(ms);
}

interface Downtime { readonly occurredAt: string; readonly downtimeRef: string }
/** LD-25: `entry_mode` live (default) | downtime_backentry; a live write carries neither occurred_at nor downtime_ref (no back-dating of anything else). */
function parseDowntime(b: Obj, now: Date): Downtime | undefined {
  const mode = b['entry_mode'] === undefined ? 'live' : b['entry_mode'];
  if (mode !== 'live' && mode !== 'downtime_backentry') throw bad('/entry_mode');
  if (mode === 'live') {
    const extra = ['occurred_at', 'downtime_ref'].filter((k) => b[k] !== undefined).map((k) => `/${k}`);
    if (extra.length) throw bad(...extra);
    return undefined;
  }
  const errs: string[] = [];
  let at: Date | undefined;
  try { at = instant(b['occurred_at'], '/occurred_at', now); } catch { errs.push('/occurred_at'); }
  const ref = b['downtime_ref'];
  if (typeof ref !== 'string' || ref.length < 1 || ref.length > 32 || ref.includes('\u0000') || ref.trim() === '') errs.push('/downtime_ref');
  if (errs.length || !at) throw bad(...errs);
  return { occurredAt: at.toISOString(), downtimeRef: ref as string };
}

type Kind = 'collect' | 'dispatch' | 'receive' | 'store' | 'discard';
const KINDS: Record<Kind, { to: SpecimenStatus; permission: string; keys: readonly string[] }> = {
  collect: { to: 'collected', permission: P.collect, keys: ['collected_at'] },
  dispatch: { to: 'in_transit', permission: P.collect, keys: [] },
  receive: { to: 'received', permission: P.receive, keys: ['processing_centre_id'] },
  store: { to: 'stored', permission: P.receive, keys: ['location'] },
  discard: { to: 'discarded', permission: P.receive, keys: ['discard_reason'] },
};
const ENTRY_KEYS = ['entry_mode', 'occurred_at', 'downtime_ref'];

interface Action { kind: Kind; at: Date; downtime?: Downtime; processingCentreId?: string; location?: string; reason?: string }
/** The body of one action (single op) or the shared part of a bulk body. `extra` = the allowed non-action keys (items for bulk). */
function parseAction(kind: Kind, body: unknown, now: Date, extra: readonly string[] = [], singleOp = true): Action {
  const k = KINDS[kind];
  const keys = singleOp ? k.keys : k.keys.filter((x) => x !== 'collected_at');      // bulk bodies have no per-item collected_at
  const b = strict(body, [...keys, ...ENTRY_KEYS, ...extra]);
  const downtime = parseDowntime(b, now);
  let at = downtime ? new Date(downtime.occurredAt) : now;
  if (b['collected_at'] !== undefined) {
    if (downtime) throw bad('/collected_at');                                      // two action times: ambiguous
    at = instant(b['collected_at'], '/collected_at', now);
  }
  const out: Action = { kind, at, ...(downtime ? { downtime } : {}) };
  if (kind === 'receive') { const v = b['processing_centre_id']; if (typeof v !== 'string' || !UUID.test(v)) throw bad('/processing_centre_id'); out.processingCentreId = v.toLowerCase(); }
  if (kind === 'store') out.location = text(b['location'], '/location', 120);
  if (kind === 'discard') out.reason = text(b['discard_reason'], '/discard_reason', 200);
  return out;
}

// ---- access: centre scope (REQ-SEC-017, 03-APP-FLOW E25) ----
async function scopeOf(c: SpecimenCtx): Promise<{ all: boolean; centreIds: readonly string[] }> {
  const s = (await c.ports.IdentityPort.getActor(c)).centreScope;
  return { all: s?.all === true, centreIds: s?.centreIds ?? [] };                  // no scope = no centre (fail closed)
}
type Scope = Awaited<ReturnType<typeof scopeOf>>;
/** Visible when its collection centre OR its processing centre is in scope; otherwise it does not exist for the caller (404, never 403). */
const visible = (s: Scope, row: Obj): boolean => s.all || s.centreIds.includes(row['centre_id']) || (row['processing_centre_id'] != null && s.centreIds.includes(row['processing_centre_id']));
const role = (c: SpecimenCtx, permission: string) => c.ports.IdentityPort.assertRole(c, { permission });

async function dto(c: SpecimenCtx, row: Obj): Promise<Obj> {
  const tests = groupTests(await listTestsOfSpecimens(repoCtx(c), [row['id']]));
  return specimenDto(row, tests.get(row['id']) ?? []);
}

// ---- the one transition mechanic shared by every action ----
/** Writes specimen row (+version), the S-transition row and the order-test/result side effects. Throws LimsError; emits nothing (see emit). */
async function move(c: SpecimenCtx, row: Obj, version: number, a: Action, centre: { id: string; branchId: string } | undefined): Promise<{ updated: Obj; code: string }> {
  if (Number(row['version']) !== version) throw new LimsError('common.version_conflict');
  const to = KINDS[a.kind].to;
  if (a.kind === 'receive') assertSpecimenReceivable(row['status']);               // AC-04.3 (rejected / discarded) before the generic table check
  const code = specimenTransition(row['status'], to, { isActive: row['is_active'] === true });
  const rc = repoCtx(c);
  const at = a.at.toISOString();
  const member = c.actor.membershipId ?? null;
  const patch: Obj = { status: to };
  if (a.kind === 'collect') Object.assign(patch, { collected_at: at, collected_by_membership_id: member });
  if (a.kind === 'dispatch') patch['in_transit_at'] = at;
  if (a.kind === 'receive') Object.assign(patch, { received_at: at, received_by_membership_id: member, processing_centre_id: centre!.id, processing_branch_id: centre!.branchId });
  if (a.kind === 'store') Object.assign(patch, { stored_at: at, storage_location: a.location });
  if (a.kind === 'discard') Object.assign(patch, { discarded_at: at, discard_reason: a.reason });
  const updated = await updateSpecimen(rc, row['id'], version, patch);            // version = version + 1 in the same statement; a racing writer gets common.version_conflict
  await insertSpecimenTransition(rc, {
    id: uuidv7(), centre_id: row['centre_id'], ...(updated['processing_centre_id'] ? { processing_centre_id: updated['processing_centre_id'] } : {}), specimen_id: row['id'],
    transition_code: code, from_status: row['status'], to_status: to, specimen_version: Number(updated['version']), occurred_at: at,
    actor_type: c.actor.type ?? 'user', actor_id: c.actor.id, ...(member ? { membership_id: member } : {}),
  });
  if (a.kind === 'collect') await markTestsAwaitingReceipt(rc, row['id']);        // 02-TRD §3.3
  if (a.kind === 'receive') {                                                      // 03-APP-FLOW S4 + 08 A13 D-13
    const p = { centreId: centre!.id, branchId: centre!.branchId };
    await startTestsOfSpecimen(rc, row['id'], { ...p, receivedAt: at });
    await copyProcessingToResultsOfSpecimen(rc, row['id'], p);
    await copyProcessingToExistingMaterialTests(rc, row['order_id'], p);
    await copyProcessingToExistingMaterialResults(rc, row['order_id'], p);
  }
  return { updated: { ...updated, registration_no: row['registration_no'] }, code };
}

/** After a committed-in-tx write: lab.specimen.status_changed.v1 (key `<id>:<to>:<version>`) and, for a back-entry, the audit entry (LD-25). */
async function emit(c: SpecimenCtx, before: Obj, after: Obj, a: Action): Promise<void> {
  const to = KINDS[a.kind].to;
  await createLabEvents(c.events as never).specimenStatusChanged(c as never, {
    specimen_id: after['id'], order_id: after['order_id'], patient_id: after['patient_id'], centre_id: after['centre_id'],
    ...(after['processing_branch_id'] ? { processing_branch_id: after['processing_branch_id'] } : {}),
    specimen_type_code: after['specimen_type_code'],
    ...(after['parent_specimen_id'] ? { parent_specimen_id: after['parent_specimen_id'] } : {}),
    ...(after['replaces_specimen_id'] ? { replaces_specimen_id: after['replaces_specimen_id'] } : {}),
    from_status: before['status'], to_status: to, changed_at: a.at.toISOString(),
  }, { specimenVersion: Number(after['version']) });
  if (a.downtime) {
    // [CONV] audit.g_cs_access_actions has no specimen action yet; 'patient.view' is the FD-T06 precedent for LD-25 back-entry audit rows (open point in the impl note).
    await c.audit.access({ action: 'patient.view', entityType: 'specimen', entityId: after['id'], centreId: after['centre_id'], outcome: 'allowed',
      detail: { entry_mode: 'downtime_backentry', downtime_ref: a.downtime.downtimeRef, occurred_at: a.downtime.occurredAt, event: `specimen_${to}` } });
  }
}

/** Attack 5 (07-SECURITY): the processing centre must be in the actor's scope and exist for the tenant (403, existence not confirmed otherwise). */
async function resolveCentre(c: SpecimenCtx, centreId: string): Promise<{ id: string; branchId: string }> {
  const scope = await scopeOf(c);
  if (!scope.all && !scope.centreIds.includes(centreId)) throw new LimsError('auth.forbidden');
  const list = c.core?.centres?.list;
  if (!list) throw new LimsError('common.internal');
  const found = (await c.core!.centres!.list(c.tx, {})).find((x) => x['id'] === centreId);
  if (!found) throw new LimsError('auth.forbidden');
  const branchId = found['branchId'] ?? found['branch_id'];
  if (typeof branchId !== 'string' || !UUID.test(branchId)) throw new LimsError('common.internal');
  return { id: centreId, branchId };
}

// ---- single actions: collect (#4), receive (#7), store (#12), discard (#13) ----
async function single(hctx: unknown, kind: Exclude<Kind, 'dispatch'>, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c = specimenCtx(hctx);
  await role(c, KINDS[kind].permission);
  const id = uuidParam(params, 'specimen_id');
  const version = expectedVersion(headers);
  const a = parseAction(kind, body, c.now());
  const centre = a.processingCentreId ? await resolveCentre(c, a.processingCentreId) : undefined;
  const row = await getSpecimenWithOrder(repoCtx(c), id);
  if (!row || !visible(await scopeOf(c), row)) throw new LimsError('common.not_found');
  const { updated } = await move(c, row, version, a, centre);
  await emit(c, row, updated, a);
  return { status: 200, body: await dto(c, updated) };
}
export const collectSpecimen = (c: unknown, params: unknown, headers: unknown, body: unknown) => single(c, 'collect', params, headers, body);
export const receiveSpecimen = (c: unknown, params: unknown, headers: unknown, body: unknown) => single(c, 'receive', params, headers, body);
export const storeSpecimen = (c: unknown, params: unknown, headers: unknown, body: unknown) => single(c, 'store', params, headers, body);
export const discardSpecimen = (c: unknown, params: unknown, headers: unknown, body: unknown) => single(c, 'discard', params, headers, body);

// ---- bulk actions: collect (#5), dispatch (#6), receive (#8) — one tx, per-id outcome; an item that errors writes nothing, the others commit ----
const ITEM_ERRORS = new Set(['common.version_conflict', 'common.not_found', 'lab.specimen_invalid_transition', 'lab.specimen_inactive', 'lab.specimen_not_receivable']);
async function bulk(hctx: unknown, kind: 'collect' | 'dispatch' | 'receive', body: unknown): Promise<Result> {
  const c = specimenCtx(hctx);
  await role(c, KINDS[kind].permission);
  const b = strict(body, [...KINDS[kind].keys, ...ENTRY_KEYS, 'items']);
  const a = parseAction(kind, b, c.now(), ['items'], false);
  const raw = b['items'];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > BULK_MAX) throw bad('/items');
  const items = raw.map((it, i) => {
    const o = strict(it, ['id', 'version'], `/items/${i}`);
    if (typeof o['id'] !== 'string' || !UUID.test(o['id'])) throw bad(`/items/${i}/id`);
    if (!Number.isInteger(o['version']) || o['version'] < 1 || o['version'] > MAX_VERSION) throw bad(`/items/${i}/version`);
    return { id: (o['id'] as string).toLowerCase(), version: o['version'] as number };
  });
  const centre = a.processingCentreId ? await resolveCentre(c, a.processingCentreId) : undefined;   // whole request 403, nothing written
  const scope = await scopeOf(c);
  const rc = repoCtx(c);
  const results: Obj[] = [];
  for (const it of items) {
    const row = await getSpecimenWithOrder(rc, it.id);
    if (!row || !visible(scope, row)) { results.push({ id: it.id, outcome: 'error', code: 'common.not_found' }); continue; }
    let moved: { updated: Obj } | undefined;
    await c.tx.query('SAVEPOINT specimen_bulk_item');
    try {
      moved = await move(c, row, it.version, a, centre);
    } catch (e) {
      await c.tx.query('ROLLBACK TO SAVEPOINT specimen_bulk_item');
      await c.tx.query('RELEASE SAVEPOINT specimen_bulk_item');
      if (e instanceof LimsError && ITEM_ERRORS.has(e.code)) { results.push({ id: it.id, outcome: 'error', code: e.code }); continue; }
      throw e;                                                                      // anything else (db failure, misuse) fails the whole request
    }
    await c.tx.query('RELEASE SAVEPOINT specimen_bulk_item');
    await emit(c, row, moved.updated, a);                                           // event / audit failure is not an item outcome: it fails the request (rolled back)
    results.push({ id: it.id, outcome: 'ok', specimen: await dto(c, moved.updated) });
  }
  return { status: 200, body: { results } };
}
export const bulkCollectSpecimens = (c: unknown, body: unknown) => bulk(c, 'collect', body);
export const bulkDispatchSpecimens = (c: unknown, body: unknown) => bulk(c, 'dispatch', body);
export const bulkReceiveSpecimens = (c: unknown, body: unknown) => bulk(c, 'receive', body);

// ---- reads: lookup (#1), list (#2), get (#3) ----
export async function lookupSpecimenByBarcode(hctx: unknown, body: unknown): Promise<Result> {
  const c = specimenCtx(hctx);
  await role(c, P.read);
  const b = isObj(body) ? body : (() => { throw bad(); })();
  const rc = repoCtx(c);
  const scope = await scopeOf(c);
  const hasBarcode = b['barcode'] !== undefined;
  const hasReg = b['registration_no'] !== undefined;
  if (hasBarcode === hasReg) throw bad();                                          // exactly one of the two forms
  if (hasBarcode) {
    strict(b, ['barcode']);
    if (typeof b['barcode'] !== 'string' || !BARCODE.test(b['barcode'])) throw bad('/barcode');
    const row = await findSpecimenWithOrderByBarcode(rc, b['barcode']);
    if (!row || !visible(scope, row)) throw new LimsError('common.not_found');     // fixed text: the scanned code is never echoed
    return { status: 200, body: await dto(c, row) };
  }
  strict(b, ['registration_no']);
  if (typeof b['registration_no'] !== 'string' || !REG_NO.test(b['registration_no'])) throw bad('/registration_no');
  const rows = (await listSpecimensWithOrderByRegistrationNo(rc, b['registration_no'], BULK_MAX)).filter((r) => visible(scope, r));
  const tests = groupTests(await listTestsOfSpecimens(rc, rows.map((r) => r['id'])));
  return { status: 200, body: { data: rows.map((r) => specimenDto(r, tests.get(r['id']) ?? [])) } };
}

const LIST_KEYS = ['order_id', 'status', 'centre_id', 'processing_centre_id', 'priority', 'received_at_from', 'received_at_to', 'is_active', 'sort', 'cursor', 'limit'];
const SORTS = ['-created_at', 'received_at', '-received_at'] as const;
function parseListQuery(query: unknown) {
  const q = strict(query ?? {}, LIST_KEYS);
  const f: SpecimenFilter = { isActive: true };
  for (const [k, slot] of [['order_id', 'orderId'], ['centre_id', 'centreId'], ['processing_centre_id', 'processingCentreId']] as const) {
    if (q[k] === undefined) continue;
    if (typeof q[k] !== 'string' || !UUID.test(q[k])) throw bad(`/${k}`);
    f[slot] = (q[k] as string).toLowerCase();
  }
  if (q['status'] !== undefined) {
    const parts = typeof q['status'] === 'string' && q['status'].length <= 200 ? q['status'].split(',') : [];
    if (parts.length === 0 || !parts.every((s) => (SPECIMEN_STATUSES as readonly string[]).includes(s))) throw bad('/status');
    f.statuses = parts;
  }
  if (q['priority'] !== undefined) { if (typeof q['priority'] !== 'string' || !CODE.test(q['priority'])) throw bad('/priority'); f.priority = q['priority']; }
  for (const [k, slot] of [['received_at_from', 'receivedFrom'], ['received_at_to', 'receivedTo']] as const) {
    const v = q[k];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !ISO_MS.test(v) || Number.isNaN(Date.parse(v)) || new Date(v).toISOString() !== v) throw bad(`/${k}`);
    f[slot] = v;
  }
  const act = q['is_active'];
  if (act !== undefined) { if (act !== true && act !== false && act !== 'true' && act !== 'false') throw bad('/is_active'); f.isActive = act === true || act === 'true'; }
  const sort = (q['sort'] ?? '-created_at') as SpecimenSort;
  if (!(SORTS as readonly unknown[]).includes(sort)) throw bad('/sort');
  const raw = q['limit'];
  const limit = raw === undefined ? 50 : typeof raw === 'string' && /^[0-9]{1,3}$/.test(raw) ? Number(raw) : raw;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 200) throw bad('/limit');
  const after = q['cursor'] === undefined ? undefined : decodeCursor(q['cursor'], sort);
  return { f, sort, limit: limit as number, after };
}

export async function listSpecimens(hctx: unknown, query: unknown): Promise<Result> {
  const c = specimenCtx(hctx);
  await role(c, P.read);
  const { f, sort, limit, after } = parseListQuery(query);
  const scope = await scopeOf(c);
  if (!scope.all) f.scopeCentreIds = scope.centreIds;
  const rows = await pageSpecimens(repoCtx(c), f, { sort, limit, ...(after ? { after } : {}) });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const tests = groupTests(await listTestsOfSpecimens(repoCtx(c), page.map((r) => r['id'])));
  return { status: 200, body: { data: page.map((r) => specimenDto(r, tests.get(r['id']) ?? [])),
    page: { limit, ...(rows.length > limit && last ? { next_cursor: encodeCursor(sort, last['sort_key'], last['id']) } : {}) } } };
}

export async function getSpecimen(hctx: unknown, params: unknown): Promise<Result> {
  const c = specimenCtx(hctx);
  await role(c, P.read);
  const id = uuidParam(params, 'specimen_id');
  const rc = repoCtx(c);
  const row = await getSpecimenWithOrder(rc, id);
  if (!row || !visible(await scopeOf(c), row)) throw new LimsError('common.not_found');
  const tests = groupTests(await listTestsOfSpecimens(rc, [id]));
  let canSeeComment = true;                                                         // REQ-SEC-081: rejection_comment only for holders of lab.specimen.reject
  try { await role(c, P.reject); } catch (e) { if (e instanceof LimsError && e.code === 'auth.forbidden') canSeeComment = false; else throw e; }
  return { status: 200, body: specimenDetailDto(row, tests.get(id) ?? [], await listSpecimenTransitions(rc, id), await resultsSummaryOfSpecimen(rc, id), canSeeComment) };
}
