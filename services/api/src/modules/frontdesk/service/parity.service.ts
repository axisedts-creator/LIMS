// T0B-REGAPI-2 (LD-310, LD-315): the 18 operations added by T0C-REGPARITY-2 — persisted registration drafts, favourite tests, number preview, ICD master, coupons,
// custom field definitions, patient reward points. Permissions are EXISTING codes only (done_when 6): the user's own data and the reads the registration screen needs
// = frontdesk.registration.create; masters' writes and the coupon list = frontdesk.settings.manage (privileged: IdentityPort enforces aal2); rewards = frontdesk.patient.read.
// Draft payloads hold patient data: never logged, never echoed in an error (fixed messages only). Drafts / favourites belong to the calling membership.
import { toDate } from '../../../core/clock.js'; // T0D-FIX-6 (LD-448): ctx.now() is an ISO string in the pipeline, a Date in unit fakes
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import { formatNumber, hasToken } from '../domain/numbering.js';
import { dateOnly, decodeCursor, encodeCursor, isoUtc } from '../mappers/patient.dto.js';
import { FRONTDESK_PERMISSIONS as P } from '../permissions.js';
import { getPatientById } from '../repository/patients.repo.js';
import {
  addFavourite, deleteLiveDraft, getLiveDraft, insertDraft, insertMaster, lockDraftKey, lockMaster, pageDrafts, pageFavourites, pageMaster, pagePoints, pointTotals,
  purgeExpiredDrafts, readCounter, removeFavourite, replaceDraft, updateMaster, type Master,
} from '../repository/parity.repo.js';
import { bad, expectedVersion, isObj, patientCtx, strict, todayIn, type PatientCtx, type Result } from './patient.service.js';
import { fiscalYearOf, portErrors } from './registration.service.js';

type Obj = Record<string, any>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_PAYLOAD_BYTES = 1_048_576;   // registration_drafts__payload__ck
const omit = (o: Obj): Obj => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
const uuidAt = (v: unknown, path: string): string => { if (typeof v !== 'string' || !UUID.test(v)) throw bad(path); return v.toLowerCase(); };
const role = (c: PatientCtx, permission: string) => c.ports.IdentityPort.assertRole(c, { permission });
const me = (c: PatientCtx): string => c.actor.membershipId ?? c.actor.id;
const textAt = (v: unknown, path: string, max: number): string => { if (typeof v !== 'string' || v.includes('\u0000') || v.length === 0 || [...v].length > max) throw bad(path); return v; };
const intAt = (v: unknown, path: string, min: number, max: number): number => { if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) throw bad(path); return v as number; };
const boolAt = (v: unknown, path: string): boolean => { if (typeof v !== 'boolean') throw bad(path); return v; };
function dateAt(v: unknown, path: string): string {
  const m = typeof v === 'string' ? DATE.exec(v) : null;
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!m || !d || d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) throw bad(path);
  return v as string;
}
function limitOf(q: Obj): number {
  const raw = q['limit'];
  const n = raw === undefined ? 50 : typeof raw === 'string' && /^[0-9]{1,3}$/.test(raw) ? Number(raw) : raw;
  if (!Number.isInteger(n) || n < 1 || n > 200) throw bad('/limit');
  return n;
}
function boolQuery(v: unknown, path: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  throw bad(path);
}
/** Key-ordered cursor (masters): base64url(JSON [sort, ...keys]). */
const keyCursor = (sort: string, keys: readonly (string | number)[]) => Buffer.from(JSON.stringify([sort, ...keys]), 'utf8').toString('base64url');
function readKeyCursor(raw: unknown, sort: string, n: number): (string | number)[] {
  const fail = () => new LimsError('common.invalid_cursor');
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(raw)) throw fail();
  let v: unknown;
  try { v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { throw fail(); }
  if (!Array.isArray(v) || v.length !== n + 1 || v[0] !== sort || !v.slice(1).every((x) => (typeof x === 'string' && x.length <= 100) || Number.isSafeInteger(x))) throw fail();
  return v.slice(1);
}
const page = <T>(rows: T[], limit: number, next: (last: T) => string) =>
  ({ rows: rows.slice(0, limit), page: { limit, ...(rows.length > limit ? { next_cursor: next(rows[limit - 1]!) } : {}) } });
async function assertCentre(c: PatientCtx, centreId: string): Promise<{ branchId: string }> {
  const scope = (await c.ports.IdentityPort.getActor(c)).centreScope;
  if (scope && scope.all !== true && !scope.centreIds.includes(centreId)) throw new LimsError('common.not_found');   // 404, never 403
  const core = (c as unknown as { core?: { centre(ctx: unknown, i: { centreId: string }): Promise<{ branchId: string }> } }).core;
  if (typeof core?.centre !== 'function') throw new LimsError('common.service_unavailable');
  return core.centre(c, { centreId });   // tenant-bound: unknown / other tenant -> common.not_found
}

// ======================= registration drafts =======================
const draftSummary = (r: Obj) => ({ id: r['id'], centre_id: r['centre_id'], created_at: isoUtc(r['created_at'])!, updated_at: isoUtc(r['updated_at'])!, expires_at: isoUtc(r['expires_at'])! });
const draftDto = (r: Obj) => ({ ...draftSummary(r), payload: JSON.stringify(r['payload']) });

export async function createRegistrationDraft(hctx: unknown, body: unknown): Promise<Result> {
  const c = patientCtx(hctx);
  await role(c, P.registrationCreate);
  const b = strict(body, ['centre_id', 'payload']);
  const centreId = uuidAt(b['centre_id'], '/centre_id');
  const text = b['payload'];
  let payload: unknown;
  try { payload = typeof text === 'string' && Buffer.byteLength(text, 'utf8') <= MAX_PAYLOAD_BYTES ? JSON.parse(text) : undefined; } catch { payload = undefined; }
  if (!isObj(payload) || Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_PAYLOAD_BYTES) throw bad('/payload');
  await assertCentre(c, centreId);
  const user = me(c);
  await lockDraftKey(c.tx, c.tenantId, user, centreId);
  await purgeExpiredDrafts(c.tx, c.tenantId, user);   // the 14 day expiry: the caller's own expired rows go (the delete policy is owner bound, LD-315 b)
  try {
    const row = (await replaceDraft(c.tx, c.tenantId, user, centreId, payload)) ?? await insertDraft(c.tx, c.tenantId, { id: uuidv7(), user_id: user, centre_id: centreId, payload });
    return { status: 201, body: draftDto(row) };
  } catch (e) {
    if ((e as Obj)?.['code'] === '23514') throw bad('/payload');   // the jsonb text form is a little longer than the JSON text: the DB CHECK has the last word
    throw e;
  }
}

export async function listRegistrationDrafts(hctx: unknown, query: unknown): Promise<Result> {
  const c = patientCtx(hctx);
  await role(c, P.registrationCreate);
  const q = strict(query ?? {}, ['centre_id', 'cursor', 'limit']);
  const limit = limitOf(q);
  const centreId = q['centre_id'] === undefined ? undefined : uuidAt(q['centre_id'], '/centre_id');
  const after = q['cursor'] === undefined ? undefined : decodeCursor(q['cursor'], 'updated_at');
  const rows = await pageDrafts(c.tx, c.tenantId, me(c), { limit, ...(centreId ? { centreId } : {}), ...(after ? { after } : {}) });
  const p = page(rows, limit, (l) => encodeCursor('updated_at', l['sort_key'], l['id']));
  return { status: 200, body: { data: p.rows.map(draftSummary), page: p.page } };
}

const draftId = (params: unknown) => uuidAt(isObj(params) ? params['draft_id'] : undefined, '/draft_id');
export async function getRegistrationDraft(hctx: unknown, params: unknown): Promise<Result> {
  const c = patientCtx(hctx);
  await role(c, P.registrationCreate);
  const row = await getLiveDraft(c.tx, c.tenantId, me(c), draftId(params));
  if (!row) throw new LimsError('common.not_found');   // another user's, expired and unknown: one answer
  return { status: 200, body: draftDto(row) };
}
export async function deleteRegistrationDraft(hctx: unknown, params: unknown): Promise<Result> {
  const c = patientCtx(hctx);
  await role(c, P.registrationCreate);
  if ((await deleteLiveDraft(c.tx, c.tenantId, me(c), draftId(params))) === 0) throw new LimsError('common.not_found');
  return { status: 204, body: undefined };
}

// ======================= favourite tests =======================
const favDto = (r: Obj) => ({ orderable_id: r['orderable_id'], created_at: isoUtc(r['created_at'])! });

export function addFavouriteTest(hctx: unknown, body: unknown): Promise<Result> {
  return portErrors(async () => {
    const c = patientCtx(hctx);
    await role(c, P.registrationCreate);
    const orderableId = uuidAt(strict(body, ['orderable_id'])['orderable_id'], '/orderable_id');
    const catalog = (c.ports as Obj)['CatalogPort'];
    if (typeof catalog?.resolveOrderables !== 'function') throw new LimsError('common.service_unavailable');
    const found = await catalog.resolveOrderables(c, { orderableIds: [orderableId], asOf: toDate(c.now()).toISOString() });   // tenant-bound: unknown / other tenant -> not_found
    if (!found?.orderables?.some((o: Obj) => o['orderableId'] === orderableId)) throw new LimsError('common.not_found');
    const out = await addFavourite(c.tx, c.tenantId, { id: uuidv7(), user_id: me(c), orderable_id: orderableId });
    return { status: out.created ? 201 : 200, body: favDto(out.row) };
  });
}
export async function listFavouriteTests(hctx: unknown, query: unknown): Promise<Result> {
  const c = patientCtx(hctx);
  await role(c, P.registrationCreate);
  const q = strict(query ?? {}, ['cursor', 'limit']);
  const limit = limitOf(q);
  const after = q['cursor'] === undefined ? undefined : decodeCursor(q['cursor'], 'created_at');
  const rows = await pageFavourites(c.tx, c.tenantId, me(c), { limit, ...(after ? { after } : {}) });
  const p = page(rows, limit, (l) => encodeCursor('created_at', l['sort_key'], l['id']));
  return { status: 200, body: { data: p.rows.map(favDto), page: p.page } };
}
export async function removeFavouriteTest(hctx: unknown, params: unknown): Promise<Result> {
  const c = patientCtx(hctx);
  await role(c, P.registrationCreate);
  const id = uuidAt(isObj(params) ? params['orderable_id'] : undefined, '/orderable_id');
  if ((await removeFavourite(c.tx, c.tenantId, me(c), id)) === 0) throw new LimsError('common.not_found');
  return { status: 204, body: undefined };
}

// ======================= masters: ICD codes, coupons, custom field definitions =======================
const ICD_CODE = /^[0-9A-Z][0-9A-Z.]{0,15}$/;
const COUPON_CODE = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;
const FIELD_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const FIELD_TYPES = ['text', 'number', 'date', 'choice'];
const KEY_OF: Record<Master, { col: string; path: string }> = { coupons: { col: 'code', path: '/code' }, icd_codes: { col: 'code', path: '/code' }, custom_field_definitions: { col: 'field_key', path: '/field_key' } };

export const icdDto = (r: Obj) => ({ id: r['id'], code: r['code'], description: r['description'], is_active: r['is_active'] === true, version: Number(r['version']) });
export const couponDto = (r: Obj) => omit({
  id: r['id'], code: r['code'], amount_paisa: r['amount_paisa'] == null ? undefined : Number(r['amount_paisa']), percent: r['percent'] == null ? undefined : Number(r['percent']),
  valid_from: dateOnly(r['valid_from']), valid_to: dateOnly(r['valid_to']), usage_limit: r['usage_limit'] == null ? undefined : Number(r['usage_limit']),
  used_count: Number(r['used_count']), is_active: r['is_active'] === true, version: Number(r['version']),
});
export const fieldDto = (r: Obj) => omit({
  id: r['id'], field_key: r['field_key'], label: r['label'], field_type: r['field_type'], required: r['required'] === true, is_active: r['is_active'] === true,
  choices: Array.isArray(r['choices']) ? r['choices'] : undefined, sort_order: Number(r['sort_order']), version: Number(r['version']),
});
const DTO: Record<Master, (r: Obj) => Obj> = { coupons: couponDto, icd_codes: icdDto, custom_field_definitions: fieldDto };

function choicesAt(v: unknown, path: string): string[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 50) throw bad(path);
  return v.map((x, i) => textAt(x, `${path}/${i}`, 100));
}

/** A duplicate key in the tenant is 400 at the key's path (errors.yaml has no 409 for it); the pg text (it holds the value) is dropped. */
async function insertUnique(c: PatientCtx, t: Master, row: Obj): Promise<Result> {
  try {
    const created = await insertMaster(c.tx, t, c.tenantId, { id: uuidv7(), ...row });
    if (!created) throw new LimsError('common.not_found');   // no row came back (RLS hid it): a LimsError, never a TypeError in the DTO
    return { status: 201, body: DTO[t](created) };
  } catch (e) {
    if ((e as Obj)?.['code'] === '23505') throw bad(KEY_OF[t].path);
    throw e;
  }
}
async function patchMaster(c: PatientCtx, t: Master, id: unknown, version: number, set: Obj, check?: (cur: Obj, set: Obj) => void): Promise<Result> {
  const cur = typeof id === 'string' && UUID.test(id) ? await lockMaster(c.tx, t, c.tenantId, id) : null;
  if (!cur) throw new LimsError('common.not_found');
  if (Object.keys(set).length === 0) throw bad('');   // after the tenant lookup: an unknown / other tenant id answers 404 before any body complaint
  if (Number(cur['version']) !== version) throw new LimsError('common.version_conflict');
  check?.(cur, set);
  const row = await updateMaster(c.tx, t, c.tenantId, cur['id'], version, set);
  if (!row) throw new LimsError('common.version_conflict');
  return { status: 200, body: DTO[t](row) };
}
async function listMaster(c: PatientCtx, t: Master, query: unknown, extra: readonly string[] = []): Promise<Result> {
  const q = strict(query ?? {}, ['is_active', 'cursor', 'limit', ...extra]);
  const limit = limitOf(q);
  const isActive = boolQuery(q['is_active'], '/is_active');
  const fields = t === 'custom_field_definitions';
  const after = q['cursor'] === undefined ? undefined : readKeyCursor(q['cursor'], t, fields ? 2 : 1);
  const qq = q['q'] === undefined ? undefined : textAt(q['q'], '/q', 64);
  const rows = await pageMaster(c.tx, t, c.tenantId, { limit, ...(isActive === undefined ? {} : { isActive }), ...(qq === undefined ? {} : { q: qq }), ...(after ? { after } : {}) });
  const p = page(rows, limit, (l) => keyCursor(t, fields ? [Number(l['sort_order']), l['field_key']] : [l['code']]));
  return { status: 200, body: { data: p.rows.map(DTO[t]), page: p.page } };
}

// ---- ICD
export async function createIcdCode(hctx: unknown, body: unknown): Promise<Result> {
  const c = patientCtx(hctx);
  await role(c, P.settingsManage);
  const b = strict(body, ['code', 'description', 'is_active']);
  if (typeof b['code'] !== 'string' || !ICD_CODE.test(b['code'])) throw bad('/code');
  return insertUnique(c, 'icd_codes', { code: b['code'], description: textAt(b['description'], '/description', 500),
    ...(b['is_active'] === undefined ? {} : { is_active: boolAt(b['is_active'], '/is_active') }) });
}
export async function updateIcdCode(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c = patientCtx(hctx);
  await role(c, P.settingsManage);
  const version = expectedVersion(headers);
  const b = strict(body, ['description', 'is_active']);
  const set: Obj = {};
  if (b['description'] !== undefined) set['description'] = textAt(b['description'], '/description', 500);
  if (b['is_active'] !== undefined) set['is_active'] = boolAt(b['is_active'], '/is_active');
  return patchMaster(c, 'icd_codes', isObj(params) ? params['icd_code_id'] : undefined, version, set);
}
export async function listIcdCodes(hctx: unknown, query: unknown): Promise<Result> {
  const c = patientCtx(hctx);
  await role(c, P.registrationCreate);
  return listMaster(c, 'icd_codes', query, ['q']);
}

// ---- coupons
export async function createCoupon(hctx: unknown, body: unknown): Promise<Result> {
  const c = patientCtx(hctx);
  await role(c, P.settingsManage);
  const b = strict(body, ['code', 'amount_paisa', 'percent', 'valid_from', 'valid_to', 'usage_limit', 'is_active']);
  if (typeof b['code'] !== 'string' || !COUPON_CODE.test(b['code'])) throw bad('/code');
  if ((b['amount_paisa'] === undefined) === (b['percent'] === undefined)) throw bad('/amount_paisa', '/percent');   // exactly one
  const row: Obj = { code: b['code'] };
  if (b['amount_paisa'] !== undefined) row['amount_paisa'] = intAt(b['amount_paisa'], '/amount_paisa', 1, Number.MAX_SAFE_INTEGER);
  if (b['percent'] !== undefined) row['percent'] = intAt(b['percent'], '/percent', 1, 100);
  if (b['valid_from'] !== undefined) row['valid_from'] = dateAt(b['valid_from'], '/valid_from');
  if (b['valid_to'] !== undefined) row['valid_to'] = dateAt(b['valid_to'], '/valid_to');
  if (row['valid_from'] && row['valid_to'] && row['valid_to'] < row['valid_from']) throw bad('/valid_to');
  if (b['usage_limit'] !== undefined) row['usage_limit'] = intAt(b['usage_limit'], '/usage_limit', 1, 2147483647);
  if (b['is_active'] !== undefined) row['is_active'] = boolAt(b['is_active'], '/is_active');
  return insertUnique(c, 'coupons', row);
}
export async function updateCoupon(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c = patientCtx(hctx);
  await role(c, P.settingsManage);
  const version = expectedVersion(headers);
  const b = strict(body, ['valid_from', 'valid_to', 'usage_limit', 'is_active']);   // code, amount and percent never change (contract)
  const set: Obj = {};
  if (b['valid_from'] !== undefined) set['valid_from'] = dateAt(b['valid_from'], '/valid_from');
  if (b['valid_to'] !== undefined) set['valid_to'] = dateAt(b['valid_to'], '/valid_to');
  if (b['usage_limit'] !== undefined) set['usage_limit'] = intAt(b['usage_limit'], '/usage_limit', 1, 2147483647);
  if (b['is_active'] !== undefined) set['is_active'] = boolAt(b['is_active'], '/is_active');
  return patchMaster(c, 'coupons', isObj(params) ? params['coupon_id'] : undefined, version, set, (cur, s) => {
    const from = s['valid_from'] ?? dateOnly(cur['valid_from']); const to = s['valid_to'] ?? dateOnly(cur['valid_to']);
    if (from && to && to < from) throw bad('/valid_to');
    if (s['usage_limit'] !== undefined && s['usage_limit'] < Number(cur['used_count'])) throw bad('/usage_limit');   // never below what is already used
  });
}
export async function listCoupons(hctx: unknown, query: unknown): Promise<Result> {
  const c = patientCtx(hctx);
  await role(c, P.settingsManage);
  return listMaster(c, 'coupons', query);
}

// ---- custom field definitions
export async function createCustomFieldDefinition(hctx: unknown, body: unknown): Promise<Result> {
  const c = patientCtx(hctx);
  await role(c, P.settingsManage);
  const b = strict(body, ['field_key', 'label', 'field_type', 'required', 'is_active', 'choices', 'sort_order']);
  if (typeof b['field_key'] !== 'string' || !FIELD_KEY.test(b['field_key'])) throw bad('/field_key');
  if (!FIELD_TYPES.includes(b['field_type'])) throw bad('/field_type');
  const row: Obj = { field_key: b['field_key'], label: textAt(b['label'], '/label', 100), field_type: b['field_type'] };
  if (b['field_type'] === 'choice') row['choices'] = choicesAt(b['choices'], '/choices');
  else if (b['choices'] !== undefined) throw bad('/choices');   // choices only for type choice (contract service rule)
  if (b['required'] !== undefined) row['required'] = boolAt(b['required'], '/required');
  if (b['is_active'] !== undefined) row['is_active'] = boolAt(b['is_active'], '/is_active');
  if (b['sort_order'] !== undefined) row['sort_order'] = intAt(b['sort_order'], '/sort_order', 0, 1000);
  return insertUnique(c, 'custom_field_definitions', row);
}
export async function updateCustomFieldDefinition(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c = patientCtx(hctx);
  await role(c, P.settingsManage);
  const version = expectedVersion(headers);
  const b = strict(body, ['label', 'required', 'is_active', 'choices', 'sort_order']);   // field_key and field_type never change
  const set: Obj = {};
  if (b['label'] !== undefined) set['label'] = textAt(b['label'], '/label', 100);
  if (b['required'] !== undefined) set['required'] = boolAt(b['required'], '/required');
  if (b['is_active'] !== undefined) set['is_active'] = boolAt(b['is_active'], '/is_active');
  if (b['choices'] !== undefined) set['choices'] = choicesAt(b['choices'], '/choices');
  if (b['sort_order'] !== undefined) set['sort_order'] = intAt(b['sort_order'], '/sort_order', 0, 1000);
  return patchMaster(c, 'custom_field_definitions', isObj(params) ? params['definition_id'] : undefined, version, set, (cur, s) => {
    if (s['choices'] !== undefined && cur['field_type'] !== 'choice') throw bad('/choices');
  });
}
export async function listCustomFieldDefinitions(hctx: unknown, query: unknown): Promise<Result> {
  const c = patientCtx(hctx);
  await role(c, P.registrationCreate);
  return listMaster(c, 'custom_field_definitions', query);
}

/** Patient.custom_fields {code: value} against the ACTIVE definitions (code = field_key). Codes without a definition are left alone (free custom fields, T0B-REGAPI-1). */
export function checkCustomFields(values: Obj, defs: readonly Obj[]): void {
  for (const d of defs) {
    const v = values[d['field_key']];
    if (v === undefined) { if (d['required'] === true) throw bad('/custom_fields'); continue; }
    const s = String(v);
    const okType = d['field_type'] === 'number' ? /^-?[0-9]+(\.[0-9]+)?$/.test(s)
      : d['field_type'] === 'date' ? (() => { try { dateAt(s, ''); return true; } catch { return false; } })()
        : d['field_type'] === 'choice' ? Array.isArray(d['choices']) && d['choices'].includes(s) : true;
    if (!okType) throw bad('/custom_fields');
  }
}

// ======================= reward points =======================
export async function getPatientRewards(hctx: unknown, params: unknown, query: unknown): Promise<Result> {
  const c = patientCtx(hctx);
  await role(c, P.patientRead);
  const q = strict(query ?? {}, ['cursor', 'limit']);
  const limit = limitOf(q);
  const after = q['cursor'] === undefined ? undefined : decodeCursor(q['cursor'], 'created_at');
  const id = isObj(params) ? params['patient_id'] : undefined;
  const p = typeof id === 'string' && UUID.test(id) ? await getPatientById(c.tx, c.tenantId, id) : null;
  if (!p) throw new LimsError('common.not_found');
  const t = await pointTotals(c.tx, c.tenantId, p['id']);
  const rows = await pagePoints(c.tx, c.tenantId, p['id'], { limit, ...(after ? { after } : {}) });
  const pg = page(rows, limit, (l) => encodeCursor('created_at', l['sort_key'], l['id']));
  return { status: 200, body: {
    patient_id: p['id'], balance_points: Math.max(0, t.earned - t.redeemed), earned_points: t.earned, redeemed_points: t.redeemed,
    data: pg.rows.map((r) => ({ id: r['id'], entry_kind: r['entry_kind'], points: Number(r['points']), order_id: r['order_id'], created_at: isoUtc(r['created_at'])! })), page: pg.page,
  } };
}

// ======================= number preview (reads only) =======================
export function previewNumbers(hctx: unknown, query: unknown): Promise<Result> {
  return portErrors(async () => {
    const c = patientCtx(hctx);
    await role(c, P.registrationCreate);
    const q = strict(query ?? {}, ['centre_id']);
    const centreId = uuidAt(q['centre_id'], '/centre_id');
    const { branchId } = await assertCentre(c, centreId);
    const tenant = (await c.ports.IdentityPort.getTenantSettings(c, { keys: ['numbering', 'timezone'] })) ?? {};
    const pattern = tenant.numbering?.registrationNoPattern;
    if (typeof pattern !== 'string') throw new LimsError('common.internal');
    const tz = typeof tenant.timezone === 'string' ? tenant.timezone : 'Asia/Kathmandu';
    const today = todayIn(tz, toDate(c.now()));
    const core = (c as unknown as { core: { branch(ctx: unknown, i: { branchId: string }): Promise<{ branchCode: string }> } }).core;
    const branch = hasToken(pattern, 'branch') ? (await core.branch(c, { branchId })).branchCode : undefined;
    // the same counter row the save takes under its row lock (counters.repo nextCounterValue), READ here: last_value + 1, nothing consumed
    const seq = (await readCounter(c.tx, c.tenantId, 'registration_no', branchId)) + 1;
    const regNo = formatNumber(pattern, { seq, year: Number(today.slice(0, 4)), ...(branch === undefined ? {} : { branch }) });
    // bill number (LD-323 b): registration payments use issueReceiptNo=false, so the invoice IS the receipt (PRD D-RECEIPT): the number shown is the next INV,
    // read through BillingCommandPort.previewInvoiceNo (08 R25: frontdesk reads no billing table). Assigned when saved; two users may see the same number.
    // LD-323 (c): no fallback number ever; if the port call fails the field is empty (the UI shows only the "assigned when saved" label).
    const portCtx = Object.defineProperty(Object.create(c as object), 'now', { value: () => toDate(c.now()).toISOString(), writable: true, configurable: true, enumerable: true });
    let receiptNo = '';
    try { receiptNo = String((await (c.ports as Obj)['BillingCommandPort'].previewInvoiceNo(portCtx, {})).invoiceNo); } catch { /* LD-323 (c): empty, never a guessed number */ }
    return { status: 200, body: { centre_id: centreId, next_registration_no: regNo, next_receipt_no: receiptNo, next_receipt_no_label: 'assigned when saved', is_preview: true } };   // LD-331 label, always present
  });
}
