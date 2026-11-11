// T-23 handlers: #38 listIngestExceptions, #39 getIngestException, #40 assignIngestException, #41 reapplyIngestException, #42 discardIngestException
// (02-TRD §5.6, §11; REQ-SEC-099 no stub; P-01/P-03/P-07). Schema, auth, x-permission and Idempotency-Key are enforced by the core pipeline from contracts/openapi/lab.yaml;
// these map request -> service -> DTO. Tenant and actor come from ctx only (no body field names them, REQ-SEC-024). A ctx without store / audit fails closed (common.internal).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext } from '../../../core/module.js';
import { toResultDto } from '../mappers/result.mapper.js';
import { withStore } from './resultEntry.handlers.js';
import {
  assignIngestException, discardIngestException, getIngestException, listIngestExceptions, reapplyIngestException, type ExceptionCtx, type ExceptionListQuery, type ExceptionRow,
} from '../service/exception.service.js';

type Obj = Record<string, any>;
const DEFAULT_LIMIT = 50;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const present = (v: unknown): boolean => v !== null && v !== undefined;
const iso = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : undefined);
const put = (o: Obj, k: string, v: unknown): void => { if (present(v)) o[k] = v; };   // absent values are omitted, never null

function authed(h: HandlerContext): ExceptionCtx {
  const c = h as Partial<ExceptionCtx>;
  if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
  if (!c.audit) throw new LimsError('common.internal');   // fail closed: audit wiring missing
  return withStore(c) as ExceptionCtx;   // LD-124: ctx.store ?? labStore(ctx.tx, ctx)
}

/** lab.yaml IngestExceptionDto (allowlist: no tenant / actor ids, raw value, flags, attachment, comment or discard reason). */
function toDto(r: ExceptionRow): Obj {
  const d: Obj = { id: r['id'], status: r['status'], reason: r['reason'], result_key: r['result_key'], created_at: iso(r['created_at']) };
  put(d, 'instrument_id', r['instrument_id']); put(d, 'sample_barcode', r['sample_barcode']); put(d, 'instrument_analyte_code', r['instrument_analyte_code']);
  put(d, 'result_id', r['result_id']); put(d, 'resolved_at', iso(r['resolved_at'])); put(d, 'resolution', r['resolution']);
  return d;
}
/** IngestExceptionDetail = the DTO + the P3 fields (only #39 returns them, access-logged). */
function toDetail(r: ExceptionRow): Obj {
  const d = toDto(r);
  put(d, 'raw_value', r['value_raw']);
  if (Array.isArray(r['instrument_flags']) && r['instrument_flags'].length > 0) d['raw_flags'] = r['instrument_flags'];
  put(d, 'unit_raw', r['unit_raw']);
  return d;
}

const list: Handler = async (req, hctx) => {
  const ctx = authed(hctx);
  const q = obj(req.query);
  const limit = q['limit'] === undefined ? DEFAULT_LIMIT : Number(q['limit']);
  const query: ExceptionListQuery = {
    status: q['status'] ?? 'open', limit,
    ...(typeof q['reason'] === 'string' && q['reason'] !== '' ? { reasons: q['reason'].split(',') } : {}),
    ...(q['instrument_id'] === undefined ? {} : { instrumentId: q['instrument_id'] }),
    ...(q['cursor'] === undefined ? {} : { cursor: q['cursor'] }),
  };
  const out = await listIngestExceptions(ctx, query);
  return { status: 200, body: { data: out.rows.map(toDto), page: { limit, ...(out.nextCursor === undefined ? {} : { next_cursor: out.nextCursor }) } } };
};

const get: Handler = async (req, hctx) => {
  const ctx = authed(hctx);
  return { status: 200, body: toDetail(await getIngestException(ctx, obj(req.params)['exception_id'])) };
};

const assign: Handler = async (req, hctx) => {
  const ctx = authed(hctx);
  const b = obj(req.body);
  const out = await assignIngestException(ctx, obj(req.params)['exception_id'], { resultId: b['result_id'], overrideAnalyte: b['override_analyte'] });
  return { status: 200, body: { exception: toDto(out.exception), outcome: out.outcome, ...(out.result === undefined ? {} : { result: toResultDto(out.result) }) } };
};

const reapply: Handler = async (req, hctx) => {
  const ctx = authed(hctx);
  const out = await reapplyIngestException(ctx, obj(req.params)['exception_id']);
  return { status: 200, body: { exception: toDto(out.exception), outcome: out.outcome } };
};

const discard: Handler = async (req, hctx) => {
  const ctx = authed(hctx);
  const b = obj(req.body);
  const row = await discardIngestException(ctx, obj(req.params)['exception_id'], { reasonCode: b['reason_code'], ...(b['comment'] === undefined ? {} : { comment: b['comment'] }) });
  return { status: 200, body: toDto(row) };
};

export const ingestExceptionHandlers: Readonly<Record<'listIngestExceptions' | 'getIngestException' | 'assignIngestException' | 'reapplyIngestException' | 'discardIngestException', Handler>> = Object.freeze({
  listIngestExceptions: list, getIngestException: get, assignIngestException: assign, reapplyIngestException: reapply, discardIngestException: discard,
});
