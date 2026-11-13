// R1–R2 (02-TRD §5.3). Thin: the service does load -> assertRole -> guard -> validate -> write.
import type { Handler } from '../../../core/module.js';
import { getReportDraft, saveReportDraft } from '../service/report.service.js';

export const getAnatomicReportDraft: Handler = (req, ctx) => getReportDraft(ctx, req.params);
export const saveAnatomicReportDraft: Handler = (req, ctx) => saveReportDraft(ctx, req.params, req.headers, req.body);
