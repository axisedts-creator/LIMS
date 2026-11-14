// R1–R3 (02-TRD §5.3) and R4–R10 (C11 T-15). Thin: the service does load -> assertRole -> guard -> validate -> write.
import type { Handler } from '../../../core/module.js';
import { createAddendum, discardChange, getVersion, listVersions, signAddendum, startChange, updateAddendumDraft } from '../service/changes.service.js';
import { getReportDraft, saveReportDraft, signOut } from '../service/report.service.js';

export const getAnatomicReportDraft: Handler = (req, ctx) => getReportDraft(ctx, req.params);
export const saveAnatomicReportDraft: Handler = (req, ctx) => saveReportDraft(ctx, req.params, req.headers, req.body);
export const signOutAnatomicCase: Handler = (req, ctx) => signOut(ctx, req.params, req.headers, req.body);

export const startAnatomicCaseChange: Handler = (req, ctx) => startChange(ctx, req.params, req.headers, req.body); // R4
export const discardAnatomicCaseChange: Handler = (req, ctx) => discardChange(ctx, req.params, req.headers); // R5
export const listAnatomicReportVersions: Handler = (req, ctx) => listVersions(ctx, req.params); // R6
export const getAnatomicReportVersion: Handler = (req, ctx) => getVersion(ctx, req.params); // R7
export const createAnatomicAddendum: Handler = (req, ctx) => createAddendum(ctx, req.params, req.headers, req.body); // R8
export const updateAnatomicAddendum: Handler = (req, ctx) => updateAddendumDraft(ctx, req.params, req.headers, req.body); // R9
export const signAnatomicAddendum: Handler = (req, ctx) => signAddendum(ctx, req.params, req.headers, req.body); // R10
