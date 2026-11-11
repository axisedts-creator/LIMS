// T-16 handlers: #27 verifyResult, #28 bulkVerifyResults, #29 returnResult (02-TRD §5.4; AC-12.3, AC-15.1–15.4; 07-SECURITY P-01/P-02/P-04, S-03, S-19; REQ-SEC-099 no stub).
// Schema, auth, x-permission and Idempotency-Key are enforced by the core pipeline from contracts/openapi/lab.yaml; these map request -> service.
// Only the documented body fields are read (S-03, REQ-SEC-024): a value / tenant / verified_by field in a body never reaches the service. Tenant comes from ctx.
import { LimsError } from '../../../core/errors.js';
import type { Handler } from '../../../core/module.js';
import { toResultDto } from '../mappers/result.mapper.js';
import { bulkVerifyResults, returnResult, verifyResult, type VerifyItem } from '../service/result.service.js';
import { authed, fieldError, obj } from './resultEntry.handlers.js';

export const MAX_ITEMS = 200;
const FLAGS = ['delta', 'critical', 'unit_mismatch', 'instrument_flag'];
export const MAX_VERSION = 2_147_483_647;
export const invalid = (path: string) => new LimsError('common.validation_failed', undefined, [fieldError(path, 'common.field_invalid', 'Field invalid')]);

/** If-Match: "<n>" (as specimen.service.ts): missing -> 428, malformed -> 400 /headers/if-match. */
export function ifMatch(headers: unknown): number {
  const h = obj(headers)['if-match'];
  if (h === undefined) throw new LimsError('common.precondition_required');
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  if (!m || Number(m[1]) > MAX_VERSION) throw invalid('/headers/if-match');
  return Number(m[1]);
}
const flagsOf = (v: unknown, path: string): string[] | undefined => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((f) => typeof f !== 'string' || !FLAGS.includes(f))) throw invalid(path);
  return v as string[];
};
export const resultId = (params: unknown): string => {
  const v = obj(params)['result_id'];
  if (typeof v !== 'string' || v === '') throw invalid('/result_id');
  return v;
};

const verify: Handler = async (req, hctx) => {
  const ctx = authed(hctx);
  const flags = flagsOf(obj(req.body)['acknowledged_flags'], '/acknowledged_flags');
  const row = await verifyResult(ctx, { resultId: resultId(req.params), version: ifMatch(req.headers), ...(flags === undefined ? {} : { acknowledgedFlags: flags }) });
  return { status: 200, body: toResultDto(row) };
};

const bulkVerify: Handler = async (req, hctx) => {
  const ctx = authed(hctx);
  const raw = obj(req.body)['items'];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ITEMS) throw invalid('/items');
  const items: VerifyItem[] = raw.map((x, i) => {
    const it = obj(x);
    const { id, version } = { id: it['id'], version: it['version'] };
    if (typeof id !== 'string' || id === '') throw invalid(`/items/${i}/id`);
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > MAX_VERSION) throw invalid(`/items/${i}/version`);
    const flags = flagsOf(it['acknowledged_flags'], `/items/${i}/acknowledged_flags`);
    return { resultId: id, version, ...(flags === undefined ? {} : { acknowledgedFlags: flags }) };
  });
  const out = await bulkVerifyResults(ctx, { items });
  return {
    status: 200,
    body: { results: out.results.map((r) => ({ id: r.resultId, outcome: r.outcome, ...(r.code === undefined ? {} : { code: r.code }), ...(r.result === undefined ? {} : { result: toResultDto(r.result) }) })) },
  };
};

const doReturn: Handler = async (req, hctx) => {
  const ctx = authed(hctx);
  const b = obj(req.body);
  const code = b['reason_code'], comment = b['comment'];
  if (typeof code !== 'string' || code.length < 1 || code.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(code)) throw invalid('/reason_code');
  if (comment !== undefined && (typeof comment !== 'string' || comment.length > 500)) throw invalid('/comment');
  const row = await returnResult(ctx, { resultId: resultId(req.params), version: ifMatch(req.headers), reasonCode: code, ...(comment === undefined ? {} : { comment }) });
  return { status: 200, body: toResultDto(row) };
};

export const verifyHandlers: Readonly<Record<'verifyResult' | 'bulkVerifyResults' | 'returnResult', Handler>> = Object.freeze({
  verifyResult: verify, bulkVerifyResults: bulkVerify, returnResult: doReturn,
});
