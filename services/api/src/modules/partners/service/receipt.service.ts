// C13 T10 — staff receipt SI1-SI5 (02-TRD §5.3; 03-APP-FLOW §2.1 MS6-MS8 + "Pending receipt" (08 A19 D-104), §2.2 LS3/LS4/LS7/LS8, §4.2 SI3 + retry; US-06.1/.2/.6/.9/.10/.11).
// Order: staff actor -> row load under RLS (the staff claims scope it by centre; invisible = 404) -> IdentityPort.assertRole(partners.manifest.receive, centre of the row)
// -> If-Match (428/400) -> version (409) -> state (409) -> body (400) -> per-line checks (422) -> writes. SI1 asserts the permission only (RLS scopes the rows).
// SQL is written unqualified by centre on purpose: RLS (staff centre scope) is the filter. Every statement binds tenant_id. The manifest row lock (SI3, SI5) serialises
// with the partner's withdraw (M9) and with a second staff tab. A partner may be suspended: receipt goes on (SI3 step 2). No patient data is logged.
import { LimsError, type FieldError } from '../../../core/errors.js';
import type { HandlerContext, HandlerResult } from '../../../core/module.js';
import { isPendingReceipt, stateAfterReceipt, type ConversionMode } from '../domain/manifest.state.js';
import { toLineDto, toManifestDto, toManifestSummaryDto, type CentreName } from '../mappers/manifest.dto.js';
import type { Q, Scope } from '../repository/counters.repo.js';
import * as lines from '../repository/manifest-lines.repo.js';
import { ifMatch, pathId } from './manifest.service.js';
import { manifestTransition } from './observability.js';

type Row = Record<string, any>;
type Req = { params?: unknown; query?: unknown; headers?: unknown; body?: unknown };
type Core = { centre(c: unknown, i: { centreId: string }): Promise<{ id: string; name: string }> };

const RECEIVE = 'partners.manifest.receive';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INBOX_STATES = ['submitted', 'partially_received', 'received', 'withdrawn']; // drafts / discarded never reach the lab
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_RECEIPT_LINES = 200;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const notFound = (): never => { throw new LimsError('common.not_found'); };
const invalid = (): never => { throw new LimsError('common.validation_failed'); };
const conflict = (): never => { throw new LimsError('common.version_conflict'); };
const lineTransition = (): never => { throw new LimsError('partners.manifest_line_invalid_transition'); };

interface Staff { tx: Q; t: string; actorId: string }
function staff(ctx: HandlerContext): Staff {
  if (ctx.actor?.type !== 'user' || !ctx.tenantId || !ctx.tx || !ctx.actor.id) throw new LimsError('auth.forbidden'); // before any SQL
  return { tx: ctx.tx as Q, t: ctx.tenantId as string, actorId: ctx.actor.id };
}
const assertReceive = (ctx: HandlerContext, centreId?: string): Promise<void> =>
  ctx.ports.IdentityPort.assertRole(ctx, { permission: RECEIVE, ...(centreId ? { centreId } : {}) });
const scopeOf = (s: Staff, partnerId: string): Scope => ({ tx: s.tx, tenantId: s.t, partnerId, actorId: s.actorId });
const centreOf = async (ctx: HandlerContext, centreId: string): Promise<CentreName> => {
  const c = await (ctx.core as unknown as Core).centre(ctx, { centreId });
  return { id: c.id, name: c.name };
};

// ---- reads ----
const getManifest = async (s: Staff, id: string, lock = false): Promise<Row | undefined> =>
  (await s.tx.query(`SELECT * FROM partners.manifests WHERE tenant_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [s.t, id])).rows[0];
const getLine = async (s: Staff, id: string, lock = false): Promise<Row | undefined> =>
  (await s.tx.query(`SELECT * FROM partners.manifest_lines WHERE tenant_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [s.t, id])).rows[0];
const linesOf = async (s: Staff, manifestId: string): Promise<Row[]> =>
  (await s.tx.query('SELECT * FROM partners.manifest_lines WHERE tenant_id = $1 AND manifest_id = $2 ORDER BY line_no ASC', [s.t, manifestId])).rows;
const partnerBlocks = async (s: Staff, ids: string[]): Promise<Map<string, Row>> => {
  if (ids.length === 0) return new Map();
  const { rows } = await s.tx.query('SELECT id, partner_code, name FROM partners.partners WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [s.t, ids]);
  return new Map(rows.map((r) => [r['id'] as string, { id: r['id'], partner_code: r['partner_code'], name: r['name'] }]));
};
/** active codes of the coded set line_not_received_reasons (partners.g_cs_reasons, 05-SCHEMA §7). */
const notReceivedReasons = async (s: Staff): Promise<Set<string>> =>
  new Set((await s.tx.query('SELECT code, is_active FROM partners.g_cs_reasons WHERE set_name = $1', ['line_not_received_reasons'])).rows.filter((r) => r['is_active'] === true).map((r) => r['code'] as string));

const receiptLine = (l: Row) => ({ state: l['state'] as string, sampleReceivedAt: l['sample_received_at'] ?? null, sampleMissing: l['sample_missing'] === true });
const counts = (ls: Row[]) => ({ converted: ls.filter((l) => l['state'] === 'converted').length, failed: ls.filter((l) => l['state'] === 'conversion_failed').length });
const staffAudit = (m: Row) => ({
  ...(m['received_by'] != null ? { received_by: m['received_by'] } : {}), ...(m['created_by'] != null ? { created_by: m['created_by'] } : {}), ...(m['submitted_by'] != null ? { submitted_by: m['submitted_by'] } : {}),
});
const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

/** ManifestLine DTO + the receipt flags staff need (D-104). */
const staffLineDto = (l: Row, refName: string | undefined) => ({
  ...toLineDto(l, refName),
  ...(l['sample_received_at'] != null ? { sample_received_at: iso(l['sample_received_at']) } : {}),
  sample_missing: l['sample_missing'] === true,
});
async function refNames(s: Staff, m: Row, ls: Row[]): Promise<Map<string, string>> {
  const ids = [...new Set(ls.map((l) => l['referrer_id']).filter(isUuid))];
  return new Map((await lines.referrers(scopeOf(s, m['partner_id']), ids)).map((r) => [r['id'] as string, r['display_name'] as string]));
}
async function inboundDto(ctx: HandlerContext, s: Staff, m: Row) {
  const ls = await linesOf(s, m['id']);
  const [centre, names, partners] = await Promise.all([centreOf(ctx, m['receiving_centre_id']), refNames(s, m, ls), partnerBlocks(s, [m['partner_id']])]);
  return { ...toManifestDto(m, centre, counts(ls), ls.map((l) => staffLineDto(l, names.get(l['referrer_id'])))), partner: partners.get(m['partner_id']), ...staffAudit(m) };
}

// ---- SI1 ----
const bool = (v: unknown): boolean | undefined => (v === undefined ? undefined : v === true || v === 'true' ? true : v === false || v === 'false' ? false : invalid());
const instant = (v: unknown): string | undefined => (v === undefined ? undefined : typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : invalid());
const optUuid = (v: unknown): string | undefined => (v === undefined ? undefined : isUuid(v) ? v : invalid());
type Sort = 'submitted_at' | 'manifest_no';
const encodeCursor = (sort: Sort, k: string, i: string): string => Buffer.from(JSON.stringify({ v: 1, s: sort, k, i })).toString('base64url');
function decodeCursor(raw: unknown, sort: Sort): { key: string; id: string } {
  const bad = (): never => { throw new LimsError('common.invalid_cursor'); };
  if (typeof raw !== 'string' || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) return bad();
  let o: unknown;
  try { o = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { return bad(); }
  if (!isObj(o) || o['v'] !== 1 || o['s'] !== sort || typeof o['k'] !== 'string' || o['k'].length > 64 || !isUuid(o['i'])) return bad();
  if (sort === 'submitted_at' && Number.isNaN(Date.parse(o['k'] as string))) return bad();
  return { key: o['k'] as string, id: o['i'] as string };
}
/** manifest ids that have at least one line matching `cond` (single-table read; RLS scopes it). */
const manifestIdsWith = async (s: Staff, cond: string): Promise<Set<string>> =>
  new Set((await s.tx.query(`SELECT manifest_id FROM partners.manifest_lines WHERE tenant_id = $1 AND ${cond}`, [s.t])).rows.map((r) => r['manifest_id'] as string));

export async function listInbound(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const s = staff(ctx);
  await assertReceive(ctx);
  const q = isObj(req.query) ? req.query : {};
  const states = q['state'] === undefined ? ['submitted', 'partially_received'] : String(q['state']).split(',');
  if (states.length === 0 || !states.every((x) => INBOX_STATES.includes(x))) invalid();
  const partnerId = optUuid(q['partner_id']); const centreId = optUuid(q['receiving_centre_id']);
  const from = instant(q['submitted_at_from']); const to = instant(q['submitted_at_to']);
  const hasFailed = bool(q['has_failed_lines']); const hasMissing = bool(q['has_missing_samples']);
  const sort: Sort = q['sort'] === undefined || q['sort'] === '-submitted_at' ? 'submitted_at' : q['sort'] === 'manifest_no' ? 'manifest_no' : invalid();
  const n = Number(q['limit']);
  const limit = q['limit'] === undefined ? DEFAULT_LIMIT : Number.isInteger(n) && n >= 1 && n <= MAX_LIMIT ? n : invalid();
  const cursor = q['cursor'] === undefined ? undefined : decodeCursor(q['cursor'], sort);

  // D-104 filters: lines first, then manifests by id (single-table statements)
  // ponytail: reads every failed / missing line id of the visible centres; a flag column on manifests if the inbox grows past a few thousand such lines
  const failed = hasFailed === undefined ? undefined : await manifestIdsWith(s, "state = 'conversion_failed'");
  const missing = hasMissing === undefined ? undefined : await manifestIdsWith(s, "sample_missing = true AND state = 'converted'") // D-104: order exists, sample missing (05-SCHEMA missing idx);
  let only: string[] | undefined;
  for (const [flag, set] of [[hasFailed, failed], [hasMissing, missing]] as const) {
    if (flag !== true || !set) continue;
    only = only ? only.filter((x) => set.has(x)) : [...set];
  }
  if (only && only.length === 0) return { status: 200, body: { data: [], page: { limit } } };

  const vals: unknown[] = [s.t, states];
  const add = (v: unknown): string => { vals.push(v); return `$${vals.length}`; };
  const where = ['tenant_id = $1', 'state = ANY($2::text[])'];
  if (partnerId) where.push(`partner_id = ${add(partnerId)}`);
  if (centreId) where.push(`receiving_centre_id = ${add(centreId)}`);
  if (from) where.push(`submitted_at >= ${add(from)}::timestamptz`);
  if (to) where.push(`submitted_at <= ${add(to)}::timestamptz`);
  if (only) where.push(`id = ANY(${add(only)}::uuid[])`);
  if (cursor) where.push(sort === 'submitted_at' ? `(submitted_at, id) < (${add(cursor.key)}::timestamptz, ${add(cursor.id)}::uuid)` : `(manifest_no, id) > (${add(cursor.key)}, ${add(cursor.id)}::uuid)`);
  const jsFilter = hasFailed === false || hasMissing === false; // exclusion is applied below, so the SQL LIMIT cannot be used
  const order = sort === 'submitted_at' ? 'submitted_at DESC, id DESC' : 'manifest_no ASC, id ASC';
  const key = "to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS submitted_key";
  let rows = (await s.tx.query(`SELECT *, ${key} FROM partners.manifests WHERE ${where.join(' AND ')} ORDER BY ${order}${jsFilter ? '' : ` LIMIT ${add(limit + 1)}`}`, vals)).rows;
  if (hasFailed === false) rows = rows.filter((r) => !failed!.has(r['id']));
  if (hasMissing === false) rows = rows.filter((r) => !missing!.has(r['id']));
  const page = rows.slice(0, limit);

  const ids = page.map((r) => r['id'] as string);
  const lineRows = ids.length ? (await s.tx.query('SELECT manifest_id, state FROM partners.manifest_lines WHERE tenant_id = $1 AND manifest_id = ANY($2::uuid[])', [s.t, ids])).rows : [];
  const partners = await partnerBlocks(s, [...new Set(page.map((r) => r['partner_id'] as string))]);
  const centres = new Map<string, CentreName>();
  for (const r of page) if (!centres.has(r['receiving_centre_id'])) centres.set(r['receiving_centre_id'], await centreOf(ctx, r['receiving_centre_id']));
  const last = rows.length > limit ? page[page.length - 1] : undefined;
  const keyOf = (r: Row): string => (sort === 'manifest_no' ? String(r['manifest_no']) : String(r['submitted_key'] ?? iso(r['submitted_at'])));
  return { status: 200, body: {
    data: page.map((r) => ({ ...toManifestSummaryDto(r, centres.get(r['receiving_centre_id'])!, counts(lineRows.filter((l) => l['manifest_id'] === r['id']))), partner: partners.get(r['partner_id']), ...staffAudit(r) })),
    page: { limit, ...(last ? { next_cursor: encodeCursor(sort, keyOf(last), last['id']) } : {}) },
  } };
}

// ---- SI2 ----
export async function getInbound(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const s = staff(ctx);
  const m = (await getManifest(s, pathId(req, 'manifest_id'))) ?? notFound();
  if (!INBOX_STATES.includes(m['state'])) notFound(); // [CONV] a draft / discarded manifest is the partner's own business
  await assertReceive(ctx, m['receiving_centre_id']);
  const body = await inboundDto(ctx, s, m);
  await ctx.audit!.access({ action: 'patient.view', entityType: 'manifest', entityId: m['id'], outcome: 'allowed' }); // after the read; a failed log write fails the request
  return { status: 200, body };
}

/** MS6/MS7/MS8: manifest state over ALL its lines (as they are after this request); version + 1 either way. Version-guarded: 0 rows = lost a race -> 409. */
async function setManifestState(s: Staff, m: Row, next: 'partially_received' | 'received', ctx: HandlerContext): Promise<Row> {
  const closing = next === 'received';
  const { rows } = await s.tx.query(
    `UPDATE partners.manifests SET state = $4, ${closing ? 'received_at = $6, received_by = $5, ' : ''}version = version + 1, updated_at = now(), updated_by = $5 `
    + "WHERE tenant_id = $1 AND id = $2 AND version = $3 AND state IN ('submitted', 'partially_received') RETURNING *",
    closing ? [s.t, m['id'], m['version'], next, s.actorId, ctx.now()] : [s.t, m['id'], m['version'], next, s.actorId]);
  return rows[0] ?? conflict();
}

// ---- SI3 ----
interface ReceiptItem { lineId: string; outcome: 'received' | 'not_received'; reason?: string }
function receiptBody(b: unknown, reasons: Set<string>): ReceiptItem[] {
  if (!isObj(b) || !Array.isArray(b['lines']) || b['lines'].length < 1 || b['lines'].length > MAX_RECEIPT_LINES) return invalid();
  const seen = new Set<string>();
  return (b['lines'] as unknown[]).map((x) => {
    if (!isObj(x) || !isUuid(x['line_id']) || (x['outcome'] !== 'received' && x['outcome'] !== 'not_received') || seen.has(x['line_id'])) return invalid();
    seen.add(x['line_id']);
    const reason = x['reason_code'];
    if (x['outcome'] === 'received') return reason === undefined ? { lineId: x['line_id'], outcome: 'received' } : invalid();
    return typeof reason === 'string' && reasons.has(reason) ? { lineId: x['line_id'], outcome: 'not_received', reason } : invalid();
  });
}

export async function receive(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const s = staff(ctx);
  const m = (await getManifest(s, pathId(req, 'manifest_id'), true)) ?? notFound(); // lock FIRST (serialises with M9 withdraw and other tabs)
  await assertReceive(ctx, m['receiving_centre_id']);
  const expected = ifMatch(req);
  if (Number(m['version']) !== expected) conflict();
  if (m['state'] !== 'submitted' && m['state'] !== 'partially_received') throw new LimsError('partners.manifest_invalid_transition');
  const items = receiptBody(req.body, await notReceivedReasons(s));
  const mode = m['conversion_mode'] as ConversionMode;
  const byId = new Map((await linesOf(s, m['id'])).map((l) => [l['id'] as string, l]));
  const errors: FieldError[] = [];
  items.forEach((it, i) => {
    const l = byId.get(it.lineId);
    if (!l || !isPendingReceipt(receiptLine(l), mode)) errors.push({ path: `/lines/${i}/line_id`, code: 'partners.manifest_invalid', message: 'Line is not pending receipt in this manifest.' });
  });
  if (errors.length > 0) throw new LimsError('partners.manifest_invalid', undefined, errors); // whole request rejected: nothing written

  // manifest FIRST (version-guarded): a second tab / the partner's withdraw that slipped past the row lock loses here, before any line is written
  const now = ctx.now(); const sc = scopeOf(s, m['partner_id']);
  const outcome = new Map(items.map((it) => [it.lineId, it.outcome]));
  const after = [...byId.values()].map((l) => {
    const r = receiptLine(l); const o = outcome.get(l['id']);
    if (o === undefined) return r;
    if (mode === 'on_receipt') return { ...r, state: o === 'received' ? 'converting' : 'not_received' };
    return o === 'received' ? { ...r, sampleReceivedAt: now } : { ...r, sampleMissing: true };
  });
  const row = await setManifestState(s, m, stateAfterReceipt(mode, after), ctx);
  for (const it of items) {
    const vals: unknown[] = [s.t, it.lineId, s.actorId];
    const add = (v: unknown): string => { vals.push(v); return `$${vals.length}`; };
    const received = it.outcome === 'received';
    const set = mode === 'on_receipt'
      ? (received ? ["state = 'converting'", 'conversion_attempt = 1', `sample_received_at = ${add(now)}`, 'received_by = $3'] : ["state = 'not_received'", `not_received_reason_code = ${add(it.reason)}`]) // LS3 / LS4
      : (received ? [`sample_received_at = ${add(now)}`, 'received_by = $3'] : ['sample_missing = true', `not_received_reason_code = ${add(it.reason)}`]); // D-104: receipt flags only
    await s.tx.query(`UPDATE partners.manifest_lines SET ${set.join(', ')}, version = version + 1, updated_at = now(), updated_by = $3 WHERE tenant_id = $1 AND id = $2`, vals);
    if (mode === 'on_receipt' && it.outcome === 'received') await lines.enqueueConversion(sc, it.lineId, 1); // job_key convert:<line_id>:1
  }
  const out = { status: 200, body: await inboundDto(ctx, s, row) };
  const reached = (row as Record<string, unknown>)['state'];
  if (reached === 'received' || reached === 'partially_received') manifestTransition(ctx, reached); // T23: the state the receipt leaves the manifest in
  return out;
}

// ---- SI4 ----
export async function retry(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const s = staff(ctx);
  const l = (await getLine(s, pathId(req, 'line_id'), true)) ?? notFound();
  await assertReceive(ctx, l['receiving_centre_id']);
  const expected = ifMatch(req);
  if (Number(l['version']) !== expected) conflict();
  if (l['state'] !== 'conversion_failed') lineTransition();
  const b = req.body === undefined ? {} : isObj(req.body) ? req.body : invalid();
  const patientId = b['patient_id'] === undefined ? undefined : isUuid(b['patient_id']) ? b['patient_id'] : invalid(); // C4 validates the patient at conversion
  const { rows } = await s.tx.query(
    "UPDATE partners.manifest_lines SET state = 'converting', conversion_attempt = conversion_attempt + 1, failure_code = NULL, failed_at = NULL, "
    + `${patientId ? 'resolved_patient_id = $5, ' : ''}version = version + 1, updated_at = now(), updated_by = $4 `
    + "WHERE tenant_id = $1 AND id = $2 AND version = $3 AND state = 'conversion_failed' RETURNING *",
    patientId ? [s.t, l['id'], expected, s.actorId, patientId] : [s.t, l['id'], expected, s.actorId]);
  const row = rows[0] ?? conflict();
  await lines.enqueueConversion(scopeOf(s, row['partner_id']), row['id'], Number(row['conversion_attempt'])); // LS7: key convert:<line_id>:<attempt>
  const names = await refNames(s, row, [row]);
  return { status: 202, body: staffLineDto(row, names.get(row['referrer_id'])) };
}

// ---- SI5 ----
export async function markNotReceived(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const s = staff(ctx);
  const lineId = pathId(req, 'line_id');
  const seen = (await getLine(s, lineId)) ?? notFound();
  await assertReceive(ctx, seen['receiving_centre_id']);
  const expected = ifMatch(req);
  const m = (await getManifest(s, seen['manifest_id'], true)) ?? notFound(); // manifest first, then the line: same lock order as SI3
  const l = (await getLine(s, lineId, true)) ?? notFound();
  if (Number(l['version']) !== expected) conflict();
  const mode = m['conversion_mode'] as ConversionMode;
  const failedOnReceipt = mode === 'on_receipt' && l['state'] === 'conversion_failed'; // LS8
  if (!isPendingReceipt(receiptLine(l), mode) && !failedOnReceipt) lineTransition();
  if (!['submitted', 'partially_received', 'received'].includes(m['state'])) throw new LimsError('partners.manifest_invalid_transition');
  const b = isObj(req.body) ? req.body : invalid();
  const reason = typeof b['reason_code'] === 'string' && (await notReceivedReasons(s)).has(b['reason_code']) ? b['reason_code'] : invalid();
  const set = mode === 'on_receipt' ? ["state = 'not_received'", 'not_received_reason_code = $5', 'failure_code = NULL', 'failed_at = NULL'] : ['sample_missing = true', 'not_received_reason_code = $5'];
  const { rows } = await s.tx.query(
    `UPDATE partners.manifest_lines SET ${set.join(', ')}, version = version + 1, updated_at = now(), updated_by = $4 WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [s.t, lineId, expected, s.actorId, reason]);
  const row = rows[0] ?? conflict();
  if (m['state'] !== 'received') await setManifestState(s, m, stateAfterReceipt(mode, (await linesOf(s, m['id'])).map(receiptLine)), ctx); // a closed manifest stays closed (LS8 on a received manifest)
  const names = await refNames(s, m, [row]);
  return { status: 200, body: staffLineDto(row, names.get(row['referrer_id'])) };
}
