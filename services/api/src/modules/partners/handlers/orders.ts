// O1–O3 — thin handlers over service/tracking.service.ts (T13).
import type { Handler } from '../../../core/module.js';
import { getOrder, listOrders, searchOrders } from '../service/tracking.service.js';

export const listPartnerOrders: Handler = (req, ctx) => listOrders(req, ctx);
export const searchPartnerOrders: Handler = (req, ctx) => searchOrders(req, ctx);
export const getPartnerOrder: Handler = (req, ctx) => getOrder(req, ctx);
