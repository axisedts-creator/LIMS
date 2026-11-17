// T-19 handlers: #25 getResultHistory, #26 getAnalyteTrend (02-TRD §5.4 rows 25/26; PRD AC-11.1-11.3; 07-SECURITY P-01 (+ #26 exception), P-02, S-22; REQ-SEC-099 no stub).
// Schema, auth and x-permission are enforced by the core pipeline from contracts/openapi/lab.yaml; these re-check `limit`, never trust the store and map rows to the closed
// ResultHistory / AnalyteTrend allowlists. Tenant comes from ctx only; patient/analyte come from the STORED result (#25) or the path (#26), never from query/body (AC-11.3).
// Store seam: ctx.store.getResults (T-14) + ctx.store.listResultHistory(tx, tenantId, { patientId, analyteId, limit }) = repository/results.repo.ts listResultHistory.
// [CONV] #25 newest first, #26 oldest -> newest (chart order); #26 plots numeric values only; every point keeps its OWN unit_code (unit separation, nothing converted/merged);
// reference_band = newest plotted point's snapshot (unit falls back to that point's unit; omitted without a bound or unit). Approved rows read cur_* (latest version).
import { LimsError, type FieldError } from '../../../core/errors.js';
import type { Handler, HandlerContext } from '../../../core/module.js';
import { withStore } from './resultEntry.handlers.js';

type Obj = Record<string, any>;
interface Store {
  getResults(tx: unknown, tenantId: string, ids: string[]): Promise<Obj[]>;
  listResultHistory(tx: unknown, tenantId: string, a: { patientId: string; analyteId: string; limit: number }): Promise<Obj[]>;
}
interface Ctx extends HandlerContext {
  tenantId: string; actor: { id: string }; tx: object; store?: Store;
  ports?: { IdentityPort: { assertRole(ctx: unknown, r: { permission: string; centreId?: string }): Promise<void> } };
  audit?: { access(e: Obj): Promise<void> };
}

export const HISTORY_ACTION = 'lab_result_history.view';
const HISTORY = { def: 5, max: 20 }, TREND = { def: 50, max: 50 };

const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const present = (v: unknown): boolean => v !== null && v !== undefined;
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const time = (v: unknown): number => (v instanceof Date ? v.getTime() : Date.parse(String(v)));

function authed(h: HandlerContext, needIdentity: boolean): Ctx {
  const c = h as Partial<Ctx>;
  if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
  if (!c.audit || (needIdentity && !c.ports?.IdentityPort)) throw new LimsError('common.internal');   // fail closed: audit / port wiring missing
  return withStore(c) as Ctx;   // LD-124: ctx.store ?? labStore(ctx.tx, ctx)
}

function limitOf(q: Obj, b: { def: number; max: number }): number {
  const raw = q['limit'];
  if (raw === undefined) return b.def;
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > b.max) {
    const e: FieldError = { path: '/limit', code: 'common.field_invalid', message: `limit must be an integer 1..${b.max}` };
    throw new LimsError('common.validation_failed', undefined, [e]);
  }
  return n;
}

/** approved rows read the LATEST version (cur_<col> from lab.v_result_current) when the view supplied it. */
const pick = (r: Obj, col: string): unknown => (`cur_${col}` in r ? r[`cur_${col}`] : r[col]);

/** the store is not trusted (AC-11.3): keep approved rows of this tenant/patient/analyte only, newest first, at most `limit`. */
function scoped(rows: Obj[], c: Ctx, patientId: string, analyteId: string, limit: number): Obj[] {
  return rows
    .filter((r) => r['tenant_id'] === c.tenantId && r['patient_id'] === patientId && r['analyte_id'] === analyteId && r['status'] === 'approved')
    .sort((a, b) => time(b['approved_at']) - time(a['approved_at']) || String(a['id']).localeCompare(String(b['id'])))
    .slice(0, limit);
}

const getResultHistory: Handler = async (req, hctx) => {
  const c = authed(hctx, true);
  const limit = limitOf(obj(req.query), HISTORY);
  const store = c.store as Store;
  const id = obj(req.params)['result_id'] as string;
  const base = (await store.getResults(c.tx, c.tenantId, [id]))[0];
  if (!base || base['tenant_id'] !== c.tenantId) throw new LimsError('common.not_found');   // P-01
  try { await c.ports!.IdentityPort.assertRole(c, { permission: 'lab.result.read', ...(present(base['centre_id']) ? { centreId: base['centre_id'] } : {}) }); }
  catch (e) { throw e instanceof LimsError && e.code === 'auth.forbidden' ? new LimsError('common.not_found') : e; }   // P-02: 404, never 403
  const patientId = base['patient_id'], analyteId = base['analyte_id'];
  const rows = scoped(await store.listResultHistory(c.tx, c.tenantId, { patientId, analyteId, limit }), c, patientId, analyteId, limit);
  const data = rows.map((r) => {
    const d: Obj = { result_id: r['id'], approved_at: iso(r['approved_at']), value: String(pick(r, 'value_numeric') ?? pick(r, 'value_text') ?? pick(r, 'ordinal_code') ?? '') };
    if (present(pick(r, 'unit_code'))) d['unit_code'] = pick(r, 'unit_code');
    if (present(pick(r, 'flag'))) d['flag'] = pick(r, 'flag');
    d['version_no'] = r['current_version_no'];
    return d;
  });
  await (c.audit as NonNullable<Ctx['audit']>).access({ action: HISTORY_ACTION, entityType: 'result', entityId: id, ...(present(base['centre_id']) ? { centreId: base['centre_id'] } : {}), outcome: 'allowed' });
  return { status: 200, body: { data } };
};

const getAnalyteTrend: Handler = async (req, hctx) => {
  const c = authed(hctx, false);
  const limit = limitOf(obj(req.query), TREND);
  const p = obj(req.params), patientId = p['patient_id'] as string, analyteId = p['analyte_id'] as string;
  // P-01 exception: unknown / other-tenant patient is an empty 200, identical to a patient without history (no existence oracle).
  const rows = scoped(await (c.store as Store).listResultHistory(c.tx, c.tenantId, { patientId, analyteId, limit }), c, patientId, analyteId, limit)
    .filter((r) => present(pick(r, 'value_numeric')));
  const points = rows.map((r) => {
    const d: Obj = { result_id: r['id'], at: iso(r['approved_at']), value: String(pick(r, 'value_numeric')) };
    if (present(pick(r, 'unit_code'))) d['unit_code'] = pick(r, 'unit_code');
    if (present(pick(r, 'flag'))) d['flag'] = pick(r, 'flag');
    return d;
  }).reverse();   // chronological for charting
  const body: Obj = { points };
  const newest = rows[0];
  if (newest) {
    const low = pick(newest, 'ref_low'), high = pick(newest, 'ref_high');
    const unit = pick(newest, 'ref_unit_code') ?? pick(newest, 'unit_code');
    if ((present(low) || present(high)) && present(unit)) {
      body['reference_band'] = { ...(present(low) ? { low: String(low) } : {}), ...(present(high) ? { high: String(high) } : {}), unit_code: unit };
    }
  }
  // the path id is caller-supplied: core access() takes entity_id as a UUIDv7 only, so any other well-formed id is kept in detail instead of failing the read (T-32 P-01 #26).
  const v7 = typeof patientId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(patientId);
  await (c.audit as NonNullable<Ctx['audit']>).access({ action: HISTORY_ACTION, entityType: 'patient', outcome: 'allowed',
    ...(v7 ? { entityId: patientId } : typeof patientId === 'string' && patientId.length <= 64 ? { detail: { patient_id: patientId } } : {}) });
  return { status: 200, body };
};

export const historyHandlers: Readonly<Record<'getResultHistory' | 'getAnalyteTrend', Handler>> = Object.freeze({ getResultHistory, getAnalyteTrend });
