// K1–K4 (partner) and SP1–SP4 (staff) — thin handlers over service/pickup.service.ts (T15).
import type { Handler } from '../../../core/module.js';
import { cancelOwn, createPickup, getOwn, listInbound, listOwn, markCollected, reject, schedule } from '../service/pickup.service.js';

export const createPickupRequest: Handler = (req, ctx) => createPickup(req, ctx);
export const listPickupRequests: Handler = (req, ctx) => listOwn(req, ctx);
export const getPickupRequest: Handler = (req, ctx) => getOwn(req, ctx);
export const cancelPickupRequest: Handler = (req, ctx) => cancelOwn(req, ctx);

export const listInboundPickups: Handler = (req, ctx) => listInbound(req, ctx);
export const schedulePickup: Handler = (req, ctx) => schedule(req, ctx);
export const markPickupCollected: Handler = (req, ctx) => markCollected(req, ctx);
export const rejectPickup: Handler = (req, ctx) => reject(req, ctx);
