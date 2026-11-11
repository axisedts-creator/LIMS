// T-17 handlers: #30 approveResult, #31 bulkApproveResults, #32 amendResult, #33 listResultVersions (02-TRD §5.4; AC-16.1–AC-16.3, AC-17.1–AC-17.4; 07-SECURITY S-01..S-04, S-19, P-01/P-02; 08 A13 P-1; REQ-SEC-099 no stub).
// Schema, auth, x-permission and Idempotency-Key are enforced by the core pipeline from contracts/openapi/lab.yaml; these map request -> service.
// Only the documented body fields are read (S-03, REQ-SEC-024): approve takes no body at all; a tenant / approver / version field never reaches the service. Tenant comes from ctx.
import { LimsError } from '../../../core/errors.js';
import type { Handler } from '../../../core/module.js';
import { toResultDto, toResultVersionDto } from '../mappers/result.mapper.js';
import { amendResult, approveResult, bulkApproveResults, listResultVersions, type AmendInput } from '../service/result.service.js';
import { authed, obj } from './resultEntry.handlers.js';
import { ifMatch, invalid, MAX_ITEMS, MAX_VERSION, resultId } from './verify.handlers.js';

// 08 A13 P-1 / S-21: C5 accepts these only through the module submit path (SubmitModuleResult), never on the public amend endpoint.
const MODULE_ONLY_REASONS = new Set(['module_phase_progression', 'module_preliminary_update', 'supplementary_report']);
/** `detail` repeats the path (fixed text, never a submitted value) so the field is named even where only the detail is read. */
const badField = (path: string) => new LimsError('common.validation_failed', `Invalid field ${path}`, [{ path, code: 'common.field_invalid', message: 'Field invalid' }]);
const str = (v: unknown, path: string, max: number): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > max) throw badField(path);
  return v;
};

const approve: Handler = async (req, hctx) => {
  const ctx = authed(hctx);
  const row = await approveResult(ctx, { resultId: resultId(req.params), version: ifMatch(req.headers) });
  return { status: 200, body: toResultDto(row) };
};

const bulkApprove: Handler = async (req, hctx) => {
  const ctx = authed(hctx);
  const raw = obj(req.body)['items'];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ITEMS) throw invalid('/items');
  const items = raw.map((x, i) => {
    const { id, version } = { id: obj(x)['id'], version: obj(x)['version'] };
    if (typeof id !== 'string' || id === '') throw invalid(`/items/${i}/id`);
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > MAX_VERSION) throw invalid(`/items/${i}/version`);
    return { resultId: id, version };
  });
  const out = await bulkApproveResults(ctx, { items });
  return {
    status: 200,
    body: { results: out.results.map((r) => ({ id: r.resultId, outcome: r.outcome, ...(r.code === undefined ? {} : { code: r.code }), ...(r.result === undefined ? {} : { result: toResultDto(r.result) }) })) },
  };
};

const amend: Handler = async (req, hctx) => {
  const ctx = authed(hctx);
  const id = resultId(req.params), version = ifMatch(req.headers);
  const b = obj(req.body);
  const [num, txt, ord] = [str(b['value_numeric'], '/value_numeric', 64), str(b['value_text'], '/value_text', 2000), str(b['ordinal_code'], '/ordinal_code', 16)];
  const codes = b['comment_codes'];
  if (codes !== undefined && (!Array.isArray(codes) || codes.length > 10 || codes.some((c) => typeof c !== 'string' || c.length < 1 || c.length > 100))) throw badField('/comment_codes');
  const [commentText, reasonCode, reasonText] = [str(b['comment_text'], '/comment_text', 1000), str(b['amendment_reason_code'], '/amendment_reason_code', 100), str(b['amendment_reason_text'], '/amendment_reason_text', 500)];
  if (reasonCode !== undefined && MODULE_ONLY_REASONS.has(reasonCode)) throw badField('/amendment_reason_code');   // before any store access
  const value = { ...(num === undefined ? {} : { numeric: num }), ...(txt === undefined ? {} : { text: txt }), ...(ord === undefined ? {} : { ordinalCode: ord }) };
  const input: AmendInput = {
    resultId: id, version, reasonCode,   // absent -> the service answers lab.amendment_reason_required (AC-17.3)
    ...(Object.keys(value).length === 0 ? {} : { value }),
    ...(codes === undefined ? {} : { commentCodes: codes as string[] }), ...(commentText === undefined ? {} : { commentText }), ...(reasonText === undefined ? {} : { reasonText }),
  };
  return { status: 200, body: toResultDto(await amendResult(ctx, input)) };
};

const versions: Handler = async (req, hctx) => {
  const ctx = authed(hctx);
  const rows = await listResultVersions(ctx, { resultId: resultId(req.params) });
  return { status: 200, body: { data: rows.map(toResultVersionDto) } };
};

export const approveHandlers: Readonly<Record<'approveResult' | 'bulkApproveResults' | 'amendResult' | 'listResultVersions', Handler>> = Object.freeze({
  approveResult: approve, bulkApproveResults: bulkApprove, amendResult: amend, listResultVersions: versions,
});
