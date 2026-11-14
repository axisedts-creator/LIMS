// K1–K12, K20–K22 (02-TRD §5.6). Thin: the service does assertRole -> validate -> write.
import type { Handler } from '../../../core/module.js';
import * as s from '../service/config.service.js';

export const getAnatomicSettings: Handler = (_req, ctx) => s.getSettings(ctx);
export const updateAnatomicSettings: Handler = (req, ctx) => s.updateSettings(ctx, req.headers, req.body);
export const listAnatomicStains: Handler = (req, ctx) => s.listStains(ctx, req.query);
export const createAnatomicStain: Handler = (req, ctx) => s.createStain(ctx, req.body);
export const updateAnatomicStain: Handler = (req, ctx) => s.updateStain(ctx, req.params, req.headers, req.body);
export const listAnatomicTestProfiles: Handler = (_req, ctx) => s.listTestProfiles(ctx);
export const upsertAnatomicTestProfile: Handler = (req, ctx) => s.upsertTestProfile(ctx, req.params, req.headers, req.body);
export const listAnatomicAssays: Handler = (req, ctx) => s.listAssays(ctx, req.query);
export const createAnatomicAssay: Handler = (req, ctx) => s.createAssay(ctx, req.body);
export const updateAnatomicAssay: Handler = (req, ctx) => s.updateAssay(ctx, req.params, req.headers, req.body);
export const listAnatomicCodedValues: Handler = (req, ctx) => s.listCodedValues(ctx, req.params, req.query);
export const upsertAnatomicCodedValue: Handler = (req, ctx) => s.upsertCodedValue(ctx, req.params, req.headers, req.body);
export const listAnatomicTextTemplates: Handler = (req, ctx) => s.listTextTemplates(ctx, req.query);
export const createAnatomicTextTemplate: Handler = (req, ctx) => s.createTextTemplate(ctx, req.body);
export const updateAnatomicTextTemplate: Handler = (req, ctx) => s.updateTextTemplate(ctx, req.params, req.headers, req.body);
