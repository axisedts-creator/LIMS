// C13 T11 — partner referrers F1–F5 (partner) and mapping SR1–SR3 (staff). 02-TRD §5.2/§5.3/§4.7/§6, 03-APP-FLOW §2.6 + LS7, 05-SCHEMA §3.3, 07-SECURITY AB2/ST1/ST2/ST4/ST8/ST13.
// Order: actor type -> IdentityPort.assertRole (F1 referrer.read, F2–F5 referrer.manage, SR1–SR3 referrer.map) -> partnerContext.require (partner callers; the partner_id
//   comes from there, never from the body) -> If-Match / body validation -> row locked FOR UPDATE -> version + transition guards -> CatalogPort (SR2) -> UPDATE.
// Duplicate rule (F2/F3/F5): left to the unique index (tenant, partner, display_name_norm, coalesce(registration_no,'')) — 23505 -> 409 partners.referrer_duplicate; the
//   request transaction rolls back on any error, so no savepoint is needed. samples_this_month (US-13.6): month bounds in the tenant timezone computed here, one GROUP BY
//   statement; never date_trunc. SR2 re-enqueue = LS7 for lines failed with partners.referrer_not_mapped, in the same transaction as the mapping (a failing enqueue rolls it back).
// SQL is parameterised and single-table; doctor names / registration numbers are never logged, echoed in an error or put in a job payload (ST13).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import type { HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { assertTransition, type ReferrerMappingState } from '../domain/referrer-mapping.state.js';
import { bad, closed, decodeCursor, encodeCursor, ifMatch, isObj, uuidParam } from './partner-user.service.js';
import { partnerContext } from './partner-context.service.js';

type Q = { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };
type Obj = Record<string, unknown>;
type Who = 'partner' | 'staff';
interface Row {
  id: string; partner_id: string; display_name: string; display_name_norm: string; qualification: string | null; registration_council: string | null;
  registration_no: string | null; is_active: boolean; mapping_state: ReferrerMappingState; catalog_doctor_id: string | null; version: number | string;
}

const PERM = { read: 'partners.referrer.read', manage: 'partners.referrer.manage', map: 'partners.referrer.map' } as const;
const CONVERT_TASK = 'partners.convert_manifest_line';
const NOT_MAPPED = 'partners.referrer_not_mapped';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON =/^[a-z][a-z0-9_]{0,63}$/; // [CONV] shape pre-check; membership in referrer_mapping_reject_reasons is checked against partners.g_cs_reasons in rejectMapping
const OPTIONAL = { qualification: 120, registration_council: 20, registration_no: 30 } as const;
type OptionalField = keyof typeof OPTIONAL;

const COLS = 'id, partner_id, display_name, display_name_norm, qualification, registration_council, registration_no, is_active, mapping_state, catalog_doctor_id, version';
const SELECT = `SELECT ${COLS} FROM partners.partner_referrers WHERE tenant_id = $1`;
const LOCK_SQL = `${SELECT} AND id = $2 FOR UPDATE`;
const LOCK_PARTNER_SQL = `${SELECT} AND id = $2 AND partner_id = $3 FOR UPDATE`;
const INSERT_SQL = 'INSERT INTO partners.partner_referrers (id, tenant_id, partner_id, display_name, display_name_norm, qualification, registration_council, registration_no, '
  + `created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING ${COLS}`;
const EDIT_HEAD = 'UPDATE partners.partner_referrers SET display_name = $3, display_name_norm = $4, qualification = $5, registration_council = $6, registration_no = $7, is_active = $8, ';
const EDIT_TAIL = `updated_at = now(), updated_by = $9, version = version + 1 WHERE tenant_id = $1 AND id = $2 AND version = $10 RETURNING ${COLS}`;
const EDIT_SQL = EDIT_HEAD + EDIT_TAIL;
const EDIT_RESET_SQL = `${EDIT_HEAD}mapping_state = 'unmapped', mapping_reject_reason_code = NULL, mapping_reject_text = NULL, ${EDIT_TAIL}`; // rejected -> unmapped (partner correction)
const MAP_SQL = 'UPDATE partners.partner_referrers SET mapping_state = $3, catalog_doctor_id = $4, mapped_at = $5, mapped_by = $6, mapping_reject_reason_code = $7, '
  + `mapping_reject_text = NULL, updated_at = now(), updated_by = $8, version = version + 1 WHERE tenant_id = $1 AND id = $2 AND version = $9 RETURNING ${COLS}`;
const SAMPLES_SQL = 'SELECT referrer_id, count(*)::int AS samples FROM partners.manifest_lines WHERE tenant_id = $1 AND referrer_id = ANY($2::uuid[]) '
  + "AND state = 'converted' AND converted_at >= $3 AND converted_at < $4 GROUP BY referrer_id";
const PARTNERS_SQL = 'SELECT id, name FROM partners.partners WHERE tenant_id = $1 AND id = ANY($2::uuid[])';
const REQUEUE_SQL = "UPDATE partners.manifest_lines SET state = 'converting', conversion_attempt = conversion_attempt + 1, failure_code = NULL, failed_at = NULL, "
  + "updated_at = now(), updated_by = $5, version = version + 1 WHERE tenant_id = $1 AND partner_id = $2 AND referrer_id = $3 AND state = 'conversion_failed' "
  + 'AND failure_code = $4 RETURNING id, conversion_attempt';
const ENQUEUE_SQL = 'SELECT app.enqueue_job($1, $2::jsonb, $3)';

const forbidden = () => new LimsError('auth.forbidden');
const notFound = () => new LimsError('common.not_found');

/** Actor type + permission + (partner callers) partnerContext. Returns the caller's partner id (partner callers only). */
async function gate(ctx: HandlerContext, who: Who, permission: string): Promise<string | undefined> {
  if (ctx.actor?.type !== (who === 'partner' ? 'partner' : 'user') || !ctx.tenantId || !ctx.tx || !ctx.actor.id) throw forbidden(); // before any SQL
  await ctx.ports.IdentityPort.assertRole(ctx, { permission } as never);
  if (who === 'staff') return undefined;
  const ref = await partnerContext.require(ctx);
  if (permission === PERM.manage && ref.role !== 'partner_admin') throw forbidden(); // defence in depth: a member never writes
  return ref.partnerId;
}

// ---------------------------------------------------------------- value rules
const squash = (s: string) => s.normalize('NFC').trim().replace(/\s+/g, ' ');
const len = (s: string) => [...s].length;
function text(v: unknown, path: string, max: number): string {
  const s = typeof v === 'string' ? squash(v) : '';
  if (len(s) < 1 || len(s) > max) throw bad(path);
  return s;
}
const norm = (name: string) => name.toLowerCase();
function name(v: unknown): { display: string; norm: string } {
  const display = text(v, '/display_name', 120), n = norm(display);
  if (len(n) > 120) throw bad('/display_name');
  return { display, norm: n };
}

/** ISO instant of local 00:00 on day 1 of month `m0` (0-based, may overflow into the next year) in `tz`. A bad zone throws (never falls back to UTC). */
export function localParts(ms: number, tz: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const o: Record<string, number> = {};
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  for (const p of f.formatToParts(ms)) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o as never;
}
export const offsetMs =(ms: number, tz: string) => { const p = localParts(ms, tz); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000; };
function monthStartUtc(year: number, m0: number, tz: string): number {
  const guess = Date.UTC(year, m0, 1);
  return guess - offsetMs(guess - offsetMs(guess, tz), tz); // two passes settle a DST edge
}
async function monthBounds(ctx: HandlerContext): Promise<[string, string]> {
  const s = await ctx.ports.IdentityPort.getTenantSettings(ctx, { keys: ['timezone'] } as never) as unknown as Obj;
  const tz = s['timezone'], now = new Date(ctx.now() as unknown as string).getTime();
  if (typeof tz !== 'string' || Number.isNaN(now)) throw new LimsError('common.internal');
  let a: number, b: number;
  try {
    const p = localParts(now, tz);
    a = monthStartUtc(p.year, p.month - 1, tz); b = monthStartUtc(p.year, p.month, tz);
  } catch { throw new LimsError('common.internal'); }
  return [new Date(a).toISOString(), new Date(b).toISOString()];
}
/** referrer id -> converted lines of the current tenant-local month. */
async function samples(ctx: HandlerContext, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const [from, to] = await monthBounds(ctx);
  const { rows } = await (ctx.tx as Q).query(SAMPLES_SQL, [ctx.tenantId, ids, from, to]);
  for (const r of rows) out.set(String(r.referrer_id), Number(r.samples));
  return out;
}

// ---------------------------------------------------------------- DTOs (explicit allowlists; null columns omitted)
function toDto(r: Row, samplesThisMonth: number): Obj {
  return {
    id: r.id, display_name: r.display_name,
    ...(r.qualification != null ? { qualification: r.qualification } : {}),
    ...(r.registration_council != null ? { registration_council: r.registration_council } : {}),
    ...(r.registration_no != null ? { registration_no: r.registration_no } : {}),
    is_active: r.is_active, mapping_state: r.mapping_state, samples_this_month: samplesThisMonth, version: Number(r.version),
  };
}
async function toMappingDtos(ctx: HandlerContext, rows: Row[], known: Map<string, { id: string; display_name: string }> = new Map()): Promise<Obj[]> {
  const tx = ctx.tx as Q;
  const counts = await samples(ctx, rows.map((r) => r.id));
  const pids = [...new Set(rows.map((r) => r.partner_id))];
  const names = new Map<string, string>();
  if (pids.length) for (const p of (await tx.query(PARTNERS_SQL, [ctx.tenantId, pids])).rows) names.set(String(p.id), String(p.name));
  const docs = new Map(known);
  for (const r of rows) {
    if (r.mapping_state !== 'mapped' || !r.catalog_doctor_id || docs.has(r.catalog_doctor_id)) continue;
    try {
      const d = await ctx.ports.CatalogPort.getReferrer(ctx, { referrerId: r.catalog_doctor_id, purpose: 'display' } as never);
      docs.set(r.catalog_doctor_id, { id: r.catalog_doctor_id, display_name: d.displayName });
    } catch (e) { if (!(e instanceof LimsError && e.code === 'common.not_found')) throw e; } // doctor gone from C3: shown without it
  }
  return rows.map((r) => ({
    ...toDto(r, counts.get(r.id) ?? 0), partner: { id: r.partner_id, name: names.get(r.partner_id) ?? '' },
    ...(r.mapping_state === 'mapped' && docs.has(r.catalog_doctor_id!) ? { catalog_doctor: docs.get(r.catalog_doctor_id!) } : {}),
  }));
}

// ---------------------------------------------------------------- lists
export function listParams(q: unknown, allowed: readonly string[]): { query: Obj; limit: number; offset: number } {
  const query = isObj(q) ? q : {};
  for (const k of Object.keys(query)) if (!allowed.includes(k)) throw bad(`/${k}`);
  let limit = 50;
  if (query['limit'] !== undefined) {
    const raw = query['limit'], n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^[0-9]{1,3}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 200) throw bad('/limit');
    limit = n;
  }
  const offset = query['cursor'] === undefined ? 0 : decodeCursor(query['cursor']); // ponytail: offset cursor, keyset if a partner ever has thousands of referrers
  return { query, limit, offset };
}
export const page = (limit: number, offset: number, n: number) => ({ limit, ...(n > limit ? { next_cursor: encodeCursor(offset + limit) } : {}) });

/** F1 */
export async function listReferrers(req: HandlerRequest, ctx: HandlerContext): Promise<HandlerResult> {
  const partnerId = (await gate(ctx, 'partner', PERM.read))!;
  const { query, limit, offset } = listParams(req.query, ['is_active', 'q', 'cursor', 'limit']);
  let sql = `${SELECT} AND partner_id = $2`;
  const values: unknown[] = [ctx.tenantId, partnerId];
  const a = query['is_active'];
  if (a !== undefined) {
    if (a !== true && a !== false && a !== 'true' && a !== 'false') throw bad('/is_active');
    values.push(a === true || a === 'true'); sql += ` AND is_active = $${values.length}`;
  }
  const qv = query['q'];
  if (qv !== undefined) {
    if (typeof qv !== 'string' || len(qv) > 64) throw bad('/q');
    values.push(`${norm(squash(qv)).replace(/[\\%_]/g, '\\$&')}%`); sql += ` AND display_name_norm LIKE $${values.length} ESCAPE '\\'`; // literal prefix
  }
  values.push(limit + 1, offset);
  const text = `${sql} ORDER BY display_name_norm, id LIMIT $${values.length - 1} OFFSET $${values.length}`; // placeholders only; values are bound
  const { rows } = await (ctx.tx as Q).query(text, values);
  const shown = rows.slice(0, limit) as Row[], counts = await samples(ctx, shown.map((r) => r.id));
  return { status: 200, body: { data: shown.map((r) => toDto(r, counts.get(r.id) ?? 0)), page: page(limit, offset, rows.length) } };
}

/** SR1 */
export async function listMappings(req: HandlerRequest, ctx: HandlerContext): Promise<HandlerResult> {
  await gate(ctx, 'staff', PERM.map);
  const { query, limit, offset } = listParams(req.query, ['mapping_state', 'partner_id', 'cursor', 'limit']);
  const st = query['mapping_state'] ?? 'unmapped';
  if (st !== 'unmapped' && st !== 'mapped' && st !== 'rejected') throw bad('/mapping_state');
  const values: unknown[] = [ctx.tenantId, st];
  let sql = `${SELECT} AND mapping_state = $2`;
  if (query['partner_id'] !== undefined) { values.push(uuidParam(query, 'partner_id')); sql += ` AND partner_id = $${values.length}`; }
  values.push(limit + 1, offset);
  const text = `${sql} ORDER BY created_at, id LIMIT $${values.length - 1} OFFSET $${values.length}`; // placeholders only; values are bound
  const { rows } = await (ctx.tx as Q).query(text, values);
  return { status: 200, body: { data: await toMappingDtos(ctx, rows.slice(0, limit) as Row[]), page: page(limit, offset, rows.length) } };
}

// ---------------------------------------------------------------- writes
const duplicate = (e: unknown): unknown => ((e as { code?: string })?.code === '23505' ? new LimsError('partners.referrer_duplicate') : e);
const body = (v: unknown): Obj => { if (!isObj(v)) throw bad('/body'); return v; };

/** F2 */
export async function createReferrer(req: HandlerRequest, ctx: HandlerContext): Promise<HandlerResult> {
  const partnerId = (await gate(ctx, 'partner', PERM.manage))!;
  const b = body(req.body);
  for (const k of Object.keys(b)) if (k !== 'display_name' && !(k in OPTIONAL)) throw bad(`/${k}`); // AB2: partner_id, tenant_id, mapping_state, … are unknown keys
  const n = name(b['display_name']);
  const opt = (f: OptionalField) => (b[f] === undefined ? null : text(b[f], `/${f}`, OPTIONAL[f]));
  const v = [uuidv7(), ctx.tenantId, partnerId, n.display, n.norm, opt('qualification'), opt('registration_council'), opt('registration_no'), ctx.actor!.id];
  try {
    const { rows } = await (ctx.tx as Q).query(INSERT_SQL, v);
    return { status: 201, body: toDto(rows[0] as Row, 0) };
  } catch (e) { throw duplicate(e); }
}

async function lock(ctx: HandlerContext, partnerId: string | undefined, id: string): Promise<Row> {
  const tx = ctx.tx as Q;
  const { rows } = partnerId === undefined ? await tx.query(LOCK_SQL, [ctx.tenantId, id]) : await tx.query(LOCK_PARTNER_SQL, [ctx.tenantId, id, partnerId]);
  if (!rows[0]) throw notFound(); // unknown / other partner / other tenant: same answer (ST2)
  return rows[0] as Row;
}

const one = async (ctx: HandlerContext, r: Row) => toDto(r, (await samples(ctx, [r.id])).get(r.id) ?? 0);

/** F3 / F4 / F5 */
export async function changeReferrer(req: HandlerRequest, ctx: HandlerContext, kind: 'update' | 'deactivate' | 'reactivate'): Promise<HandlerResult> {
  const partnerId = (await gate(ctx, 'partner', PERM.manage))!;
  const expected = ifMatch(req.headers), id = uuidParam(req.params, 'referrer_id');
  const set: Partial<Pick<Row, 'display_name' | 'display_name_norm' | 'qualification' | 'registration_council' | 'registration_no' | 'is_active'>> = {};
  if (kind === 'deactivate') set.is_active = false;
  if (kind === 'reactivate') set.is_active = true;
  if (kind === 'update') {
    const b = body(req.body);
    for (const k of Object.keys(b)) if (k !== 'display_name' && k !== 'unset' && !(k in OPTIONAL)) throw bad(`/${k}`); // AB2
    if (Object.keys(b).length === 0) throw bad('/body');
    const unset = b['unset'];
    if (unset !== undefined) {
      if (!Array.isArray(unset) || unset.length > 3) throw bad('/unset');
      for (const f of unset) { if (typeof f !== 'string' || !(f in OPTIONAL) || b[f] !== undefined) throw bad('/unset'); set[f as OptionalField] = null; }
    }
    if (b['display_name'] !== undefined) { const n = name(b['display_name']); set.display_name = n.display; set.display_name_norm = n.norm; }
    for (const f of Object.keys(OPTIONAL) as OptionalField[]) if (b[f] !== undefined) set[f] = text(b[f], `/${f}`, OPTIONAL[f]);
  }
  const row = await lock(ctx, partnerId, id);
  if (Number(row.version) !== expected) throw new LimsError('common.version_conflict');
  const m = { ...row, ...set };
  const reopen = row.mapping_state === 'rejected' && (m.display_name_norm !== row.display_name_norm || m.registration_no !== row.registration_no); // 03-APP-FLOW 2.6
  try {
    const { rows } = await (ctx.tx as Q).query(reopen ? EDIT_RESET_SQL : EDIT_SQL, [ctx.tenantId, row.id, m.display_name, m.display_name_norm, m.qualification, m.registration_council,
      m.registration_no, m.is_active, ctx.actor!.id, Number(row.version)]);
    if (!rows[0]) throw new LimsError('common.version_conflict'); // cannot happen under the row lock
    return { status: 200, body: await one(ctx, rows[0] as Row) };
  } catch (e) { throw duplicate(e); }
}

// ---------------------------------------------------------------- SR2 / SR3
async function mappingStep(req: HandlerRequest, ctx: HandlerContext, to: ReferrerMappingState): Promise<{ row: Row; b: Obj }> {
  await gate(ctx, 'staff', PERM.map);
  const expected = ifMatch(req.headers), id = uuidParam(req.params, 'referrer_id');
  const b = to === 'unmapped' ? {} : closed(req.body, [to === 'mapped' ? 'catalog_doctor_id' : 'reason_code']);
  const row = await lock(ctx, undefined, id);
  if (Number(row.version) !== expected) throw new LimsError('common.version_conflict');
  assertTransition(row.mapping_state, to); // 409 partners.referrer_invalid_transition
  if (to === 'unmapped' && row.mapping_state !== 'mapped') throw new LimsError('partners.referrer_invalid_transition'); // rejected -> unmapped is F3 only (03-APP-FLOW 2.6)
  return { row, b };
}
async function setMapping(ctx: HandlerContext, row: Row, to: ReferrerMappingState, doctor: string | null, reason: string | null): Promise<Row> {
  const actor = ctx.actor!.id;
  const { rows } = await (ctx.tx as Q).query(MAP_SQL, [ctx.tenantId, row.id, to, doctor, doctor ? ctx.now() : null, doctor ? actor : null, reason, actor, Number(row.version)]);
  if (!rows[0]) throw new LimsError('common.version_conflict'); // cannot happen under the row lock
  return rows[0] as Row;
}

/** SR2 — validates the doctor through CatalogPort.getReferrer, maps, then re-enqueues the lines failed with partners.referrer_not_mapped (LS7). */
export async function mapReferrer(req: HandlerRequest, ctx: HandlerContext): Promise<HandlerResult> {
  const { row, b } = await mappingStep(req, ctx, 'mapped');
  const docId = b['catalog_doctor_id'];
  if (typeof docId !== 'string' || !UUID.test(docId)) throw bad('/catalog_doctor_id');
  const doc = await ctx.ports.CatalogPort.getReferrer(ctx, { referrerId: docId, purpose: 'display' } as never); // not_found / infra errors pass through unchanged
  if (!doc.isActive) throw new LimsError('partners.referrer_doctor_inactive');
  const saved = await setMapping(ctx, row, 'mapped', doc.canonicalReferrerId, null);
  const tx = ctx.tx as Q;
  const { rows: lines } = await tx.query(REQUEUE_SQL, [ctx.tenantId, row.partner_id, row.id, NOT_MAPPED, ctx.actor!.id]);
  for (const l of lines) { // same transaction: a failing enqueue is not swallowed, the mapping rolls back with it
    await tx.query(ENQUEUE_SQL, [CONVERT_TASK, JSON.stringify({ tenant_id: ctx.tenantId, line_id: l.id, attempt: Number(l.conversion_attempt) }), `convert:${l.id}:${l.conversion_attempt}`]);
  }
  const known = new Map([[doc.canonicalReferrerId, { id: doc.canonicalReferrerId, display_name: doc.displayName }]]);
  return { status: 200, body: (await toMappingDtos(ctx, [saved], known))[0]! };
}

/** SR3 reject */
export async function rejectMapping(req: HandlerRequest, ctx: HandlerContext): Promise<HandlerResult> {
  const { row, b } = await mappingStep(req, ctx, 'rejected');
  const reason = b['reason_code'];
  if (typeof reason !== 'string' || !REASON.test(reason)) throw bad('/reason_code');
  // x-coded-set is annotation-only in core and the DDL has no CHECK/FK on mapping_reject_reason_code (05-SCHEMA §7): validate here as partner.service suspend
  const coded = (await (ctx.tx as Q).query('SELECT code, is_active FROM partners.g_cs_reasons WHERE set_name = $1 AND code = $2',
    ['referrer_mapping_reject_reasons', reason])).rows.find((r) => r['code'] === reason);
  if (!coded || coded['is_active'] !== true) throw bad('/reason_code');
  return { status: 200, body: (await toMappingDtos(ctx, [await setMapping(ctx, row, 'rejected', null, reason)]))[0]! };
}

/** SR3 unmap — lines and jobs are not touched; later conversions simply omit referrerId. */
export async function unmapReferrer(req: HandlerRequest, ctx: HandlerContext): Promise<HandlerResult> {
  const { row } = await mappingStep(req, ctx, 'unmapped');
  return { status: 200, body: (await toMappingDtos(ctx, [await setMapping(ctx, row, 'unmapped', null, null)]))[0]! };
}
