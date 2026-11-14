// A8–A11 (02-TRD §5.1). Thin: the service does load -> assertRole -> guard -> validate -> write.
import type { Handler } from '../../../core/module.js';
import { cancelCase, markReady, saveGross, startProcessing } from '../service/gross.service.js';

export const saveAnatomicGross: Handler = (req, ctx) => saveGross(ctx, req.params, req.headers, req.body);
export const startAnatomicProcessing: Handler = (req, ctx) => startProcessing(ctx, req.params, req.headers);
export const markAnatomicCaseReady: Handler = (req, ctx) => markReady(ctx, req.params, req.headers);
export const cancelAnatomicCase: Handler = (req, ctx) => cancelCase(ctx, req.params, req.headers, req.body);
