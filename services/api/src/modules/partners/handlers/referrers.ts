// F1–F5 (partner) and SR1–SR3 (staff) — thin handlers over service/referrer.service.ts (T11).
import type { Handler } from '../../../core/module.js';
import { changeReferrer, createReferrer, listMappings, listReferrers, mapReferrer, rejectMapping, unmapReferrer } from '../service/referrer.service.js';

export const listPartnerReferrers: Handler = (req, ctx) => listReferrers(req, ctx);
export const createPartnerReferrer: Handler = (req, ctx) => createReferrer(req, ctx);
export const updatePartnerReferrer: Handler = (req, ctx) => changeReferrer(req, ctx, 'update');
export const deactivatePartnerReferrer: Handler = (req, ctx) => changeReferrer(req, ctx, 'deactivate');
export const reactivatePartnerReferrer: Handler = (req, ctx) => changeReferrer(req, ctx, 'reactivate');

export const listReferrerMappings: Handler = (req, ctx) => listMappings(req, ctx);
export const mapPartnerReferrer: Handler = (req, ctx) => mapReferrer(req, ctx);
export const rejectPartnerReferrerMapping: Handler = (req, ctx) => rejectMapping(req, ctx);
export const unmapPartnerReferrer: Handler = (req, ctx) => unmapReferrer(req, ctx);
