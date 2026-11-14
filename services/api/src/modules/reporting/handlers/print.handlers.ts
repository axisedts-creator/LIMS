// R10-R13 + T5 handlers (02-TRD §6.2/§6.4; 01-PRD AC-12.1-12.4, AC-13.1). Staff only (no device / portal actors). Request context first (fail closed, echoing nothing),
// then ids (non-uuid == unknown), then the body (additionalProperties: false), then the service. Never echoes input.
import { LimsError, type FieldError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import * as S from '../service/print.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 200;                                   // REQ-SEC-100
const invalid = (path: string): LimsError => new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' } satisfies FieldError]);

function staff(hctx: HandlerContext): S.PrintCtx {
  const c = hctx as unknown as Partial<S.PrintCtx>;
  if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
  if (c.actor.type !== 'user') throw new LimsError('auth.forbidden');
  return c as S.PrintCtx;
}
const idOr404 = (req: HandlerRequest, key: string): string => {
  const v = (req.params as Record<string, unknown> | undefined)?.[key];
  if (typeof v !== 'string' || !UUID.test(v)) throw new LimsError('common.not_found');
  return v;
};
function body(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw invalid('/');
  for (const k of Object.keys(raw)) if (!allowed.includes(k)) throw invalid('/');
  return raw as Record<string, unknown>;
}
const variantOf = (b: Record<string, unknown>): 'letterhead' | 'plain' => {
  if (b['variant'] !== 'letterhead' && b['variant'] !== 'plain') throw invalid('/variant');
  return b['variant'];
};

export const printHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  createReportPrint: async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = staff(hctx); const id = idOr404(req, 'report_version_id');
    const b = body(req.body, ['variant', 'copies']); const variant = variantOf(b); const copies = b['copies'];
    if (typeof copies !== 'number' || !Number.isInteger(copies) || copies < 1 || copies > 5) throw invalid('/copies');
    return S.createReportPrint(c, id, variant, copies);
  },
  getReportPrint: async (req: HandlerRequest, hctx: HandlerContext) => { const c = staff(hctx); return S.getReportPrint(c, idOr404(req, 'print_id')); },
  downloadReportPrintPdf: async (req: HandlerRequest, hctx: HandlerContext) => { const c = staff(hctx); return S.downloadReportPrintPdf(c, idOr404(req, 'print_id')); },
  createBulkPrint: async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = staff(hctx); const b = body(req.body, ['ids', 'variant']); const variant = variantOf(b); const ids = b['ids'];
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_IDS || !ids.every((i) => typeof i === 'string' && UUID.test(i)) || new Set(ids.map((i: string) => i.toLowerCase())).size !== ids.length) throw invalid('/ids');
    return S.createBulkPrint(c, ids as string[], variant);
  },
  previewReportTemplate: async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = staff(hctx); const id = idOr404(req, 'template_id'); const variant = variantOf(body(req.body, ['variant']));
    return S.previewReportTemplate(c, id, variant);
  },
});
