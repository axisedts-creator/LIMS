// R4-R6 — thin handlers over service/access-slip.service.ts (T14).
import type { Handler } from '../../../core/module.js';
import { downloadSlip, getSlip, requestSlip } from '../service/access-slip.service.js';

export const issuePatientAccessSlip: Handler = (req, ctx) => requestSlip(req, ctx);
export const getPatientAccessSlip: Handler = (req, ctx) => getSlip(req, ctx);
export const downloadPatientAccessSlip: Handler = (req, ctx) => downloadSlip(req, ctx);
