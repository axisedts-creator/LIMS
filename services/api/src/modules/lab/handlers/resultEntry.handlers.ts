// T-14 handlers: #24 bulkEnterResults, #23 getResult, #16 listOrderResults (02-TRD §5.2/§5.4; REQ-SEC-099 no stub; 07-SECURITY P-01/P-02/S-12/S-19).
// Schema, auth, x-permission and Idempotency-Key are enforced by the core pipeline from contracts/openapi/lab.yaml; these map request -> service and
// fail closed without an authenticated request context. Tenant comes from ctx only (a tenant_id in a body is never read, REQ-SEC-024).
// The store and ports come from ctx (`ctx.store`, `ctx.ports`, `ctx.events`, `ctx.audit`); the production SQL store is wired with the core pipeline (open point,
// see .orchestra/notes/C5.T-14-impl.md) — until then a ctx without them fails closed with common.internal.
// LD-25 (2026-11-07, A33-2 downtime mode): entry_mode live|downtime_backentry; back-entry needs occurred_at (<= now, >= now - max hours) and downtime_ref (1..32);
// live entry rejects both fields (no back-dating of anything else). max hours = tenant setting downtime_backentry_max_hours, DEFAULT 72 until that setting has a column.
import { LimsError, type FieldError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { toResultDto } from '../mappers/result.mapper.js';
import { labStore } from '../store/labStore.js';
import { bulkEnterResults, type EntryInput, type EntryStore, type ResultRow } from '../service/result.service.js';

const MAX_ENTRIES = 200;
const DOWNTIME_MAX_HOURS_DEFAULT = 72;
const DOWNTIME_REF_MAX = 32;
const HOUR_MS = 3_600_000;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

type Obj = Record<string, any>;
interface Ports { IdentityPort: { assertRole(ctx: unknown, r: { permission: string; centreId?: string }): Promise<void> } }
interface OrderResults { order: unknown; centreId: string; items: { orderItemId: string; testId: string; testCode: string; results: ResultRow[] }[] }
type ReadStore = EntryStore & { getOrderResults(tx: unknown, tenantId: string, a: { orderId: string; departmentId?: string }): Promise<OrderResults | undefined> };
interface Ctx extends HandlerContext { tenantId: string; actor: { id: string }; tx: object; now?: () => Date; store?: ReadStore; ports?: Ports; audit?: { access(e: Obj): Promise<void> } }

export const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});

export function authed(h: HandlerContext): Ctx {
  const c = h as Partial<Ctx>;
  if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
  if (!c.ports?.IdentityPort) throw new LimsError('common.internal');   // fail closed: port wiring missing (no port is invented)
  return withStore(c) as Ctx;
}

/** LD-124 (2026-11-12): ctx.store ?? labStore(ctx.tx, ctx) — a view of the ctx (prototype = ctx), the caller's object is not mutated. */
export const withStore = <C extends object>(c: C): C => ((c as { store?: unknown }).store ? c : Object.assign(Object.create(c), { store: labStore((c as any).tx, c as never) }));

export const fieldError = (path: string, code: 'common.field_required' | 'common.field_invalid', message: string): FieldError => ({ path, code, message });

/** LD-25: returns the downtime block for the service (original strings, unchanged) or undefined for a live entry. Throws 400 common.validation_failed at the field path. */
function downtimeOf(b: Obj, now: Date): { occurredAt: string; downtimeRef: string } | undefined {
  const errors: FieldError[] = [];
  const mode = b['entry_mode'];
  if (mode !== undefined && mode !== 'live' && mode !== 'downtime_backentry') errors.push(fieldError('/entry_mode', 'common.field_invalid', 'entry_mode must be live or downtime_backentry'));
  const back = mode === 'downtime_backentry';
  const at = b['occurred_at'], ref = b['downtime_ref'];
  if (mode === 'live' || mode === undefined) {
    if (at !== undefined) errors.push(fieldError('/occurred_at', 'common.field_invalid', 'occurred_at is only allowed for downtime_backentry'));
    if (ref !== undefined) errors.push(fieldError('/downtime_ref', 'common.field_invalid', 'downtime_ref is only allowed for downtime_backentry'));
  }
  if (back) {
    if (at === undefined) errors.push(fieldError('/occurred_at', 'common.field_required', 'occurred_at is required for downtime_backentry'));
    else {
      const t = typeof at === 'string' && ISO_INSTANT.test(at) ? Date.parse(at) : Number.NaN;
      if (Number.isNaN(t)) errors.push(fieldError('/occurred_at', 'common.field_invalid', 'occurred_at must be an ISO instant'));
      else if (t > now.getTime()) errors.push(fieldError('/occurred_at', 'common.field_invalid', 'occurred_at must not be in the future'));
      else if (t < now.getTime() - DOWNTIME_MAX_HOURS_DEFAULT * HOUR_MS) errors.push(fieldError('/occurred_at', 'common.field_invalid', 'occurred_at is older than the downtime back-entry window'));
    }
    if (ref === undefined) errors.push(fieldError('/downtime_ref', 'common.field_required', 'downtime_ref is required for downtime_backentry'));
    else if (typeof ref !== 'string' || ref.length < 1 || ref.length > DOWNTIME_REF_MAX) errors.push(fieldError('/downtime_ref', 'common.field_invalid', `downtime_ref must be 1..${DOWNTIME_REF_MAX} characters`));
  }
  if (errors.length > 0) throw new LimsError('common.validation_failed', undefined, errors);
  return back ? { occurredAt: at as string, downtimeRef: ref as string } : undefined;
}

const bulkEnter: Handler = async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
  const ctx = authed(hctx);
  const b = obj(req.body);
  const raw = b['entries'];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ENTRIES) {
    throw new LimsError('common.validation_failed', undefined, [fieldError('/entries', 'common.field_invalid', `entries must hold 1..${MAX_ENTRIES} items`)]);
  }
  const downtime = downtimeOf(b, (ctx.now ?? (() => new Date()))());
  const entries: EntryInput['entries'][number][] = raw.map((x, n) => {
    const e = obj(x);
    // lab.yaml: value_numeric is a DecimalString, value_text / ordinal_code strings; anything else is a 400 at the field (never reaches the evaluator).
    for (const k of ['value_numeric', 'value_text', 'ordinal_code']) {
      if (e[k] !== undefined && typeof e[k] !== 'string') throw new LimsError('common.validation_failed', undefined, [fieldError(`/entries/${n}/${k}`, 'common.field_invalid', 'Field invalid')]);
    }
    return {
      resultId: e['result_id'], version: e['version'],
      ...(e['value_numeric'] === undefined ? {} : { valueNumeric: e['value_numeric'] }),
      ...(e['value_text'] === undefined ? {} : { valueText: e['value_text'] }),
      ...(e['ordinal_code'] === undefined ? {} : { ordinalCode: e['ordinal_code'] }),
      ...(e['manual_abnormal'] === undefined ? {} : { manualAbnormal: e['manual_abnormal'] }),
      ...(e['comment_codes'] === undefined ? {} : { commentCodes: e['comment_codes'] }),
      ...(e['comment_text'] === undefined ? {} : { commentText: e['comment_text'] }),
    };
  });
  const out = await bulkEnterResults(ctx, { entries, ...(downtime === undefined ? {} : { downtime }) });
  return {
    status: 200,
    body: {
      results: out.results.map((r) => ({ result_id: r.resultId, outcome: r.outcome, ...(r.code === undefined ? {} : { code: r.code }), ...(r.result === undefined ? {} : { result: toResultDto(r.result) }) })),
      recomputed: out.recomputed.map(toResultDto),
    },
  };
};

/** P-02: a centre the caller lacks is reported as not found, never 403. */
async function assertRead(ctx: Ctx, centreId: string | undefined): Promise<void> {
  try { await (ctx.ports as Ports).IdentityPort.assertRole(ctx, { permission: 'lab.result.read', ...(centreId === undefined ? {} : { centreId }) }); }
  catch (e) { throw e instanceof LimsError && e.code === 'auth.forbidden' ? new LimsError('common.not_found') : e; }
}

const getResult: Handler = async (req, hctx) => {
  const ctx = authed(hctx);
  const id = obj(req.params)['result_id'];
  const row = (await (ctx.store as ReadStore).getResults(ctx.tx, ctx.tenantId, [id]))[0];
  if (!row) throw new LimsError('common.not_found');   // P-01: unknown / other tenant / invisible
  // authz after the object load (P-02); 08 A13 D-13 hub lab: the processing centre also sees the result (T-32 P-12)
  try { await assertRead(ctx, row['centre_id']); }
  catch (e) { if (!(e instanceof LimsError && e.code === 'common.not_found' && typeof row['processing_centre_id'] === 'string')) throw e; await assertRead(ctx, row['processing_centre_id']); }
  return { status: 200, body: toResultDto(row) };
};

const listOrderResults: Handler = async (req, hctx) => {
  const ctx = authed(hctx);
  const orderId = obj(req.params)['order_id'];
  const dept = obj(req.query)['department_id'];
  const r = await (ctx.store as ReadStore).getOrderResults(ctx.tx, ctx.tenantId, { orderId, ...(dept === undefined ? {} : { departmentId: dept }) });
  if (!r) throw new LimsError('common.not_found');     // P-01
  await assertRead(ctx, r.centreId);                   // the order's own centre (store fills it from the order row), even when no result rows exist (P-02)
  // 02-TRD §11 "Access log" #16 (D-11): one row per call, ids only (REQ-SEC-006); after authz so a refused caller writes no row.
  await (ctx.audit as NonNullable<Ctx['audit']>).access({ action: 'lab_result.view', entityType: 'order', entityId: orderId, centreId: r.centreId, outcome: 'allowed' });
  return {
    status: 200,
    body: { order: r.order, items: r.items.map((i) => ({ order_item_id: i.orderItemId, test: { test_id: i.testId, test_code: i.testCode }, results: i.results.map(toResultDto) })) },
  };
};

export const resultEntryHandlers: Readonly<Record<'bulkEnterResults' | 'getResult' | 'listOrderResults', Handler>> = Object.freeze({
  bulkEnterResults: bulkEnter, getResult, listOrderResults,
});
