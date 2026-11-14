// K13–K19 (02-TRD §5.6). Thin: the service does assertRole -> validate -> write.
import type { Handler } from '../../../core/module.js';
import * as s from '../service/synoptic.service.js';

export const listAnatomicSynopticTemplates: Handler = (req, ctx) => s.listTemplates(ctx, req.query);
export const createAnatomicSynopticTemplate: Handler = (req, ctx) => s.createTemplate(ctx, req.body);
export const getAnatomicSynopticTemplate: Handler = (req, ctx) => s.getTemplate(ctx, req.params);
export const updateAnatomicSynopticTemplate: Handler = (req, ctx) => s.updateTemplate(ctx, req.params, req.headers, req.body);
export const publishAnatomicSynopticTemplate: Handler = (req, ctx) => s.publishTemplate(ctx, req.params, req.headers);
export const retireAnatomicSynopticTemplate: Handler = (req, ctx) => s.retireTemplate(ctx, req.params, req.headers);
export const createAnatomicSynopticTemplateVersion: Handler = (req, ctx) => s.createTemplateVersion(ctx, req.params);
