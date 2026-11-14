// M1–M3, M5, M7–M11, M13–M15 (02-TRD §5.2). Thin: the service does load -> assertRole -> guard -> validate -> write.
import type { Handler } from '../../../core/module.js';
import * as s from '../service/material.service.js';

export const createAnatomicBlocks: Handler = (req, ctx) => s.createBlocks(ctx, req.params, req.body);
export const createAnatomicSlides: Handler = (req, ctx) => s.createSlides(ctx, req.params, req.body);
export const markAnatomicSlidesReady: Handler = (req, ctx) => s.markSlidesReady(ctx, req.body);
export const saveAnatomicSlideAssessment: Handler = (req, ctx) => s.saveSlideAssessment(ctx, req.params, req.headers, req.body);
export const listAnatomicStainOrders: Handler = (req, ctx) => s.listStainOrdersQueue(ctx, req.query);
export const listAnatomicBlocks: Handler = (req, ctx) => s.listBlocksOverview(ctx, req.query);
export const createAnatomicStainOrder: Handler = (req, ctx) => s.createStainOrder(ctx, req.params, req.body);
export const startAnatomicStainOrder: Handler = (req, ctx) => s.startStainOrder(ctx, req.params, req.headers);
export const completeAnatomicStainOrder: Handler = (req, ctx) => s.completeStainOrder(ctx, req.params, req.headers, req.body);
export const cancelAnatomicStainOrder: Handler = (req, ctx) => s.cancelStainOrder(ctx, req.params, req.headers, req.body);
export const linkAnatomicAddonItem: Handler = (req, ctx) => s.linkAddonItem(ctx, req.params, req.headers, req.body);
export const recordAnatomicMovements: Handler = (req, ctx) => s.recordMovements(ctx, req.body);
export const listAnatomicBlockMovements: Handler = (req, ctx) => s.listBlockMovements(ctx, req.params, req.query);
export const listAnatomicSlideMovements: Handler = (req, ctx) => s.listSlideMovements(ctx, req.params, req.query);
export const getAnatomicLabels: Handler = (req, ctx) => s.getLabels(ctx, req.params, req.query);
