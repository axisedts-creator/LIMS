// T0B-REGAPI-2: 17 of the 18 operations added by T0C-REGPARITY-2 (the 18th, previewRegistrationNumbers, has its own file).
// [CONV] grouped in one file instead of handlers/<operationId>.ts each: the task brief caps the task at 24 files. Each export is a thin call into service/parity.service.ts.
import type { Handler } from '../../../core/module.js';
import * as s from '../service/parity.service.js';

export const createRegistrationDraft: Handler = (req, ctx) => s.createRegistrationDraft(ctx, req.body);
export const listRegistrationDrafts: Handler = (req, ctx) => s.listRegistrationDrafts(ctx, req.query);
export const getRegistrationDraft: Handler = (req, ctx) => s.getRegistrationDraft(ctx, req.params);
export const deleteRegistrationDraft: Handler = (req, ctx) => s.deleteRegistrationDraft(ctx, req.params);
export const addFavouriteTest: Handler = (req, ctx) => s.addFavouriteTest(ctx, req.body);
export const listFavouriteTests: Handler = (req, ctx) => s.listFavouriteTests(ctx, req.query);
export const removeFavouriteTest: Handler = (req, ctx) => s.removeFavouriteTest(ctx, req.params);
export const listCustomFieldDefinitions: Handler = (req, ctx) => s.listCustomFieldDefinitions(ctx, req.query);
export const createCustomFieldDefinition: Handler = (req, ctx) => s.createCustomFieldDefinition(ctx, req.body);
export const updateCustomFieldDefinition: Handler = (req, ctx) => s.updateCustomFieldDefinition(ctx, req.params, req.headers, req.body);
export const listCoupons: Handler = (req, ctx) => s.listCoupons(ctx, req.query);
export const createCoupon: Handler = (req, ctx) => s.createCoupon(ctx, req.body);
export const updateCoupon: Handler = (req, ctx) => s.updateCoupon(ctx, req.params, req.headers, req.body);
export const listIcdCodes: Handler = (req, ctx) => s.listIcdCodes(ctx, req.query);
export const createIcdCode: Handler = (req, ctx) => s.createIcdCode(ctx, req.body);
export const updateIcdCode: Handler = (req, ctx) => s.updateIcdCode(ctx, req.params, req.headers, req.body);
export const getPatientRewards: Handler = (req, ctx) => s.getPatientRewards(ctx, req.params, req.query);
