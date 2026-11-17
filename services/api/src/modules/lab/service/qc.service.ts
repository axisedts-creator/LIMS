// T-24 QC hold (03-IC §4.5 holdResultsSince; 02-TRD §6.1; PRD AC-19.4; 01 §2.5). Runs in the caller's tx (ctx.tx); tenant from ctx only.
// Idempotent on (tenant, qcRunId): the INSERT ... ON CONFLICT DO NOTHING is the gate. A concurrent second call waits on the unique index until the first commits and then reads the stored lists,
// so each result is written once. Result rows are locked in id order (02-TRD §3.2). Approved rows are never changed except qc_review_required (lab.enforce_result_lock allows it).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import { first, isUuid, query, type RepoCtx } from '../repository/base.repo.js';
import { decodeCursor, encodeCursor } from '../mappers/specimen.mapper.js';
import { bad, instant, uuid } from './port.shared.js';
import { isObj, ISO_MS, repoCtx, role, scopeOf, specimenCtx, strict, uuidParam, type Obj, type Result } from './specimen.service.js';

export interface HoldOutput { heldResultIds: string[]; reviewFlaggedResultIds: string[] }
const CODE = /^[A-Za-z0-9_.:^+\-]{1,64}$/;
const MAX_ANALYTES = 100;
const sorted = (v: unknown): string[] => [...((v as string[] | null) ?? [])].sort();

/** `at` falls in an active hold of the (instrument, analyte) pair: new results arrive held (02-TRD §6.1: the hold stays active until released, T-25). */
export const ACTIVE_HOLD_SQL = `SELECT h.id FROM lab.qc_holds h WHERE h.tenant_id = $1 AND h.instrument_id = $2 AND h.status = 'active' AND $3::uuid = ANY(h.analyte_ids) AND h.since <= $4::timestamptz LIMIT 1`;
export async function isOnQcHold(rc: RepoCtx, a: { instrumentId: string; analyteId: string; at: string }): Promise<boolean> {
  return (await first(rc, ACTIVE_HOLD_SQL, [a.instrumentId, a.analyteId, a.at])) !== null;
}

export async function holdResultsSince(rc: RepoCtx, raw: unknown): Promise<HoldOutput> {
  const i = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const instrumentId = uuid(i['instrumentId'], '/instrumentId'), qcRunId = uuid(i['qcRunId'], '/qcRunId'), since = instant(i['since'], '/since');
  const ids = i['analyteIds'];
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_ANALYTES || !ids.every((x) => typeof x === 'string' && isUuid(x))) throw bad('/analyteIds');
  const analyteIds = [...new Set((ids as string[]).map((x) => x.toLowerCase()))];
  const reasonCode = i['reasonCode'];
  if (typeof reasonCode !== 'string' || !CODE.test(reasonCode)) throw bad('/reasonCode');

  const holdId = uuidv7();
  const ins = await first(rc, `INSERT INTO lab.qc_holds (id, tenant_id, qc_run_id, instrument_id, analyte_ids, since, reason_code, created_by, updated_by)
      VALUES ($2, $1, $3, $4, $5::uuid[], $6::timestamptz, $7, $8, $8) ON CONFLICT (tenant_id, qc_run_id) DO NOTHING RETURNING id`,
  [holdId, qcRunId, instrumentId, analyteIds, since, reasonCode, rc.actorId]);
  if (!ins) {   // replay: same lists, nothing rewritten
    const row = await first(rc, 'SELECT held_result_ids, review_flagged_result_ids FROM lab.qc_holds WHERE tenant_id = $1 AND qc_run_id = $2', [qcRunId]);
    return { heldResultIds: sorted(row?.['held_result_ids']), reviewFlaggedResultIds: sorted(row?.['review_flagged_result_ids']) };
  }

  // coalesce(instrument_result_time, resulted_at) >= since, same instrument, listed analytes (02-TRD §6.1); pending rows have no value and are not touched
  const mark = (status: string, set: string, extra: unknown[]) => query(rc, `WITH t AS (SELECT id FROM lab.results WHERE tenant_id = $1 AND instrument_id = $2 AND analyte_id = ANY($3::uuid[]) AND status ${status}
        AND coalesce(instrument_result_time, resulted_at) >= $4::timestamptz ORDER BY id FOR UPDATE)
      UPDATE lab.results r SET ${set}, version = r.version + 1, updated_at = now(), updated_by = $5 FROM t WHERE r.tenant_id = $1 AND r.id = t.id RETURNING r.id`,
  [instrumentId, analyteIds, since, rc.actorId, ...extra]);
  const held = (await mark("IN ('resulted','verified')", 'on_hold = true, hold_id = $6', [holdId])).map((r) => r['id'] as string).sort();
  const flagged = (await mark("= 'approved'", 'qc_review_required = true', [])).map((r) => r['id'] as string).sort();
  await query(rc, `UPDATE lab.qc_holds SET held_result_ids = $3::uuid[], review_flagged_result_ids = $4::uuid[], version = version + 1, updated_at = now(), updated_by = $5
      WHERE tenant_id = $1 AND id = $2`, [holdId, held, flagged, rc.actorId]);
  return { heldResultIds: held, reviewFlaggedResultIds: flagged };
}

// ====================================================================== T-25 ======================================================================
// instruments.qc.received.v1 / quality.qc_run.rejected.v1 consumers (02-TRD §7.2) and handlers #43-#46 (02-TRD §5.7). Tenant + actor from ctx only (REQ-SEC-024).
// No QC judgement anywhere (PRD AC-19.3): the DTOs carry values only; accept / reject is C9's.
export interface QcEnvelope { readonly tenant_id: string; readonly idempotency_key: string; readonly payload: Obj }
interface JobCtx { readonly tenantId?: string; readonly tx: unknown; readonly actor: { readonly id: string } }
const rcOfJob = (c: JobCtx, e: { tenant_id?: string }): RepoCtx => {
  if (typeof c.tenantId !== 'string' || e?.tenant_id !== c.tenantId) throw new LimsError('common.internal');   // P-11: the job's tenant is the only tenant
  return { tx: c.tx as RepoCtx['tx'], tenantId: c.tenantId, actorId: c.actor.id };
};
const opt = (v: unknown): unknown => (v === undefined ? null : v);

/** AC-19.1: one qc_results row per envelope idempotency_key. A duplicate does nothing (ON CONFLICT); a foreign centre / over-long field is a DB error -> the job dead-letters. */
export async function applyQcReceived(ctx: JobCtx, env: QcEnvelope): Promise<void> {
  const rc = rcOfJob(ctx, env), p = env.payload;
  await query(rc, `INSERT INTO lab.qc_results (id, tenant_id, centre_id, instrument_id, instrument_message_id, analyte_id, instrument_analyte_code, mapping_status, control_id_raw, control_lot_raw, control_level,
      value_raw, value_numeric, unit_raw, instrument_flags, instrument_result_time, received_at, source, idempotency_key, entered_by_membership_id, created_by)
    VALUES ($2, $1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::numeric, $14, coalesce($15::text[], '{}'), $16::timestamptz, $17::timestamptz, 'instrument', $18, NULL, $19)
    ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
  [uuidv7(), p['centre_id'], p['instrument_id'], opt(p['instrument_message_id']), opt(p['analyte_id']), opt(p['instrument_analyte_code']), opt(p['mapping_status']), p['control_id_raw'], opt(p['control_lot_raw']),
    opt(p['control_level']), p['value_raw'], opt(p['value_numeric']), opt(p['unit_raw']), opt(p['instrument_flags']), opt(p['instrument_result_time']), p['received_at'], env.idempotency_key, rc.actorId]);
}

/** AC-19.4: hold the instrument's results since hold_since; replay of the same qc_run_id changes nothing (holdResultsSince). */
export async function applyQcRejected(ctx: JobCtx, env: QcEnvelope): Promise<void> {
  const rc = rcOfJob(ctx, env), p = env.payload;
  await holdResultsSince(rc, { instrumentId: p['instrument_id'], analyteIds: p['analyte_ids'], since: p['hold_since'], qcRunId: p['qc_run_id'], reasonCode: 'qc_run_rejected' });
}

const P = { capture: 'lab.qc.capture', read: 'lab.result.read', release: 'lab.qc_hold.release' } as const;
const DECIMAL = /^-?[0-9]+(\.[0-9]+)?$/;
const CODE_DTO = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const iso = (v: unknown): string => new Date(v as string | Date).toISOString();
const omitNull = (o: Obj): Obj => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
const qcDto = (r: Obj): Obj => omitNull({ id: r['id'], centre_id: r['centre_id'], instrument_id: r['instrument_id'], analyte_id: r['analyte_id'], control_id_raw: r['control_id_raw'], control_lot_raw: r['control_lot_raw'],
  control_level: r['control_level'], value_numeric: r['value_numeric'] === null ? null : String(r['value_numeric']), unit_code: r['unit_code'], instrument_result_time: iso(r['instrument_result_time'] ?? r['received_at']),
  source: r['source'], received_at: iso(r['received_at']) });

const QC_COLS = 'id, centre_id, instrument_id, analyte_id, control_id_raw, control_lot_raw, control_level, value_numeric, unit_code, instrument_result_time, source, received_at';
const optUuid = (q: Obj, k: string): string | undefined => { const v = q[k]; if (v === undefined) return undefined; if (typeof v !== 'string' || !isUuid(v)) throw bad(`/${k}`); return v.toLowerCase(); };
const optInstant = (q: Obj, k: string): string | undefined => { const v = q[k]; if (v === undefined) return undefined; if (typeof v !== 'string' || !ISO_MS.test(v) || !Number.isFinite(Date.parse(v))) throw bad(`/${k}`); return v; };

/** #43. Newest first by the instrument time (received_at when the instrument sent none); keyset cursor on that key. RLS scopes the centres. */
export async function listQcResults(c: unknown, rawQuery: unknown): Promise<Result> {
  const ctx = specimenCtx(c);
  await role(ctx, P.capture);
  const q = isObj(rawQuery) ? rawQuery : {};
  const instrumentId = optUuid(q, 'instrument_id'), analyteId = optUuid(q, 'analyte_id'), from = optInstant(q, 'instrument_result_time_from'), to = optInstant(q, 'instrument_result_time_to');
  const rawLimit = q['limit'];
  const n = rawLimit === undefined ? 50 : typeof rawLimit === 'string' && /^\d+$/.test(rawLimit) ? Number(rawLimit) : rawLimit;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 200) throw bad('/limit');
  const after = q['cursor'] === undefined ? undefined : decodeCursor(q['cursor'], 'qc_time');
  const T = 'coalesce(instrument_result_time, received_at)';
  // ponytail: unmapped rows have no QcResultDto shape (analyte_id / value_numeric are required there), so they are not listed; upgrade = CR for a nullable DTO.
  const where: string[] = ['tenant_id = $1', 'analyte_id IS NOT NULL', 'value_numeric IS NOT NULL'];
  const vals: unknown[] = [];
  const add = (sql: string, v: unknown) => { vals.push(v); where.push(sql.replace('?', `$${vals.length + 1}`)); };
  if (instrumentId) add('instrument_id = ?::uuid', instrumentId);
  if (analyteId) add('analyte_id = ?::uuid', analyteId);
  if (from) add(`${T} >= ?::timestamptz`, from);
  if (to) add(`${T} <= ?::timestamptz`, to);
  if (after) { vals.push(after.key, after.id); where.push(`(${T}, id) < ($${vals.length}::timestamptz, $${vals.length + 1}::uuid)`); }
  vals.push(n + 1);
  const rows = await query(repoCtx(ctx), `SELECT ${QC_COLS}, to_char(${T} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_key FROM lab.qc_results WHERE ${where.join(' AND ')}
    ORDER BY ${T} DESC, id DESC LIMIT $${vals.length + 1}`, vals);
  const page = rows.slice(0, n), last = page[page.length - 1];
  return { status: 200, body: { data: page.map(qcDto), page: { limit: n, ...(rows.length > n && last ? { next_cursor: encodeCursor('qc_time', last['sort_key'], last['id']) } : {}) } } };
}

/** #44. Server sets source, entered_by, value_raw (= the DecimalString as received), received_at, idempotency_key manual:<id>, mapping_status (NULL). centre_id must be in the actor's scope. */
export async function captureQcResult(c: unknown, body: unknown): Promise<Result> {
  const ctx = specimenCtx(c);
  await role(ctx, P.capture);
  const b = strict(body, ['centre_id', 'instrument_id', 'analyte_id', 'control_id_raw', 'control_lot_raw', 'control_level', 'value_numeric', 'unit_code', 'instrument_result_time']);
  const id = (k: string): string => { const v = b[k]; if (typeof v !== 'string' || !isUuid(v)) throw bad(`/${k}`); return v.toLowerCase(); };
  const text = (k: string, min: number, max: number, required: boolean): string | null => {
    const v = b[k];
    if (v === undefined) { if (required) throw bad(`/${k}`); return null; }
    if (typeof v !== 'string' || v.length < min || v.length > max || v.includes('\u0000')) throw bad(`/${k}`);
    return v;
  };
  const centreId = id('centre_id'), instrumentId = id('instrument_id'), analyteId = id('analyte_id');
  const control = text('control_id_raw', 1, 64, true) as string, lot = text('control_lot_raw', 0, 64, false), level = text('control_level', 0, 16, false);
  const value = b['value_numeric'];
  if (typeof value !== 'string' || value.length > 40 || !DECIMAL.test(value)) throw bad('/value_numeric');
  const unit = b['unit_code'];
  if (unit !== undefined && (typeof unit !== 'string' || unit.length > 100 || !CODE_DTO.test(unit))) throw bad('/unit_code');
  const rt = b['instrument_result_time'];
  if (typeof rt !== 'string' || !ISO_MS.test(rt) || !Number.isFinite(Date.parse(rt))) throw bad('/instrument_result_time');
  const s = await scopeOf(ctx);
  if (!s.all && !s.centreIds.includes(centreId)) throw new LimsError('auth.forbidden');   // REQ-SEC-017
  const membership = ctx.actor.membershipId;
  if (!membership) throw new LimsError('auth.forbidden');
  const rid = uuidv7();
  try {
    const row = await first(repoCtx(ctx), `INSERT INTO lab.qc_results (id, tenant_id, centre_id, instrument_id, analyte_id, control_id_raw, control_lot_raw, control_level, value_raw, value_numeric, unit_code,
        instrument_result_time, received_at, source, idempotency_key, entered_by_membership_id, created_by)
      VALUES ($2, $1, $3, $4, $5, $6, $7, $8, $9::text, $9::text::numeric, $10, $11::timestamptz, $12::timestamptz, 'manual', $13, $14, $15) RETURNING ${QC_COLS}`,
    [rid, centreId, instrumentId, analyteId, control, lot, level, value, opt(unit), rt, ctx.now().toISOString(), `manual:${rid}`, membership, ctx.actor.id]);
    return { status: 201, body: qcDto(row as Obj) };
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === '23503') throw new LimsError('common.not_found');   // a centre of another tenant: indistinguishable from unknown (P-01)
    throw e;
  }
}

// [CONV] QcHoldDto has one analyte_id: the smallest of qc_holds.analyte_ids (spec gap, .orchestra/notes/C5.T-25-impl.md); held_at = created_at.
const holdDto = (r: Obj): Obj => omitNull({ id: r['id'], instrument_id: r['instrument_id'], analyte_id: [...(r['analyte_ids'] as string[])].sort()[0], status: r['status'], held_at: iso(r['created_at']),
  released_at: r['released_at'] === null ? null : iso(r['released_at']), release_comment: r['release_comment'] });
const HOLD_COLS = 'id, instrument_id, analyte_ids, status, created_at, released_at, release_comment';

/** #45 */
export async function listQcHolds(c: unknown, rawQuery: unknown): Promise<Result> {
  const ctx = specimenCtx(c);
  await role(ctx, P.read);
  const st = isObj(rawQuery) ? rawQuery['status'] : undefined;
  if (st !== undefined && st !== 'active' && st !== 'released') throw bad('/status');
  const rows = await query(repoCtx(ctx), `SELECT ${HOLD_COLS} FROM lab.qc_holds WHERE tenant_id = $1 ${st === undefined ? '' : 'AND status = $2'} ORDER BY created_at DESC, id DESC LIMIT 200`, st === undefined ? [] : [st]);
  return { status: 200, body: { data: rows.map(holdDto) } };
}

/** #46 S-16. One release wins (UPDATE ... WHERE status = 'active'); the hold's results are freed (on_hold = false; the held-id record and qc_review_required stay). */
export async function releaseQcHold(c: unknown, params: unknown, body: unknown): Promise<Result> {
  const ctx = specimenCtx(c);
  await role(ctx, P.release);   // auth.mfa_required from IdentityPort passes through (REQ-SEC-062/067)
  // lab.qc_holds is tenant-wide but lab.results is centre-RLS: a centre-scoped release would free only some results (spec silent; .orchestra/cr/C5.T-25.md).
  if (!(await scopeOf(ctx)).all) throw new LimsError('auth.forbidden');
  const id = uuidParam(params, 'hold_id');
  const b = strict(body, ['comment']);
  const comment = b['comment'];
  if (typeof comment !== 'string' || comment.length < 1 || comment.length > 500 || comment.includes('\u0000') || comment.trim() === '') throw bad('/comment');
  const membership = ctx.actor.membershipId;
  if (!membership) throw new LimsError('auth.forbidden');
  const rc = repoCtx(ctx);
  const row = await first(rc, `UPDATE lab.qc_holds SET status = 'released', released_at = $3::timestamptz, released_by_membership_id = $4, release_comment = $5, version = version + 1, updated_at = now(), updated_by = $6
      WHERE tenant_id = $1 AND id = $2 AND status = 'active' RETURNING ${HOLD_COLS}`, [id, ctx.now().toISOString(), membership, comment, ctx.actor.id]);
  if (!row) {
    if (!(await first(rc, 'SELECT 1 AS x FROM lab.qc_holds WHERE tenant_id = $1 AND id = $2', [id]))) throw new LimsError('common.not_found');
    throw new LimsError('common.version_conflict');   // already released; 409 not yet declared on #46 in lab.yaml (.orchestra/cr/C5.T-25.md)
  }
  await query(rc, `WITH t AS (SELECT id FROM lab.results WHERE tenant_id = $1 AND hold_id = $2 AND on_hold AND status NOT IN ('approved','cancelled') ORDER BY id FOR UPDATE)
    UPDATE lab.results r SET on_hold = false, version = r.version + 1, updated_at = now(), updated_by = $3 FROM t WHERE r.tenant_id = $1 AND r.id = t.id`, [id, ctx.actor.id]);
  return { status: 200, body: holdDto(row) };
}
