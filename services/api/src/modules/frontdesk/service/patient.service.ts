// Patients F1-F6 (02-TRD §5.1; PRD US-FD-01.1-6, US-FD-02.1-5; 07-SECURITY REQ-SEC-005/024/095). One transaction = ctx.tx (RLS on); access-log rows
// commit with the action. The core pipeline already schema-validates; every check here is repeated defensively (fail closed, never echo request values).
// Ctx shape is ASSUMED (spec names no frontdesk ctx): tenantId, tx, requestId, now(), centreId, actor, audit.access, ports.IdentityPort{assertRole,getActor,getTenantSettings}.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, type FieldError } from '../../../core/errors.js';
import { estimatedBirthOn, isDuplicateSuspect, normaliseName } from '../domain/patient.js';
import { formatNumber } from '../domain/numbering.js';
import { consentRecordDto, dateOnly, decodeCursor, encodeCursor, orderSummaryDto, patientDto, patientSummaryDto } from '../mappers/patient.dto.js';
import { nextCounterValue } from '../repository/counters.repo.js';
import { insertConsent, listConsentsByPatient } from '../repository/consents.repo.js';
import { deriveOrderStatus, type ItemProcessingStatus, type OrderStatus } from '../domain/order.state.js';
import { activeItemIdsByOrders } from '../repository/orderItems.repo.js';
import { lastOrderAt, openOrdersOfPatient, pageOrdersByPatient } from '../repository/orders.repo.js';
import { anonymisePatientRow, duplicateCandidates, findDedupePool, findPatientsByCode, findPatientsByPhone, findPatientsByRegistrationNo, getPatientById, insertPatient,
  pageDuplicatePatients, searchPatientsByNameRanked, updatePatientRow } from '../repository/patients.repo.js';
import { getSettings } from '../repository/settings.repo.js';
import { deactivateTrfByPatient } from '../repository/trf.repo.js';
import type { Tx } from '../repository/shared.repo.js';
import { FRONTDESK_PERMISSIONS as P } from '../permissions.js';

export interface PatientCtx {
  readonly tenantId: string; readonly tx: Tx; readonly requestId: string; now(): Date; readonly centreId?: string;
  readonly actor: { readonly type: string; readonly id: string; readonly membershipId?: string };
  readonly audit: { access(e: object): Promise<void> };
  readonly ports: { readonly IdentityPort: {
    assertRole(ctx: unknown, r: { permission: string; centreId?: string }): Promise<void>;
    getActor(ctx: unknown): Promise<{ displayName: string; permissions: readonly string[]; centreScope?: { all?: boolean; centreIds: readonly string[] } }>;
    getTenantSettings(ctx: unknown, i: { keys: readonly string[] }): Promise<any>;
  } };
}
export type Result = { status: number; body: unknown };
type Obj = Record<string, any>;

/** Fail closed when the pipeline did not hand us an authenticated request context. */
export function patientCtx(c: unknown): PatientCtx {
  const x = c as Partial<PatientCtx> | null;
  if (typeof x?.tenantId !== 'string' || !x.tx || typeof x.actor?.id !== 'string' || typeof x.now !== 'function' || typeof x.audit?.access !== 'function' || !x.ports?.IdentityPort) {
    throw new LimsError('auth.unauthenticated');
  }
  return x as PatientCtx;
}

// ---- validation helpers (messages are fixed text: no submitted value is ever echoed) ----
export const bad = (...paths: string[]): LimsError => new LimsError('common.validation_failed', undefined,
  paths.map((path): FieldError => ({ path, code: 'common.field_invalid', message: 'Field invalid' })));
export const isObj =(v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export function strict(v: unknown, allowed: readonly string[], path = ''): Obj {
  if (!isObj(v)) throw bad(path);
  for (const k of Object.keys(v)) if (!allowed.includes(k)) throw new LimsError('common.validation_failed', undefined, [{ path: `${path}/${k}`, code: 'common.unknown_field', message: 'Unknown field' }]);
  return v;
}
const SEX = ['male', 'female', 'other', 'unknown'];
const PHONE = /^\+[1-9][0-9]{7,14}$/;
const CODE = /^[A-Za-z0-9_.:^+\-]{1,64}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const noNul = (s: string): boolean => !s.includes('\u0000');
function text(v: unknown, path: string, max: number, o: { min?: number } = {}): string {
  if (typeof v !== 'string' || !noNul(v)) throw bad(path);
  const t = v.trim();
  if ([...t].length < (o.min ?? 0) || v.length > max) throw bad(path);
  return t;
}
function calendarDate(v: unknown, path: string, today: string): string {
  const m = typeof v === 'string' ? DATE.exec(v) : null;
  if (!m) throw bad(path);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || (v as string) > today) throw bad(path);   // impossible or future
  return v as string;
}
/** today's A.D. date in the tenant timezone. */
export function todayIn(tz: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
const daysIn = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** today minus years/months/days (US-FD-02.1). Years via the domain helper (Feb 29 rule); then months (day clamped), then days. */
function birthFromAge(age: unknown, today: string): string {
  const a = strict(age, ['years', 'months', 'days'], '/age');
  const int = (k: string, max: number, dflt?: number): number => {
    const v = a[k] ?? dflt;
    if (!Number.isInteger(v) || v < 0 || v > max) throw bad(`/age/${k}`);
    return v;
  };
  const years = int('years', 150); const months = int('months', 11, 0); const days = int('days', 31, 0);
  const [y0, m0, d0] = estimatedBirthOn(years, today).split('-').map(Number) as [number, number, number];
  const idx = y0 * 12 + (m0 - 1) - months;
  const y = Math.floor(idx / 12); const m = (idx % 12) + 1;
  return new Date(Date.UTC(y, m - 1, Math.min(d0, daysIn(y, m)) - days)).toISOString().slice(0, 10);
}

async function role(c: PatientCtx, permission: string): Promise<void> { await c.ports.IdentityPort.assertRole(c, { permission }); }
async function tenantInfo(c: PatientCtx): Promise<{ today: string; tz: string; numbering: Obj }> {
  const s = (await c.ports.IdentityPort.getTenantSettings(c, { keys: ['numbering', 'timezone'] })) ?? {};
  const tz = typeof s.timezone === 'string' ? s.timezone : 'Asia/Kathmandu';
  return { today: todayIn(tz, c.now()), tz, numbering: isObj(s.numbering) ? s.numbering : {} };
}
const canSeePii = async (c: PatientCtx): Promise<boolean> => (await c.ports.IdentityPort.getActor(c)).permissions.includes(P.registrationCreate);
const consentOf = async (c: PatientCtx, patientId: string) => (await listConsentsByPatient(c.tx, c.tenantId, patientId))[0];
async function loadPatient(c: PatientCtx, id: unknown): Promise<Obj> {
  const r = typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id) ? await getPatientById(c.tx, c.tenantId, id) : null;
  if (!r) throw new LimsError('common.not_found');
  return r;
}

// ---- F1 searchPatients ----
function patternRe(p: unknown): RegExp | undefined {
  if (typeof p !== 'string') return undefined;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = ''; let last = 0;
  for (const m of p.matchAll(/\{([a-z]+)(?::(\d+))?\}/g)) {
    out += esc(p.slice(last, m.index)) + (m[1] === 'seq' ? `[0-9]{${m[2] ?? 1},}` : '[A-Za-z0-9]+');
    last = m.index! + m[0].length;
  }
  return new RegExp(`^${out}${esc(p.slice(last))}$`);
}
/** National 10-digit (+977 default) or E.164 -> E.164, else undefined. */
function toE164(q: string): string | undefined {
  if (!/^\+?[0-9\s-]+$/.test(q)) return undefined;
  const digits = q.replace(/\D/g, '');
  const e = q.startsWith('+') ? `+${digits}` : digits.length === 10 ? `+977${digits}` : digits.startsWith('977') ? `+${digits}` : '';
  return PHONE.test(e) ? e : undefined;
}

export async function searchPatients(hctx: unknown, body: unknown): Promise<Result> {
  const c = patientCtx(hctx);
  await role(c, P.patientRead);
  const b = strict(body, ['query', 'mode', 'limit']);
  const q = text(b['query'], '/query', 100, { min: 1 });
  const mode0 = b['mode'] ?? 'auto';
  if (!['auto', 'name', 'phone', 'code', 'registration_no'].includes(mode0)) throw bad('/mode');
  const limit = b['limit'] ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw bad('/limit');
  const min = Number((await getSettings(c.tx, c.tenantId))?.patient_search_min_chars ?? 3);
  const { today, numbering } = await tenantInfo(c);
  const codeRe = patternRe(numbering['patientCodePattern']); const regRe = patternRe(numbering['registrationNoPattern']);

  const mode: 'name' | 'phone' | 'code' | 'registration_no' = mode0 === 'auto'
    ? (/^\+?[0-9\s-]+$/.test(q) && (q.startsWith('+') || q.replace(/\D/g, '').length >= 10) ? 'phone' : codeRe?.test(q) ? 'code' : regRe?.test(q) ? 'registration_no' : 'name')
    : mode0;
  let rows: Obj[];
  if (mode === 'phone') {
    const e = toE164(q);
    if (!e) throw bad('/query');
    rows = await findPatientsByPhone(c.tx, c.tenantId, e, limit);
  } else {
    if ([...q].length < min) throw bad('/query');   // US-FD-01.3
    rows = mode === 'code' ? await findPatientsByCode(c.tx, c.tenantId, q, limit)
      : mode === 'registration_no' ? await findPatientsByRegistrationNo(c.tx, c.tenantId, q, limit)
        : await searchPatientsByNameRanked(c.tx, c.tenantId, normaliseName(q), limit);
  }
  // 01-PRD US-FD-01.5 / REQ-SEC-024: effective mode + count only, never the query text.
  await c.audit.access({ action: 'patient.search', entityType: 'patient', outcome: 'allowed', detail: { mode, result_count: rows.length } });
  return { status: 200, body: { data: rows.map((r) => patientSummaryDto(r, today)) } };
}

// ---- F2 createPatient ----
function consentsIn(v: unknown, path: string): Obj {
  const k = strict(v, ['processing', 'sms', 'whatsapp', 'email', 'share_with_referrer', 'consent_text_version'], path);
  for (const f of ['processing', 'sms', 'whatsapp', 'email', 'share_with_referrer']) if (typeof k[f] !== 'boolean') throw bad(`${path}/${f}`);
  if (typeof k['consent_text_version'] !== 'string' || k['consent_text_version'].length < 1 || k['consent_text_version'].length > 32) throw bad(`${path}/consent_text_version`);
  return k;
}
/** processing must be true (422 consent_required), the version must be the tenant's current one (400). */
async function checkConsents(c: PatientCtx, k: Obj): Promise<void> {
  if (k['processing'] !== true) throw new LimsError('frontdesk.consent_required');
  const cur = (await getSettings(c.tx, c.tenantId))?.consent_text_version;
  if (typeof cur !== 'string') throw new LimsError('common.internal');   // onboarding sets it (02-TRD §11)
  if (k['consent_text_version'] !== cur) throw bad('/consents/consent_text_version');
}
const optionalFields = (b: Obj) => ({
  phone_e164: b['phone_e164'] === undefined ? undefined : (typeof b['phone_e164'] === 'string' && PHONE.test(b['phone_e164']) ? b['phone_e164'] : (() => { throw bad('/phone_e164'); })()),
  email: b['email'] === undefined ? undefined : text(b['email'], '/email', 254, { min: 1 }),
  address_text: b['address_text'] === undefined ? undefined : text(b['address_text'], '/address_text', 300, { min: 1 }),
});
function demographics(b: Obj, today: string): { birth_on?: string; is_birth_on_estimated?: boolean } {
  if (b['birth_on'] !== undefined && b['age'] !== undefined) throw bad('/birth_on', '/age');
  if (b['birth_on'] !== undefined) return { birth_on: calendarDate(b['birth_on'], '/birth_on', today), is_birth_on_estimated: false };
  if (b['age'] !== undefined) return { birth_on: birthFromAge(b['age'], today), is_birth_on_estimated: true };
  return {};
}

export async function createPatient(hctx: unknown, body: unknown): Promise<Result> {
  const c = patientCtx(hctx);
  await role(c, P.registrationCreate);
  const b = strict(body, ['full_name', 'sex', 'birth_on', 'age', 'phone_e164', 'email', 'address_text', 'consents', 'duplicate_override']);
  const fullName = text(b['full_name'], '/full_name', 200, { min: 1 });
  if (!SEX.includes(b['sex'])) throw bad('/sex');
  const { today, numbering } = await tenantInfo(c);
  const demo = demographics(b, today);
  if (demo.birth_on === undefined) throw bad('/birth_on', '/age');   // birth_on xor age (server-validated)
  const opt = optionalFields(b);
  const consents = consentsIn(b['consents'], '/consents');
  let overrideCode: string | undefined;
  if (b['duplicate_override'] !== undefined) {
    const o = strict(b['duplicate_override'], ['reason_code'], '/duplicate_override');
    if (typeof o['reason_code'] !== 'string' || !CODE.test(o['reason_code'])) throw bad('/duplicate_override/reason_code');
    overrideCode = o['reason_code'];   // ponytail: format only; membership of frontdesk.duplicate_override_reasons is not checked (no coded-set reader in C4 yet)
  }
  await checkConsents(c, consents);

  // US-FD-02.2: same normalised name + birth year +-1 + same phone (when both present). Candidates come back masked.
  const nameSearch = normaliseName(fullName);
  if (overrideCode === undefined) {
    const cand = { fullName, birthOn: demo.birth_on, ...(opt.phone_e164 ? { phoneE164: opt.phone_e164 } : {}) };
    const dupes = (await findDedupePool(c.tx, c.tenantId, nameSearch)).filter((r) =>
      isDuplicateSuspect(cand, { fullName: String(r['full_name']), birthOn: dateOnly(r['birth_on'])!, phoneE164: r['phone_e164'], anonymised: r['anonymised_at'] != null }));
    if (dupes.length) {
      // `candidates` rides on the error object; the problem+json body cannot carry it until the core renders extensions (CR FD-T04-problem-candidates).
      throw Object.assign(new LimsError('frontdesk.patient_duplicate_suspected'), { candidates: dupes.slice(0, 5).map((r) => patientSummaryDto(r, today)) });
    }
  }

  const centreId = c.centreId ?? (await c.ports.IdentityPort.getActor(c)).centreScope?.centreIds[0];
  if (!centreId) throw new LimsError('common.validation_failed');
  const pattern = numbering['patientCodePattern'];
  if (typeof pattern !== 'string') throw new LimsError('common.internal');
  const seq = await nextCounterValue(c.tx, c.tenantId, 'patient_code', '', c.actor.id);
  const row = await insertPatient(c.tx, c.tenantId, {
    id: uuidv7(), patient_code: formatNumber(pattern, { seq }), full_name: fullName, name_search: nameSearch, sex: b['sex'], ...demo, ...opt,
    source: 'front_desk', registered_centre_id: centreId, duplicate_override_reason_code: overrideCode,
  });
  const consent = await insertConsent(c.tx, c.tenantId, { id: uuidv7(), patient_id: row.id, ...consents, source: 'front_desk', captured_at: c.now() });
  return { status: 201, body: patientDto(row, consent, today, true) };
}

// ---- F3 getPatient ----
export async function getPatient(hctx: unknown, params: unknown): Promise<Result> {
  const c = patientCtx(hctx);
  await role(c, P.patientRead);
  const row = await loadPatient(c, isObj(params) ? params['patient_id'] : undefined);
  const { today } = await tenantInfo(c);
  await c.audit.access({ action: 'patient.view', entityType: 'patient', entityId: row['id'], outcome: 'allowed' });
  return { status: 200, body: patientDto(row, await consentOf(c, row['id']), today, await canSeePii(c)) };
}

// ---- F4 updatePatient ----
/** If-Match: "<version>" (02-CV §4.2). Absent -> 428; malformed -> 400. */
export function expectedVersion(headers: unknown): number {
  const h = isObj(headers) ? headers['if-match'] : undefined;
  if (h === undefined) throw new LimsError('common.precondition_required');
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  if (!m || Number(m[1]) > 2147483647) throw bad('/headers/if-match');
  return Number(m[1]);
}
const UNSETTABLE = ['birth_on', 'phone_e164', 'email', 'address_text'];

export async function updatePatient(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c = patientCtx(hctx);
  await role(c, P.registrationCreate);
  const version = expectedVersion(headers);
  const b = strict(body, ['full_name', 'sex', 'birth_on', 'age', 'phone_e164', 'email', 'address_text', 'unset']);
  const { today } = await tenantInfo(c);
  const set: Obj = {};
  const changed = new Set<string>();
  if (b['full_name'] !== undefined) { const n = text(b['full_name'], '/full_name', 200, { min: 1 }); set['full_name'] = n; set['name_search'] = normaliseName(n); changed.add('full_name'); }
  if (b['sex'] !== undefined) { if (!SEX.includes(b['sex'])) throw bad('/sex'); set['sex'] = b['sex']; changed.add('sex'); }
  const demo = demographics(b, today);
  if (demo.birth_on !== undefined) { Object.assign(set, demo); changed.add('birth_on'); }
  for (const [k, v] of Object.entries(optionalFields(b))) if (v !== undefined) { set[k] = v; changed.add(k); }
  if (b['unset'] !== undefined) {
    if (!Array.isArray(b['unset']) || b['unset'].length > 4) throw bad('/unset');
    for (const f of b['unset']) {
      if (!UNSETTABLE.includes(f) || changed.has(f)) throw bad('/unset');
      set[f] = null; changed.add(f);
      if (f === 'birth_on') set['is_birth_on_estimated'] = false;
    }
  }
  if (changed.size === 0) throw bad('');   // nothing to change

  const cur = await loadPatient(c, isObj(params) ? params['patient_id'] : undefined);
  if (cur['anonymised_at'] != null) throw new LimsError('common.not_found');
  if (Number(cur['version']) !== version) throw new LimsError('common.version_conflict');
  const row = await updatePatientRow(c.tx, c.tenantId, cur['id'], version, set);
  if (!row) throw new LimsError('common.version_conflict');   // lost a race on the row lock: the version moved under us
  // A13 D-27a compensating control: column names only, never values.
  await c.audit.access({ action: 'patient.update', entityType: 'patient', entityId: row['id'], outcome: 'allowed', detail: { changed_fields: [...changed].join(',') } });
  return { status: 200, body: patientDto(row, await consentOf(c, row['id']), today, true) };
}

// ---- F5 recordPatientConsent (append-only) ----
export async function recordPatientConsent(hctx: unknown, params: unknown, body: unknown): Promise<Result> {
  const c = patientCtx(hctx);
  await role(c, P.registrationCreate);
  const k = consentsIn(body, '');
  const p = await loadPatient(c, isObj(params) ? params['patient_id'] : undefined);
  if (p['anonymised_at'] != null) throw new LimsError('common.not_found');
  await checkConsents(c, k);
  const row = await insertConsent(c.tx, c.tenantId, { id: uuidv7(), patient_id: p['id'], ...k, source: 'front_desk', captured_at: c.now() });
  await c.audit.access({ action: 'consent.change', entityType: 'patient', entityId: p['id'], outcome: 'allowed' });
  const who = await c.ports.IdentityPort.getActor(c);
  return { status: 201, body: consentRecordDto(row, { membershipId: c.actor.membershipId ?? c.actor.id, displayName: who.displayName }) };
}

// ---- F6 listPatientOrders ----
export async function listPatientOrders(hctx: unknown, params: unknown, query: unknown): Promise<Result> {
  const c = patientCtx(hctx);
  await role(c, P.orderRead);
  const q = strict(query ?? {}, ['sort', 'cursor', 'limit']);
  const sort = q['sort'] ?? '-registered_at';
  if (sort !== '-registered_at' && sort !== 'registered_at') throw bad('/sort');
  const raw = q['limit'];
  const limit = raw === undefined ? 50 : typeof raw === 'string' && /^[0-9]{1,3}$/.test(raw) ? Number(raw) : raw;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw bad('/limit');
  const after = q['cursor'] === undefined ? undefined : decodeCursor(q['cursor'], sort);
  const p = await loadPatient(c, isObj(params) ? params['patient_id'] : undefined);
  const s = (await c.ports.IdentityPort.getActor(c)).centreScope;                   // 07-SECURITY §6.2: other-centre orders never listed (fail closed: no scope = no centre)
  const scopeCentreIds = s?.all === true ? undefined : (s?.centreIds ?? []);
  const rows = await pageOrdersByPatient(c.tx, c.tenantId, p['id'], { asc: sort === 'registered_at', limit, ...(after ? { after } : {}), ...(scopeCentreIds ? { scopeCentreIds } : {}) });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const display = String(p['full_name'] ?? '');
  return { status: 200, body: { data: page.map((o) => orderSummaryDto(o, display)), page: { limit, ...(rows.length > limit && last ? { next_cursor: encodeCursor(sort, last['sort_key'], last['id']) } : {}) } } };
}

// ---- F7 anonymisePatient (FD-T15; 03-APP-FLOW §2.18, 08 A13 D-27 a/b, P-12 c, CR-C4-007, REQ-SEC-139) ----
const BUCKET = 'frontdesk-trf' as const;
const portClock = <T extends { now(): Date }>(c: T): T => Object.assign(Object.create(c), { now: () => c.now().toISOString() });
interface LabLike { getOrderItemProcessingState?: (c: unknown, i: { orderId: string }) => Promise<readonly { orderItemId: string; processingStatus: ItemProcessingStatus }[]> }

/** An order blocks while it is pre_registered, or registered/in_progress and not (derived) completed. LabPort is only needed for the latter and fails CLOSED. */
async function assertNoOpenOrder(c: PatientCtx, patientId: string): Promise<void> {
  const open = await openOrdersOfPatient(c.tx, c.tenantId, patientId);
  if (open.some((o) => o['status'] === 'pre_registered')) throw new LimsError('frontdesk.order_not_editable');
  if (open.length === 0) return;
  const lab = (c.ports as { LabPort?: LabLike }).LabPort;
  if (typeof lab?.getOrderItemProcessingState !== 'function') throw new LimsError('common.service_unavailable');
  const active = await activeItemIdsByOrders(c.tx, c.tenantId, open.map((o) => o['id']));
  for (const o of open) {
    const by = new Map((await lab.getOrderItemProcessingState(portClock(c), { orderId: o['id'] })).map((s) => [s.orderItemId, s.processingStatus]));   // {orderId} only, no PHI
    const derived = deriveOrderStatus(o['status'] as OrderStatus, [...(active.get(o['id']) ?? [])].map((id) => by.get(id) ?? 'not_started'));
    if (derived !== 'completed') throw new LimsError('frontdesk.order_not_editable');
  }
}

export async function anonymisePatient(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c = patientCtx(hctx);
  const storage = (c as unknown as { storage?: { delete?: (bucket: string, path: string) => Promise<void> } }).storage;
  await role(c, P.patientAnonymise);   // privileged: IdentityPort enforces aal2 (auth.mfa_required)
  // REQ-SEC-139 / P-12 c (FD-T15 review): orders + trf_attachments RLS is tenant+centre, so a centre-scoped admin would miss other-centre
  // open orders and TRF objects. Fail closed before any write until C0 gives an all-centre path (.orchestra/cr/FD-T15.md).
  if ((await c.ports.IdentityPort.getActor(c)).centreScope?.all !== true) throw new LimsError('auth.forbidden');
  const version = expectedVersion(headers);
  const b = strict(body, ['reason_code', 'reason_text']);
  if (typeof b['reason_code'] !== 'string' || !CODE.test(b['reason_code'])) throw bad('/reason_code');   // ponytail: format only, membership of anonymise_reasons is not checked (as duplicate_override)
  if (b['reason_text'] !== undefined) text(b['reason_text'], '/reason_text', 500);   // validated, never stored or logged (patients has no column for it)
  if (typeof storage?.delete !== 'function') throw new LimsError('common.service_unavailable');

  const cur = await loadPatient(c, isObj(params) ? params['patient_id'] : undefined);
  if (cur['anonymised_at'] != null) throw new LimsError('common.not_found');   // as F4: an anonymised patient is gone for edits
  if (Number(cur['version']) !== version) throw new LimsError('common.version_conflict');
  await assertNoOpenOrder(c, cur['id']);
  // retention (CR-C4-007): last order + retentionYears must be strictly before now; default 5 (PRD B15). ponytail: UTC calendar-year arithmetic, tenant-zone edge ignored.
  const ry = Number(((await c.ports.IdentityPort.getTenantSettings(c, { keys: ['retentionYears'] })) ?? {}).retentionYears);
  const until = new Date((await lastOrderAt(c.tx, c.tenantId, cur['id'])) ?? cur['created_at']);   // no order at all: the patient row's age
  until.setUTCFullYear(until.getUTCFullYear() + (Number.isInteger(ry) && ry > 0 ? ry : 5));
  if (!(until < c.now())) throw new LimsError('frontdesk.retention_not_elapsed');

  // the UPDATE goes first: it serialises concurrent calls, so the loser (version moved) leaves no consent row, no TRF change, no storage delete.
  const row = await anonymisePatientRow(c.tx, c.tenantId, cur['id'], version, { at: c.now(), by: c.actor.id, reasonCode: b['reason_code'] });
  if (!row) throw new LimsError('common.version_conflict');
  const prev = await consentOf(c, row['id']);
  const consent = await insertConsent(c.tx, c.tenantId, { id: uuidv7(), patient_id: row['id'], processing: false, sms: false, whatsapp: false, email: false, share_with_referrer: false,
    consent_text_version: prev?.consent_text_version ?? (await getSettings(c.tx, c.tenantId))?.consent_text_version ?? 'none', source: 'anonymisation', captured_at: c.now() });
  const trfs = await deactivateTrfByPatient(c.tx, c.tenantId, row['id']);   // metadata rows stay, inactive
  // A13 D-27a compensating control: column names only, never values.
  await c.audit.access({ action: 'patient.anonymise', entityType: 'patient', entityId: row['id'], outcome: 'allowed',
    detail: { changed_fields: 'full_name,name_search,birth_on,phone_e164,email,address_text', reason_code: b['reason_code'] } });
  // objects last: a failure here rolls the tx back, a retry deletes the rest (ponytail: objects already deleted stay deleted; storage.delete must be idempotent).
  for (const t of trfs) await storage.delete(t.bucket ?? BUCKET, t.object_path);
  const { today } = await tenantInfo(c);
  return { status: 200, body: patientDto(row, consent, today, true) };
}

// ---- F26 listPossibleDuplicatePatients (FD-T15; 02-TRD §5 F26, US-FD-02.2 over one day of registrations) ----
export async function listPossibleDuplicates(hctx: unknown, query: unknown): Promise<Result> {
  const c = patientCtx(hctx);
  await role(c, P.registrationCreate);
  const q = strict(query ?? {}, ['created_on', 'cursor', 'limit']);
  const raw = q['limit'];
  const limit = raw === undefined ? 50 : typeof raw === 'string' && /^[0-9]{1,3}$/.test(raw) ? Number(raw) : raw;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw bad('/limit');
  const { today, tz } = await tenantInfo(c);
  const date = q['created_on'] === undefined ? today : calendarDate(q['created_on'], '/created_on', '9999-12-31');   // a future day is legal, just empty
  const after = q['cursor'] === undefined ? undefined : decodeCursor(q['cursor'], 'created_at');
  const rows = await pageDuplicatePatients(c.tx, c.tenantId, date, tz, { limit, ...(after ? { after } : {}) });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const by = new Map<string, Obj[]>();
  for (const r of await duplicateCandidates(c.tx, c.tenantId, page.map((p) => p['id']))) (by.get(r['for_id']) ?? by.set(r['for_id'], []).get(r['for_id'])!).push(r);
  await c.audit.access({ action: 'patient.search', entityType: 'patient', outcome: 'allowed', detail: { mode: 'possible_duplicates', result_count: page.length } });
  return { status: 200, body: {
    data: page.map((p) => ({ patient: patientSummaryDto(p, today), candidates: (by.get(p['id']) ?? []).map((r) => patientSummaryDto(r, today)) })),
    page: { limit, ...(rows.length > limit && last ? { next_cursor: encodeCursor('created_at', last['sort_key'], last['id']) } : {}) },
  } };
}
