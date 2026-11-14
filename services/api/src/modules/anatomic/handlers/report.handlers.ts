// R1–R3 (02-TRD §5.3). Thin: the service does load -> assertRole -> guard -> validate -> write.
import type { Handler } from '../../../core/module.js';
import { getReportDraft, saveReportDraft, signOut } from '../service/report.service.js';

export const getAnatomicReportDraft: Handler = (req, ctx) => getReportDraft(ctx, req.params);
export const saveAnatomicReportDraft: Handler = (req, ctx) => saveReportDraft(ctx, req.params, req.headers, req.body);
export const signOutAnatomicCase: Handler = (req, ctx) => signOut(ctx, req.params, req.headers, req.body);
