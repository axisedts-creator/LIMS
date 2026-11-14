// C13 T15 — pickups: K1–K4 (partner) and SP1–SP4 (staff). 02-TRD §5.2/§5.3/§10.2, 03-APP-FLOW §2.3 + §4.5, 05-SCHEMA §3.6, 07-SECURITY AB2/AB3/AB11/ST7.
// Order: actor type -> IdentityPort.assertRole (K1/K4 partners.pickup.request, K2/K3 partners.order.read, SP1–SP4 partners.pickup.manage) -> partnerContext.require (partner
//   callers; partner_id comes from there, never from the body) -> body / query / If-Match validation (no SQL) -> row locks -> version + transition guards -> UPDATE.
// K1: manifests locked FOR UPDATE in id order (no deadlock between overlapping requests), THEN the open-link check; the partial unique index (one open pickup per manifest)
//   is the backstop: 23505 -> 422 partners.pickup_invalid. The request transaction rolls back on any error, so no savepoint is needed.
// SQL is parameterised and single-table; contact data / notes are never logged or echoed in an error. Staff reach rows through RLS (receiving-centre scope, REQ-SEC-017).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import type { HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { assertTransition, PICKUP_STATES, type PickupState } from '../domain/pickup.state.js';
import { pickupTransition } from './observability.js';
import { partnerContext } from './partner-context.service.js';
import { bad, closed, ifMatch, isObj, uuidParam } from './partner-user.service.js';
import { listParams, page } from './referrer.service.js';

type Q = { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };
type Obj = Record<string, unknown>;
type Who = 'partner' | 'staff';
type Op = 'cancel' | 'schedule' | 'collect' | 'reject';

const PERM = { request: 'partners.pickup.request', read: 'partners.order.read', manage: 'partners.pickup.manage' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const PHONE = /^\+[1-9][0-9]{7,14}$/;
const REASON = /^[a-z][a-z0-9_]{0,63}$/; // shape pre-check; membership is checked against partners.g_cs_reasons
const STATE_CSV = /^(requested|scheduled|picked_up|cancelled|rejected)(,(requested|scheduled|picked_up|cancelled|rejected)){0,4}$/;
const OPEN: readonly string[] = ['requested', 'scheduled'];
const HOUR = 3_600_000, DAY = 24 * HOUR;
const DEFAULT_MAX_DAYS_AHEAD = 7; // 02-TRD §10.2 default when the tenant has no partners.settings row
const START_GRACE = HOUR; // window_start >= now - 1 h (03-APP-FLOW §2.3)

const COLS = 'id, partner_id, receiving_centre_id, state, window_start, window_end, packages_count, notes, contact_name, contact_phone_e164, scheduled_start, scheduled_end, '
  + 'assignee_text, picked_up_at, cancel_reason_code, reject_reason_code, created_at, version';
const SELECT = `SELECT ${COLS} FROM partners.pickup_requests WHERE tenant_id = $1`;
const LOCK_SQL = `${SELECT} AND id = $2 FOR UPDATE`;
const LOCK_PARTNER_SQL = `${SELECT} AND id = $2 AND partner_id = $3 FOR UPDATE`;
const GET_SQL = `${SELECT} AND id = $2 AND partner_id = $3`;
const SETTINGS_SQL = 'SELECT pickup_max_days_ahead FROM partners.settings WHERE tenant_id = $1';
const LOCK_MANIFESTS_SQL = 'SELECT id, manifest_no, state, receiving_centre_id FROM partners.manifests WHERE tenant_id = $1 AND partner_id = $2 AND id = ANY($3::uuid[]) ORDER BY id FOR UPDATE';
const OPEN_LINKS_SQL = 'SELECT manifest_id FROM partners.pickup_request_manifests WHERE tenant_id = $1 AND is_open = true AND manifest_id = ANY($2::uuid[])';
const INSERT_SQL = 'INSERT INTO partners.pickup_requests (id, tenant_id, partner_id, receiving_centre_id, window_start, window_end, packages_count, notes, contact_name, '
  + 'contact_phone_e164, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) RETURNING id'; // RETURNING id only: the row is re-read (partner SQL never names staff-only columns, AB11)
const INSERT_LINK_SQL = 'INSERT INTO partners.pickup_request_manifests (tenant_id, pickup_request_id, manifest_id, partner_id, receiving_centre_id, created_by, updated_by) '
  + 'VALUES ($1, $2, $3, $4, $5, $6, $6)';
const LINKS_SQL = 'SELECT pickup_request_id, manifest_id, is_open FROM partners.pickup_request_manifests WHERE tenant_id = $1 AND pickup_request_id = ANY($2::uuid[])';
const MANIFEST_NOS_SQL = 'SELECT id, manifest_no FROM partners.manifests WHERE tenant_id = $1 AND id = ANY($2::uuid[])';
const PARTNERS_SQL = 'SELECT id, partner_code, name, contact_phone_e164, address_text FROM partners.partners WHERE tenant_id = $1 AND id = ANY($2::uuid[])';
const REASON_SQL = 'SELECT code, is_active FROM partners.g_cs_reasons WHERE set_name = $1 AND code = $2';
const CLOSE_LINKS_SQL = 'UPDATE partners.pickup_request_manifests SET is_open = false, updated_at = now(), updated_by = $3 WHERE tenant_id = $1 AND pickup_request_id = $2 AND is_open = true';
const OPEN_OF_PICKUP_SQL = 'SELECT manifest_id FROM partners.pickup_request_manifests WHERE tenant_id = $1 AND pickup_request_id = $2 AND is_open = true';
const IN_TRANSIT_SQL = 'UPDATE partners.manifests SET in_transit_at = $3, updated_at = now(), updated_by = $4, version = version + 1 WHERE tenant_id = $1 AND id = ANY($2::uuid[])';
const UPDATE_TAIL = ', updated_at = now(), updated_by = $3, version = version + 1 WHERE tenant_id = $1 AND id = $2 AND version = $4 RETURNING id';
const REREAD_SQL = `${SELECT} AND id = $2`;
const UPDATE_SET: Record<Op, string> = {
  cancel: "UPDATE partners.pickup_requests SET state = 'cancelled', cancel_reason_code = $5, resolved_at = $6, resolved_by = $3" + UPDATE_TAIL,
  schedule: "UPDATE partners.pickup_requests SET state = 'scheduled', scheduled_start = $5, scheduled_end = $6, assignee_text = $7" + UPDATE_TAIL,
  collect: "UPDATE partners.pickup_requests SET state = 'picked_up', picked_up_at = $5, resolved_at = $6, resolved_by = $3" + UPDATE_TAIL,
  reject: "UPDATE partners.pickup_requests SET state = 'rejected', reject_reason_code = $5, resolved_at = $6, resolved_by = $3" + UPDATE_TAIL,
};
const TARGET: Record<Op, PickupState> = { cancel: 'cancelled', schedule: 'scheduled', collect: 'picked_up', reject: 'rejected' };
const REASON_SET = { cancel: 'pickup_cancel_reasons', reject: 'pickup_reject_reasons' } as const;

const forbidden = () => new LimsError('auth.forbidden');
const notFound = () => new LimsError('common.not_found');
const invalid = () => new LimsError('partners.pickup_invalid');

/** Actor type + permission + (partner callers) partnerContext. Returns the caller's partner id (partner callers only). */
async function gate(ctx: HandlerContext, who: Who, permission: string): Promise<string | undefined> {
  if (ctx.actor?.type !== (who === 'partner' ? 'partner' : 'user') || !ctx.tenantId || !ctx.tx || !ctx.actor.id) throw forbidden(); // before any SQL
  await ctx.ports.IdentityPort.assertRole(ctx, { permission } as never);
  return who === 'staff' ? undefined : (await partnerContext.require(ctx)).partnerId;
}

// ---------------------------------------------------------------- value rules
const len = (s: string) => [...s].length;
const nowMs = (ctx: HandlerContext): number => {
  const n = new Date(ctx.now() as unknown as string).getTime();
  if (Number.isNaN(n)) throw new LimsError('common.internal');
  return n;
};
const iso = (v: unknown): string => new Date(v as string).toISOString();
/** IsoUtc (02-CV §4.8): millisecond precision, Z only, a real calendar instant. Returns epoch ms. */
function instant(v: unknown, path: string): number {
  if (typeof v !== 'string' || !ISO.test(v)) throw bad(path);
  const ms = Date.parse(v);
  if (Number.isNaN(ms) || new Date(ms).toISOString() !== v) throw bad(path);
  return ms;
}
function str(v: unknown, path: string, max: number): string {
  if (typeof v !== 'string' || len(v) > max) throw bad(path);
  return v;
}
function reasonShape(v: unknown): string {
  if (typeof v !== 'string' || !REASON.test(v)) throw bad('/reason_code');
  return v;
}
/** x-coded-set is annotation-only in core and the DDL has no FK on the reason columns (05-SCHEMA §7): membership is checked here. */
async function reasonInSet(ctx: HandlerContext, set: string, code: string): Promise<void> {
  const { rows } = await (ctx.tx as Q).query(REASON_SQL, [set, code]);
  const hit = rows.find((r) => r['code'] === code);
  if (!hit || hit['is_active'] !== true) throw bad('/reason_code');
}
function stateFilter(v: unknown, fallback: readonly string[]): string[] {
  if (v === undefined) return [...fallback];
  if (typeof v !== 'string' || v.length > 48 || !STATE_CSV.test(v)) throw bad('/state');
  return [...new Set(v.split(','))];
}

// ---------------------------------------------------------------- DTOs (explicit allowlists; null columns omitted)
interface Row {
  id: string; partner_id: string; receiving_centre_id: string; state: PickupState; window_start: unknown; window_end: unknown; packages_count: number | string;
  notes: string | null; contact_name: string | null; contact_phone_e164: string | null; scheduled_start: unknown; scheduled_end: unknown; assignee_text: string | null;
  picked_up_at: unknown; cancel_reason_code: string | null; reject_reason_code: string | null; created_at: unknown; version: number | string;
}
type Mf = { id: string; manifest_no: string };
const has = (v: unknown) => v !== null && v !== undefined;
function toDto(r: Row, manifests: Mf[], partner?: Obj): Obj {
  return {
    id: r.id, state: r.state, window_start: iso(r.window_start), window_end: iso(r.window_end), packages_count: Number(r.packages_count),
    ...(has(r.notes) ? { notes: r.notes } : {}), ...(has(r.contact_name) ? { contact_name: r.contact_name } : {}),
    ...(has(r.contact_phone_e164) ? { contact_phone_e164: r.contact_phone_e164 } : {}),
    manifests,
    ...(has(r.scheduled_start) ? { scheduled_start: iso(r.scheduled_start), scheduled_end: iso(r.scheduled_end) } : {}),
    ...(has(r.assignee_text) ? { assignee_text: r.assignee_text } : {}), ...(has(r.picked_up_at) ? { picked_up_at: iso(r.picked_up_at) } : {}),
    ...(has(r.reject_reason_code) ? { reject_reason_code: r.reject_reason_code } : {}), ...(has(r.cancel_reason_code) ? { cancel_reason_code: r.cancel_reason_code } : {}),
    created_at: iso(r.created_at), version: Number(r.version),
    ...(partner ? { partner } : {}),
  };
}
/** Manifests of a non-terminal pickup = its open links (a detached manifest, MS5, is not listed); of a closed pickup = every link ever made. Partner block for staff. */
async function hydrate(ctx: HandlerContext, rows: Row[], admin: boolean): Promise<Obj[]> {
  if (rows.length === 0) return [];
  const tx = ctx.tx as Q;
  const links = (await tx.query(LINKS_SQL, [ctx.tenantId, rows.map((r) => r.id)])).rows;
  const mids = [...new Set(links.map((l) => String(l['manifest_id'])))];
  const nos = new Map<string, string>();
  if (mids.length) for (const m of (await tx.query(MANIFEST_NOS_SQL, [ctx.tenantId, mids])).rows) nos.set(String(m['id']), String(m['manifest_no']));
  const partners = new Map<string, Obj>();
  if (admin) {
    for (const p of (await tx.query(PARTNERS_SQL, [ctx.tenantId, [...new Set(rows.map((r) => r.partner_id))]])).rows) {
      partners.set(String(p['id']), { id: p['id'], partner_code: p['partner_code'], name: p['name'],
        ...(has(p['contact_phone_e164']) ? { contact_phone_e164: p['contact_phone_e164'] } : {}), ...(has(p['address_text']) ? { address_text: p['address_text'] } : {}) });
    }
  }
  return rows.map((r) => {
    const mine = links.filter((l) => l['pickup_request_id'] === r.id && (l['is_open'] === true || !OPEN.includes(r.state)) && nos.has(String(l['manifest_id'])));
    const manifests = mine.map((l) => ({ id: String(l['manifest_id']), manifest_no: nos.get(String(l['manifest_id']))! })).sort((a, b) => a.manifest_no.localeCompare(b.manifest_no) || a.id.localeCompare(b.id));
    return toDto(r, manifests, admin ? (partners.get(r.partner_id) ?? { id: r.partner_id, partner_code: '', name: '' }) : undefined);
  });
}

/** Row as written by this transaction (the INSERT / UPDATE of a pickup returns only its id). */
async function reread(ctx: HandlerContext, id: unknown): Promise<Row> {
  const row = (await (ctx.tx as Q).query(REREAD_SQL, [ctx.tenantId, id])).rows[0] as Row | undefined;
  if (!row) throw new LimsError('common.internal');
  return row;
}

// ---------------------------------------------------------------- K1
function k1Body(v: unknown): { ids: string[]; start: number; end: number; packages: number; notes: string | null; contactName: string | null; phone: string | null } {
  if (!isObj(v)) throw bad('/body');
  for (const k of Object.keys(v)) if (!['manifest_ids', 'window_start', 'window_end', 'packages_count', 'notes', 'contact_name', 'contact_phone_e164'].includes(k)) throw bad(`/${k}`); // AB2, AB11
  const ids = v['manifest_ids'];
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20 || ids.some((i) => typeof i !== 'string' || !UUID.test(i)) || new Set(ids).size !== ids.length) throw bad('/manifest_ids');
  const start = instant(v['window_start'], '/window_start'), end = instant(v['window_end'], '/window_end');
  const n = v['packages_count'];
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 50) throw bad('/packages_count');
  const opt = (k: string, max: number) => (v[k] === undefined ? null : str(v[k], `/${k}`, max));
  const phone = opt('contact_phone_e164', 16);
  if (phone !== null && !PHONE.test(phone)) throw bad('/contact_phone_e164');
  return { ids: ids as string[], start, end, packages: n, notes: opt('notes', 500), contactName: opt('contact_name', 80), phone };
}
async function maxDaysAhead(ctx: HandlerContext): Promise<number> {
  const { rows } = await (ctx.tx as Q).query(SETTINGS_SQL, [ctx.tenantId]);
  return rows[0] ? Number(rows[0]['pickup_max_days_ahead']) : DEFAULT_MAX_DAYS_AHEAD;
}

/** K1 */
export async function createPickup(req: HandlerRequest, ctx: HandlerContext): Promise<HandlerResult> {
  const partnerId = (await gate(ctx, 'partner', PERM.request))!;
  const b = k1Body(req.body), now = nowMs(ctx), tx = ctx.tx as Q, actor = ctx.actor!.id;
  if (!(b.start < b.end) || b.start < now - START_GRACE || b.end > now + (await maxDaysAhead(ctx)) * DAY) throw invalid();
  const locked = (await tx.query(LOCK_MANIFESTS_SQL, [ctx.tenantId, partnerId, b.ids])).rows;
  if (locked.length !== b.ids.length) throw notFound(); // unknown / other partner / other tenant: one answer for the whole request (AB3)
  const centre = locked[0]!['receiving_centre_id'];
  if (locked.some((m) => (m['state'] !== 'submitted' && m['state'] !== 'partially_received') || m['receiving_centre_id'] !== centre)) throw invalid();
  if ((await tx.query(OPEN_LINKS_SQL, [ctx.tenantId, b.ids])).rows.length > 0) throw invalid(); // after the locks: a concurrent creator has committed or is gone
  const pid = uuidv7();
  const { rows } = await tx.query(INSERT_SQL, [pid, ctx.tenantId, partnerId, centre, new Date(b.start).toISOString(), new Date(b.end).toISOString(), b.packages, b.notes, b.contactName, b.phone, actor]);
  try {
    for (const m of locked) await tx.query(INSERT_LINK_SQL, [ctx.tenantId, pid, m['id'], partnerId, centre, actor]);
  } catch (e) { throw (e as { code?: string })?.code === '23505' ? invalid() : e; } // unique index: one open pickup per manifest
  const manifests = locked.map((m) => ({ id: String(m['id']), manifest_no: String(m['manifest_no']) })).sort((x, y) => x.manifest_no.localeCompare(y.manifest_no) || x.id.localeCompare(y.id));
  const out = { status: 201, body: toDto(await reread(ctx, rows[0]!['id']), manifests) };
  pickupTransition(ctx, 'requested'); // T23
  return out;
}

// ---------------------------------------------------------------- K2 / K3 / SP1
const ORDER = { '-created_at': 'created_at DESC, id DESC', window_start: 'window_start, id' } as const;
function sortParam(v: unknown, fallback: keyof typeof ORDER): string {
  if (v === undefined) return ORDER[fallback];
  if (typeof v !== 'string' || !Object.hasOwn(ORDER, v)) throw bad('/sort');
  return ORDER[v as keyof typeof ORDER];
}
async function run(ctx: HandlerContext, sql: string, values: unknown[], order: string, limit: number, offset: number, admin: boolean): Promise<HandlerResult> {
  values.push(limit + 1, offset);
  const text = `${sql} ORDER BY ${order} LIMIT $${values.length - 1} OFFSET $${values.length}`; // placeholders only; values are bound
  const { rows } = await (ctx.tx as Q).query(text, values);
  return { status: 200, body: { data: await hydrate(ctx, rows.slice(0, limit) as Row[], admin), page: page(limit, offset, rows.length) } };
}

/** K2 */
export async function listOwn(req: HandlerRequest, ctx: HandlerContext): Promise<HandlerResult> {
  const partnerId = (await gate(ctx, 'partner', PERM.read))!;
  const { query, limit, offset } = listParams(req.query, ['state', 'sort', 'cursor', 'limit']);
  const order = sortParam(query['sort'], '-created_at');
  const values: unknown[] = [ctx.tenantId, partnerId];
  let sql = `${SELECT} AND partner_id = $2`;
  if (query['state'] !== undefined) { values.push(stateFilter(query['state'], PICKUP_STATES)); sql += ` AND state = ANY($${values.length}::text[])`; }
  return run(ctx, sql, values, order, limit, offset, false);
}

/** K3 */
export async function getOwn(req: HandlerRequest, ctx: HandlerContext): Promise<HandlerResult> {
  const partnerId = (await gate(ctx, 'partner', PERM.read))!;
  const pid = uuidParam(req.params, 'pickup_request_id');
  const row = (await (ctx.tx as Q).query(GET_SQL, [ctx.tenantId, pid, partnerId])).rows[0] as Row | undefined;
  if (!row) throw notFound();
  return { status: 200, body: (await hydrate(ctx, [row], false))[0]! };
}

/** SP1 */
export async function listInbound(req: HandlerRequest, ctx: HandlerContext): Promise<HandlerResult> {
  await gate(ctx, 'staff', PERM.manage);
  const { query, limit, offset } = listParams(req.query, ['state', 'partner_id', 'receiving_centre_id', 'window_start_from', 'window_start_to', 'sort', 'cursor', 'limit']);
  const order = sortParam(query['sort'], 'window_start');
  const values: unknown[] = [ctx.tenantId, stateFilter(query['state'], OPEN)];
  let sql = `${SELECT} AND state = ANY($2::text[])`;
  for (const k of ['partner_id', 'receiving_centre_id'] as const) if (query[k] !== undefined) { values.push(uuidParam(query, k)); sql += ` AND ${k} = $${values.length}`; }
  if (query['window_start_from'] !== undefined) { values.push(new Date(instant(query['window_start_from'], '/window_start_from')).toISOString()); sql += ` AND window_start >= $${values.length}`; }
  if (query['window_start_to'] !== undefined) { values.push(new Date(instant(query['window_start_to'], '/window_start_to')).toISOString()); sql += ` AND window_start <= $${values.length}`; }
  return run(ctx, sql, values, order, limit, offset, true);
}

// ---------------------------------------------------------------- K4 / SP2 / SP3 / SP4
/** Body of the transition: [update args after $4]. Validation only; no SQL except the coded-set lookup. */
async function transitionArgs(req: HandlerRequest, ctx: HandlerContext, op: Op, now: number): Promise<unknown[]> {
  if (op === 'cancel' || op === 'reject') {
    const code = reasonShape(closed(req.body, ['reason_code'])['reason_code']);
    await reasonInSet(ctx, REASON_SET[op], code);
    return [code, new Date(now).toISOString()];
  }
  if (op === 'schedule') {
    const b = closed(req.body, ['scheduled_start', 'scheduled_end', 'assignee_text']);
    const s = instant(b['scheduled_start'], '/scheduled_start'), e = instant(b['scheduled_end'], '/scheduled_end');
    const who = str(b['assignee_text'], '/assignee_text', 80);
    if (who.trim() === '') throw bad('/assignee_text');
    if (!(s < e)) throw invalid();
    return [new Date(s).toISOString(), new Date(e).toISOString(), who];
  }
  if (req.body !== undefined && !isObj(req.body)) throw bad('/body');
  const b: Obj = req.body === undefined ? {} : (req.body as Obj);
  for (const k of Object.keys(b)) if (k !== 'picked_up_at') throw bad(`/${k}`); // AB11: in_transit_at, state, … are unknown keys
  const at = b['picked_up_at'] === undefined ? now : instant(b['picked_up_at'], '/picked_up_at');
  if (at > now) throw bad('/picked_up_at'); // SP3: <= now
  return [new Date(at).toISOString(), new Date(now).toISOString()];
}

async function transition(req: HandlerRequest, ctx: HandlerContext, op: Op): Promise<HandlerResult> {
  const partnerId = await gate(ctx, op === 'cancel' ? 'partner' : 'staff', op === 'cancel' ? PERM.request : PERM.manage);
  const expected = ifMatch(req.headers), pid = uuidParam(req.params, 'pickup_request_id');
  const now = nowMs(ctx), args = await transitionArgs(req, ctx, op, now), tx = ctx.tx as Q, actor = ctx.actor!.id;
  const { rows: found } = partnerId === undefined ? await tx.query(LOCK_SQL, [ctx.tenantId, pid]) : await tx.query(LOCK_PARTNER_SQL, [ctx.tenantId, pid, partnerId]);
  const row = found[0] as Row | undefined;
  if (!row) throw notFound(); // unknown / other partner / other tenant / other centre: same answer
  if (Number(row.version) !== expected) throw new LimsError('common.version_conflict');
  assertTransition(row.state, TARGET[op]); // 409 partners.pickup_invalid_transition
  const { rows } = await tx.query(UPDATE_SET[op], [ctx.tenantId, row.id, actor, Number(row.version), ...args]);
  if (!rows[0]) throw new LimsError('common.version_conflict'); // cannot happen under the row lock
  if (op === 'collect') { // US-10.4: the pickup's open manifests are now in transit (their state is unchanged)
    const open = (await tx.query(OPEN_OF_PICKUP_SQL, [ctx.tenantId, row.id])).rows.map((l) => String(l['manifest_id']));
    if (open.length) await tx.query(IN_TRANSIT_SQL, [ctx.tenantId, open, args[0], actor]);
  }
  if (op !== 'schedule') await tx.query(CLOSE_LINKS_SQL, [ctx.tenantId, row.id, actor]); // the open-link slot is free again
  const out = { status: 200, body: (await hydrate(ctx, [await reread(ctx, row.id)], op !== 'cancel'))[0]! };
  pickupTransition(ctx, TARGET[op]); // T23: the state reached (a reschedule is one more `scheduled`)
  return out;
}

/** K4 */ export const cancelOwn = (req: HandlerRequest, ctx: HandlerContext) => transition(req, ctx, 'cancel');
/** SP2 */ export const schedule = (req: HandlerRequest, ctx: HandlerContext) => transition(req, ctx, 'schedule');
/** SP3 */ export const markCollected = (req: HandlerRequest, ctx: HandlerContext) => transition(req, ctx, 'collect');
/** SP4 */ export const reject = (req: HandlerRequest, ctx: HandlerContext) => transition(req, ctx, 'reject');
